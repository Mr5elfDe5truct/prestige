// Sprite sheets for characters (the character editor's "Make sprites…"): VNCCS clones the character from their face into
// full-body sprites in many poses, and sprites.rs puts them on one sheet. VNCCS runs in a ComfyUI of its own, and its
// Pose Studio draws the poses in its page while a job runs, so the job is started from that page, in a Prestige window,
// by the script below (it does what you'd click: load the Character Cloner, pick the character, add the picture, Turbo).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Character } from "./characters";

interface Deps {
  toast: (msg: string, kind?: string) => void;
  root: () => string | null;
  openRender: (path: string) => void;
}
let deps: Deps;

interface Status {
  installed: boolean;
  missing: string[];
  running: boolean;
  setup: { stage: string; pct: number; line: string; error?: string } | null;
}
interface Progress {
  running: boolean;
  busy: boolean | null;
  done: number;
  error: string | null;
}

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let working = false;

export function initSprites(d: Deps) {
  deps = d;
  listen<Status["setup"]>("sprites-setup", (e) => {
    const s = e.payload;
    if (!s) return;
    if (s.stage === "done") deps.toast("Sprites are set up. Click Make sprites… again to make some.");
    else if (s.stage === "failed") deps.toast(`Couldn't set up sprites: ${s.error}`, "warn");
    else if (/^(Getting|Making|Installing)/.test(s.line) || s.line.endsWith("…")) deps.toast(`Setting up sprites: ${s.line}`);
  });
}

/** The page script: waits for VNCCS's page, then fills in its Character Cloner and queues it. */
function driver(p: { job: string; name: string; face: string; poses: number }) {
  return `(async () => {
  if (window.top !== window) return;
  const P = ${JSON.stringify(p)};
  try { if (sessionStorage.getItem("prestige-job") === P.job) return; sessionStorage.setItem("prestige-job", P.job); } catch {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 120 && !(window.comfyAPI?.app?.app?.graph); i++) await sleep(1000);
  const app = window.comfyAPI.app.app;
  const widget = (id, name) => app.graph.getNodeById(id).widgets.find((w) => w.name === name);
  const button = (root, text) => [...root.querySelectorAll("button")].find((b) => b.innerText.trim() === text);
  const set = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  await sleep(2000);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const wf = await (await fetch("/api/userdata/" + encodeURIComponent("workflows/VNCCS_3.2_Step1_CharacterCloner.json"))).json();
  await app.loadGraphData(wf);
  await sleep(4000);
  // The character (Prestige wrote its settings, so it's in the list).
  const ui = widget(774, "ui").element;
  const sel = ui.querySelector("select");
  if ([...sel.options].some((o) => o.value === P.name)) {
    sel.value = P.name;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    button(ui, "NEW").click();
    await sleep(1000);
    set([...document.querySelectorAll("input")].find((i) => /name/i.test(i.placeholder || "")), P.name);
    button(document, "Create").click();
  }
  await sleep(2500);
  // Their face.
  const blob = await (await fetch(P.face)).blob();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], "prestige-face.jpg", { type: blob.type || "image/jpeg" }));
  const fi = ui.querySelector("input[type=file]");
  fi.files = dt.files;
  fi.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(4000);
  // Turbo (6 steps, CFG 1), and no upscaler.
  const nums = [...widget(771, "cc_widget").element.querySelectorAll("input")].filter((i) => /^\\d+(\\.\\d+)?$/.test(i.value));
  set(nums[0], 6);
  set(nums[1], 1);
  await sleep(800);
  button(widget(776, "character_generator_ui").element, "OFF")?.click();
  await sleep(800);
  // Fewer poses: remove them from the end of the Pose Studio's list.
  if (P.poses > 0) {
    const ps = widget(761, "pose_studio_ui").element;
    const count = () => JSON.parse(widget(761, "pose_data").value).poses.length;
    for (let i = 0; i < 40 && count() > P.poses; i++) {
      const xs = [...ps.querySelectorAll("button")].filter((b) => ["X", "✕"].includes(b.innerText.trim()));
      xs[xs.length - 1].click();
      await sleep(600);
      [...document.querySelectorAll("button")].find((b) => /^(yes|ok|delete|confirm)$/i.test(b.innerText.trim()) && b.offsetParent)?.click();
      await sleep(600);
    }
  }
  // The Pose Studio draws its previews before the job can use them.
  await sleep(15000);
  await app.queuePrompt(0, 1);
})();`;
}

