// What chat and Film ask Studio to render (renderMedia, renderShot, …): each goes through Studio's render queue.
import { type Reference, type RefKind, refPrefs, uploadReference } from "./reference";
import { type WorldState } from "./world";
import { type MusicSettings, type Quality, settings, sviSeconds, type VideoSettings } from "./gensettings";
import { invoke } from "@tauri-apps/api/core";
import { ask, swapInto } from "./swap";
import { cancelJob, chained, deps, ensureWorkflows, esc, items, modeOf, MOSS_EDIT, mossEdits, outside, pictureMode, refImageMode, refVideo, renderCreate, rq, run, workflowOf, workflows } from "./studio";
import { type Asset, type GenMode, MODES, plan, type Source, SWAP, type SwapQuality, TALK_LOAD_SECS, TALK_PART_SECS, talkParts, WORLD } from "./modes";
import { settingsForm } from "./settingsform";
import { refresh } from "./cards";
import { openLightbox, toModel } from "./gallery";
import { foleyFor, foleySecs, swapSecs, type VideoInfo } from "./renderactions";
import { showMenu } from "./rendermenu";

// ---------- used from chat ----------
export type MediaKind = "image" | "video" | "audio";
/** The workflow chat uses: the Studio's Image mode pick, LTX text-to-video, or an ACE-Step song. */
export const chatMode = (kind: MediaKind): GenMode => (kind === "audio" ? "song" : kind === "video" ? "video" : pictureMode());

/** The model chat images (or videos) are made with ("Qwen-Image-2.1 → LTX-2.5" for a video from a reference). */
export async function modelLabel(kind: MediaKind, withRef = false) {
  await ensureWorkflows();
  if (!withRef) return modeOf(chatMode(kind)).label;
  const img = modeOf(refImageMode()).label;
  if (kind !== "video") return img;
  return chained("refvideo") ? `${img} → ${modeOf("refvideo").label}` : modeOf("refvideo").label;
}

/** Makes an image (or as many as the settings ask for) or a video and resolves with the saved files. With a
 *  reference, the picture's character or item goes into the scene (for a video, into its first frame). */
export async function renderMedia(
  kind: MediaKind,
  prompt: string,
  progress: (pct: number, label: string) => void,
  r?: Reference,
  kindOverride?: RefKind,
): Promise<Asset[]> {
  await ensureWorkflows();
  if (!r) return run(chatMode(kind), prompt, null, {}, progress, { from: "chat" });
  // The same choices as Studio's reference slot: Auto / Character / Item, and for a video its first frame
  // (a character's face is always a Character).
  const refKind = kindOverride ?? refPrefs().kind;
  const gm = kind === "video" ? "refvideo" : refImageMode();
  for (const need of chained(gm) ? (["refvideo", refImageMode()] as GenMode[]) : [gm])
    if (!workflowOf(need)) throw new Error(`workflows\\${modeOf(need).file} wasn't found`);
  if (chained(gm)) return refVideo(prompt, r, refKind, progress, "chat");
  return run(gm, prompt, r, gm === "refvideo" ? {} : { kind: refKind }, progress, { from: "chat" });
}

/** Chat's /world: renders the world so far (a segment more than last time; ComfyUI reuses the earlier ones while they
 *  are still in its cache) and resolves with the video of all of it. */
export async function renderWorld(w: WorldState, prompt: string, progress: (pct: number, label: string) => void, start?: Reference): Promise<Asset[]> {
  await ensureWorkflows();
  if (!workflows.world) throw new Error(`workflows\\${MODES.world.file} wasn't found (add the Explore a world pack)`);
  if (start && !w.start) w.start = await uploadReference(start);
  const n = w.json.segments.length;
  return run("world", prompt, null, { world: w }, progress, { from: "chat", note: `${n} segment${n > 1 ? "s" : ""}, about ${Math.round((WORLD.secs * n) / 60) || 1} min · `, title: prompt });
}

/** Chat's /edit: changes a picture by instruction (the whole picture, keeping its size), with Qwen-Image-2.1 Edit or
 *  MOSS-Image (Edit with). `more`: up to two more attached pictures, as images 2 and 3. */
