import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { errMsg } from "./backends";
import { CONSENT, imageIn, loadReference, renderIn, uploadReference, videoIn, videoRenderIn } from "./reference";
import { characterById, characters, faceBlob, onCharactersChange } from "./characters";
import { aboutTime } from "./gensettings";
import { $, current, deps, ensureWorkflows, esc, job, mode, renderCreate, run, setMode, starting, type SwapJob, swapParts, workflows, findItem } from "./studio";
import { type Asset, MODES, SWAP, SWAP_STEPS, type SwapQuality } from "./modes";
import { refresh } from "./cards";
import { closeLightbox } from "./gallery";
import { swapSecs, type VideoInfo } from "./renderactions";
import { openRender } from "./renderapi";

// ---------- the Swap panel ----------
// Swap a character in Studio's create bar (Film's and Video's Swap chip, or a video's "Swap a character…"): the video
// on the left, who goes in on the right, each dropped from Explorer or the gallery, pasted or picked; then the swap
// joins the render queue like any render, so another can be set up while it runs.
export let swapOpen = false;
export function toggleSwap() {
  swapOpen = !swapOpen;
}
export const sw: { video: Asset | null; info: VideoInfo | null; picture: Blob | null; picName: string; picUrl: string; done: string | null } = {
  video: null,
  info: null,
  picture: null,
  picName: "",
  picUrl: "",
  done: null,
};

/** Whether the Swap panel is showing (Film and Video modes, with the Swap a character pack). */
export const swapShown = () => swapOpen && (mode === "film" || mode === "video") && !!workflows.swap;

/** The Swap chip beside the other chips: it shows and hides the panel. */
export const swapChip = () =>
  workflows.swap
    ? `<button type="button" class="opt pick swap${swapOpen ? " on" : ""}" aria-expanded="${swapOpen}" title="Put the person in a picture in place of a person in a video, moving as they did (SCAIL-2)">⇆ ${mode === "film" ? "<b>Swap</b>" : "Swap a character"}</button>`
    : "";

