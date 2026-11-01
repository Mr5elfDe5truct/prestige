import { type SongMusic } from "./songedit";
import { imageDims, ltxFrames, type MusicSettings, parseRes, type Quality, QUALITY_NAMES, settings, type SettingsKey, SVI_FPS, sviSeconds, type VideoSettings, wanAuto, wanFrames } from "./gensettings";
import { type Reference } from "./reference";
import { cardsText, comfyCards, heldOn, othersText, readHolders, shortName, vramGB } from "./gpus";
import { modeOf, MOSS_EDIT, mossEdits, REDRAW, REDRAW_MP, redrawMp, renderCreate, srcAsset, wanFromPicture } from "./studio";

export interface Asset {
  path: string;
  name: string;
  kind: "image" | "video" | "audio" | "model"; // model: a .glb from Picture to 3D
  mtime: number;
  size: number;
  prompt?: string | null; // for a song, its style
  model?: string | null;
  width?: number | null;
  height?: number | null;
  seed?: number | null;
  lyrics?: string | null; // a song's
  duration?: number | null; // a song's length in seconds
  music?: SongMusic | null; // a song's tempo, key, meter and language
}

export type GenMode =
  | "image"
  | "fast"
  | "edit"
  | "inpaint"
  | "video"
  | "animate"
  | "long"
  | "ref"
  | "reffast"
  | "refvideo"
  | "shotvideo"
  | "song"
  | "songedit"
  | "model3d"
  | "talk"
  | "select"
  | "cutout"
  | "vidcut"
  | "upimage"
  | "upvideo"
  | "angle"
  | "outfit"
  | "restore"
  | "manga"
  | "redraw4"
  | "redraw8"
  | "moss"
  | "person"
  | "foley"
  | "swap"
  | "world";

// How a workflow takes the generation settings: an image model with a latent size and batch, an edit
// (size follows the picture), LTX with a 2× upscale pass ("ltx") or without ("ltx1"), Wan's two samplers,
// Wan 2.2 SVI's chained shots ("svi"), an ACE-Step song ("song"), Pixal3D turning a picture into a textured 3D model ("model3d"),
// InfiniteTalk making a picture speak a voice recording ("talk"), SAM 3.1 selecting something in a picture ("select", not
// queued), a picture cut out onto transparent ("cutout"), or SAM 3.1 tracking a subject through a video ("vidcut").
// SeedVR2 sharpening a picture or a video to 1080p or 4K ("upscale"). LTX-2.3 making the sound for a silent video ("foley").
// MatAnyone2 matting a person out of a video ("person"). Hy-Nomas exploring a world a segment at a time ("world").
// SCAIL-2 swapping a person in a video for the character in a picture ("swap").
export type Family = "image" | "edit" | "ltx" | "ltx1" | "wan" | "svi" | "song" | "songedit" | "model3d" | "talk" | "select" | "cutout" | "vidcut" | "upscale" | "foley" | "person" | "world" | "swap";

export interface Mode {
  file: string;
  label: string;
  family: Family;
  promptNode: string;
  promptKey?: string; // the prompt input's name, "text" unless set
  seed: [string, string]; // node id, input name (for images also the sampler, which takes the steps)
  latent?: string; // the empty latent's node (width, height, batch_size)
  steps?: Partial<Record<Quality, number>>; // sampler steps per quality
  secs: number; // render time at the default settings on the reference RTX 3060 12 GB
  note?: string;
  imageNode?: string; // LoadImage node for image-to-video, edits and reference images
  imageKey?: string; // that node's file input, "image" unless set ("file" for a LoadVideo)
  imageClass?: string; // when set, that node is found by its class_type instead of imageNode's id
  fallback?: Mode; // used when this workflow file isn't there
  fast?: number; // with the Lightning LoRA (4 steps): seconds a megapixel, on top of LIGHTNING_LOAD_SECS
}

/* InfiniteTalk on an RTX 3060 12 GB at 448×640, 4 steps (ComfyUI's log and nvidia-smi): 55 s a step, so each 81-frame
 * part takes ~255 s, plus ~15 s for the rest once the models are in RAM. 3.2 s of speech (one part) took 264 s, 8 s
 * (three parts) 774 s; VRAM peaked at 10.1 GB either way, as ComfyUI streams the rest of Wan 2.1 14B from RAM.
 * That's ~1.5 minutes of rendering per second of speech, so a talking video is capped at 30 s (~47 min). */
export const TALK_PART_SECS = 255;
export const TALK_LOAD_SECS = 15;
/** The longest speech a talking video takes, in seconds. */
export const TALK_MAX_SECONDS = 30;

/* SAM 3.1 tracking a subject through a video, measured on an RTX 3060 12 GB: 8 s at 448×640 (199 frames) in 123 s,
 * peak 4.0 GB. On the RTX 2060 6 GB it took 117 s at 3.0 GB, so a second card can run it (see segment). */
export const VIDCUT_SECS = 15;

/* SeedVR2 on an RTX 3060 12 GB (nvidia-smi every 2 s): a 1024² picture to 1080p in 9 s, to 4K (2160²) in 15 s with
 * the 3B model at 6.3 GB, or with the 7B at 10.6 GB (and a 832×1216 portrait to 2160×3156 in 18 s at 10.5 GB); the 7B is
 * more faithful (SSIM 0.92 against the original, 0.86 for the 3B) at the same speed.
 * Videos to 1080p with the 3B: sampling is quick (~3 s per 21 frames); SeedVR2's VAE is what takes the time, ~5 s a
 * frame at 1620×1080. 2 s of 768×512 took 378 s with the template's 512 px tiles, 267 s with 1024 px tiles and 128-frame
 * temporal tiles (7.1 GB), 240 s untiled (7.8 GB, but that grows with the length). SeedVR2's own automatic chunking
 * picked 1 frame per chunk at 1080p, so chunks are set to 21 frames, which keeps the frames consistent. */
export const UPSCALE_IMAGE_SECS = 20;
export const UPSCALE_VIDEO_SECS = 130;
/* Add sound (Foley) on an RTX 3060 12 GB: LTX-2.3 dev Q4_K_M with the Foley LoRA, 30 steps at audio CFG 6 (Lightricks'
 * settings), 832×480: one 89-frame window (3.7 s) took 1,112 s including ~2 min of loading, ~33 s a step with 4 GB of
 * the model streamed from RAM. On the distilled model (8 steps) it was 4× quicker but made music-like sound, not
 * effects, so the pack brings dev. */
export const FOLEY_WINDOW_SECS = 1000;
export const FOLEY_LOAD_SECS = 120;
/** LTX-2.3's frames a window (1 + 8k) and the longest video Add sound takes (seconds at 24 fps). */
export const FOLEY_WINDOW = 89;
export const FOLEY_MAX_SECONDS = 15;

/* Swap a character: Z.ai's SCAIL-2 (Wan 2.1 14B, Comfy-Org's int8 convrot, with its DPO LoRA and lightx2v's 480p
 * step-distill LoRA at CFG 1) in Replacement mode, through ComfyUI's native nodes. SAM 3.1 tracks who's replaced
 * (the biggest one named), BiRefNet cuts the character out of the picture (padded to the video's shape first). It
 * makes 81 frames at a time; each segment after the first carries on from the last 5 frames of the one before (a
 * 76-frame step), its colours matched to it.
 * On an RTX 3060 12 GB a 5 s 768×512 clip (121 frames: a full segment and a 45-frame one) took 546 s at 4 steps, peaking
 * at 10.9 GB of VRAM and 24.5 GB of system RAM: ~52 s a step for a full segment, plus ~95 s a segment for SAM 3.1
 * (~35 s), decoding and getting the model back (ComfyUI reads all 16.7 GB again for each: 42 s from an SSD, 2 min 16 s
 * from a hard drive, so the pack puts it in a folder of its own that can be a junction). A shorter segment's steps
 * take less than its share of frames (attention grows faster than the frames). 6 steps with the model on a hard drive
 * took 1,003 s. That was on a card of its own; through Prestige, with the Windows desktop on ComfyUI's card, the same
 * 4-step swap took 701 s (10.5 GB peak), so secs below are scaled to that (and are for the SSD). */
