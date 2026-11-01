import { openInpaint, type SelectQuery } from "./inpaint";
import { segment } from "./clickselect";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openRender } from "./renderapi";
import { errMsg } from "./backends";
import { type MenuItem } from "./rendermenu";
import { ask, videoSeconds } from "./swap";
import { aboutTime, settings, update } from "./gensettings";
import { askSongEdit, editSecs, type EditTask, INSTRUMENTAL_PARTS, type SongEdit, type SongSource, stemSecs } from "./songedit";
import { openLaser } from "./laser";
import { imageIn } from "./reference";
import { $, deps, INSTRUMENTAL, isInstrumental, REDRAW_MP, renderCreate, run, setMode, workflows } from "./studio";
import { ACE_MODELS, anglePrompt, ANGLES, type Asset, ELEVATIONS, FOLEY_LOAD_SECS, FOLEY_MAX_SECONDS, FOLEY_WINDOW, FOLEY_WINDOW_SECS, MODES, MP, outfitPrompt, plan, type RestoreKind, restorePrompt, SWAP, SWAP_STEPS, type SwapQuality, type UpscaleSize, XL_FIXED_SECS, XL_SECS_PER_SECOND } from "./modes";
import { refresh } from "./cards";
import { closeLightbox } from "./gallery";

// ---------- actions on a render (lightbox buttons and the right-click menu) ----------
/** Edit (Image mode) or animate (Video mode) this image: the create bar takes it as the source. */
export function startFrom(a: Asset, m: "image" | "video") {
  deps.show();
  setMode(m, a);
  ($("#gen-prompt") as HTMLInputElement).value = "";
  closeLightbox();
  renderCreate();
  $("#gen-prompt").focus();
}

/** Paint to change: paint the area on the picture (inpaint.ts) and say what goes there; only that part is redrawn.
 *  With nothing painted it's an instruction edit of the whole picture. The result opens when it's done. */