/** Opens the Swap panel (in Video mode, unless Film is showing), with this video in it when there's one. */
export async function swapCharacter(a?: Asset) {
  closeLightbox();
  deps.show();
  await ensureWorkflows();
  if (!workflows.swap) return deps.toast(`workflows\\${MODES.swap.file} wasn't found: add the Swap a character pack in Packs`, "warn");
  if (mode !== "film" && mode !== "video") {
    setMode("video");
  }
  swapOpen = true;
  renderCreate();
  if (a) await setSwapVideo(a);
  $("#swap-panel").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/** The video to swap in (null clears it): ffprobe reads its size, frame rate and length first. */
export async function setSwapVideo(a: Asset | null) {
  const info = a
    ? await invoke<VideoInfo>("video_info", { path: a.path }).catch((e) => {
        deps.toast(`Couldn't read the video: ${errMsg(e)}`, "warn");
        return null;
      })
    : null;
  if (a && !info) return;
  sw.video = a;
  sw.info = info;
  sw.done = null;
  renderSwap();
}

/** A video file dropped or pasted from outside: the page gets its bytes, so it's saved first (swap_video_save). */
export async function swapVideoFile(f: File) {
  try {
    const body = new Uint8Array(await f.arrayBuffer());
    const path = await invoke<string>("swap_video_save", body, { headers: { "x-name": encodeURIComponent(f.name), "x-root": encodeURIComponent(deps.root() ?? "") } });
    await setSwapVideo({ path, name: f.name, kind: "video", mtime: 0, size: f.size });
  } catch (e) {
    deps.toast(`Couldn't take ${f.name}: ${errMsg(e)}`, "warn");
  }
}

/** Who goes in (null clears it): any picture, or a saved Character's face. */
export function setSwapPicture(b: Blob | null, name = "") {
  if (sw.picUrl) URL.revokeObjectURL(sw.picUrl);
  sw.picture = b;
  sw.picName = b ? name : "";
  sw.picUrl = b ? URL.createObjectURL(b) : "";
  sw.done = null;
  if (!b || !name.endsWith("'s face")) ($("#sp-char") as HTMLSelectElement).value = "";
  renderSwap();
}

/** A drop or paste while the panel shows: a video (a render or a file) goes in the Video box, a picture in Person.
 *  False when there's neither. */
export async function swapTake(data: DataTransfer | null): Promise<boolean> {
  const vid = videoRenderIn(data);
  if (vid) {
    findItem(vid).then(setSwapVideo, (e) => deps.toast(errMsg(e), "warn"));
    return true;
  }
  const pic = renderIn(data);
  if (pic) {
    const b = await fetch(convertFileSrc(pic))
      .then((r) => (r.ok ? r.blob() : null))
      .catch(() => null);
    if (b) setSwapPicture(b, pic.split(/[\\/]/).pop());
    return true;
  }
  const v = videoIn(data);
  if (v) {
    swapVideoFile(v);
    return true;
  }
  const f = imageIn(data);
  if (f) {
    setSwapPicture(f, f.name && f.name !== "image.png" ? f.name : "a pasted picture");
    return true;
  }
  return false;
}

export function initSwapPanel() {
  const vbox = $("#sp-video");
  const pbox = $("#sp-person");
  const vfile = $("#sp-video-file") as HTMLInputElement;
  const pfile = $("#sp-person-file") as HTMLInputElement;
  const video = $("video", vbox) as HTMLVideoElement;
  // Click a box to pick (the PC's own file dialog for a video, so it's read where it is); × clears it.
  vbox.addEventListener("click", async (e) => {
    if ((e.target as HTMLElement).closest(".swap-clear")) return setSwapVideo(null);
    if (!("__TAURI_INTERNALS__" in window)) return vfile.click();
    const path = await invoke<string | null>("pick_video").catch(() => null);
    if (path) setSwapVideo({ path, name: path.split(/[\\/]/).pop()!, kind: "video", mtime: 0, size: 0 });
  });
  pbox.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".swap-clear")) return setSwapPicture(null);
    if ((e.target as HTMLElement).closest("select")) return;
    pfile.click();
  });
  for (const box of [vbox, pbox]) {
    box.addEventListener("keydown", (e) => {
      if (e.target !== box || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      box.click();
    });
    box.addEventListener("dragover", () => box.classList.add("over"));
    box.addEventListener("dragleave", (e) => !box.contains(e.relatedTarget as Node) && box.classList.remove("over"));
    box.addEventListener("drop", () => box.classList.remove("over"));
  }
  vfile.addEventListener("change", () => {
    const f = vfile.files?.[0];
    vfile.value = "";
    if (f) swapVideoFile(f);
  });
  pfile.addEventListener("change", () => {
    const f = pfile.files?.[0];
    pfile.value = "";
    if (f) setSwapPicture(f, f.name);
  });
  // The video plays (muted) while the pointer is over it.
  vbox.addEventListener("mouseenter", () => sw.video && video.play().catch(() => {}));
  vbox.addEventListener("mouseleave", () => video.pause());
  $("#sp-char").addEventListener("change", (e) => {
    const c = characterById((e.target as HTMLSelectElement).value);
    if (c?.face) setSwapPicture(faceBlob(c), `${c.name}'s face`);
  });
  $("#sp-quality").addEventListener("change", renderSwap);
  ($("#sp-who") as HTMLInputElement).value = "person";
  $("#sp-consent").textContent = `${CONSENT} Never make sexual content of anyone under 18.`;
  onCharactersChange(() => swapShown() && renderSwap());
  $("#sp-go").addEventListener("click", runSwap);
  $("#sp-add").addEventListener("click", async () => {
    const path = sw.done;
    if (!path) return;
    const add = $("#sp-add") as HTMLButtonElement;
    add.disabled = true;
    try {
      await deps.film.addClip(path, sw.picName.endsWith("'s face") ? `${sw.picName.slice(0, -7)} swapped in` : `Swapped in from ${sw.picName || "a picture"}`);
    } catch (e) {
      deps.toast(`Couldn't add it to the film: ${errMsg(e)}`, "warn");
    }
    add.disabled = false;
  });
}