export const SWAP = { part: 81, step: 76, overlap: 5, area: 832 * 480, loadSecs: 130, partSecs: 125, stepSecs: 69, maxSeconds: 20 };
export type SwapQuality = "draft" | "standard";
export const SWAP_STEPS: Record<SwapQuality, number> = { draft: 4, standard: 8 };

/** What an upscale's shorter side becomes. */
export type UpscaleSize = 1080 | 2160;

// The nodes in the stack's exported API workflows (workflows\*.api.json) that the settings go into.
export const QWEN_STEPS = { draft: 12, standard: 20, high: 30, max: 40 };
export const ZIMAGE: Mode = {
  file: "z-image-turbo.api.json",
  label: "Z-Image-Turbo",
  family: "image",
  promptNode: "4",
  seed: ["7", "seed"],
  latent: "6",
  steps: { draft: 6, standard: 8, high: 12, max: 16 },
  secs: 40,
};
/* Explore a world: Tencent's Hy-Nomas (Apache-2.0 DiT, int8) through PedroMarinhoDev's ComfyUI-Hy-Nomas nodes (GPL-3.0),
 * in segments the chat model writes (world.ts). Its PixelUMM decoder is NVIDIA's, under the One-Way Noncommercial
 * License (research and evaluation only), which the pack and chat say. On the RTX 3060 at 832×480 a 5 s segment
 * sampled in 25-42 s (8 steps). The decoder runs at window overlap 1: Tencent's 5 took a 4-segment, 20 s world from
 * 428 s to 1,735 s, with no difference to see (FP8 runs no faster than dequantized on Ampere). A 3-segment world took
 * 305 s, one from a picture with a segment after it 137 s, peaking at 11.5 GB. secs is one segment with its share of
 * the decode. */
