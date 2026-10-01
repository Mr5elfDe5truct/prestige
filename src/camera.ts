// Webcam vision: a live preview with a device picker, "Ask about this" (sends the current frame with a
// question to the chat, answered by Gemma 4), an optional live caption every few seconds, and the
// composer's camera button that attaches a frame to the next message.
import { errMsg, freeLlamaVram, http, OLLAMA, NUM_CTX } from "./backends";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

interface Deps {
  toast: (msg: string, kind?: string) => void;
  /** Sends a chat message with images; switches to a vision model if needed. */
  ask: (text: string, images: string[], visionModel: string) => void;
  attach: (b64: string) => void;
  getCamera: () => string | undefined;
  setCamera: (id: string) => void;
}

export const VISION_MODELS = [
  { id: "gemma4:12b", label: "Gemma 4 12B" },
  { id: "gemma4:e4b", label: "Gemma 4 E4B (fast)" },
];

let deps: Deps;
let stream: MediaStream | null = null;
let liveTimer = 0;
let liveBusy = false;
let paneOn = false;

export function initCamera(d: Deps) {
  deps = d;
  $("#cam-device").addEventListener("change", () => {
    deps.setCamera(($("#cam-device") as HTMLSelectElement).value);
    if (paneOn) startPreview($("#cam-video") as HTMLVideoElement);
  });
  $("#cam-start").addEventListener("click", () => (stream ? stopPane() : showCameraPane(true)));
  $("#cam-ask-form").addEventListener("submit", (e) => {
    e.preventDefault();
    askAboutThis();
  });
  $("#cam-live").addEventListener("change", () => setLive(($("#cam-live") as HTMLInputElement).checked));
  $("#cam-every").addEventListener("change", () => {
    if (($("#cam-live") as HTMLInputElement).checked) setLive(true);
  });

  // Composer camera button: a small popover with a preview and "Attach this frame".
  $("#composer-cam").addEventListener("click", openPopover);
  $("#cam-pop-cancel").addEventListener("click", closePopover);
  $("#cam-pop-attach").addEventListener("click", () => {
    const b64 = snapshot($("#cam-pop-video") as HTMLVideoElement, 1024);
    if (b64) deps.attach(b64);
    closePopover();
  });
}

async function listCameras() {
  const sel = $("#cam-device") as HTMLSelectElement;
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  sel.innerHTML = "";
  devs.forEach((d, i) => {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `Camera ${i + 1}`;
    sel.appendChild(o);
  });
  const want = deps.getCamera();
  if (want && devs.some((d) => d.deviceId === want)) sel.value = want;
  return devs;
}

async function openStream(): Promise<MediaStream> {
  const id = deps.getCamera();
  const video: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
  if (id) video.deviceId = { exact: id };
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (e) {
    // The saved camera may be unplugged; fall back to any camera.
    if (id) return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 } }, audio: false });
    throw e;
  }
}

async function startPreview(v: HTMLVideoElement) {
  stopStream();
  stream = await openStream();
  v.srcObject = stream;
  await v.play().catch(() => {});
}

function stopStream() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

/** The current frame as a base64 JPEG, longest side `max` px. */
export function snapshot(v: HTMLVideoElement, max = 1024): string | null {
  if (!v.videoWidth) return null;
  const scale = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85).split(",")[1];
}

function camError(e: unknown) {
  const name = (e as DOMException)?.name;
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera found. Plug in a webcam and try again.";
  if (name === "NotAllowedError") return "Camera access was blocked. Check Windows Settings → Privacy → Camera → let desktop apps use the camera.";
  if (name === "NotReadableError") return "The camera is busy in another app (close it there, then try again).";
  return `Camera error: ${errMsg(e)}`;
}

// ---------- Studio "Webcam" pane ----------
export async function showCameraPane(on: boolean) {
  paneOn = on;
  if (!on) {
    stopPane();
    return;
  }
  const note = $("#cam-note");
  try {
    await startPreview($("#cam-video") as HTMLVideoElement);
    await listCameras(); // labels are only available once access is granted
    $("#cam-view").classList.add("on");
    $("#cam-start").textContent = "Stop camera";
    note.textContent = "";
    ($("#cam-ask") as HTMLInputElement).focus();
  } catch (e) {
    $("#cam-view").classList.remove("on");
    note.textContent = camError(e);
  }
}

function stopPane() {
  setLive(false);
  ($("#cam-live") as HTMLInputElement).checked = false;
  stopStream();
  ($("#cam-video") as HTMLVideoElement).srcObject = null;
  $("#cam-view").classList.remove("on");
  $("#cam-start").textContent = "Start camera";
}

function visionModel() {
  return ($("#cam-model") as HTMLSelectElement).value || VISION_MODELS[0].id;
}

function askAboutThis() {
  const q = ($("#cam-ask") as HTMLInputElement).value.trim() || "What do you see?";
  const b64 = snapshot($("#cam-video") as HTMLVideoElement, 1024);
  if (!b64) return deps.toast("Start the camera first.");
  ($("#cam-ask") as HTMLInputElement).value = "";
  deps.ask(q, [b64], visionModel());
}

function setLive(on: boolean) {
  clearInterval(liveTimer);
  if (!on) {
    $("#cam-caption").textContent = "";
    $("#cam-view").classList.remove("scanning");
    return;
  }
  const every = Math.max(2, Number(($("#cam-every") as HTMLInputElement).value) || 5) * 1000;
  const tick = async () => {
    if (liveBusy || !stream) return; // one request at a time
    const b64 = snapshot($("#cam-video") as HTMLVideoElement, 512);
    if (!b64) return;
    liveBusy = true;
    $("#cam-view").classList.add("scanning");
    try {
      await freeLlamaVram();
      const r = await http(`${OLLAMA}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: visionModel(),
          prompt: "In one short sentence, describe what the camera sees right now.",
          images: [b64],
          stream: false,
          think: false,
          options: { num_ctx: NUM_CTX, num_predict: 60 },
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Ollama answered ${r.status}`);
      if (paneOn && liveTimer) $("#cam-caption").textContent = String(j.response ?? "").trim();
    } catch (e) {
      $("#cam-caption").textContent = `Couldn't describe the frame: ${errMsg(e) === "not reachable" ? "Ollama isn't running" : errMsg(e)}`;
    } finally {
      liveBusy = false;
      $("#cam-view").classList.remove("scanning");
    }
  };
  liveTimer = window.setInterval(tick, every);
  tick();
}

// ---------- composer popover ----------
async function openPopover() {
  const pop = $("#cam-pop");
  pop.hidden = false;
  $("#cam-pop-note").textContent = "";
  try {
    const s = await openStream();
    const v = $("#cam-pop-video") as HTMLVideoElement;
    v.srcObject = s;
    await v.play().catch(() => {});
  } catch (e) {
    $("#cam-pop-note").textContent = camError(e);
  }
}

function closePopover() {
  const v = $("#cam-pop-video") as HTMLVideoElement;
  (v.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
  v.srcObject = null;
  $("#cam-pop").hidden = true;
}