export async function editMedia(prompt: string, r: Reference, progress: (pct: number, label: string) => void, more: Reference[] = []): Promise<Asset[]> {
  await ensureWorkflows();
  if (!workflows.edit) throw new Error(`workflows\\${MODES.edit.file} wasn't found`);
  const extra = await Promise.all(more.slice(0, MOSS_EDIT.refs - 1).map((x) => uploadReference(x)));
  return run("edit", prompt, r, { extra }, progress, { from: "chat" });
}

/** The label for chat's edits. */
export const editLabel = () => (mossEdits("edit") ? "MOSS-Image Edit" : MODES.edit.label);

/** Chat's /3d: a textured 3D model of the picture with Pixal3D. Resolves with the saved .glb. */
export async function renderModel(r: Reference, progress: (pct: number, label: string) => void): Promise<Asset[]> {
  return toModel(r, "chat", progress);
}

/** Talking characters: InfiniteTalk lip-syncs the picture (a render's path, or a reference picture) to the voice
 *  recording. `prompt` describes how they move ("smiling, nodding"); `title` is what the render queue shows (the line
 *  they say). Resolves with the saved video. */
export async function renderTalk(
  pic: Reference | string,
  audio: Blob,
  seconds: number,
  prompt: string,
  progress: (pct: number, label: string) => void,
  from = "chat",
  title?: string,
): Promise<Asset[]> {
  await ensureWorkflows();
  if (!workflows.talk) throw new Error(`workflows\\${MODES.talk.file} wasn't found (update the Workstation and add the talk pack)`);
  let src: Source;
  if (typeof pic === "string") {
    await refresh();
    const a = items.find((x) => x.path === pic);
    src = a ?? { path: pic, name: pic.split(/[\\/]/).pop() ?? "picture", kind: "image", mtime: 0, size: 0 };
  } else src = pic;
  const parts = talkParts(seconds);
  const note = parts > 1 ? `${parts} parts, about ${Math.round(talkSecs(seconds) / 60)} min · ` : "";
  return run("talk", prompt || TALK_PROMPT, src, { talk: { audio, seconds } }, progress, { from, note, title });
}

/** What InfiniteTalk is told when nothing else is said about how they move. */
export const TALK_PROMPT = "A person talking to the camera with natural expressions, blinking and slight head movement.";
/** How long a talking video of this much speech takes, in seconds (measured on an RTX 3060 12 GB). */
export const talkSecs = (seconds: number) => TALK_LOAD_SECS + TALK_PART_SECS * talkParts(seconds);

/** Director: one shot of a music video, LTX-2.5 text-to-video at 768×512 for this long; `quality` is the saved Video
 *  quality unless given ("draft" skips the upscale pass). `title` is what the render queue shows. */
export async function renderShot(
  prompt: string,
  seconds: number,
  progress: (pct: number, label: string) => void,
  how: { title?: string; note?: string; quality?: Quality; frame?: string; seed?: number; from?: string } = {},
): Promise<Asset[]> {
  await ensureWorkflows();
  const video: Partial<VideoSettings> = { seconds, res: "768x512", fps: 24, ...(how.quality ? { quality: how.quality } : {}) };
  const from = how.from ?? "Director";
  // A storyboard shot with its frame drawn: LTX-2.5 image-to-video, starting on that frame.
  if (how.frame) {
    if (!workflows.shotvideo) throw new Error(`workflows\\${MODES.shotvideo.file} wasn't found (update the Workstation and add the video pack)`);
    const src: Source = items.find((x) => x.path === how.frame) ?? { path: how.frame, name: how.frame.split(/[\\/]/).pop() ?? "frame", kind: "image", mtime: 0, size: 0 };
    return run("shotvideo", prompt, src, { video, seed: how.seed }, progress, { from, title: how.title, note: how.note });
  }
  if (!workflows.video) throw new Error(`workflows\\${MODES.video.file} wasn't found (update the Workstation and add the video pack)`);
  return run("video", prompt, null, { video, seed: how.seed }, progress, { from, title: how.title, note: how.note });
}

/** How long one LTX-2.5 shot this long takes at 768×512 ("draft" skips the upscale pass), in seconds. */
export const shotSecs = (seconds: number, draft: boolean) => plan("video", null, undefined, undefined, { seconds, res: "768x512", fps: 24, quality: draft ? "draft" : "standard" }).secs;

/** Storyboard: a shot's frame, one picture from the image model at the video's shape (3:2, drawn at 1152×768 so it
 *  stays sharp when LTX-2.5 starts from it). `title` is what the render queue shows. */