export const WORLD = { w: 832, h: 480, steps: 8, secs: 110 };
/** Redraw upscale (Qwen-Image-2.1 with the Restore LoRA, a tile at a time); secs and fast are per megapixel made. */
export const REDRAW_MODE: Mode = {
  file: "qwen-image-21-edit.api.json",
  label: "Qwen-Image-2.1 Redraw",
  family: "edit",
  promptNode: "4",
  promptKey: "prompt",
  seed: ["6", "seed"],
  steps: { draft: 16, standard: 25, high: 30, max: 40 },
  secs: 71,
  fast: 25,
  note: "redraw upscale",
  imageNode: "9",
};
export const MODES: Record<GenMode, Mode> = {
  image: {
    file: "qwen-image-21.api.json",
    label: "Qwen-Image-2.1",
    family: "image",
    promptNode: "4",
    promptKey: "prompt",
    seed: ["6", "seed"],
    latent: "5",
    steps: QWEN_STEPS,
    secs: 90,
    note: "best with text and signs",
    fallback: ZIMAGE,
  },
  fast: {
    file: "qwen-image-21-turbo.api.json",
    label: "Qwen-Image-2.1 Turbo",
    family: "image",
    promptNode: "4",
    promptKey: "prompt",
    seed: ["6", "seed"],
    latent: "5",
    steps: { draft: 3, standard: 4, high: 6, max: 8 }, // the GGUF's; the int8 Turbo always runs its 8-step schedule
    secs: 13,
    fallback: ZIMAGE,
  },
  edit: {
    file: "qwen-image-21-edit.api.json",
    label: "Qwen-Image-2.1 Edit",
    family: "edit",
    promptNode: "4",
    promptKey: "prompt",
    seed: ["6", "seed"],
    steps: QWEN_STEPS,
    secs: 90,
    fast: 15,
    note: "keeps the image's size",
    imageNode: "9",
  },
  // Paint to change: the edit graph with a mask, so only the painted area is regenerated (see inpaintGraph).
  inpaint: {
    file: "qwen-image-21-edit.api.json",
    label: "Qwen-Image-2.1 Inpaint",
    family: "edit",
    promptNode: "4",
    promptKey: "prompt",
    seed: ["6", "seed"],
    steps: QWEN_STEPS,
    secs: 95,
    fast: 16,
    note: "only the painted area changes",
    imageNode: "9",
  },
  video: {
    file: "ltx25-t2v-distilled.api.json",
    label: "LTX-2.5",
    family: "ltx",
    promptNode: "5",
    seed: ["16", "noise_seed"],
    secs: 360,
    fallback: {
      file: "ltx23-t2v-distilled.api.json",
      label: "LTX-2.3",
      family: "ltx1",
      promptNode: "5",
      seed: ["16", "noise_seed"],
      secs: 360,
    },
  },
  // MOSS-Image (OpenMOSS, Apache-2.0): a second text-to-image model, int8 with lodestones' 8-step DMD LoRA at CFG 1,
  // its Qwen3.5-9B text encoder (w4a8) and FLUX.2's small VAE (workflows\moss-image-turbo.api.json). Best with
  // lettering and with a layout (layout.ts); Kromoss can stand in for it (mossGraph). Text to image only: references
  // and edits stay on Qwen-Image-2.1. On an RTX 3060 a 1024² picture took 14 s (21 s with loading), peaking at 8.1 GB.
  moss: {
    file: "moss-image-turbo.api.json",
    label: "MOSS-Image",
    family: "image",
    promptNode: "4",
    seed: ["6", "seed"],
    latent: "5",
    steps: { draft: 4, standard: 8 },
    secs: 15,
    note: "text and layouts",
  },
  // A reference image placed in a new scene: the text-to-image graph with the picture fed to the text encoder.
  ref: {
    file: "qwen-image-21-reference.api.json",
    label: "Qwen-Image-2.1",
    family: "image",
    promptNode: "4",
    promptKey: "prompt",
    seed: ["6", "seed"],
    latent: "5",
    steps: QWEN_STEPS,
    secs: 130,
    note: "with your reference",
    imageNode: "9",
  },
  reffast: {
    file: "qwen-image-21-turbo-reference.api.json",
    label: "Qwen-Image-2.1 Turbo",
    family: "image",
    promptNode: "4",
    promptKey: "prompt",
    seed: ["6", "seed"],
    latent: "5",
    steps: { draft: 3, standard: 4, high: 6, max: 8 },
    secs: 40, // the turbo model; with Lightning on Qwen-Image-2.1 (fastRef) a 1216×832 scene took 29 s, peaking at 7.3 GB
    note: "with your reference",
    imageNode: "9",
  },
  // LTX image-to-video: the picture is the first frame of a clip with sound.
  refvideo: {
    file: "ltx25-i2v-distilled.api.json",
    label: "LTX-2.5",
    family: "ltx",
    promptNode: "5",
    seed: ["16", "noise_seed"],
    secs: 360,
    imageNode: "50",
    fallback: {
      file: "ltx23-i2v-distilled.api.json",
      label: "LTX-2.3",
      family: "ltx1",
      promptNode: "5",
      seed: ["16", "noise_seed"],
      secs: 360,
      imageNode: "50",
    },
  },
  // Director's storyboard shot from its drawn frame: always LTX, for the sound and the shot's own length.
  shotvideo: {
    file: "ltx25-i2v-distilled.api.json",
    label: "LTX-2.5",
    family: "ltx",
    promptNode: "5",
    seed: ["16", "noise_seed"],
    secs: 360,
    imageNode: "50",
    fallback: {
      file: "ltx23-i2v-distilled.api.json",
      label: "LTX-2.3",
      family: "ltx1",
      promptNode: "5",
      seed: ["16", "noise_seed"],
      secs: 360,
      imageNode: "50",
    },
  },
  animate: {
    file: "wan22-i2v-4step.api.json",
    label: "Wan 2.2",
    family: "wan",
    promptNode: "6",
    seed: ["11", "noise_seed"],
    steps: { standard: 4, high: 6, max: 8 },
    secs: 600,
    imageNode: "9",
  },
  // Wan 2.2 with the Stable Video Infinity LoRAs: each shot continues the last, then FILM doubles the frame rate.
  long: {
    file: "wan22-svi-long.api.json",
    label: "Wan 2.2 SVI",
    family: "svi",
    promptNode: "7",
    seed: ["28", "noise_seed"],
    steps: { standard: 4, high: 6, max: 8 },
    secs: 410,
    imageNode: "6",
  },
  // ACE-Step 1.5 turbo: the style goes in as tags, and the lyrics and the music settings beside them (node 4).
  song: {
    file: "ace-step-15-song.api.json",
    label: "ACE-Step 1.5",
    family: "song",
    promptNode: "4",
    promptKey: "tags",
    seed: ["7", "seed"],
    latent: "6",
    secs: 10,
  },
  // The song editor (songedit.ts): ACE-Step 1.5 turbo redoes a part of a song, extends it or covers it, through the
  // Workstation's workstation_music node. The song goes into LoadAudio (node 20); the job, its times and the music
  // settings are set per edit (songEditGraph). secs is a 60 s song's (editSecs has the rest).
  songedit: {
    file: "ace-step-15-edit.api.json",
    label: "ACE-Step 1.5",
    family: "songedit",
    promptNode: "4",
    promptKey: "tags",
    seed: ["7", "seed"],
    secs: 23,
    note: "song edit",
    imageNode: "20",
    imageKey: "audio",
  },
  // Picture to 3D: Pixal3D (int8) through ComfyUI's native nodes, the picture's background removed by BiRefNet and its
  // field of view from MoGe; a textured .glb comes out (workflows\pixal3d-image-to-3d.api.json).
  model3d: {
    file: "pixal3d-image-to-3d.api.json",
    label: "Pixal3D",
    family: "model3d",
    promptNode: "",
    seed: ["3", "seed"],
    secs: 300,
    note: "textured 3D model",
    imageNode: "122",
  },
  // Talking characters: InfiniteTalk (MeiGen, on Wan 2.1 I2V 14B 480p in GGUF Q4_K_M with the lightx2v step-distill
  // LoRA) lip-syncs a picture to a voice recording, through ComfyUI's native nodes (workflows\infinitetalk-talking.api.json).
  // It makes 81 frames (3.24 s at 25 fps) at a time; longer speech chains more parts, each carrying on from the last 9
  // frames of the one before (talkGraph). secs is one part.
  talk: {
    file: "infinitetalk-talking.api.json",
    label: "InfiniteTalk",
    family: "talk",
    promptNode: "10",
    seed: ["15", "noise_seed"],
    secs: TALK_PART_SECS,
    note: "talking video",
    imageNode: "7",
  },
  // Click to select: SAM 3.1 (Meta, through ComfyUI's native nodes) outlines what's under a click, or things by name,
  // in ~3 s. Run straight away rather than queued (segment), and returned as a mask (workflows\sam3-select.api.json).
  select: {
    file: "sam3-select.api.json",
    label: "SAM 3.1",
    family: "select",
    promptNode: "",
    seed: ["", ""],
    secs: 3,
    imageNode: "2",
  },
  // A transparent cut-out: BiRefNet finds the subject ("Remove background"), or the selection's mask is used
  // (workflows\cutout.api.json).
  cutout: {
    file: "cutout.api.json",
    label: "Cut-out",
    family: "cutout",
    promptNode: "",
    seed: ["", ""],
    secs: 5,
    imageNode: "1",
  },
  // A video's subject, tracked by SAM 3.1 in every frame, on a green screen with the sound kept
  // (workflows\sam3-video-cutout.api.json). secs is per second of video.
  vidcut: {
    file: "sam3-video-cutout.api.json",
    label: "SAM 3.1",
    family: "vidcut",
    promptNode: "4",
    seed: ["", ""],
    secs: VIDCUT_SECS,
    imageNode: "2",
    imageKey: "file",
  },
  // Cut out a person: MatAnyone2 (spiritform's ComfyUI nodes) follows the person picked on the first frame (a SAM 3.1
  // selection) through the video as an alpha matte; the frames come back as RGBA PNGs in a .frames folder, plus the
  // matte as a video, and person_video (studio.rs) makes them into what was asked for with ffmpeg
  // (workflows\matanyone2-person.api.json). On an RTX 3060 an 8 s 448×640 clip (199 frames) took 24–28 s, peaking at
  // 2.5 GB. secs is per second of video, loading included.
  person: {
    file: "matanyone2-person.api.json",
    label: "MatAnyone2",
    family: "person",
    promptNode: "",
    seed: ["", ""],
    secs: 4,
    imageNode: "2",
    imageKey: "file",
  },
  // Upscale and enhance: SeedVR2 (ByteDance, one-step diffusion restoration, ComfyUI's native nodes, 0.38's faster
  // version) redraws a picture at 1080p or 4K with real detail, in tiles so it fits 12 GB
  // (workflows\seedvr2-upscale-image.api.json). Pictures use the 7B model; secs is for 4K.
  upimage: {
    file: "seedvr2-upscale-image.api.json",
    label: "SeedVR2",
    family: "upscale",
    promptNode: "",
    seed: ["9", "seed"],
    secs: UPSCALE_IMAGE_SECS,
    imageNode: "1",
  },
  // A video to 1080p with the 3B model, a few frames at a time so they stay consistent
  // (workflows\seedvr2-upscale-video.api.json). secs is per second of video.
  upvideo: {
    file: "seedvr2-upscale-video.api.json",
    label: "SeedVR2",
    family: "upscale",
    promptNode: "",
    seed: ["10", "seed"],
    secs: UPSCALE_VIDEO_SECS,
    imageNode: "1",
    imageKey: "file",
  },
  // New camera angle: the edit graph with the Multiple-Angles LoRA v2 (reshootGraph), asked for a view by its labels.
  angle: {
    file: "qwen-image-21-edit.api.json",
    label: "Qwen-Image-2.1 Angles",
    family: "edit",
    promptNode: "4",
    promptKey: "prompt",
    seed: ["6", "seed"],
    steps: QWEN_STEPS,
    secs: 135, // an 832×1216 portrait took 128–152 s on the RTX 3060, loading included
    note: "new camera angle",
    imageNode: "9",
  },
  // Try on outfit: the edit graph with the Outfit Swap LoRA, the person as image 1 and the outfit as image 2. Its
  // author measured it at 25 steps, CFG 1, euler / simple.
  outfit: {
    file: "qwen-image-21-edit.api.json",
    label: "Qwen-Image-2.1 Outfit",
    family: "edit",
    promptNode: "4",
    promptKey: "prompt",
    seed: ["6", "seed"],
    steps: { draft: 16, standard: 25, high: 30, max: 40 },
    secs: 180, // 178 s for an 832×1216 portrait on the RTX 3060 (two pictures encoded, 25 steps)
    note: "try on outfit",
    imageNode: "9",
  },
  // Restore photo: the edit graph with ausboss's Restore LoRA (restoreGraph). The picture is redrawn at about 2 MP,
  // which its author trained and measured at; 25 steps without Lightning, as in its card. On the RTX 3060 a 448×252
  // JPEG took 278 s at 25 steps and 92 s with Lightning (4 steps), loading included, peaking at 8.3 and 9.6 GB.
  restore: {
    file: "qwen-image-21-edit.api.json",
    label: "Qwen-Image-2.1 Restore",
    family: "edit",
    promptNode: "4",
    promptKey: "prompt",
    seed: ["6", "seed"],
    steps: { draft: 16, standard: 25, high: 30, max: 40 },
    secs: 139,
    fast: 36,
    note: "restore photo",
    imageNode: "9",
  },
  // Redraw at 4 or 8 MP: the edit graph with the Restore LoRA, run on the tiles AusBoss's Tiled Upscale cuts the
  // picture into (redrawGraph). secs and fast are per megapixel of the result. On the RTX 3060 a 1 MP picture took
  // 286 s to 4 MP and 567 s to 8 MP at 25 steps, and 60 s and 228 s Fast (Lightning), peaking at 11.5 GB.
  redraw4: REDRAW_MODE,
  redraw8: REDRAW_MODE,
  // Make it manga: the edit graph redraws the picture as an inked black-and-white panel at about 2 MP, then
  // ashukae's Manga Finish prints it with a real screentone and Manga Panel frames it (mangaGraph). On the RTX 3060 a
  // 1024² picture took 204 s to sample at 20 steps and 44 s with Lightning, peaking at 9.1 and 10.3 GB.
  manga: {
    file: "qwen-image-21-edit.api.json",
    label: "Qwen-Image-2.1 Manga",
    family: "edit",
    promptNode: "4",
    promptKey: "prompt",
    seed: ["6", "seed"],
    steps: QWEN_STEPS,
    secs: 115,
    fast: 30,
    note: "manga panel",
    imageNode: "9",
  },
  // Add sound: LTX-2.3 dev with Lightricks' Foley LoRA hears the video (frozen, its own frames) and makes its sound
  // effects, 89 frames (3.7 s) at a time (foleyGraph); Prestige then puts the sound on the original video (mux_foley).
  // secs is one window.
  world: {
    file: "hy-nomas-world.api.json",
    label: "Hy-Nomas",
    family: "world",
    promptNode: "",
    seed: ["6", "seed"],
    secs: WORLD.secs,
  },
  foley: {
    file: "ltx23-foley-v2a.api.json",
    label: "LTX-2.3 Foley",
    family: "foley",
    promptNode: "5",
    seed: ["w0n", "noise_seed"],
    secs: FOLEY_WINDOW_SECS,
    imageNode: "10",
    imageKey: "video",
  },
  // Swap a character: SCAIL-2 puts the character from a picture in place of a person in a video, moving as they did,
  // in 81-frame segments (swapGraph); Prestige then puts the video's own sound back on (mux_swap). The video goes into
  // LoadVideo, the picture into LoadImage (swapGraph finds both by class). secs is one segment at Draft.
  swap: {
    file: "scail2-swap.api.json",
    label: "SCAIL-2",
    family: "swap",
    promptNode: "",
    seed: ["", ""],
    secs: SWAP.partSecs + SWAP.stepSecs * SWAP_STEPS.draft,
    imageNode: "9",
    imageClass: "LoadVideo",
    imageKey: "file",
  },
};