export function paintToChange(a: Asset, selecting = false) {
  closeLightbox();
  const select = workflows.select ? (q: SelectQuery) => segment(a, q) : undefined;
  const cutout = workflows.cutout ? (mask: Blob, w: number, h: number) => cutOut(a, mask, w, h) : undefined;
  openInpaint(convertFileSrc(a.path), a.name, async (r) => {
    deps.show();
    try {
      let out: Asset[];
      if (r.mask) {
        const bytes = new Uint8Array(await r.mask.arrayBuffer());
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
        const hex = Array.from(hash.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
        const name = await invoke<string>("comfy_upload_bytes", bytes, { headers: { "x-name": `prestige-mask-${hex}.png` } });
        out = await run("inpaint", r.prompt, a, { mask: { name, w: r.width, h: r.height } }, undefined, { from: "Paint to change" });
      } else out = await run("edit", r.prompt, a, {}, undefined, { from: "Paint to change" });
      deps.toast(r.mask ? "Changed the painted area." : "Edited the picture.");
      if (out[0]) openRender(out[0].path);
    } catch (e) {
      if (errMsg(e) !== "stopped") deps.toast(`Couldn't change it: ${errMsg(e)}`, "warn");
    }
  }, { select, cutout, selecting });
}

/** The Upscale menu items a render gets: 1080p and 4K for a picture smaller than that, 1080p for a video. */
export function upscaleItems(a: Asset): MenuItem[] {
  const short = a.width && a.height ? Math.min(a.width, a.height) : 0;
  const out: MenuItem[] = [];
  if (a.kind === "image" && workflows.upimage) {
    if (short < 1080) out.push({ label: "Upscale to 1080p", run: () => upscale(a, 1080), key: "SeedVR2" });
    if (short < 2160) out.push({ label: "Upscale to 4K", run: () => upscale(a, 2160), key: "SeedVR2" });
  }
  // Redraw: Qwen-Image redraws the picture in tiles at 4 or 8 MP (new detail, where SeedVR2 sharpens what's there).
  const mp = a.width && a.height ? (a.width * a.height) / MP : 0;
  if (a.kind === "image" && workflows.redraw4 && mp) {
    if (mp < 3.5) out.push({ label: "Redraw at 4 MP", run: () => redraw(a, "redraw4"), key: "Qwen-Image" });
    if (mp < 7) out.push({ label: "Redraw at 8 MP", run: () => redraw(a, "redraw8"), key: "Qwen-Image" });
  }
  if (a.kind === "video" && workflows.upvideo && short < 1080) out.push({ label: "Upscale to 1080p", run: () => upscale(a, 1080), key: "SeedVR2" });
  return out;
}

/** Upscale and enhance: SeedVR2 redraws the picture (or every frame of the video) at 1080p or 4K. The result goes into
 *  the gallery next to the original and opens when it's done. */
export async function upscale(a: Asset, size: UpscaleSize) {
  closeLightbox();
  const video = a.kind === "video";
  const name = size === 1080 ? "1080p" : "4K";
  const secs = video ? MODES.upvideo.secs * Math.max(1, await videoSeconds(a.path)) : MODES.upimage.secs;
  deps.toast(`Upscaling to ${name}: ${aboutTime(secs)}. It opens when it's done.`);
  try {
    const out = await run(video ? "upvideo" : "upimage", `${a.prompt || a.name}`, a, { upscale: size }, undefined, {
      from: "Upscale",
      title: `${a.name} to ${name}`,
    });
    if (out[0]) openRender(out[0].path);
  } catch (e) {
    if (errMsg(e) !== "stopped") deps.toast(`Couldn't upscale it: ${errMsg(e)}`, "warn");
  }
}

/** Redraw upscale: Qwen-Image redraws the picture a tile at a time at 4 or 8 MP. It goes into the gallery next to the
 *  original and opens when it's done. */
export async function redraw(a: Asset, gm: "redraw4" | "redraw8") {
  closeLightbox();
  const p = plan(gm, a);
  deps.toast(`Redrawing at ${REDRAW_MP[gm]} MP: ${aboutTime(p.secs)}. It opens when it's done.`);
  try {
    const out = await run(gm, a.prompt || a.name, a, {}, undefined, { from: "Upscale", title: `${a.name} redrawn at ${REDRAW_MP[gm]} MP` });
    if (out[0]) openRender(out[0].path);
  } catch (e) {
    if (errMsg(e) !== "stopped") deps.toast(`Couldn't redraw it: ${errMsg(e)}`, "warn");
  }
}

/** The song editor's items for a song: redo a part, extend it, or cover it in a new style. */
export function songEditItems(a: Asset): MenuItem[] {
  if (a.kind !== "audio" || !workflows.songedit) return [];
  return [
    { label: "Redo a part…", run: () => editSong(a, "repaint"), key: "new words or a new take" },
    { label: "Extend…", run: () => editSong(a, "extend"), key: "up to 4 min more" },
    { label: "Cover in a new style…", run: () => editSong(a, "cover") },
    { label: "Stems…", run: () => editSong(a, "stems"), key: "vocals, instrumental, drums…" },
  ];
}

/** Opens the song editor on a gallery song or one from the PC, then renders the edit in the queue. The new song goes
 *  into the gallery next to the original and opens when it's done. */
export async function editSong(a: Asset | File, task: EditTask) {
  closeLightbox();
  if (!workflows.songedit) return deps.toast(`Editing songs needs workflows\\${MODES.songedit.file} (update the Workstation).`, "warn");
  const file = a instanceof File ? a : null;
  const asset = file ? null : (a as Asset);
  const src: SongSource = file
    ? { name: file.name, url: URL.createObjectURL(file), blob: file, style: "", lyrics: "" }
    : {
        name: asset!.name,
        url: convertFileSrc(asset!.path),
        path: asset!.path,
        style: asset!.prompt ?? "",
        lyrics: isInstrumental(asset!.lyrics) ? "" : (asset!.lyrics ?? ""),
        music: asset!.music,
      };
  try {
    const e = await askSongEdit(src, task, deps.toast);
    if (!e) return;
    e.quality = settings().music.quality;
    const what = { repaint: "Redoing the part", extend: "Extending the song", cover: "Making the cover", stems: "Taking out the stems" }[e.task];
    const secs = e.task === "stems" ? stemSecs(e.source, e.stems) : e.quality === "high" ? XL_FIXED_SECS + XL_SECS_PER_SECOND * e.seconds : editSecs(e.seconds);
    deps.toast(`${what}: about ${aboutTime(secs)}. ${e.task === "stems" ? "The first opens" : "It opens"} when it's done.`);
    const title = `${{ repaint: "Redo", extend: "Extend", cover: "Cover of", stems: "Stems of" }[e.task]} ${src.name}`;
    const out = await run("songedit", e.style, asset, { edit: e, audio: file ?? undefined }, undefined, { from: "Song editor", title });
    if (out[0]) openRender(out[0].path);
  } catch (err) {
    if (errMsg(err) !== "stopped") deps.toast(`Couldn't edit the song: ${errMsg(err)}`, "warn");
  } finally {
    if (file) URL.revokeObjectURL(src.url);
  }
}

/** The song editor's job in the edit workflow: what's done where, and the music settings the new song keeps. */
export function songEditGraph(g: any, e: SongEdit) {
  if (e.task === "stems") return stemsGraph(g, e);
  if (e.quality === "high") g["1"].inputs.unet_name = ACE_MODELS.high;
  const lyrics = isInstrumental(e.lyrics) ? INSTRUMENTAL : e.lyrics;
  Object.assign(g["4"].inputs, {
    task: e.task,
    lyrics,
    bpm: e.bpm,
    duration: e.seconds,
    timesignature: e.meter,
    language: e.language,
    keyscale: e.key,
  });
  Object.assign(g["22"].inputs, {
    task: e.task,
    start: e.start,
    end: e.end,
    extend_before: 0,
    extend_after: e.task === "extend" ? e.add : 0,
    // Carrying on from the very end keeps it all (0); from earlier leaves out what comes after.
    keep_until: e.task === "extend" && e.keepUntil < e.source - 0.05 ? e.keepUntil : 0,
    strength: e.strength,
    // An extension has nothing of its own to blend into; a redone part blends over 0.4 s.
    crossfade: e.task === "extend" ? 0 : 0.4,
    // The gallery shows the whole song's words: an extension's are the original's then the new part's.
    song_lyrics: e.task === "extend" ? [e.sourceLyrics, e.lyrics].filter((x) => x.trim()).join("\n\n") || lyrics : lyrics,
  });
  g["10"].inputs.filename_prefix = `ace-step-${e.task === "repaint" ? "redo" : e.task}`;
}

/** Stems: ACE-Step's base model listens to the whole song and makes one part of it at a time ("extract"), 32 steps
 *  with guidance, each saved as its own MP3. It's told the song's style, and the vocals its words: with them a vocal
 *  stem came out with the right words and half the drum bleed (percussive/tonal 0.37 against 0.72 without). The instrumental is the drums, bass, guitar, keys and synth mixed.
 *  (Measured on a 60 s song: the vocal stem had the words and 38% silence between lines, the bass 59% of its
 *  energy under 150 Hz, the drums twice as much percussive as tonal energy, and the instrumental mix no words and
 *  the original's chords: chroma similarity 0.94.) */
export function stemsGraph(g: any, e: SongEdit) {
  const enc = g["4"], edit = g["22"], ks = g["7"], dec = g["9"], save = g["10"];
  for (const id of ["4", "5", "22", "7", "9", "10"]) delete g[id];
  g["1"].inputs.unet_name = ACE_MODELS.stems;
  const seed = ks.inputs.seed;
  const part = (track: string, i: number) => {
    const n = `s${i}`;
    g[`${n}e`] = { class_type: enc.class_type, inputs: { ...enc.inputs, task: "extract", track, tags: e.style, lyrics: /vocals/.test(track) ? e.sourceLyrics : "", bpm: e.bpm, keyscale: e.key, timesignature: e.meter, language: e.language, duration: e.source } };
    g[`${n}z`] = { class_type: "ConditioningZeroOut", inputs: { conditioning: [`${n}e`, 0] } };
    g[`${n}m`] = { class_type: edit.class_type, inputs: { ...edit.inputs, task: "extract", song_lyrics: track === "vocals" ? e.sourceLyrics : "" } };
    g[`${n}k`] = { class_type: ks.class_type, inputs: { ...ks.inputs, model: [`${n}m`, 0], positive: [`${n}e`, 0], negative: [`${n}z`, 0], latent_image: [`${n}m`, 1], seed: seed + i, steps: 32, cfg: 7 } };
    g[`${n}d`] = { class_type: dec.class_type, inputs: { ...dec.inputs, samples: [`${n}k`, 0] } };
    return `${n}d`;
  };
  let i = 0;
  for (const stem of e.stems) {
    let out: string;
    if (stem === "instrumental") {
      const parts = INSTRUMENTAL_PARTS.map((t) => part(t, i++));
      out = parts[0];
      parts.slice(1).forEach((p, k) => {
        g[`mix${k}`] = { class_type: "AudioMerge", inputs: { audio1: [out, 0], audio2: [p, 0], merge_method: "add" } };
        out = `mix${k}`;
      });
      // Five parts added together peaked at 0.95 of full scale; 2 dB down leaves room so the MP3 doesn't clip.
      g["mixv"] = { class_type: "AudioAdjustVolume", inputs: { audio: [out, 0], volume: -2 } };
      out = "mixv";
    } else out = part(stem, i++);
    g[`save-${stem}`] = { class_type: save.class_type, inputs: { ...save.inputs, audio: [out, 0], filename_prefix: `stem-${stem.replace("_", "-")}` } };
  }
}

/** Laser: a PNG to engrave or an SVG to cut from this picture (laser.ts). */
export function laser(a: Asset) {
  closeLightbox();
  openLaser(a.path, a.name, a.prompt ?? "");
}

/** Puts a mask in ComfyUI's input folder (named from its content). */
export async function uploadMask(mask: Blob): Promise<string> {
  const bytes = new Uint8Array(await mask.arrayBuffer());
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  const hex = Array.from(hash.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
  return invoke<string>("comfy_upload_bytes", bytes, { headers: { "x-name": `prestige-mask-${hex}.png` } });
}

/** Cut out: the selection on a transparent background, saved as a new PNG next to the picture in the gallery. */
export async function cutOut(a: Asset, mask: Blob, w: number, h: number) {
  deps.show();
  try {
    const name = await uploadMask(mask);
    const out = await run("cutout", `Cut-out from ${a.name}`, a, { mask: { name, w, h } }, undefined, { from: "Cut out" });
    deps.toast("Cut out on a transparent background.");
    if (out[0]) openRender(out[0].path);
  } catch (e) {
    if (errMsg(e) !== "stopped") deps.toast(`Couldn't cut it out: ${errMsg(e)}`, "warn");
  }
}

/** Remove background: BiRefNet finds the subject, and it's saved on a transparent background as a new PNG. */
export async function removeBackground(a: Asset) {
  closeLightbox();
  deps.toast("Removing the background…");
  try {
    const out = await run("cutout", `${a.name} without its background`, a, {}, undefined, { from: "Remove background" });
    if (out[0]) openRender(out[0].path);
  } catch (e) {
    if (errMsg(e) !== "stopped") deps.toast(`Couldn't remove the background: ${errMsg(e)}`, "warn");
  }
}

/** New camera angle: asks where the camera goes (one of the LoRA's 12 azimuths and 4 heights, or a close-up), then
 *  Qwen-Image-2.1 reshoots the picture from there. Every view picked is its own render. */
export async function newAngle(a: Asset) {
  closeLightbox();
  const dlg = $("#reshoot") as HTMLDialogElement;
  const az = $("#rs-az") as HTMLSelectElement;
  const el = $("#rs-el") as HTMLSelectElement;
  const close = $("#rs-close") as HTMLInputElement;
  const turn = $("#rs-turn") as HTMLInputElement;
  ($("#rs-pic") as HTMLImageElement).src = convertFileSrc(a.path);
  if (!az.options.length) {
    az.innerHTML = ANGLES.map(([, label], i) => `<option value="${i}">${label} · ${i * 30}°</option>`).join("");
    el.innerHTML = ELEVATIONS.map(([, label], i) => `<option value="${i}">${label}</option>`).join("");
    // The right side: on portraits, side, back and high views turn the camera the furthest (a three-quarter view
    // often stays close to the original).
    az.value = "3";
  }
  const est = () => {
    const n = turn.checked ? 4 : 1;
    az.disabled = turn.checked;
    $("#rs-est").textContent = `${n > 1 ? "4 renders (front, right, back, left)" : "1 render"}, ${aboutTime(plan("angle", a).secs * n)}.`;
  };
  turn.onchange = est;
  est();
  dlg.returnValue = "";
  dlg.showModal();
  await new Promise((r) => dlg.addEventListener("close", r, { once: true }));
  if (dlg.returnValue !== "go") return;
  const views = turn.checked ? [0, 3, 6, 9] : [Number(az.value)];
  deps.toast(views.length > 1 ? "Reshooting from 4 sides. The first opens when it's done." : "Reshooting from the new angle. It opens when it's done.");
  try {
    const outs = views.map((v) =>
      run("angle", anglePrompt(v, Number(el.value), close.checked), a, {}, undefined, { from: "New camera angle", title: `${a.name} · ${ANGLES[v][1].toLowerCase()}` }),
    );
    const [first] = await outs[0];
    if (first) openRender(first.path);
    await Promise.all(outs);
  } catch (e) {
    if (errMsg(e) !== "stopped") deps.toast(`Couldn't reshoot it: ${errMsg(e)}`, "warn");
  }
}

/** Try on outfit: the person in this picture, dressed in the outfit from another picture (a photo of someone wearing
 *  it, a flat lay or a product shot). Everything but the clothes stays where it was. */
export async function tryOnOutfit(a: Asset) {
  closeLightbox();
  const dlg = $("#outfit") as HTMLDialogElement;
  const file = $("#of-file") as HTMLInputElement;
  const pic = $("#of-outfit") as HTMLImageElement;
  const what = $("#of-what") as HTMLInputElement;
  const go = $("#of-go") as HTMLButtonElement;
  ($("#of-pic") as HTMLImageElement).src = convertFileSrc(a.path);
  let outfit: File | null = null;
  let url = "";
  const show = () => {
    if (url) URL.revokeObjectURL(url);
    url = outfit ? URL.createObjectURL(outfit) : "";
    pic.hidden = !outfit;
    pic.src = url;
    $("#of-name").textContent = outfit ? outfit.name : "";
    go.disabled = !outfit;
  };
  file.value = "";
  file.onchange = () => {
    outfit = file.files?.[0] ?? null;
    show();
  };
  $("#of-pick").onclick = () => file.click();
  // An outfit picture dropped on the dialog from Explorer or a browser works too.
  dlg.ondragover = (e) => e.preventDefault();
  dlg.ondrop = (e) => {
    e.preventDefault();
    const f = imageIn(e.dataTransfer);
    if (f) {
      outfit = f;
      show();
    }
  };
  what.value = "";
  ($("#of-shoes") as HTMLInputElement).checked = false;
  $("#of-est").textContent = `Takes ${aboutTime(plan("outfit", a).secs)}.`;
  show();
  dlg.returnValue = "";
  dlg.showModal();
  await new Promise((r) => dlg.addEventListener("close", r, { once: true }));
  if (url) URL.revokeObjectURL(url);
  // (Set by the handlers above, which TypeScript doesn't follow.)
  const picked = outfit as File | null;
  if (dlg.returnValue !== "go" || !picked) return;
  deps.toast("Trying on the outfit. It opens when it's done.");
  try {
    const name = await uploadImage(picked, "outfit");
    const prompt = outfitPrompt(what.value, ($("#of-shoes") as HTMLInputElement).checked);
    const out = await run("outfit", prompt, a, { outfit: name }, undefined, { from: "Try on outfit", title: `${a.name} in ${what.value.trim() || picked.name}` });
    if (out[0]) openRender(out[0].path);
  } catch (e) {
    if (errMsg(e) !== "stopped") deps.toast(`Couldn't try it on: ${errMsg(e)}`, "warn");
  }
}

/** Restore photo: a small, compressed, blurry or worn picture redrawn at about 2 MP with the Restore LoRA, keeping the
 *  people and the framing. One pass is enough (a second came back crunchy, its author found). */
export async function restorePhoto(a: Asset) {
  closeLightbox();
  const dlg = $("#restore") as HTMLDialogElement;
  const kind = $("#rp-kind") as HTMLSelectElement;
  const fast = $("#rp-fast") as HTMLInputElement;
  ($("#rp-pic") as HTMLImageElement).src = convertFileSrc(a.path);
  fast.checked = settings().image.edits !== "quality";
  const est = () => ($("#rp-est").textContent = `Comes out at about 2 megapixels. Takes ${aboutTime(plan("restore", a).secs)}.`);
  fast.onchange = () => {
    update("image", { edits: fast.checked ? "fast" : "quality" });
    est();
  };
  est();
  dlg.returnValue = "";
  dlg.showModal();
  await new Promise((r) => dlg.addEventListener("close", r, { once: true }));
  if (dlg.returnValue !== "go") return;
  const k = kind.value as RestoreKind;
  deps.toast("Restoring the photo. It opens when it's done.");
  try {
    const out = await run("restore", restorePrompt(k), a, { restore: k }, undefined, { from: "Restore photo", title: `${a.name}, restored` });
    if (out[0]) openRender(out[0].path);
  } catch (e) {
    if (errMsg(e) !== "stopped") deps.toast(`Couldn't restore it: ${errMsg(e)}`, "warn");
  }
}

/** Make it manga: the picture as a black-and-white manga panel with screentone, as a new render. */
export async function makeManga(a: Asset) {
  closeLightbox();
  deps.toast(`Making it manga (${aboutTime(plan("manga", a).secs)}). It opens when it's done.`);
  try {
    const out = await run("manga", "Make it manga", a, {}, undefined, { from: "Make it manga", title: `${a.name} as manga` });
    if (out[0]) openRender(out[0].path);
  } catch (e) {
    if (errMsg(e) !== "stopped") deps.toast(`Couldn't make it manga: ${errMsg(e)}`, "warn");
  }
}

/** Puts a picture in ComfyUI's input folder (named from its content, so a retry reuses it). */
export async function uploadImage(img: Blob, prefix: string): Promise<string> {
  const bytes = new Uint8Array(await img.arrayBuffer());
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  const hex = Array.from(hash.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
  const ext = img.type.includes("jpeg") ? "jpg" : img.type.includes("webp") ? "webp" : "png";
  return invoke<string>("comfy_upload_bytes", bytes, { headers: { "x-name": `prestige-${prefix}-${hex}.${ext}` } });
}

/** Cut out a subject from a video: SAM 3.1 tracks what's named through every frame, and the rest turns green (with
 *  the sound kept), ready to key out in a video editor. */
export async function videoCutout(a: Asset) {
  closeLightbox();
  const what = await ask("Cut out a subject", "What should stay? The rest of the video turns green, so it can be keyed out in any video editor.", "e.g. the woman, the dog, the red car");
  if (!what) return;
  const secs = MODES.vidcut.secs * Math.max(2, await videoSeconds(a.path));
  deps.toast(`Tracking ${what}: ${aboutTime(secs)}. It opens when it's done.`);
  try {
    const out = await run("vidcut", what, a, {}, undefined, { from: "Cut out", title: `${what}, cut out of ${a.name}` });
    if (out[0]) openRender(out[0].path);
  } catch (e) {
    if (errMsg(e) !== "stopped") deps.toast(`Couldn't cut it out: ${errMsg(e)}`, "warn");
  }
}

/** What Cut out a person makes: a transparent WebM, the PNG frames, a green-screen MP4, or an MP4 on a new background. */
export type PersonOut = "webm" | "png" | "green" | "background";

/** Cut out a person: click them on the first frame (SAM 3.1), pick what to make, and MatAnyone2 mattes them through
 *  the whole video, hair and all. The result opens when it's done (the PNG frames' folder is shown in Explorer). */
export async function personCutout(a: Asset) {
  closeLightbox();
  let frame: string;
  try {
    frame = await invoke<string>("video_first_frame", { root: deps.root(), video: a.path });
  } catch (e) {
    return deps.toast(`Couldn't read the video: ${errMsg(e)}`, "warn");
  }
  const still = { ...a, path: frame, kind: "image" as const };
  const picked = await new Promise<{ mask: Blob; w: number; h: number } | null>((res) => {
    let done = false;
    openInpaint(
      convertFileSrc(frame),
      a.name,
      () => {},
      {
        select: (q) => segment(still, q),
        cutout: (mask, w, h) => {
          done = true;
          res({ mask, w, h });
        },
        selecting: true,
        pick: { title: "Click the person to cut out", button: "Cut out this person" },
      },
    );
    // Closing the overlay without picking anyone cancels.
    const overlay = $("#inpaint");
    const watch = new MutationObserver(() => {
      if (overlay.hidden && !done) {
        watch.disconnect();
        res(null);
      } else if (done) watch.disconnect();
    });
    watch.observe(overlay, { attributes: true, attributeFilter: ["hidden"] });
  });
  if (!picked) return;
  const dlg = $("#person") as HTMLDialogElement;
  const bgBtn = $("#pc-bg") as HTMLButtonElement;
  let background: string | null = null;
  const sync = () => {
    const out = (dlg.querySelector("input[name=pc-out]:checked") as HTMLInputElement).value as PersonOut;
    bgBtn.hidden = out !== "background";
    $("#pc-bg-name").textContent = out === "background" ? (background ? background.split(/[\\/]/).pop()! : "none picked yet") : "";
    ($("#pc-go") as HTMLButtonElement).disabled = out === "background" && !background;
  };
  dlg.querySelectorAll("input[name=pc-out]").forEach((r) => ((r as HTMLInputElement).onchange = sync));
  bgBtn.onclick = async () => {
    background = (await invoke<string | null>("pick_background").catch(() => null)) ?? background;
    sync();
  };
  const seconds = await videoSeconds(a.path);
  $("#pc-est").textContent = `Takes ${aboutTime(MODES.person.secs * Math.max(2, seconds) + 15)} on an RTX 3060.`;
  sync();
  dlg.returnValue = "";
  dlg.showModal();
  await new Promise((r) => dlg.addEventListener("close", r, { once: true }));
  if (dlg.returnValue !== "go") return;
  const out = (dlg.querySelector("input[name=pc-out]:checked") as HTMLInputElement).value as PersonOut;
  deps.toast("Cutting the person out. It opens when it's done.");
  try {
    const name = await uploadImage(picked.mask, "person-mask");
    const stem = a.name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-").slice(0, 40);
    const frames = `${stem}-person-${Date.now().toString(36)}.frames`;
    const res = await run("person", "Cut out a person", a, { mask: { name, w: picked.w, h: picked.h }, frames }, undefined, { from: "Cut out a person", title: `A person cut out of ${a.name}` });
    const matte = res.find((x) => x.kind === "video");
    if (!matte) throw new Error("no matte came back");
    const dir = `${matte.path.replace(/[\\/][^\\/]+$/, "")}\\${frames}`;
    const made = await invoke<string>("person_video", { root: deps.root(), frames: dir, source: a.path, out, background });
    await refresh();
    if (out === "png") await invoke("reveal", { path: `${made}\\frame_00001_.png` });
    else openRender(made);
  } catch (e) {
    if (errMsg(e) !== "stopped") deps.toast(`Couldn't cut them out: ${errMsg(e)}`, "warn");
  }
}

/** Add sound: LTX-2.3 with Lightricks' Foley LoRA watches the video and makes its sound effects (no speech, no
 *  music), then the sound goes onto the original video, saved as a new file next to it. Any sound it had is replaced. */
export async function addSound(a: Asset) {
  closeLightbox();
  const secs = await videoSeconds(a.path);
  const what = await ask(
    "Add sound",
    `Say what should be heard, tied to what happens in the video: the sources and how they sound. Any sound it has now is replaced.${secs > FOLEY_MAX_SECONDS ? ` Only the first ${FOLEY_MAX_SECONDS} s get sound.` : ""}`,
    "e.g. footsteps on gravel, a dog barking twice, wind in the trees",
  );
  if (!what) return;
  deps.toast(`Making the sound: about ${aboutTime(foleySecs(secs))} on an RTX 3060. It opens when it's done.`);
  try {
    openRender(await foleyFor(a, secs, what));
  } catch (e) {
    if (errMsg(e) !== "stopped") deps.toast(`Couldn't add sound: ${errMsg(e)}`, "warn");
  }
}

/** How long Add sound takes for a video this long, in seconds (on the RTX 3060). */
export const foleySecs = (secs: number) => FOLEY_LOAD_SECS + Math.ceil(Math.max(9, Math.floor(Math.min(secs, FOLEY_MAX_SECONDS) * 24)) / FOLEY_WINDOW) * FOLEY_WINDOW_SECS;

/** The sound itself: LTX-2.3 Foley makes it for the video's first 15 s, and it goes onto the original as a new file.
 *  Resolves with that file's path. */
export async function foleyFor(a: Asset, secs: number, what: string, progress?: (pct: number, label: string) => void, from = "Add sound") {
  const frames = Math.max(9, Math.floor(Math.min(secs, FOLEY_MAX_SECONDS) * 24));
  // LTX hears the frames at about 832×480 (what the LoRA was made at), the video's shape kept, in multiples of 32.
  const ratio = a.width && a.height ? a.width / a.height : 16 / 9;
  const area = 832 * 480;
  const w = Math.max(256, Math.round(Math.sqrt(area * ratio) / 32) * 32);
  const h = Math.max(256, Math.round(Math.sqrt(area / ratio) / 32) * 32);
  const out = await run("foley", what, a, { foley: { frames, w, h } }, progress, { from, title: `Sound for ${a.name}: ${what}` });
  const track = out.find((x) => x.kind === "audio");
  if (!track) throw new Error("no sound came back");
  const video = await invoke<string>("mux_foley", { root: deps.root(), video: a.path, audio: track.path });
  await refresh();
  return video;
}

/** What ffprobe reads of a video (video_info). */
export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  frames: number;
  seconds: number;
  audio: boolean;
}

/** A swap's time on the RTX 3060: loading, then each segment's sampling and the rest, a short last one by its frames. */
export function swapSecs(frames: number, q: SwapQuality) {
  let t = SWAP.loadSecs;
  for (let start = 0; start === 0 || start + SWAP.overlap < frames; start += SWAP.step) {
    const k = Math.min(SWAP.part, frames - start) / SWAP.part;
    t += SWAP.partSecs * k + SWAP.stepSecs * SWAP_STEPS[q] * k ** 1.8;
  }
  return t;
}