/** Draws the panel from what's in it. */
export function renderSwap() {
  const vbox = $("#sp-video");
  const pbox = $("#sp-person");
  const video = $("video", vbox) as HTMLVideoElement;
  const src = sw.video ? convertFileSrc(sw.video.path) : "";
  if (video.dataset.src !== src) {
    video.dataset.src = src;
    if (src) video.src = src;
    else {
      video.removeAttribute("src");
      video.load();
    }
  }
  vbox.classList.toggle("full", !!sw.video);
  video.hidden = !sw.video;
  $(".swap-empty", vbox).hidden = !!sw.video;
  $(".swap-clear", vbox).hidden = !sw.video;
  $(".swap-name", vbox).textContent = sw.video ? `${sw.video.name}${sw.info ? ` · ${sw.info.seconds.toFixed(1)} s · ${sw.info.width}×${sw.info.height}` : ""}` : "";
  const img = $("img", pbox) as HTMLImageElement;
  if (img.getAttribute("src") !== sw.picUrl) {
    if (sw.picUrl) img.src = sw.picUrl;
    else img.removeAttribute("src");
  }
  pbox.classList.toggle("full", !!sw.picture);
  img.hidden = !sw.picture;
  $(".swap-empty", pbox).hidden = !!sw.picture;
  $(".swap-clear", pbox).hidden = !sw.picture;
  $(".swap-name", pbox).textContent = sw.picName;
  // A saved Character's face can go in instead.
  const sel = $("#sp-char") as HTMLSelectElement;
  const faces = characters().filter((c) => c.face);
  const was = sel.value;
  sel.innerHTML = `<option value="">${faces.length ? "Pick one…" : "none saved yet"}</option>` + faces.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  sel.value = faces.some((c) => c.id === was) ? was : "";
  sel.disabled = !faces.length;
  // How long it takes, and how much of the video is swapped.
  const q = ($("#sp-quality") as HTMLSelectElement).value as SwapQuality;
  const info = sw.info;
  if (info) {
    const frames = Math.min(info.frames, Math.floor(SWAP.maxSeconds * info.fps));
    const parts = swapParts(frames);
    const over = info.seconds > SWAP.maxSeconds + 0.05 ? ` Only the first ${SWAP.maxSeconds} s are swapped.` : "";
    $("#sp-est").textContent = `Takes ${aboutTime(swapSecs(frames, q))} on an RTX 3060 (${parts} part${parts > 1 ? "s" : ""} of up to ${(SWAP.part / info.fps).toFixed(1)} s). The chat model is unloaded while it runs.${over}`;
  } else $("#sp-est").textContent = `Up to the first ${SWAP.maxSeconds} s of a video is swapped; 5 s at Draft takes about 12 min on an RTX 3060.`;
  const go = $("#sp-go") as HTMLButtonElement;
  go.disabled = !sw.video || !sw.picture;
  go.textContent = job || starting || current ? "Swap (add to queue)" : "Swap";
  go.title = !sw.video ? "Put a video in the left box first" : !sw.picture ? "Put a picture of who goes in in the right box first" : "";
  // When it's done: open it, or put it in the film.
  const film = sw.done ? deps.film.target() : null;
  const add = $("#sp-add") as HTMLButtonElement;
  add.hidden = !film;
  if (film) add.textContent = `Add to “${film.name}”`;
  const done = $("#sp-done");
  done.innerHTML = sw.done ? `Done: <button type="button" class="linkish" id="sp-open">${esc(sw.done.split(/[\\/]/).pop() ?? "")}</button> is in Renders.` : "";
  if (sw.done) $("#sp-open").onclick = () => sw.done && openRender(sw.done);
}