export async function renderFrame(prompt: string, progress: (pct: number, label: string) => void, title?: string): Promise<Asset[]> {
  await ensureWorkflows();
  const gm = chatMode("image");
  if (!workflowOf(gm)) throw new Error(`workflows\\${modeOf(gm).file} wasn't found`);
  return run(gm, prompt, null, { override: { w: 1152, h: 768, count: 1 } }, progress, { from: "Storyboard", title });
}

/** The image model storyboard frames are drawn with. */
export async function frameLabel() {
  await ensureWorkflows();
  return modeOf(chatMode("image")).label;
}
/** The saved Video quality ("draft" makes a Director's shots quicker). */
export const videoQuality = () => settings().video.quality;

/** Draws the create bar again (Film mode's list of films changed). */
export const refreshCreate = () => renderCreate();

// ---------- used from Film ----------
/** A file as the gallery knows it (its size, prompt and model), or as a bare file when it isn't a render. */
export async function assetAt(path: string, kind: Asset["kind"]): Promise<Asset> {
  await allowRenders();
  let a = items.find((x) => x.path === path);
  if (!a) {
    await refresh();
    a = items.find((x) => x.path === path);
  }
  return a ?? { path, name: path.split(/[\\/]/).pop() ?? kind, kind, mtime: 0, size: 0 };
}

/** Film: a shot's frame with a cast member in it. Qwen-Image puts the character from their picture into the scene, at
 *  the video's 3:2 shape like a storyboard frame. */
export async function renderCastFrame(prompt: string, r: Reference, progress: (pct: number, label: string) => void, title?: string): Promise<Asset[]> {
  await ensureWorkflows();
  const gm = refImageMode();
  if (!workflowOf(gm)) throw new Error(`workflows\\${modeOf(gm).file} wasn't found`);
  return run(gm, prompt, r, { kind: "character", override: { w: 1152, h: 768, count: 1 } }, progress, { from: "Film", title });
}

/** Whether Film's shot actions have their workflows: a long take (Wan 2.2 SVI), a swap, an upscale and Foley sound. */
export async function filmTools() {
  await ensureWorkflows();
  return { long: !!workflows.long, swap: !!workflows.swap, upscale: !!workflows.upvideo, sound: !!workflows.foley, talk: !!workflows.talk };
}

/** Film: a long take from the shot's frame with Wan 2.2 SVI, in the saved Long video settings (a "|" in the prompt
 *  splits it into its shots). Silent, at 48 fps. Resolves with the video's path. */
export async function renderLongTake(prompt: string, frame: string, progress: (pct: number, label: string) => void, title?: string): Promise<string> {
  await ensureWorkflows();
  if (!workflows.long) throw new Error(`workflows\\${MODES.long.file} wasn't found`);
  const out = await run("long", prompt, await assetAt(frame, "image"), {}, progress, { from: "Film", title });
  const v = out.find((x) => x.kind === "video");
  if (!v) throw new Error("no video came back");
  return v.path;
}

/** How long a long take lasts, and takes to render, with the saved settings. */
export function longTake(frame?: { width?: number | null; height?: number | null }) {
  const s = settings().long;
  return { seconds: sviSeconds(s.frames, s.shots), secs: plan("long", frame ? ({ path: "", name: "", kind: "image", mtime: 0, size: 0, ...frame } as Asset) : null).secs };
}

/** Film: SCAIL-2 swaps a cast member (their picture) in for `who` in a clip (one of the film's takes, or a video of
 *  your own). Resolves with the new video's path. */
export async function swapClip(path: string, picture: Blob, who: string, q: SwapQuality, progress: (pct: number, label: string) => void): Promise<string> {
  await ensureWorkflows();
  if (!workflows.swap) throw new Error(`workflows\\${MODES.swap.file} wasn't found (add the Swap a character pack)`);
  const info = await invoke<VideoInfo>("video_info", { path });
  return swapInto(await assetAt(path, "video"), info, picture, who || "person", q, progress, "Film");
}

/** How long a swap of a clip this long takes, in seconds. */
export const swapClipSecs = (seconds: number, q: SwapQuality) => swapSecs(Math.ceil(Math.min(seconds, SWAP.maxSeconds) * 24) + 1, q);