/* The LoRAs for New camera angle and Try on outfit (the reshoot pack), in ComfyUI's loras folder. Multiple-Angles v2 is
 * the step-1,500 checkpoint its card recommends, at 0.9 (its range is 0.8–1.0: lower holds the subject, higher turns
 * the camera further); Outfit Swap is step 1,000 at 1.0 (at 0.5 half of the drift it removes comes back). */
export const RESHOOT_LORAS: Partial<Record<GenMode, { file: string; strength: number }>> = {
  angle: { file: "qwen-image-2.1-multiple-angles-v2.safetensors", strength: 0.9 },
  outfit: { file: "qwen-image-2.1-outfit-swap.safetensors", strength: 1 },
};

/* lightx2v's Lightning LoRA for Qwen-Image-2.1 (DMD, 4 steps, CFG 1, text to image and edits, one picture or several).
 * On the RTX 3060 a 1024×576 edit with the uncensored Q4_K_M took 19 s for 4 steps against 93 s for 20 (4.7 s a step),
 * peaking at 9.4 GB the first time (the LoRA patched in) and 7.3–8 GB after; its result held the subject as 20 steps did,
 * a little less saturated. It stacks with a taught face or style and with the Restore LoRA, but not with the Reshoot
 * ones: with it the Multiple-Angles LoRA hardly turned the camera (even at 1.0 and 6 steps), and Outfit Swap moved and
 * enlarged the person, which is what that LoRA is there to stop. Those two keep their own steps. */
export const LIGHTNING = { file: "qwen-image-2.1-lightning-4step.safetensors", steps: 4 };
export const LIGHTNING_LOAD_SECS = 20;
/** The modes the Speed setting (Fast or Quality) applies to. Reference's own Turbo pick runs Lightning too. */
export const LIGHTNING_MODES: GenMode[] = ["edit", "inpaint", "restore", "manga", "redraw4", "redraw8"];
export const lightningOn = (gm: GenMode) => (LIGHTNING_MODES.includes(gm) && settings().image.edits !== "quality") || gm === "reffast";
/** The turbo model Reference's Turbo pick falls back to when the Lightning LoRA isn't installed. */
export const TURBO_UNET = "qwen-image\\qwen_image_2.1_turbo_int8_convrot.safetensors";

/* Qwen-Image-2.1 runs as Comfy-Org's int8 convrot files (the base model and Qwen's own 8-step Turbo), in
 * models\comfy\diffusion_models\qwen-image. On the RTX 3060 a 20-step 1024² edit took 40 s against 102 s with the
 * Q4_K_M GGUF (peak 10.9 GB against 6.6), and a Turbo picture 12 s against 21 s. abenzerps' uncensored LoRA goes on
 * top of both: it is what their uncensored builds have merged in (their UC int8 file gave the same edit as the
 * official int8 with the LoRA). The Turbo samples Qwen's saved 8-step schedule: at the Viggle turbo's 4 simple steps
 * it came out dark with a garbled sign. Without the int8 files the GGUFs still run (qwenModels). */
export const QWEN_INT8 = {
  base: "qwen-image\\qwen_image_2.1_int8_convrot.safetensors",
  turbo: TURBO_UNET,
  uncensored: "qwen-image\\qwen-image-2.1-uncensored-lora.safetensors",
};
export const QWEN_GGUF: Record<string, string> = {
  [QWEN_INT8.base]: "qwen-image-2.1-UC-Q4_K_M.gguf",
  [QWEN_INT8.turbo]: "qwen_image_2.1_turbo_Q4_K_M.gguf",
};
export const TURBO_SIGMAS = "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0";

/* Restore photo: ausboss's Restore LoRA (step 1,500, rank 32) at 1.0, or 0.5 for a blurry photo (at 1.0 it stays true to
 * the blur), with the requests it was trained on. */
export type RestoreKind = "photo" | "blurry" | "old";
export const RESTORE = { file: "qwen-image-2.1-restore.safetensors", mp: 2 };
export const RESTORE_PROMPTS: Record<RestoreKind, string> = {
  photo: "Restore the photo: remove blur, noise and compression artifacts and recover sharp, natural detail, keeping the same composition, people and colors.",
  blurry: "Restore the photo: remove blur, noise and compression artifacts and recover sharp, natural detail, keeping the same composition, people and colors.",
  old: "Restore the old photo: remove scratches, dust, fading and grain and recover sharp, natural detail and color, keeping the same composition and people.",
};
export const restorePrompt = (k: RestoreKind) => RESTORE_PROMPTS[k];

/* Kromoss (lodestones' full fine-tune of MOSS-Image-Base) in place of the SFT model, with its own DMD2 8-step LoRA.
 * Next to the SFT one it drew people more naturally but misspelt a sign ("RCG TUDIOS" for "RG STUDIOS"), so MOSS-Image
 * stays the default. Both are in models\comfy\<folder>\moss. */
export const KROMOSS = { unet: "moss\\kromoss_int8_convrot.safetensors", lora: "moss\\kromoss-8-steps-dmd2-lora.safetensors" };

/* Make it manga: the edit request from ashukae's QWEN-Manga workflow (Qwen-Image-2.1 decides what is paper, tone and
 * ink by meaning, not brightness), then Manga Finish with that workflow's settings and Manga Panel with no crop. */
