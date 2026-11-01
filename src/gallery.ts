import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { errMsg } from "./backends";
import { confirmDelete, deleteRender, gone, kindWord, reusePrompt, revealFile, saveAs } from "./fileactions";
import { attachZoom, type Zoom } from "./zoom";
import { closeMenu, copy, type MenuItem, showMenu } from "./rendermenu";
import { editSong, laser, paintToChange, songEditItems, startFrom, upscaleItems } from "./renderactions";
import { $, $$, age, deps, ensureWorkflows, filter, items, run, selected, starred, workflows } from "./studio";
import { type Asset, MODES, songLength, type Source } from "./modes";
import { render, visible } from "./cards";

// ---------- stars ----------
export function loadStarred(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("studio.starred") ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveStarred() {
  try {
    localStorage.setItem("studio.starred", JSON.stringify([...starred]));
  } catch {}
}

/** Stars a render, or takes its star away (the card, the viewer and the Starred filter follow). */
export function toggleStar(path: string, on = !starred.has(path)) {
  if (on) starred.add(path);
  else starred.delete(path);
  saveStarred();
  if (filter === "starred") render();
  else $$<HTMLElement>("#gallery .thumb").forEach((f) => f.dataset.path === path && $(".star", f)?.classList.toggle("on", on));
  if (lbAsset?.path === path) renderLbStar();
}

export function renderLbStar() {
  const on = !!lbAsset && starred.has(lbAsset.path);
  const b = $("#lb-star");
  b.textContent = on ? "★ Starred" : "☆ Star";
  b.classList.toggle("on", on);
}

// ---------- picking several renders (Ctrl- or Shift-click) ----------
// A Shift-click range starts at the last one clicked.
let anchor: string | null = null;
export function pick(a: Asset, range: boolean) {
  const list = visible();
  const from = range && anchor ? list.findIndex((x) => x.path === anchor) : -1;
  const to = list.findIndex((x) => x.path === a.path);
  if (from >= 0 && to >= 0) {
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) selected.add(list[i].path);
  } else if (selected.has(a.path)) selected.delete(a.path);
  else selected.add(a.path);
  anchor = a.path;
  $$<HTMLElement>("#gallery .thumb").forEach((f) => f.classList.toggle("sel", selected.has(f.dataset.path!)));
  renderSelection();
}

export function clearSelection() {
  selected.clear();
  anchor = null;
  $$<HTMLElement>("#gallery .thumb.sel").forEach((f) => f.classList.remove("sel"));
  renderSelection();
}

/** The bar over the gallery while renders are picked: star, copy or delete them all at once. */
export function renderSelection() {
  const bar = $("#gal-sel");
  bar.hidden = !selected.size;
  if (!selected.size) return;
  $("#sel-count").textContent = `${selected.size} selected`;
  $("#sel-star").textContent = [...selected].every((p) => starred.has(p)) ? "Unstar" : "Star";
}

export function initSelectionBar() {
  $("#sel-clear").addEventListener("click", clearSelection);
  $("#sel-all").addEventListener("click", () => {
    for (const a of visible()) selected.add(a.path);
    $$<HTMLElement>("#gallery .thumb").forEach((f) => f.classList.toggle("sel", selected.has(f.dataset.path!)));
    renderSelection();
  });
  $("#sel-star").addEventListener("click", () => {
    const on = ![...selected].every((p) => starred.has(p));
    for (const p of selected) on ? starred.add(p) : starred.delete(p);
    saveStarred();
    render();
  });
  $("#sel-copy").addEventListener("click", async () => {
    try {
      await invoke("copy_renders", { root: deps.root(), paths: [...selected] });
      deps.toast(`${selected.size === 1 ? "File" : `${selected.size} files`} copied. Paste into a folder or a chat app.`);
    } catch (e) {
      deps.toast(`Couldn't copy them: ${errMsg(e)}`, "warn");
    }
  });
  $("#sel-delete").addEventListener("click", deleteSelected);
}