/** Film: SeedVR2 sharpens a take to 1080p (its sound kept). Resolves with the new video's path. */
export async function upscaleClip(path: string, progress: (pct: number, label: string) => void): Promise<string> {
  await ensureWorkflows();
  if (!workflows.upvideo) throw new Error(`workflows\\${MODES.upvideo.file} wasn't found (add the Upscale pack)`);
  const a = await assetAt(path, "video");
  const out = await run("upvideo", a.prompt || a.name, a, { upscale: 1080 }, progress, { from: "Film", title: `${a.name} to 1080p` });
  const v = out.find((x) => x.kind === "video");
  if (!v) throw new Error("no video came back");
  return v.path;
}

/** How long an upscale to 1080p takes for a clip this long, in seconds. */
export const upscaleClipSecs = (seconds: number) => MODES.upvideo.secs * Math.max(1, seconds);

/** Film: LTX-2.3 Foley makes a take's sound effects from what's said should be heard (its first 15 s), on a copy of
 *  the take. Resolves with the new video's path. */
export async function soundClip(path: string, seconds: number, what: string, progress: (pct: number, label: string) => void): Promise<string> {
  await ensureWorkflows();
  if (!workflows.foley) throw new Error(`workflows\\${MODES.foley.file} wasn't found (add the Add sound pack)`);
  return foleyFor(await assetAt(path, "video"), seconds, what, progress, "Film");
}

export const soundClipSecs = (seconds: number) => foleySecs(seconds);

/** Stops every render a film has waiting or running. */
export function cancelFilm() {
  for (const j of [...rq].reverse()) if (j.from === "Film" && (j.state === "waiting" || j.state === "running")) cancelJob(j);
}

export { ask as askLine };

/** Chat's /song: a song in this style with these lyrics (empty: an instrumental). `song` sets its tempo, key or
 *  language for this one song; its length is the saved setting. Resolves with the saved file. */
export async function renderSong(
  style: string,
  lyrics: string,
  progress: (pct: number, label: string) => void,
  song: Partial<MusicSettings> = {},
): Promise<Asset[]> {
  await ensureWorkflows();
  if (!workflows.song) throw new Error(`workflows\\${MODES.song.file} wasn't found (update the Workstation and add the music pack)`);
  return run("song", style, null, { lyrics, song }, progress, { from: "chat" });
}

/** A song's length in the settings (chat's songwriter writes about that much). */
export const songSeconds = () => settings().music.seconds;

/** The generation settings form for chat's popover (the same settings as Studio's). */
export async function chatSettings(el: HTMLElement, kind: MediaKind) {
  await ensureWorkflows();
  const gm = chatMode(kind);
  if (!workflowOf(gm)) {
    el.innerHTML = `<p class="credit">workflows\\${esc(modeOf(gm).file)} wasn't found, so chat can't make ${kind === "video" ? "videos" : kind === "audio" ? "songs" : "images"} yet.</p>`;
    return;
  }
  settingsForm(el, gm, true);
}

/** Stops chat's render: takes it out of the queue if it's still waiting, or stops it if it's running. */
/** Stops chat's latest render (or the latest one from `from`, e.g. a Director's shot). */
export async function cancelRender(from = "chat") {
  const mine = [...rq].reverse().find((j) => j.from === from && (j.state === "waiting" || j.state === "running"));
  if (mine) cancelJob(mine);
}

export let allowed: Promise<void> | null = null;
/** Lets the webview show files from ComfyUI's output folder (needed before showing a saved render in chat). */
export function allowRenders() {
  return (allowed ??= refresh());
}

/** Whether a file is one of Prestige's own renders, not one made from a photo brought in (after allowRenders). */
export const isRender = (path: string) => !outside.has(path) && items.some((x) => x.path === path);

/** Opens a render in the lightbox (Animate, Reuse prompt and Open in folder work from there). */
export async function openRender(path: string) {
  await allowRenders();
  let a = items.find((x) => x.path === path);
  if (!a) {
    await refresh();
    a = items.find((x) => x.path === path);
  }
  if (a) openLightbox(a);
  else deps.toast("That image isn't in ComfyUI's output folder any more.", "warn");
}

/** The right-click menu for a render shown in chat. */
export async function renderMenu(e: MouseEvent, path: string) {
  e.preventDefault();
  await allowRenders();
  let a = items.find((x) => x.path === path);
  if (!a) {
    await refresh();
    a = items.find((x) => x.path === path);
  }
  if (a) showMenu(e, a);
  else deps.toast("That file isn't in ComfyUI's output folder any more.", "warn");
}