export const MANGA_PROMPT =
  "Redraw <image1> as a printed black-and-white manga page panel, as if inked by the original artist for serialization. Keep the exact composition, pose, character design, face, expression and drawing style of <image1>. Use confident ink lines with varied line weight, solid black for dark hair and deep shadows, white paper for skin and light surfaces, ink hatching lines for shadows on cloth, and regular screentone only where a mid tone is needed. No color and no smooth gradients. Do not add anything that is not in <image1>.";
export const MANGA_MP = 2;

/** The Multiple-Angles LoRA's 12 azimuths (30° apart, clockwise from the front) and 4 elevations, by the labels it was
 *  trained on, with what the menu shows. */
export const ANGLES = [
  ["front view", "Front"],
  ["front-right view", "Front, a little right"],
  ["front-right quarter view", "Three-quarter right"],
  ["right side view", "Right side"],
  ["back-right quarter view", "Back three-quarter right"],
  ["back-right view", "Back, a little right"],
  ["back view", "Back"],
  ["back-left view", "Back, a little left"],
  ["back-left quarter view", "Back three-quarter left"],
  ["left side view", "Left side"],
  ["front-left quarter view", "Three-quarter left"],
  ["front-left view", "Front, a little left"],
] as const;
export const ELEVATIONS = [
  ["eye-level shot", "Eye level"],
  ["elevated shot", "A little above (30°)"],
  ["high-angle shot", "High angle (60°)"],
  ["top-down shot", "Straight down (90°)"],
] as const;
/** The Multiple-Angles prompt: "<mva> {azimuth}, {elevation}[ close-up]". */
export const anglePrompt = (az: number, el: number, close: boolean) => `<mva> ${ANGLES[az][0]}, ${ELEVATIONS[el][0]}${close ? " close-up" : ""}`;

/** The Outfit Swap prompt its author tested, with the sentence that takes the old outfit off (or keeps shoes on). */
export const outfitPrompt = (what: string, keepShoes: boolean) =>
  `Dress the person in image 1 in the ${what.trim().replace(/[.\s]+$/, "") || "outfit"} shown in image 2. Keep their face, hair, hands, pose and the background exactly the same. ${keepShoes ? "Keep their own shoes and legwear." : "Replace everything they wear."}`;

/* ACE-Step 1.5 turbo on an RTX 3060 12 GB (ComfyUI's log and nvidia-smi): its 1.7B language model writes the audio codes
 * (~60 tokens/s), then 8 diffusion steps and a tiled VAE decode. Each song loads the models fresh (~5.2 GB peak at any
 * length): 30 s of music took 18 s, 60 s 26 s, 120 s 44 s, 180 s 62 s, 240 s 53 s. On a 6 GB RTX 2060 the language
 * model ran at 1.7 s a token (a 60 s song took 9 min), so songs stay on ComfyUI's main card. 8 minutes took 172 s
 * and peaked at 5.8 GB. */
export const SONG_FIXED_SECS = 10;
export const SONG_SECS_PER_SECOND = 0.3;
export const songPeakGB = (seconds: number) => (seconds > 240 ? 5.8 : 5.3);
/* ACE-Step 1.5 XL turbo (4B, the music-xl pack), Settings' High quality: on the RTX 3060 a 60 s song took 128 s with
 * the 10 GB model loading, 4 min took 188 s, and VRAM peaked at 11.1 GB (ComfyUI streams what doesn't fit). */
export const XL_FIXED_SECS = 105;
export const XL_SECS_PER_SECOND = 0.35;
export const XL_PEAK_GB = 11.1;
/** The ACE-Step models: Standard (turbo), High (XL turbo), and the base model that takes stems out. */
export const ACE_MODELS = {
  standard: "acestep_v1.5_turbo.safetensors",
  high: "acestep_v1.5_xl_turbo_bf16.safetensors",
  stems: "acestep_v1.5_base.safetensors",
};
export const ACE_PACK: Record<string, string> = { [ACE_MODELS.high]: "music-xl", [ACE_MODELS.stems]: "music" };
/** What a song's progress line says for each step. */
export const SONG_STEPS: Record<string, string> = {
  "TextEncodeAceStepAudio1.5": "Composing the melody and vocals",
  TextEncodeAceStep15Task: "Reading the style and lyrics",
  VAEEncodeAudio: "Reading the song",
  AceStep15SongEdit: "Lining up the edit",
  KSampler: "Rendering the audio",
  VAEDecodeAudioTiled: "Decoding the audio",
  SaveAudioMP3: "Saving the MP3",
};

// Pixal3D's samplers, in order (structure, shape, upsampled shape, texture): each gets its own seed.
export const MODEL3D_SAMPLERS = ["3", "18", "23", "12"];
/** What a 3D render's progress line says for each of its steps. */
export const MODEL3D_STEPS: Record<string, string> = {
  RemoveBackground: "Cutting out the subject",
  Pixal3DConditioning: "Reading the picture",
  ImageCropToMask: "Framing the subject",
  Trellis2ShapeStage: "Shaping the model",
  Trellis2UpsampleStage: "Refining the shape",
  Trellis2TextureStage: "Painting the texture",
  MeshSmoothNormals: "Smoothing the surface",
  MoGeInference: "Estimating the camera",
  KSampler: "Shaping the model",
  VaeDecodeStructureTrellis2: "Decoding the structure",
  VaeDecodeShapeTrellis: "Decoding the shape",
  VaeDecodeTextureTrellis: "Decoding the texture",
  RemeshMesh: "Remeshing",
  DecimateMesh: "Simplifying the mesh",
  UnwrapMesh: "Unwrapping the UVs",
  BakeTextureFromVoxel: "Baking the texture",
  BakeNormalMapFromMesh: "Baking the normal map",
  BakeAmbientOcclusion: "Baking ambient occlusion",
  ApplyTextureToMesh: "Texturing the mesh",
  Save3DAdvanced: "Saving the .glb",
};

// InfiniteTalk's nodes (workflows\infinitetalk-talking.api.json): the voice recording and its encoding, the first
// part's talk node, scheduler, sampler and decode, and the frames the video is made from. Each part is 81 frames at
// 25 fps and carries on from the last 9 frames before it.
export const TALK = { audio: "8", encode: "9", talk: "12", scheduler: "14", sampler: "17", decode: "18", frames: "20", fps: 25, part: 81, motion: 9 };
/** What an upscale's progress line says. */
export const UPSCALE_STEPS: Record<string, string> = {
  ResizeImageMaskNode: "Resizing",
  VAEEncodeTiled: "Encoding in tiles",
  SeedVR2TemporalChunk: "Splitting the video into chunks",
  KSampler: "Restoring detail",
  SeedVR2TemporalMerge: "Joining the chunks",
  VAEDecodeTiled: "Decoding in tiles",
  SeedVR2PostProcessing: "Matching the colours",
  CreateVideo: "Making the video",
  SaveVideo: "Saving the video",
  SaveImage: "Saving the picture",
};
/** What a cut-out's progress line says. */
export const CUT_STEPS: Record<string, string> = {
  RemoveBackground: "Finding the subject",
  SAM3_VideoTrack: "Tracking the subject in every frame",
  SAM3_TrackToMask: "Cutting it out",
  ImageCompositeMasked: "Putting it on a green screen",
  CreateVideo: "Making the video",
  SaveVideo: "Saving the video",
  SaveImage: "Saving the PNG",
};
/** What a talking video's progress line says for its other steps. */
export const TALK_STEPS: Record<string, string> = {
  LoadAudio: "Loading the voice",
  AudioEncoderEncode: "Listening to the voice",
  WanInfiniteTalkToVideo: "Matching the lips to the voice",
  CreateVideo: "Adding the voice",
  SaveVideo: "Saving the video",
};

/** A talking video's size: the picture's shape at the area of 448×640, in multiples of 16. On the 3060 a step took 54 s
 *  there and 81 s at 528×768 (480p's full area), and the faces looked as good. */