/** Asks once, then moves every picked render to the Recycle Bin. */
export async function deleteSelected() {
  const picked = items.filter((a) => selected.has(a.path));
  if (!picked.length) return;
  if (!(await confirmDelete(picked.length === 1 ? `Delete this ${kindWord(picked[0])}?` : `Delete these ${picked.length} renders?`, picked.length === 1 ? picked[0].name : `${picked.length} files`))) return;
  let failed = 0;
  for (const a of picked) {
    try {
      await invoke("delete_render", { root: deps.root(), path: a.path, mtime: a.mtime });
      gone(a.path);
    } catch {
      failed++;
    }
  }
  selected.clear();
  anchor = null;
  render();
  const moved = picked.length - failed;
  deps.toast(failed ? `Moved ${moved} to the Recycle Bin; ${failed} couldn't be deleted.` : `Moved ${moved} ${moved === 1 ? "render" : "renders"} to the Recycle Bin.`, failed ? "warn" : undefined);
}

export const CUBE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l9 5v10l-9 5-9-5V7z" /><path d="M3 7l9 5 9-5M12 12v10" /></svg>`;

/** Picture to 3D: queues Pixal3D on a picture (a render, or a reference picture from chat); the .glb opens in the 3D
 *  viewer when it's done. */
export async function toModel(a: Source, from = "Studio", progress?: (pct: number, label: string) => void): Promise<Asset[]> {
  await ensureWorkflows();
  if (!workflows.model3d) throw new Error(`workflows\\${MODES.model3d.file} wasn't found (update the Workstation and add the 3d pack)`);
  return run("model3d", "name" in a ? `3D model of ${a.name}` : "3D model of the picture", a, {}, progress, { from });
}

export function makeModel(a: Asset) {
  closeLightbox();
  deps.toast("Making a 3D model: 3 to 8 minutes, longer for detailed subjects. It opens in the 3D viewer when it's done (the render queue shows how far it is).");
  toModel(a)
    .then((got) => got[0] && deps.openModel(got[0].path, got[0].name))
    .catch((e) => errMsg(e) !== "stopped" && deps.toast(`Couldn't make the 3D model: ${errMsg(e)}`, "warn"));
}