/** The Swap button: the swap joins the render queue (the chat model is unloaded for it, the video's sound kept). */
export async function runSwap() {
  const a = sw.video;
  const info = sw.info;
  const picture = sw.picture;
  if (!a || !info || !picture) return;
  const q = ($("#sp-quality") as HTMLSelectElement).value as SwapQuality;
  const target = ($("#sp-who") as HTMLInputElement).value.trim() || "person";
  const frames = Math.min(info.frames, Math.floor(SWAP.maxSeconds * info.fps));
  deps.toast(`Swapping ${sw.picName || "the character"} in: ${aboutTime(swapSecs(frames, q))} on an RTX 3060. It's in the render queue.`);
  try {
    const path = await swapInto(a, info, picture, target, q);
    sw.done = path;
    if (swapShown()) renderSwap();
    deps.toast(`The swap is done: ${path.split(/[\\/]/).pop()} is in Renders.`);
  } catch (e) {
    if (errMsg(e) !== "stopped") deps.toast(`Couldn't swap the character: ${errMsg(e)}`, "warn");
  }
}

/** The swap itself: SCAIL-2 puts the character from `picture` in place of `target` in the video (its first 20 s), then
 *  the video's own sound goes back on. Resolves with the new video's path. */
export async function swapInto(a: Asset, info: VideoInfo, picture: Blob, target: string, q: SwapQuality, progress?: (pct: number, label: string) => void, from = "Swap a character") {
  const frames = Math.min(info.frames, Math.floor(SWAP.maxSeconds * info.fps));
  // The video's shape at about 832×480 (what SCAIL-2 and the distill LoRA were made at), in multiples of 32.
  const ratio = info.width && info.height ? info.width / info.height : 16 / 9;
  const w = Math.max(256, Math.round(Math.sqrt(SWAP.area * ratio) / 32) * 32);
  const h = Math.max(256, Math.round(Math.sqrt(SWAP.area / ratio) / 32) * 32);
  // As a reference: scaled to at most 2048 px and kept as a JPEG.
  const r = await loadReference(picture);
  URL.revokeObjectURL(r.url);
  const ref = await uploadReference(r);
  const job: SwapJob = { ref, who: target, steps: SWAP_STEPS[q], frames, w, h };
  const out = await run("swap", target, a, { swap: job }, progress, { from, title: `${a.name}: ${target} swapped` });
  const made = out.find((x) => x.kind === "video" && x.path !== a.path);
  if (!made) throw new Error("no video came back");
  const swapped = await invoke<string>("mux_swap", { root: deps.root(), video: made.path, source: a.path });
  await refresh();
  return swapped;
}

/** A video's length in seconds, from its own metadata (8 when it can't be read). */
export function videoSeconds(path: string): Promise<number> {
  return new Promise((res) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => res(Number.isFinite(v.duration) ? v.duration : 8);
    v.onerror = () => res(8);
    setTimeout(() => res(8), 5000);
    v.src = convertFileSrc(path);
  });
}

/** A one-line question in a small dialog; resolves with the answer (null when cancelled). */
export function ask(title: string, text: string, placeholder: string): Promise<string | null> {
  const dlg = $("#ask") as HTMLDialogElement;
  const inp = $("#ask-input") as HTMLInputElement;
  $("#ask-title").textContent = title;
  $("#ask-text").textContent = text;
  inp.placeholder = placeholder;
  inp.value = "";
  // Enter answers (the form's first button is Cancel, which Enter would otherwise press).
  inp.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    dlg.close("ok");
  };
  dlg.returnValue = "";
  dlg.showModal();
  inp.focus();
  return new Promise((res) =>
    dlg.addEventListener("close", () => res(dlg.returnValue === "ok" && inp.value.trim() ? inp.value.trim() : null), { once: true }),
  );
}