export const TALK_AREA = 448 * 640;
export function talkDims(srcW?: number | null, srcH?: number | null): [number, number] {
  const r = srcW && srcH ? srcW / srcH : 1;
  const r16 = (x: number) => Math.max(256, Math.round(x / 16) * 16);
  return [r16(Math.sqrt(TALK_AREA * r)), r16(Math.sqrt(TALK_AREA / r))];
}

/** How many 81-frame parts cover this much speech: the first makes 81 frames, each after it 72 new ones. */
export function talkParts(seconds: number) {
  const frames = Math.ceil(seconds * TALK.fps);
  return frames <= TALK.part ? 1 : 1 + Math.ceil((frames - TALK.part) / (TALK.part - TALK.motion));
}

/** A talking video's plan: the picture's shape, enough parts for the speech, and the measured time. */
export function talkPlan(src: Source | null, seconds: number): Plan {
  const [w, h] = talkDims(src?.width, src?.height);
  const parts = talkParts(seconds);
  return { w, h, count: 1, seconds, frames: Math.ceil(seconds * TALK.fps), fps: TALK.fps, shots: parts, load: 0, secs: TALK_LOAD_SECS + TALK_PART_SECS * parts, warn: "" };
}

/** Chains InfiniteTalk parts until the frames cover the speech. A part carries on from the last 9 frames of the one
 *  before, and counts that part's frames to know where it is in its recording, so each gets the voice from where the
 *  previous part started (its first 72 frames' worth then lie behind it). Its own first 9 frames repeat the previous
 *  part's last 9, so they're dropped, and the parts are joined once at the end and cut to the speech's length. (Giving
 *  each part everything made so far instead kept every growing copy in RAM: ~20 GB for 23 s.) */
export function talkGraph(g: any, p: Plan, seed: number) {
  set(g, TALK.talk, { width: p.w, height: p.h });
  const step = TALK.part - TALK.motion;
  const join: Record<string, [string, number]> = { "images.image0": [TALK.decode, 0] };
  let prev: [string, number] = [TALK.decode, 0];
  for (let k = 2; k <= p.shots!; k++) {
    const id = (n: number) => `${k}0${n}`;
    // ~6 s of voice from where the previous part started: the 72 frames behind this part, then its own 81.
    g[id(1)] = { class_type: "TrimAudioDuration", inputs: { audio: [TALK.audio, 0], start_index: ((k - 2) * step) / TALK.fps, duration: (step + TALK.part) / TALK.fps + 1 } };
    g[id(2)] = { class_type: "AudioEncoderEncode", inputs: { ...g[TALK.encode].inputs, audio: [id(1), 0] } };
    g[id(3)] = { class_type: "WanInfiniteTalkToVideo", inputs: { ...g[TALK.talk].inputs, audio_encoder_output_1: [id(2), 0], previous_frames: prev } };
    g[id(4)] = { class_type: "BasicScheduler", inputs: { ...g[TALK.scheduler].inputs, model: [id(3), 0] } };
    g[id(5)] = { class_type: "RandomNoise", inputs: { noise_seed: seed + k - 1 } };
    g[id(6)] = { class_type: "CFGGuider", inputs: { model: [id(3), 0], positive: [id(3), 1], negative: [id(3), 2], cfg: 1 } };
    g[id(7)] = { class_type: "SamplerCustomAdvanced", inputs: { ...g[TALK.sampler].inputs, noise: [id(5), 0], guider: [id(6), 0], sigmas: [id(4), 0], latent_image: [id(3), 3] } };
    g[id(8)] = { class_type: "VAEDecode", inputs: { ...g[TALK.decode].inputs, samples: [id(7), 0] } };
    g[id(9)] = { class_type: "ImageFromBatch", inputs: { image: [id(8), 0], batch_index: TALK.motion, length: step } };
    join[`images.image${k - 1}`] = [id(9), 0];
    prev = [id(8), 0];
  }
  if (p.shots! > 1) {
    g["19"] = { class_type: "BatchImagesNode", inputs: join };
    set(g, TALK.frames, { image: ["19", 0] });
  }
  set(g, TALK.frames, { length: p.frames });
}

/** The progress line for each part: "Animating part 2 of 4", "Decoding part 2 of 4". */
export function talkLabels(nodes: Record<string, string>, parts: number) {
  for (let k = 1; k <= parts; k++) {
    const of = parts > 1 ? ` part ${k} of ${parts}` : "";
    nodes[k === 1 ? TALK.sampler : `${k}07`] = `Animating${of || " the face"}`;
    nodes[k === 1 ? TALK.decode : `${k}08`] = `Decoding${of || " the frames"}`;
  }
}

// The SVI workflow's nodes: each shot's prompt and noise, the merge after each shot, and the settings.
export const SVI = {
  high: "1",
  low: "2",
  fp16: ["24", "10"], // each model's fp16-accumulation patch (high, low)
  frames: "13",
  size: "14",
  split: "20",
  steps: "21",
  shots: [
    { prompt: "7", noise: "28", merged: ["33", 0] },
    { prompt: "34", noise: "42", merged: ["48", 2] },
    { prompt: "36", noise: "53", merged: ["59", 2] },
    { prompt: "62", noise: "66", merged: ["72", 2] },
  ],
  finish: "73", // takes the joined frames on to FILM, the 2× upscale and the save
};
// Where the SVI render time was measured: 4 shots of 49 frames at 480 × 480.
export const SVI_BASE = 480 * 480 * 49 * 4;

/** A long video's prompt: one per shot, separated by "|". A shorter list repeats its last prompt. */
export function shotPrompts(prompt: string, shots: number): string[] {
  const parts = prompt.split("|").map((s) => s.trim()).filter(Boolean);
  return Array.from({ length: shots }, (_, i) => parts[Math.min(i, parts.length - 1)] ?? prompt);
}

// ---------- generation settings → workflow inputs ----------
export interface Plan {
  w: number; // output size; 0 when it follows the source picture (edits)
  h: number;
  steps?: number;
  count: number;
  seconds?: number;
  frames?: number;
  fps?: number;
  shots?: number; // a long video's shots, each `frames` long
  song?: MusicSettings; // a song's length, tempo, key, meter and language
  draft?: boolean; // LTX without its upscale pass: half size, much quicker
  load: number; // VRAM use relative to the defaults, which fit a 12 GB card (the limits scale with ComfyUI's card)
  secs: number; // rough render time on the reference PC
  warn: string; // "" when it should fit
  cards?: string; // what each card holds, when ComfyUI has two (or for LTX-2.5, how much of the model fits)
}

export const settingsKey = (gm: GenMode): SettingsKey =>
  gm === "refvideo"
    ? wanFromPicture()
      ? "animate"
      : "video"
    : gm === "video" || gm === "shotvideo"
      ? "video"
      : gm === "animate"
        ? "animate"
        : gm === "long"
          ? "long"
          : gm === "song"
            ? "music"
            : "image";
export const isVideo = (gm: GenMode) => gm === "video" || gm === "animate" || gm === "long" || gm === "refvideo" || gm === "shotvideo";

/** A picture a render starts from: a render in the gallery (edit, animate) or a reference image. */
export type Source = Asset | Reference;
/** Changes to a plan for one step of a chain: the first frame for a video is one picture at the video's shape. */
export type Override = { w: number; h: number; count: 1 };

/** "2:30", "45 s". */
export const songLength = (s: number) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

/** The quality levels a model offers, with their steps. */
export const levels = (m: Mode) => (Object.keys(QUALITY_NAMES) as Quality[]).filter((q) => m.steps?.[q] != null);
export const stepsOf = (m: Mode, q: Quality) => m.steps?.[q] ?? m.steps?.standard;

export const LTX_BASE = 768 * 512 * 97;
export const LTX_FRAME = 768 * 512;