function form(c: Character): Promise<{ sex: string; poses: number } | null> {
  const dlg = $("#sprites") as HTMLDialogElement;
  $("#sprites-title").textContent = `Make sprites of ${c.name || "them"}`;
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((done) =>
    dlg.addEventListener(
      "close",
      () => done(dlg.returnValue === "ok" ? { sex: ($("#sprites-sex") as HTMLSelectElement).value, poses: +($("#sprites-poses") as HTMLSelectElement).value } : null),
      { once: true },
    ),
  );
}

/** "Make sprites…": sets VNCCS up the first time, then runs it for the character and opens the sheet. */
export async function makeSprites(c: Character) {
  if (!c.face) return deps.toast("Add a face first.");
  if (working) return deps.toast("Sprites are already being made.");
  const root = deps.root();
  const st = await invoke<Status>("sprites_status", { root });
  if (st.setup?.stage === "running") return deps.toast(`Still setting up sprites: ${st.setup.line}`);
  if (!st.installed || st.missing.length) {
    const ok = confirm(
      "Sprites use VNCCS, in a ComfyUI of its own. Set it up now? It downloads about 25 GB (ComfyUI, its Python packages and the Qwen-Image 2.1 models) into apps\\ComfyUI-VNCCS.",
    );
    if (!ok) return;
    await invoke("sprites_setup", { root }).catch((e) => deps.toast(`Couldn't set up sprites: ${e}`, "warn"));
    return deps.toast("Setting up sprites… (this takes a while; Prestige says when it's done)");
  }
  const opts = await form(c);
  if (!opts) return;
  working = true;
  let comfyStopped = false;
  try {
    deps.toast("Starting VNCCS…");
    // Only a ComfyUI that was running is started again after.
    const comfyUp = await fetch("http://127.0.0.1:8188/", { mode: "no-cors" }).then(() => true, () => false);
    if (comfyUp) comfyStopped = await invoke("svc_stop", { root, name: "comfyui" }).then(() => true, () => false);
    await invoke("sprites_start", { root });
    const name = await invoke<string>("sprites_character", { root, name: c.name, sex: opts.sex });
    const since = Date.now() - 2000;
    await invoke("sprites_window", { script: driver({ job: String(since), name, face: `data:image/jpeg;base64,${c.face}`, poses: opts.poses }) });
    deps.toast(`Making sprites of ${c.name} in VNCCS's window…`);
    // Wait for the job to be queued, then for it to finish.
    let seen = false;
    let shown = 0;
    for (let t = 0; ; t += 5) {
      await sleep(5000);
      const p = await invoke<Progress>("sprites_progress", { root, name, since });
      if (!p.running) throw new Error("VNCCS's ComfyUI stopped (see logs\\vnccs.log)");
      if (p.error && seen) throw new Error(p.error);
      if (p.busy) seen = true;
      if (p.done > shown) {
        shown = p.done;
        deps.toast(`Sprites of ${c.name}: ${p.done}${opts.poses ? ` of ${opts.poses}` : ""} done`);
      }
      if (seen && p.busy === false) break;
      if (!seen && t > 240) throw new Error("VNCCS didn't start the job");
    }
    const sheet = await invoke<{ path: string; count: number }>("sprite_sheet", { root, name, since });
    deps.toast(`${sheet.count} sprites of ${c.name}, on one sheet. They're in Studio's gallery too.`);
    await invoke("sprites_stop");
    deps.openRender(sheet.path);
  } catch (e) {
    deps.toast(`Couldn't make sprites: ${e instanceof Error ? e.message : e}`, "warn");
    await invoke("sprites_stop");
  } finally {
    working = false;
    if (comfyStopped) await invoke("svc_start", { root, names: ["comfyui"] }).catch(() => {});
  }
}
