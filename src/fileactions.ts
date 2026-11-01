// What can be done to a render's file: reuse its prompt or seed, reveal it, save a copy, delete it.
import { type SettingsKey, update } from "./gensettings";
import { invoke } from "@tauri-apps/api/core";
import { errMsg } from "./backends";
import { closeMenu } from "./rendermenu";
import { $, $$, deps, isInstrumental, dropItem, setMode, renderCreate, selected, starred } from "./studio";
import { type Asset } from "./modes";
import { render } from "./cards";
import { closeLightbox, lbAsset, saveStarred } from "./gallery";

export function reusePrompt(a: Asset) {
  deps.show();
  ($("#gen-prompt") as HTMLInputElement).value = a.prompt || "";
  // A song's style and its lyrics both come back.
  if (a.kind === "audio") ($("#song-lyrics-text") as HTMLTextAreaElement).value = isInstrumental(a.lyrics) ? "" : (a.lyrics ?? "");
  setMode(a.kind === "video" ? "video" : a.kind === "audio" ? "music" : "image");
  renderCreate();
  closeLightbox();
  $("#gen-prompt").focus();
}

/** Fixes the seed for the next render of this kind, to vary a render you liked. */
export function reuseSeed(a: Asset) {
  deps.toast(fixSeed(a));
}

/** Fixes the next render's seed to this render's, and says so. */
export function fixSeed(a: Asset) {
  const key: SettingsKey =
    a.kind === "image" ? "image" : a.kind === "audio" ? "music" : /svi-long/i.test(a.name) ? "long" : /wan/i.test(a.model ?? a.name) ? "animate" : "video";
  update(key, { seed: a.seed ?? null });
  return `The next ${key === "image" ? "image" : key === "music" ? "song" : "video"} uses seed ${a.seed}. Pick Random in Settings to go back.`;
}

export const revealFile = (a: Asset) => invoke("reveal", { path: a.path }).catch((e) => deps.toast(errMsg(e), "warn"));

/** Runs a Studio command on a render's file and toasts the outcome. */
export async function fileAction(cmd: string, a: Asset, args: Record<string, unknown>, done?: string) {
  try {
    await invoke(cmd, { root: deps.root(), path: a.path, ...args });
    if (done) deps.toast(done);
  } catch (e) {
    deps.toast(errMsg(e), "warn");
  }
}

export async function saveAs(a: Asset) {
  try {
    const dest = await invoke<string | null>("save_render_as", { root: deps.root(), path: a.path });
    if (dest) deps.toast(`Saved a copy as ${dest}`);
  } catch (e) {
    deps.toast(`Couldn't save it: ${errMsg(e)}`, "warn");
  }
}

/** Asks first, then moves the file to the Recycle Bin and takes it out of the gallery and chats. */
export async function deleteRender(a: Asset) {
  closeMenu();
  if (!(await confirmDelete(`Delete this ${kindWord(a)}?`, a.name))) return;
  try {
    await removeRender(a);
  } catch (e) {
    deps.toast(`Couldn't delete ${a.name}: ${errMsg(e)}`, "warn");
    return;
  }
  deps.toast(`Moved ${a.name} to the Recycle Bin.`);
}

export const kindWord = (a: Asset) => (a.kind === "audio" ? "song" : a.kind === "model" ? "3D model" : a.kind);

/** The "goes to the Recycle Bin" question; true when it's answered Delete. */
export async function confirmDelete(title: string, name: string) {
  const dlg = $("#del-confirm") as HTMLDialogElement;
  $("#del-title").textContent = title;
  $("#del-name").textContent = name;
  dlg.returnValue = "";
  dlg.showModal();
  await new Promise((r) => dlg.addEventListener("close", r, { once: true }));
  return dlg.returnValue === "delete";
}

/** Moves a render to the Recycle Bin and takes it out of the gallery and chats (asked first, here or on the phone). */
export async function removeRender(a: Asset) {
  await invoke("delete_render", { root: deps.root(), path: a.path, mtime: a.mtime });
  gone(a.path);
  render();
}

/** Forgets a deleted render: the viewer, the gallery, its star and pick, and chat messages that showed it. */
export function gone(path: string) {
  if (lbAsset?.path === path) closeLightbox();
  dropItem(path);
  selected.delete(path);
  if (starred.delete(path)) saveStarred();
  // Chat messages that showed it say it's gone instead of a broken picture.
  $$<HTMLElement>("figure.chat-render").forEach((f) => f.dataset.path === path && f.classList.add("missing"));
}