/* LTX-2.5 (two passes: half size, then upscaled 2× and refined), measured on an RTX 3060 12 GB with nvidia-smi and
 * ComfyUI's own log. ComfyUI fills the card and streams the rest of the 15.7 GB diffusion model from system RAM, so
 * every length runs; longer clips leave less of the model on the card and take longer:
 *   size      frames  left for the model (2nd pass)  peak     time
 *   768×512   121     8.2 GB                         11.9 GB  229 s
 *   768×512   145     8.0 GB                         11.9 GB  246 s
 *   768×512   241     7.0 GB                         12.0 GB  321 s
 *   1280×704  241     4.0 GB                         11.6 GB  595 s
 * That's ~10 MB per 768×512 frame on top of ~2.8 GB (the desktop, buffers and the 1 GB upscaler). With the upscaler on
 * a second card (an RTX 2060 on PCIe x4) the model got ~1.1 GB more (9.3 / 9.1 / 8.2 / 5.1 GB) in about the same time
 * (241 / 256 / 324 / 589 s). Even 4 GB left rendered at the usual pace, so the warnings start below that. */
export const LTX_MODEL_GB = 15.7;
export const LTX_FIXED_MIB = 2854;
export const LTX_FRAME_MIB = 10;
export const LTX_UPSCALER_MIB = 1120;
export const LTX_DRAFT_FIXED_MIB = 2526;

/** GB of the LTX-2.5 diffusion model that stays on ComfyUI's main card for this render (the rest streams from RAM). */
export function ltxRoom(w: number, h: number, frames: number, draft: boolean): { room: number; mainGB: number } {
  const { main, parts } = comfyCards();
  const mainGB = main ? main.mem_total / 1024 - takenGB(main.index) : 12;
  // w × h is the size the last pass renders at. A draft is the first pass alone (half size, no upscaler), which left
  // 9.8 GB for the model at every length measured: ~2.5 GB fixed.
  const fixed = draft ? LTX_DRAFT_FIXED_MIB : LTX_FIXED_MIB - (parts.includes("upscaler") ? LTX_UPSCALER_MIB : 0);
  const room = mainGB - (fixed + LTX_FRAME_MIB * frames * ((w * h) / LTX_FRAME)) / 1024;
  return { room, mainGB };
}
// The limits were measured with the Windows desktop on the card (~1 GB). Other programs beyond that (a browser, a game)
// take VRAM ComfyUI can't free, measured per process (gpus.ts), so they come off the card's size.
export const DESKTOP_MIB = 1024;
export const othersGB = (index: number) => Math.max(0, heldOn(index).others - DESKTOP_MIB) / 1024;
export let rechecking = false;
export function takenGB(index: number): number {
  const gb = othersGB(index);
  // The counters are read in the background (cached 2 s); when a fresh reading moves the number, the warnings redraw.
  if (!rechecking) {
    rechecking = true;
    readHolders().then(() => {
      rechecking = false;
      if (Math.abs(othersGB(index) - gb) >= 0.25) renderCreate();
    });
  }
  return gb;
}
/** " Chrome 1.2 GB and … are using 2.0 GB of it." when other programs take a noticeable share of ComfyUI's card. */
export function takenText(index: number): string {
  const gb = takenGB(index);
  const who = othersText(index);
  return gb >= 0.5 && who ? ` Other programs are using ${gb.toFixed(1)} GB of it (${who}); closing them gives ComfyUI more room.` : "";
}
export const WAN_BASE = 832 * 480 * 81;
export const MP = 1024 * 1024;

/** The SVI render size: the picture's shape with its longest side at `size`, in multiples of 32. */
export function sviDims(size: number, srcW?: number | null, srcH?: number | null): [number, number] {
  const r = srcW && srcH ? srcW / srcH : 1;
  const r32 = (x: number) => Math.max(32, Math.round(x / 32) * 32);
  return r >= 1 ? [r32(size), r32(size / r)] : [r32(size * r), r32(size)];
}

/** What a render with the current settings will be: sizes, steps, frames, and a VRAM and time estimate. A song can
 *  take its own tempo, key and language (chat's songwriter picks them) over the saved ones. */