export const NOTE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></svg>`;

/** The first sung lines of a song's lyrics, without the [Verse] / [Chorus] tags. */
export function lyricLines(lyrics: string | null | undefined, n: number) {
  const lines = (lyrics ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !/^\[.*\]$/.test(l));
  return lines.length ? lines.slice(0, n).join("\n") : "Instrumental";
}

// ---------- lightbox ----------
export let lbAsset: Asset | null = null;
// Pictures zoom with the mouse wheel or the bar under them (zoom.ts).
export let lbZoom: Zoom;
export function initLightboxZoom() {
  lbZoom = attachZoom($("#lb-media"), { target: () => $("#lb-media img"), bar: $("#lb-zoom"), panButton: 0 });
}

export function openLightbox(a: Asset) {
  closeMenu();
  lbAsset = a;
  const media = $("#lb-media");
  lbZoom.reset();
  media.innerHTML = "";
  $("#lb-zoom").hidden = a.kind !== "image";
  media.oncontextmenu = (e) => showMenu(e, a);
  if (a.kind === "video") {
    const v = document.createElement("video");
    v.src = convertFileSrc(a.path);
    v.controls = true;
    v.autoplay = true;
    v.loop = true;
    media.appendChild(v);
  } else if (a.kind === "audio") {
    // The song plays straight away, with its lyrics to read along.
    const box = document.createElement("div");
    box.className = "lb-song";
    box.innerHTML = `<span class="song-art" aria-hidden="true">${NOTE_SVG}</span><audio controls autoplay></audio><pre class="lb-lyrics"></pre>`;
    ($("audio", box) as HTMLAudioElement).src = convertFileSrc(a.path);
    $(".lb-lyrics", box).textContent = a.lyrics?.trim() || "Instrumental (no lyrics)";
    media.appendChild(box);
  } else {
    const img = document.createElement("img");
    img.src = convertFileSrc(a.path);
    img.alt = a.prompt || a.name;
    media.appendChild(img);
  }
  $("#lb-p").textContent = a.prompt || "No prompt saved in this file.";
  const dl = $("#lb-dl");
  dl.innerHTML = "";
  const rows: [string, string][] = [
    ["File", a.name],
    ["Type", a.kind === "video" ? "Video" : a.kind === "audio" ? "Song" : "Image"],
    ["Model", a.model || "unknown"],
    a.kind === "audio" ? ["Length", a.duration ? songLength(Math.round(a.duration)) : "–"] : ["Size", a.width ? `${a.width} × ${a.height}` : "–"],
    ["Seed", a.seed != null ? String(a.seed) : "–"],
    ["File size", `${(a.size / 1048576).toFixed(1)} MB`],
    ["Made", `${new Date(a.mtime).toLocaleString()} (${age(a.mtime)})`],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
  ($("#lb-copy") as HTMLButtonElement).disabled = !a.prompt;
  // A song's prompt is its style, and reusing it brings back its lyrics too.
  $("#lb-copy").textContent = a.kind === "audio" ? "Copy style" : "Copy prompt";
  $("#lb-reuse").textContent = a.kind === "audio" ? "Reuse style and lyrics" : "Reuse prompt";
  ($("#lb-animate") as HTMLButtonElement).hidden = a.kind !== "image" || !(workflows.animate || workflows.long);
  ($("#lb-edit") as HTMLButtonElement).hidden = a.kind !== "image" || !workflows.edit;
  $("#lb-edit").onclick = () => startFrom(a, "image");
  ($("#lb-inpaint") as HTMLButtonElement).hidden = a.kind !== "image" || !workflows.inpaint;
  $("#lb-inpaint").onclick = () => paintToChange(a);
  $("#lb-animate").onclick = () => startFrom(a, "video");
  // One button to sharpen it: 4K for a picture (1080p when that's all it lacks), 1080p for a video.
  const up = upscaleItems(a).filter((x): x is Exclude<MenuItem, "-"> => x !== "-").pop();
  ($("#lb-upscale") as HTMLButtonElement).hidden = !up;
  if (up) {
    $("#lb-upscale").textContent = up.label;
    $("#lb-upscale").onclick = up.run;
  }
  ($("#lb-songedit") as HTMLButtonElement).hidden = !songEditItems(a).length;
  $("#lb-songedit").onclick = () => editSong(a, "repaint");
  ($("#lb-laser") as HTMLButtonElement).hidden = a.kind !== "image";
  $("#lb-laser").onclick = () => laser(a);
  ($("#lb-reuse") as HTMLButtonElement).disabled = !a.prompt;
  $("#lb-reveal").onclick = () => revealFile(a);
  $("#lb-copy").onclick = () => copy(a.prompt || "");
  $("#lb-reuse").onclick = () => reusePrompt(a);
  $("#lb-save").onclick = () => saveAs(a);
  $("#lb-delete").onclick = () => deleteRender(a);
  renderLbStar();
  // Back and next buttons for the gallery around it (the arrow keys do the same).
  const list = viewable();
  const i = list.findIndex((x) => x.path === a.path);
  $("#lb-prev").hidden = i <= 0;
  $("#lb-next").hidden = i < 0 || i >= list.length - 1;
  $("#lb").hidden = false;
}

/** What the viewer steps through: the gallery as filtered and searched, without 3D models (they open in 3D). */
export const viewable = () => visible().filter((a) => a.kind !== "model");

/** Opens the render before (-1) or after (1) the one in the viewer. */
export function stepLightbox(d: number) {
  if (!lbAsset) return;
  const list = viewable();
  const i = list.findIndex((x) => x.path === lbAsset!.path);
  const next = i >= 0 ? list[i + d] : undefined;
  if (next) openLightbox(next);
}

export function closeLightbox() {
  const v = $("#lb-media video, #lb-media audio") as HTMLMediaElement | null;
  v?.pause();
  $("#lb-media").innerHTML = "";
  $("#lb").hidden = true;
  lbAsset = null;
}