export function plan(gm: GenMode, src: Source | null = srcAsset, o?: Override, song?: Partial<MusicSettings>, video?: Partial<VideoSettings>): Plan {
  const m = modeOf(gm);
  let p: Omit<Plan, "warn">;
  // Picture to 3D: one model per picture; its time and VRAM were measured (see MODES.model3d).
  if (m.family === "model3d" || m.family === "select" || m.family === "cutout" || m.family === "upscale" || m.family === "songedit") return { w: 0, h: 0, count: 1, load: 0, secs: m.secs, warn: "" };
  if (m.family === "vidcut" || m.family === "person") return { w: 0, h: 0, count: 1, load: 0, secs: m.secs * 8, warn: "" }; // per second of video (videoCutout, personCutout)
  if (m.family === "foley") return { w: 0, h: 0, count: 1, load: 0, secs: m.secs * 2, warn: "" }; // per window (addSound)
  if (m.family === "world") return { w: WORLD.w, h: WORLD.h, count: 1, load: 0, secs: m.secs, warn: "" }; // per segment (renderWorld)
  if (m.family === "swap") return { w: 0, h: 0, count: 1, load: 0, secs: m.secs, warn: "" }; // per segment (swapSecs)
  if (m.family === "song") {
    // Measured (see SONG_FIXED_SECS): the same ~5.3 GB at every length, so only a small card gets a warning.
    // A songwriter's pick that's missing (undefined) keeps the saved setting rather than blanking it.
    const s = { ...settings().music, ...Object.fromEntries(Object.entries(song ?? {}).filter(([, v]) => v != null)) } as MusicSettings;
    const { main } = comfyCards();
    const mainGB = main ? main.mem_total / 1024 : vramGB("comfyui");
    const where = main ? `the ${shortName(main)}'s ${Math.round(mainGB)} GB` : cardsText("comfyui");
    const high = s.quality === "high";
    const peak = high ? XL_PEAK_GB : songPeakGB(s.seconds);
    const warn = mainGB < peak + 0.7 ? `ACE-Step${high ? " XL" : ""} peaks at about ${peak} GB, more than ${where} can hold: it will run partly from system RAM, slowly.` : "";
    const secs = high ? XL_FIXED_SECS + XL_SECS_PER_SECOND * s.seconds : SONG_FIXED_SECS + SONG_SECS_PER_SECOND * s.seconds;
    return { w: 0, h: 0, count: 1, seconds: s.seconds, song: s, load: 0, secs, warn };
  }
  if (m.family === "image" || m.family === "edit") {
    const s = settings().image;
    const fast = lightningOn(gm) && m.fast != null;
    const steps = fast ? LIGHTNING.steps : stepsOf(m, s.quality)!;
    const ratio = steps / m.steps!.standard!;
    if (m.family === "edit") {
      // Restore photo redraws the picture at about 2 MP, whatever its size.
      const px = gm === "restore" ? RESTORE.mp : gm === "manga" ? MANGA_MP : REDRAW_MP[gm] ? redrawMp(gm, src) : src?.width && src.height ? (src.width * src.height) / MP : 1;
      p = { w: 0, h: 0, steps, count: 1, load: REDRAW_MP[gm] ? REDRAW.tileMp : px, secs: fast ? LIGHTNING_LOAD_SECS + m.fast! * px : m.secs * px * ratio };
    } else {
      const [w, h] = o ? [o.w, o.h] : imageDims(s.aspect, s.size);
      const count = o ? o.count : s.count;
      const px = (w * h) / MP;
      p = { w, h, steps, count, load: px * count, secs: m.secs * px * count * ratio };
    }
    if (mossEdits(gm)) {
      const ms = fast || gm === "reffast" ? MOSS_EDIT.fast : MOSS_EDIT.quality;
      p = { ...p, steps: ms.steps, secs: ms.secs * Math.max(1, p.load) };
    }
  } else if (m.family === "wan") {
    const s = settings().animate;
    const [w, h] = s.res === "auto" ? wanAuto(src?.width, src?.height) : parseRes(s.res);
    const frames = wanFrames(s.seconds);
    const steps = stepsOf(m, s.quality)!;
    const load = (w * h * frames) / WAN_BASE;
    p = { w, h, steps, count: 1, seconds: s.seconds, frames, fps: 16, load, secs: m.secs * load * (steps / 4) };
  } else if (m.family === "svi") {
    // The picture keeps its shape, scaled so its longest side is the size (multiples of 32), and the result is upscaled 2×.
    const s = settings().long;
    const [w, h] = sviDims(s.size, src?.width, src?.height);
    const steps = stepsOf(m, s.quality)!;
    const work = w * h * s.frames;
    p = {
      w: w * 2,
      h: h * 2,
      steps,
      count: 1,
      seconds: sviSeconds(s.frames, s.shots),
      frames: s.frames,
      fps: SVI_FPS * 2,
      shots: s.shots,
      load: work / WAN_BASE, // one shot is in VRAM at a time
      secs: m.secs * ((work * s.shots) / SVI_BASE) * (steps / 4),
    };
  } else {
    const s = { ...settings().video, ...video };
    const [w, h] = parseRes(s.res);
    const frames = ltxFrames(s.seconds, s.fps);
    const draft = m.family === "ltx" && s.quality === "draft";
    const work = (w * h * frames) / LTX_BASE;
    // LTX-2.5's time: ~135 s of loading and the first pass, then ~0.77 s per 768×512 frame (measured; see above).
    const secs = m.family === "ltx" ? (135 + 0.77 * frames * ((w * h) / LTX_FRAME)) * (draft ? 0.3 : 1) : m.secs * work * (draft ? 0.3 : 1);
    p = { w: draft ? w / 2 : w, h: draft ? h / 2 : h, count: 1, seconds: s.seconds, frames, fps: s.fps, draft, load: draft ? work / 4 : work, secs };
  }
  const { main, aux, parts } = comfyCards();
  const auxText = aux ? `${parts.map((x) => ({ upscaler: "the LTX upscaler", vae: "the VAEs", text_encoder: "the text encoders" })[x] ?? x).join(", ")} on the ${shortName(aux)}` : "";
  if (m.family === "ltx") {
    // Measured, per card: what's left on the main card for the model decides speed, and only a nearly full card fails.
    const { room, mainGB } = ltxRoom(p.w, p.h, p.frames!, !!p.draft);
    const where = main ? `the ${shortName(main)}` : "the GPU";
    const kept = Math.max(0, Math.min(LTX_MODEL_GB, room));
    const cards = `${kept.toFixed(1)} of the model's ${LTX_MODEL_GB} GB on ${where}, the rest streamed from RAM` + (auxText ? ` · ${auxText}` : "");
    const warn =
      (room < 1.5
        ? `Likely more than ${where} can take: it may fail with out of memory. Try a smaller size or a shorter length.`
        : room < 3
          ? `Heavy for ${where}: only ${room.toFixed(1)} GB is left for the model, so most of it streams from system RAM and the render is slower.`
          : "") + (room < 3 && main ? takenText(main.index) : "");
    return { ...p, warn, cards };
  }
  // Videos hold every frame in VRAM at once, so they reach the limit sooner than images. The limits were set on a
  // 12 GB card; they scale with ComfyUI's main card (a second card only takes the parts that can move).
  const mainGB = main ? main.mem_total / 1024 - takenGB(main.index) : vramGB("comfyui");
  const scale = mainGB / 12;
  const [soft, hard] = (m.family === "image" || m.family === "edit" ? [2.2, 3.5] : [1.35, 2.2]).map((x) => x * scale);
  const card = main ? `the ${shortName(main)}'s ${Math.round(main.mem_total / 1024)} GB` : cardsText("comfyui");
  const warn =
    (p.load > hard
      ? `Likely more than ${card} of VRAM: it may fail with out of memory. Try a smaller size, a shorter length or fewer images.`
      : p.load > soft
        ? `Heavy for ${card}: ComfyUI may spill into system RAM and render much slower.`
        : "") + (p.load > soft && main ? takenText(main.index) : "");
  // The LTX upscaler is the only part other models don't use; the VAEs and text encoders follow them anywhere.
  const moved = parts.filter((x) => x !== "upscaler");
  const cards = aux && moved.length ? `the diffusion model on the ${shortName(main!)}, ${moved.map((x) => (x === "vae" ? "the VAE" : "the text encoder")).join(" and ")} on the ${shortName(aux)}` : undefined;
  return { ...p, warn, cards };
}

/** Sets a node's inputs if the workflow has that node. */
export function set(g: any, id: string, inputs: Record<string, unknown>) {
  if (g[id]) Object.assign(g[id].inputs, inputs);
}

/** Writes the plan and seed into a copy of the workflow. */
export function apply(m: Mode, g: any, p: Plan, seed: number) {
  set(g, m.seed[0], { [m.seed[1]]: seed });
  switch (m.family) {
    case "image":
      set(g, m.latent!, { width: p.w, height: p.h, batch_size: p.count });
      set(g, m.seed[0], { steps: p.steps });
      break;
    case "edit":
      set(g, m.seed[0], { steps: p.steps });
      break;
    case "ltx":
    case "ltx1": {
      // LTX-2.5 makes the clip at half size, then upscales it 2× and refines (nodes 40–46).
      const half = m.family === "ltx" ? 2 : 1;
      const [w, h] = p.draft ? [p.w * 2, p.h * 2] : [p.w, p.h];
      set(g, "14", { width: w / half, height: h / half, length: p.frames });
      set(g, "13", { frames_number: p.frames, frame_rate: p.fps });
      set(g, "23", { frame_rate: p.fps });
      set(g, "36", { fps: p.fps });
      set(g, "43", { noise_seed: seed + 1 });
      if (p.draft) {
        // Decode the first pass directly and drop the upscale.
        set(g, "35", { samples: ["19", 1] });
        set(g, "37", { samples: ["19", 0] });
        for (const id of ["40", "41", "42", "43", "44", "45", "46", "53"]) delete g[id];
      }
      break;
    }
    case "wan": {
      // Two samplers split the steps: high-noise model first, low-noise model second.
      const n = p.steps!;
      set(g, "10", { width: p.w, height: p.h, length: p.frames });
      set(g, "11", { steps: n, end_at_step: n / 2 });
      set(g, "12", { steps: n, start_at_step: n / 2, end_at_step: n, noise_seed: seed });
      break;
    }
    case "model3d":
      MODEL3D_SAMPLERS.forEach((id, i) => set(g, id, { seed: seed + i }));
      break;
    case "talk":
      talkGraph(g, p, seed);
      break;
    case "svi": {
      const s = settings().long;
      set(g, SVI.size, { value: s.size });
      set(g, SVI.frames, { value: p.frames });
      set(g, SVI.steps, { value: p.steps });
      set(g, SVI.split, { value: p.steps! / 2 });
      SVI.shots.forEach((shot, i) => set(g, shot.noise, { noise_seed: seed + i }));
      // Fewer shots: the finishing nodes take the frames joined so far, and ComfyUI skips the rest.
      set(g, SVI.finish, { anything: SVI.shots[p.shots! - 1].merged });
      // The models picked in Settings go in when the render is sent (submit → applyWanModels).
      break;
    }
    case "song": {
      // The text encoder's own seed drives the language model that writes the audio codes; the sampler's the rest.
      const s = p.song!;
      set(g, m.promptNode, { seed, duration: s.seconds, bpm: s.bpm, keyscale: s.key, timesignature: s.meter, language: s.language });
      set(g, m.latent!, { seconds: s.seconds });
      if (s.quality === "high") set(g, "1", { unet_name: ACE_MODELS.high });
      break;
    }
  }
}
