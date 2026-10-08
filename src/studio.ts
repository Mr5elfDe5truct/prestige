// Studio screen: the real renders in ComfyUI's output folder, and a create bar that queues the
// stack's own ComfyUI workflows (Qwen-Image-2.1 or its 4-step turbo for images, Z-Image-Turbo without
// them, Qwen-Image-2.1 to edit an image, LTX-2.5 for video with sound, Wan 2.2 to animate an image, or Wan 2.2 SVI
// to make a longer video from it in up to four chained shots), and ACE-Step 1.5 for songs (a style, lyrics, a length).
// A reference image (a character or an item, from reference.ts) puts that subject into a new scene with Qwen-Image-2.1;
// in Video mode that picture (or the reference itself) becomes LTX-2.5's first frame.
// The Webcam mode shows the camera pane from camera.ts. Chat uses renderMedia() to make images or a video the same way
// and show them inline. Size, quality, seed, count, length and fps come from gensettings.ts, shared with chat.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { errMsg, http } from "./backends";
import { cardsText, comfyCards, heldOn, othersText, readHolders, shortName, vramGB } from "./gpus";
import {
  ASPECTS,
  LTX_FPS,
  LTX_RES,
  LTX_SECONDS,
  QUALITY_NAMES,
  SIZES,
  SONG_BPMS,
  SONG_KEYS,
  SONG_LANGUAGES,
  SONG_METERS,
  SONG_SECONDS,
  SVI_FPS,
  SVI_FRAMES,
  SVI_SHOTS,
  SVI_SIZES,
  WAN_RES,
  WAN_SECONDS,
  aboutTime,
  imageDims,
  lastSeed,
  ltxFrames,
  onSettingsChange,
  parseRes,
  reset,
  settings,
  sviSeconds,
  takeSeed,
  update,
  wanAuto,
  wanFrames,
  type MusicSettings,
  type Quality,
  type SettingsKey,
  type VideoSettings,
} from "./gensettings";
import { CONSENT, bindRefChoices, hasFiles, imageIn, loadReference, onRefPrefsChange, refChoicesHtml, refPrefs, refPrompt, referenceFromBase64, sceneOf, setRefPrefs, uploadReference, type RefKind, type Reference } from "./reference";
import { characterById, characters, faceBlob, onCharactersChange } from "./characters";
import { initInpaint, openInpaint, type SelectQuery } from "./inpaint";
import { initLaser, openLaser } from "./laser";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll(s)) as T[];

const COMFY = "http://127.0.0.1:8188";

interface Asset {
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
}

type GenMode =
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
  | "song"
  | "model3d"
  | "talk"
  | "select"
  | "cutout"
  | "vidcut"
  | "upimage"
  | "upvideo";

// How a workflow takes the generation settings: an image model with a latent size and batch, an edit
// (size follows the picture), LTX with a 2× upscale pass ("ltx") or without ("ltx1"), Wan's two samplers,
// Wan 2.2 SVI's chained shots ("svi"), an ACE-Step song ("song"), Pixal3D turning a picture into a textured 3D model ("model3d"),
// InfiniteTalk making a picture speak a voice recording ("talk"), SAM 3.1 selecting something in a picture ("select", not
// queued), a picture cut out onto transparent ("cutout"), or SAM 3.1 tracking a subject through a video ("vidcut").
// SeedVR2 sharpening a picture or a video to 1080p or 4K ("upscale").
type Family = "image" | "edit" | "ltx" | "ltx1" | "wan" | "svi" | "song" | "model3d" | "talk" | "select" | "cutout" | "vidcut" | "upscale";

interface Mode {
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
  fallback?: Mode; // used when this workflow file isn't there
}

/* InfiniteTalk on an RTX 3060 12 GB at 448×640, 4 steps (ComfyUI's log and nvidia-smi): 55 s a step, so each 81-frame
 * part takes ~255 s, plus ~15 s for the rest once the models are in RAM. 3.2 s of speech (one part) took 264 s, 8 s
 * (three parts) 774 s; VRAM peaked at 10.1 GB either way, as ComfyUI streams the rest of Wan 2.1 14B from RAM.
 * That's ~1.5 minutes of rendering per second of speech, so a talking video is capped at 30 s (~47 min). */
const TALK_PART_SECS = 255;
const TALK_LOAD_SECS = 15;
/** The longest speech a talking video takes, in seconds. */
export const TALK_MAX_SECONDS = 30;

/* SAM 3.1 tracking a subject through a video, measured on an RTX 3060 12 GB: 8 s at 448×640 (199 frames) in 123 s,
 * peak 4.0 GB. On the RTX 2060 6 GB it took 117 s at 3.0 GB, so a second card can run it (see segment). */
const VIDCUT_SECS = 15;

/* SeedVR2 on an RTX 3060 12 GB (nvidia-smi every 2 s): a 1024² picture to 1080p in 9 s, to 4K (2160²) in 15 s with
 * the 3B model at 6.3 GB, or with the 7B at 10.6 GB (and a 832×1216 portrait to 2160×3156 in 18 s at 10.5 GB); the 7B is
 * more faithful (SSIM 0.92 against the original, 0.86 for the 3B) at the same speed.
 * Videos to 1080p with the 3B: sampling is quick (~3 s per 21 frames); SeedVR2's VAE is what takes the time, ~5 s a
 * frame at 1620×1080. 2 s of 768×512 took 378 s with the template's 512 px tiles, 267 s with 1024 px tiles and 128-frame
 * temporal tiles (7.1 GB), 240 s untiled (7.8 GB, but that grows with the length). SeedVR2's own automatic chunking
 * picked 1 frame per chunk at 1080p, so chunks are set to 21 frames, which keeps the frames consistent. */
const UPSCALE_IMAGE_SECS = 20;
const UPSCALE_VIDEO_SECS = 130;
/** What an upscale's shorter side becomes. */
export type UpscaleSize = 1080 | 2160;

// The nodes in the stack's exported API workflows (workflows\*.api.json) that the settings go into.
const QWEN_STEPS = { draft: 12, standard: 20, high: 30, max: 40 };
const ZIMAGE: Mode = {
  file: "z-image-turbo.api.json",
  label: "Z-Image-Turbo",
  family: "image",
  promptNode: "4",
  seed: ["7", "seed"],
  latent: "6",
  steps: { draft: 6, standard: 8, high: 12, max: 16 },
  secs: 40,
};
const MODES: Record<GenMode, Mode> = {
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
    steps: { draft: 3, standard: 4, high: 6, max: 8 },
    secs: 25,
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
    secs: 40,
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
};

/* ACE-Step 1.5 turbo on an RTX 3060 12 GB (ComfyUI's log and nvidia-smi): its 1.7B language model writes the audio codes
 * (~60 tokens/s), then 8 diffusion steps and a tiled VAE decode. Each song loads the models fresh (~5.2 GB peak at any
 * length): 30 s of music took 18 s, 60 s 26 s, 120 s 44 s, 180 s 62 s, 240 s 53 s. On a 6 GB RTX 2060 the language
 * model ran at 1.7 s a token (a 60 s song took 9 min), so songs stay on ComfyUI's main card. */
const SONG_FIXED_SECS = 10;
const SONG_SECS_PER_SECOND = 0.3;
const SONG_PEAK_GB = 5.3;
/** What a song's progress line says for each step. */
const SONG_STEPS: Record<string, string> = {
  "TextEncodeAceStepAudio1.5": "Composing the melody and vocals",
  KSampler: "Rendering the audio",
  VAEDecodeAudioTiled: "Decoding the audio",
  SaveAudioMP3: "Saving the MP3",
};

// Pixal3D's samplers, in order (structure, shape, upsampled shape, texture): each gets its own seed.
const MODEL3D_SAMPLERS = ["3", "18", "23", "12"];
/** What a 3D render's progress line says for each of its steps. */
const MODEL3D_STEPS: Record<string, string> = {
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
const TALK = { audio: "8", encode: "9", talk: "12", scheduler: "14", sampler: "17", decode: "18", frames: "20", fps: 25, part: 81, motion: 9 };
/** What an upscale's progress line says. */
const UPSCALE_STEPS: Record<string, string> = {
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
const CUT_STEPS: Record<string, string> = {
  RemoveBackground: "Finding the subject",
  SAM3_VideoTrack: "Tracking the subject in every frame",
  SAM3_TrackToMask: "Cutting it out",
  ImageCompositeMasked: "Putting it on a green screen",
  CreateVideo: "Making the video",
  SaveVideo: "Saving the video",
  SaveImage: "Saving the PNG",
};
/** What a talking video's progress line says for its other steps. */
const TALK_STEPS: Record<string, string> = {
  LoadAudio: "Loading the voice",
  AudioEncoderEncode: "Listening to the voice",
  WanInfiniteTalkToVideo: "Matching the lips to the voice",
  CreateVideo: "Adding the voice",
  SaveVideo: "Saving the video",
};

/** A talking video's size: the picture's shape at the area of 448×640, in multiples of 16. On the 3060 a step took 54 s
 *  there and 81 s at 528×768 (480p's full area), and the faces looked as good. */
const TALK_AREA = 448 * 640;
function talkDims(srcW?: number | null, srcH?: number | null): [number, number] {
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
function talkPlan(src: Source | null, seconds: number): Plan {
  const [w, h] = talkDims(src?.width, src?.height);
  const parts = talkParts(seconds);
  return { w, h, count: 1, seconds, frames: Math.ceil(seconds * TALK.fps), fps: TALK.fps, shots: parts, load: 0, secs: TALK_LOAD_SECS + TALK_PART_SECS * parts, warn: "" };
}

/** Chains InfiniteTalk parts until the frames cover the speech. A part carries on from the last 9 frames of the one
 *  before, and counts that part's frames to know where it is in its recording, so each gets the voice from where the
 *  previous part started (its first 72 frames' worth then lie behind it). Its own first 9 frames repeat the previous
 *  part's last 9, so they're dropped, and the parts are joined once at the end and cut to the speech's length. (Giving
 *  each part everything made so far instead kept every growing copy in RAM: ~20 GB for 23 s.) */
function talkGraph(g: any, p: Plan, seed: number) {
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
function talkLabels(nodes: Record<string, string>, parts: number) {
  for (let k = 1; k <= parts; k++) {
    const of = parts > 1 ? ` part ${k} of ${parts}` : "";
    nodes[k === 1 ? TALK.sampler : `${k}07`] = `Animating${of || " the face"}`;
    nodes[k === 1 ? TALK.decode : `${k}08`] = `Decoding${of || " the frames"}`;
  }
}

// The SVI workflow's nodes: each shot's prompt and noise, the merge after each shot, and the settings.
const SVI = {
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
const SVI_BASE = 480 * 480 * 49 * 4;

/** A long video's prompt: one per shot, separated by "|". A shorter list repeats its last prompt. */
function shotPrompts(prompt: string, shots: number): string[] {
  const parts = prompt.split("|").map((s) => s.trim()).filter(Boolean);
  return Array.from({ length: shots }, (_, i) => parts[Math.min(i, parts.length - 1)] ?? prompt);
}

// ---------- generation settings → workflow inputs ----------
interface Plan {
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

const settingsKey = (gm: GenMode): SettingsKey =>
  gm === "video" || gm === "refvideo" ? "video" : gm === "animate" ? "animate" : gm === "long" ? "long" : gm === "song" ? "music" : "image";
const isVideo = (gm: GenMode) => gm === "video" || gm === "animate" || gm === "long" || gm === "refvideo";

/** A picture a render starts from: a render in the gallery (edit, animate) or a reference image. */
type Source = Asset | Reference;
/** Changes to a plan for one step of a chain: the first frame for a video is one picture at the video's shape. */
type Override = { w: number; h: number; count: 1 };

/** "2:30", "45 s". */
const songLength = (s: number) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

/** The quality levels a model offers, with their steps. */
const levels = (m: Mode) => (Object.keys(QUALITY_NAMES) as Quality[]).filter((q) => m.steps?.[q] != null);
const stepsOf = (m: Mode, q: Quality) => m.steps?.[q] ?? m.steps?.standard;

const LTX_BASE = 768 * 512 * 97;
const LTX_FRAME = 768 * 512;

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
const LTX_MODEL_GB = 15.7;
const LTX_FIXED_MIB = 2854;
const LTX_FRAME_MIB = 10;
const LTX_UPSCALER_MIB = 1120;
const LTX_DRAFT_FIXED_MIB = 2526;

/** GB of the LTX-2.5 diffusion model that stays on ComfyUI's main card for this render (the rest streams from RAM). */
function ltxRoom(w: number, h: number, frames: number, draft: boolean): { room: number; mainGB: number } {
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
const DESKTOP_MIB = 1024;
const othersGB = (index: number) => Math.max(0, heldOn(index).others - DESKTOP_MIB) / 1024;
let rechecking = false;
function takenGB(index: number): number {
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
function takenText(index: number): string {
  const gb = takenGB(index);
  const who = othersText(index);
  return gb >= 0.5 && who ? ` Other programs are using ${gb.toFixed(1)} GB of it (${who}); closing them gives ComfyUI more room.` : "";
}
const WAN_BASE = 832 * 480 * 81;
const MP = 1024 * 1024;

/** The SVI render size: the picture's shape with its longest side at `size`, in multiples of 32. */
function sviDims(size: number, srcW?: number | null, srcH?: number | null): [number, number] {
  const r = srcW && srcH ? srcW / srcH : 1;
  const r32 = (x: number) => Math.max(32, Math.round(x / 32) * 32);
  return r >= 1 ? [r32(size), r32(size / r)] : [r32(size * r), r32(size)];
}

/** What a render with the current settings will be: sizes, steps, frames, and a VRAM and time estimate. A song can
 *  take its own tempo, key and language (chat's songwriter picks them) over the saved ones. */
function plan(gm: GenMode, src: Source | null = srcAsset, o?: Override, song?: Partial<MusicSettings>, video?: Partial<VideoSettings>): Plan {
  const m = modeOf(gm);
  let p: Omit<Plan, "warn">;
  // Picture to 3D: one model per picture; its time and VRAM were measured (see MODES.model3d).
  if (m.family === "model3d" || m.family === "select" || m.family === "cutout" || m.family === "upscale") return { w: 0, h: 0, count: 1, load: 0, secs: m.secs, warn: "" };
  if (m.family === "vidcut") return { w: 0, h: 0, count: 1, load: 0, secs: m.secs * 8, warn: "" }; // per second of video (videoCutout)
  if (m.family === "song") {
    // Measured (see SONG_FIXED_SECS): the same ~5.3 GB at every length, so only a small card gets a warning.
    const s = { ...settings().music, ...song };
    const { main } = comfyCards();
    const mainGB = main ? main.mem_total / 1024 : vramGB("comfyui");
    const where = main ? `the ${shortName(main)}'s ${Math.round(mainGB)} GB` : cardsText("comfyui");
    const warn = mainGB < SONG_PEAK_GB + 0.7 ? `ACE-Step peaks at about ${SONG_PEAK_GB} GB, more than ${where} can hold: it will run partly from system RAM, slowly.` : "";
    return { w: 0, h: 0, count: 1, seconds: s.seconds, song: s, load: 0, secs: SONG_FIXED_SECS + SONG_SECS_PER_SECOND * s.seconds, warn };
  }
  if (m.family === "image" || m.family === "edit") {
    const s = settings().image;
    const steps = stepsOf(m, s.quality)!;
    const ratio = steps / m.steps!.standard!;
    if (m.family === "edit") {
      const px = src?.width && src.height ? (src.width * src.height) / MP : 1;
      p = { w: 0, h: 0, steps, count: 1, load: px, secs: m.secs * px * ratio };
    } else {
      const [w, h] = o ? [o.w, o.h] : imageDims(s.aspect, s.size);
      const count = o ? o.count : s.count;
      const px = (w * h) / MP;
      p = { w, h, steps, count, load: px * count, secs: m.secs * px * count * ratio };
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
function set(g: any, id: string, inputs: Record<string, unknown>) {
  if (g[id]) Object.assign(g[id].inputs, inputs);
}

/** Writes the plan and seed into a copy of the workflow. */
function apply(m: Mode, g: any, p: Plan, seed: number) {
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
      // The models picked in Settings (kept on this PC only), with the loader each file type needs. fp16
      // accumulation speeds up safetensors models but breaks GGUF ones, so it's on only for safetensors.
      for (const [id, patch, name] of [[SVI.high, SVI.fp16[0], s.high], [SVI.low, SVI.fp16[1], s.low]] as const) {
        if (!name || !g[id]) continue;
        const gguf = /\.gguf$/i.test(name);
        g[id] = gguf
          ? { class_type: "UnetLoaderGGUF", inputs: { unet_name: name } }
          : { class_type: "UNETLoader", inputs: { unet_name: name, weight_dtype: "default" } };
        set(g, patch, { enable_fp16_accumulation: !gguf });
      }
      break;
    }
    case "song": {
      // The text encoder's own seed drives the language model that writes the audio codes; the sampler's the rest.
      const s = p.song!;
      set(g, m.promptNode, { seed, duration: s.seconds, bpm: s.bpm, keyscale: s.key, timesignature: s.meter, language: s.language });
      set(g, m.latent!, { seconds: s.seconds });
      break;
    }
  }
}
// The Image mode's model: Qwen-Image-2.1, or its 4-step turbo when "fast" is picked (remembered).
let imageMode: "image" | "fast" = (() => {
  try {
    return localStorage.getItem("studio.imageModel") === "fast" ? "fast" : "image";
  } catch {
    return "image";
  }
})();
// Animating a picture: one Wan 2.2 clip, or a long video in chained shots with Wan 2.2 SVI (remembered).
let animateMode: "animate" | "long" = (() => {
  try {
    return localStorage.getItem("studio.animateModel") === "long" ? "long" : "animate";
  } catch {
    return "animate";
  }
})();

interface Deps {
  toast: (msg: string, kind?: string) => void;
  root: () => string | null;
  freeGpu: () => Promise<void>;
  cameraPane: (on: boolean) => void;
  /** Switches to the Studio screen (from the lightbox when it was opened in chat). */
  show: () => void;
  /** Opens a 3D model (.glb) in the Canvas's 3D viewer. */
  openModel: (path: string, name: string) => void;
  /** Lyrics for a song in this style from the chat model, about `seconds` long (Music mode's "Write lyrics"). */
  writeLyrics: (style: string, seconds: number, signal: AbortSignal) => Promise<string>;
  /** Opens "Make it talk" for this picture: what to say and in which voice. */
  makeTalk: (path: string) => void;
}

let deps: Deps;
let items: Asset[] = [];
let filter: "all" | "image" | "video" | "audio" = "all";
let mode: "image" | "video" | "music" | "webcam" = "image";
// The image being animated (Video mode) or edited (Image mode), picked from the lightbox.
let srcAsset: Asset | null = null;
// The reference image (a character or item to put in a new scene), and how it's used. Kept across Image and Video.
let ref: Reference | null = null;
// How it's used (Auto / Character / Item, and a video's first frame) is in reference.ts, shared with chat.
// Shown before the progress label during a two-step render ("Step 1 of 2 · first frame · ").
let stepNote = "";
const workflows: Partial<Record<GenMode, any>> = {};
const active: Partial<Record<GenMode, Mode>> = {}; // the Mode (or fallback) each workflow was loaded from
const clientId = `prestige-${Math.random().toString(36).slice(2, 10)}`;
let job: { id: string; mode: GenMode; started: number; prompt: string; nodes: Record<string, string>; outputs: string[]; seed: number; count: number } | null = null;
let starting = false; // freeing the GPU / uploading, before ComfyUI has the job
let fresh = new Set<string>(); // names of the files the last render made
let workflowsLoaded: Promise<void> | null = null;
let settingsOpen = false;
// A render started from chat: it hears the progress and gets the finished files.
let waiter: { progress: (pct: number, label: string) => void; resolve: (a: Asset[]) => void; reject: (e: Error) => void } | null = null;

const age = (ms: number) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

export function initStudio(d: Deps) {
  initInpaint();
  $("#rq-clear").addEventListener("click", () => {
    for (let i = rq.length - 1; i >= 0; i--) if (!["waiting", "running"].includes(rq[i].state)) rq.splice(i, 1);
    renderQueue();
  });
  deps = d;
  initLaser({ toast: d.toast, root: d.root, openRender });
  $$(".filters [data-f]").forEach((b) =>
    b.addEventListener("click", () => {
      filter = b.dataset.f as typeof filter;
      $$(".filters [data-f]").forEach((x) => x.classList.toggle("on", x === b));
      render();
    }),
  );
  $$(".modes [data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      mode = b.dataset.mode as typeof mode;
      srcAsset = null;
      renderCreate();
    }),
  );
  $("#animate-clear").addEventListener("click", () => {
    srcAsset = null;
    renderCreate();
  });
  initRefSlot();
  $("#gen-opts").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".opt.set")) {
      settingsOpen = !settingsOpen;
      return renderCreate();
    }
    if (t.closest(".opt.model")) flipModel(mode === "video");
  });
  onSettingsChange(() => renderCreate());
  initSongWriter();
  $("#gen-form").addEventListener("submit", (e) => {
    e.preventDefault();
    generate();
  });
  $("#lb-close").addEventListener("click", closeLightbox);
  $("#lb").addEventListener("click", (e) => {
    if (e.target === $("#lb")) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if ($("#lb").hidden || (e.target as HTMLElement)?.closest?.("input, textarea, dialog")) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "Delete" && lbAsset) deleteRender(lbAsset);
  });
  listen<any>("comfy", (e) => onComfy(e.payload));
}

let holdersTimer: number | undefined;
export async function showStudio(on: boolean) {
  clearInterval(holdersTimer);
  if (!on) return;
  // While Studio is open, a program starting or closing on ComfyUI's card updates the warnings (takenGB redraws).
  holdersTimer = window.setInterval(() => {
    const main = comfyCards().main;
    if (main) takenGB(main.index);
  }, 3000);
  if (mode === "webcam") deps.cameraPane(true);
  await ensureWorkflows();
  await refresh();
}

let workflowsRoot: string | null | undefined; // the Workstation folder they were read from
let workflowsDone = false;
function ensureWorkflows() {
  // Once read, read them again if the Workstation folder changed or one was missing (it may be installed since).
  const root = deps.root();
  if (workflowsDone && (root !== workflowsRoot || Object.values(workflows).some((w) => !w))) workflowsLoaded = null;
  return (workflowsLoaded ??= loadWorkflows());
}

async function loadWorkflows() {
  workflowsDone = false;
  workflowsRoot = deps.root();
  for (const gm of Object.keys(MODES) as GenMode[]) {
    workflows[gm] = null;
    for (let m: Mode | undefined = MODES[gm]; m; m = m.fallback) {
      try {
        workflows[gm] = await invoke("read_workflow", { root: deps.root(), name: m.file });
        active[gm] = m;
        break;
      } catch {}
    }
  }
  workflowsDone = true;
  renderCreate();
}

/** The workflow the create bar runs now. */
function currentMode(): GenMode {
  if (mode === "music") return "song";
  if (mode === "video") return srcAsset ? animatePick() : ref ? "refvideo" : "video";
  if (srcAsset) return "edit";
  if (ref) return refImageMode();
  return workflows[imageMode] ? imageMode : "fast";
}

/** The workflow that animates a picture: the remembered pick, or whichever of the two is there. */
const animatePick = (): GenMode => (animateMode === "long" ? (workflows.long ? "long" : "animate") : workflows.animate ? "animate" : workflows.long ? "long" : "animate");

/** The reference-image workflow for the Image mode's model pick (Qwen-Image-2.1 or its turbo). */
const refImageMode = (): GenMode => (imageMode === "fast" ? (workflows.reffast ? "reffast" : "ref") : workflows.ref ? "ref" : "reffast");

/** A video from a reference: Qwen-Image makes the first frame first, unless the reference itself is the first frame. */
const chained = (gm: GenMode) => gm === "refvideo" && refPrefs().frame === "scene";

/** The first frame's size for a video: the video's shape at about a megapixel (LTX scales it to the clip). */
function frameSize(): Override {
  const [w, h] = parseRes(settings().video.res);
  const k = Math.sqrt(MP / (w * h));
  const r16 = (x: number) => Math.round((x * k) / 16) * 16;
  return { w: r16(w), h: r16(h), count: 1 };
}

const modeOf = (gm: GenMode) => active[gm] ?? MODES[gm];

function renderCreate() {
  const webcam = mode === "webcam";
  const gm = currentMode();
  $$(".modes [data-mode]").forEach((x) => x.classList.toggle("on", x.dataset.mode === mode));
  $("#gen-form").hidden = webcam;
  $("#gen-opts").hidden = webcam;
  $("#cam-pane").hidden = !webcam;
  deps?.cameraPane(webcam);
  $("#animate-src").hidden = webcam || !srcAsset;
  if (srcAsset) {
    ($("#animate-img") as HTMLImageElement).src = convertFileSrc(srcAsset.path);
    $("#animate-what").textContent = `${gm === "edit" ? "Editing" : "Animating"} this image with ${modeOf(gm).label}`;
  }
  // A song takes lyrics beside its style (empty: an instrumental).
  $("#song-lyrics").hidden = gm !== "song";
  renderRefSlot(gm, webcam || gm === "song");
  if (webcam) {
    $("#gen-warn").hidden = true;
    $("#gen-settings").hidden = true;
    return;
  }
  const chain = chained(gm);
  const first = refImageMode();
  // A chained video also needs the reference-image workflow for its first frame.
  const missing = !workflows[gm] ? modeOf(gm).file : chain && !workflows[first] ? modeOf(first).file : "";
  const wf = workflows[gm] && !missing;
  const m = modeOf(gm);
  $("#create").classList.toggle("disabled", !wf);
  ($("#gen-btn") as HTMLButtonElement).disabled = !wf;
  // While something renders, the button adds to the queue.
  ($("#gen-btn") as HTMLButtonElement).textContent = buttonText(gm);
  ($("#gen-prompt") as HTMLInputElement).placeholder = promptHint(gm);
  // In Image mode the model chip switches between Qwen-Image-2.1 and its faster turbo (or Z-Image-Turbo);
  // when animating a picture, between one Wan 2.2 clip and a long Wan 2.2 SVI video.
  const animating = gm === "animate" || gm === "long";
  const label = chain ? `${modeOf(first).label} → ${m.label}` : m.label;
  const chip = canPick(gm)
    ? `<button type="button" class="opt pick model" title="${animating ? "Switch between one clip and a long video" : "Switch image model"}"><b>${label}</b> ⇄</button>`
    : `<span class="opt"><b>${label}</b></span>`;
  const p = plan(gm);
  // A chained video's time includes making its first frame.
  const shown = chain ? { ...p, secs: p.secs + plan(first, ref, frameSize()).secs } : p;
  const what = gm === "song" ? "Length, tempo, key, language, seed" : `Size, quality, seed${isVideo(gm) ? ", length" : ", count"}`;
  const gear = `<button type="button" class="opt pick set${settingsOpen ? " on" : ""}" title="${what}…" aria-expanded="${settingsOpen}">⚙ Settings</button>`;
  $("#gen-opts").innerHTML = wf
    ? chip + summary(gm, shown).map((o) => `<span class="opt"><b>${o}</b></span>`).join("") + gear
    : `<span class="opt">workflows\\${esc(missing)} not found, so this mode is off</span>`;
  const warn = $("#gen-warn");
  warn.hidden = !wf || !p.warn;
  warn.textContent = p.warn;
  const panel = $("#gen-settings");
  panel.hidden = !wf || !settingsOpen;
  if (!panel.hidden) settingsForm(panel, gm, false);
}

/** The create button's words: "Add to queue" while something renders. */
const buttonText = (gm: GenMode) =>
  job || starting || current ? "Add to queue" : gm === "animate" || gm === "long" ? "Animate" : gm === "edit" ? "Edit" : gm === "song" ? "Make song" : "Generate";

/** Whether the model chip can switch: Qwen-Image-2.1 and its turbo, or one Wan 2.2 clip and a long SVI video. */
const canPick = (gm: GenMode) =>
  !!(
    ((gm === "image" || gm === "fast") && workflows.fast && workflows.image && active.image !== ZIMAGE) ||
    ((gm === "ref" || gm === "reffast") && workflows.ref && workflows.reffast) ||
    ((gm === "animate" || gm === "long") && workflows.animate && workflows.long)
  );

/** The model chip: switches the image model, or one clip and a long video (Studio and the phone). */
function flipModel(video: boolean) {
  if (video) {
    animateMode = animateMode === "long" ? "animate" : "long";
    try {
      localStorage.setItem("studio.animateModel", animateMode);
    } catch {}
  } else {
    imageMode = imageMode === "fast" ? "image" : "fast";
    try {
      localStorage.setItem("studio.imageModel", imageMode);
    } catch {}
  }
  renderCreate();
}

/** What the prompt box asks for in a mode. */
function promptHint(gm: GenMode) {
  const chain = chained(gm);
  return gm === "song"
      ? "Describe the style… e.g. dreamy indie pop, soft female vocals, warm guitars, summer night"
      : gm === "image" || gm === "fast"
      ? "Describe an image… e.g. a red and gold dragon coiled around a glowing GPU"
      : gm === "ref" || gm === "reffast"
        ? "Describe the new scene… e.g. sitting at a café in Paris at golden hour, laughing"
        : gm === "edit"
          ? "Say what to change… e.g. make it night, swap the car for a horse, remove the sign"
          : gm === "animate"
            ? "Describe the motion… e.g. slow push-in, snow falling, warm light flickering"
            : gm === "long"
              ? settings().long.shots > 1
                ? "One prompt per shot, split with | … e.g. slow push-in | pans right along the porch | tilts up to the peaks"
                : "Describe the motion… e.g. slow push-in, snow falling, warm light flickering"
            : gm === "refvideo" && !chain
              ? "Describe the motion and sound… e.g. turns to the camera and waves, birds singing"
              : `Describe a ${settings().video.seconds}-second scene${gm === "refvideo" ? " with your reference in it" : ""}, including any sound…`;
}

// ---------- song lyrics ----------
/** Music mode's "Write lyrics": the chat model writes lyrics for the style in the prompt box (click again to stop). */
function initSongWriter() {
  const btn = $<HTMLButtonElement>("#song-write");
  const box = $<HTMLTextAreaElement>("#song-lyrics-text");
  let writing: AbortController | null = null;
  btn.addEventListener("click", async () => {
    if (writing) return writing.abort();
    const style = ($("#gen-prompt") as HTMLInputElement).value.trim();
    if (!style) {
      deps.toast("Describe the song's style or what it's about first, then Write lyrics.");
      return $("#gen-prompt").focus();
    }
    if (box.value.trim() && !confirm("Replace the lyrics in the box?")) return;
    writing = new AbortController();
    btn.textContent = "Stop writing";
    box.classList.add("writing");
    try {
      box.value = await deps.writeLyrics(style, settings().music.seconds, writing.signal);
    } catch (e) {
      if (!writing.signal.aborted) deps.toast(`Couldn't write lyrics: ${errMsg(e)}`, "warn");
    } finally {
      writing = null;
      btn.textContent = "✍ Write lyrics for me";
      box.classList.remove("writing");
    }
  });
}

// ---------- reference image slot ----------
const studioShown = () => !$('[data-screen="studio"]').hidden;

function initRefSlot() {
  const file = $<HTMLInputElement>("#ref-file");
  $("#ref-add").addEventListener("click", () => file.click());
  $("#ref-change").addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    file.value = "";
    if (f) setRef(f);
  });
  $("#ref-clear").addEventListener("click", () => setRef(null));
  $("#ref-character").addEventListener("change", async (e) => {
    const c = characterById((e.target as HTMLSelectElement).value);
    if (!c?.face) return;
    setRefPrefs({ kind: "character" });
    await setRef(faceBlob(c));
  });
  onCharactersChange(() => renderCreate());
  bindRefChoices($("#ref-picks"));
  onRefPrefsChange(() => renderCreate());
  // Drop a picture anywhere on the create bar, or paste one while Studio is open.
  const create = $("#create");
  create.addEventListener("dragover", (e) => {
    if (!hasFiles(e) || mode === "webcam") return;
    e.preventDefault();
    create.classList.add("drop");
  });
  create.addEventListener("dragleave", (e) => {
    if (!create.contains(e.relatedTarget as Node)) create.classList.remove("drop");
  });
  create.addEventListener("drop", (e) => {
    create.classList.remove("drop");
    const f = imageIn(e.dataTransfer);
    if (!f || mode === "webcam") return;
    e.preventDefault();
    setRef(f);
  });
  document.addEventListener("paste", (e) => {
    if (!studioShown() || mode === "webcam" || (e.target as HTMLElement)?.closest?.("dialog")) return;
    const f = imageIn(e.clipboardData);
    if (!f) return;
    e.preventDefault();
    setRef(f);
  });
}

/** Sets (or with null clears) the reference image. */
async function setRef(src: Blob | null) {
  try {
    const r = src ? await loadReference(src) : null;
    if (ref) URL.revokeObjectURL(ref.url);
    ref = r;
    if (r) srcAsset = null; // a reference replaces a picked edit or animate source
  } catch (e) {
    deps.toast(errMsg(e), "warn");
  }
  renderCreate();
  if (ref) $("#gen-prompt").focus();
}

/** "Use as reference image" on a render: Studio's create bar takes it as the reference. */
async function useAsReference(a: Asset) {
  deps.show();
  closeLightbox();
  try {
    await setRef(await (await fetch(convertFileSrc(a.path))).blob());
  } catch (e) {
    deps.toast(`Couldn't read ${a.name}: ${errMsg(e)}`, "warn");
  }
}

function renderRefSlot(gm: GenMode, webcam: boolean) {
  const usable = !!(workflows.ref || workflows.reffast);
  $("#ref-slot").hidden = webcam || !!srcAsset || !usable;
  $("#ref-add").hidden = !!ref;
  $("#ref-set").hidden = !ref;
  // Or one of the characters' faces.
  const faces = characters().filter((c) => c.face);
  $("#ref-char-wrap").hidden = !!ref || !faces.length;
  if (!ref && faces.length) {
    const sel = $<HTMLSelectElement>("#ref-character");
    sel.innerHTML = `<option value="">Pick…</option>` + faces.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  }
  if (!ref) return;
  ($("#ref-img") as HTMLImageElement).src = ref.url;
  $("#ref-what").textContent = refWhat(gm);
  $("#ref-picks").innerHTML = refChoicesHtml(gm === "refvideo");
  $("#ref-consent").textContent = CONSENT;
}

/** What happens to the reference in this mode. */
const refWhat = (gm: GenMode) =>
  gm === "refvideo"
    ? chained(gm)
      ? `Reference: ${modeOf(refImageMode()).label} puts it in the first frame, then ${modeOf(gm).label} animates it`
      : `Reference: ${modeOf(gm).label} animates this picture as it is`
    : `Reference: ${modeOf(gm).label} puts it in the scene you describe`;

/** The settings as chips: size, steps, length, seed and a time estimate. */
function summary(gm: GenMode, p: Plan): string[] {
  const m = modeOf(gm);
  const s = settings()[settingsKey(gm)];
  const out: string[] = [];
  if (p.song) {
    const sg = p.song;
    out.push(songLength(sg.seconds), `${sg.bpm} bpm`, sg.key, SONG_METERS.find(([v]) => v === sg.meter)?.[1].split(" ")[0] ?? sg.meter);
    if (sg.language !== "en") out.push(SONG_LANGUAGES.find(([c]) => c === sg.language)?.[1] ?? sg.language);
    out.push(s.seed != null ? `seed ${s.seed}` : "random seed", aboutTime(p.secs));
    return out;
  }
  if (p.w) out.push(`${p.w} × ${p.h}`);
  if (p.seconds) out.push(`${p.seconds} s · ${p.fps} fps`);
  if (p.steps) out.push(`${p.steps} steps`);
  if (p.draft) out.push("draft, one pass");
  if (m.family === "ltx" || m.family === "ltx1") out.push("with sound");
  if (p.shots) out.push(p.shots === 1 ? "1 shot" : `${p.shots} shots`);
  if (m.family === "wan" || m.family === "svi") out.push("no sound");
  if (p.count > 1) out.push(`${p.count} images`);
  if (m.note) out.push(m.note);
  if (gm === "refvideo") out.push(chained(gm) ? "your reference in a new first frame" : "your reference as the first frame");
  out.push(s.seed != null ? `seed ${s.seed}` : "random seed");
  out.push(aboutTime(p.secs));
  return out;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const optionList = (pairs: [string | number, string][], cur: string | number) =>
  pairs.map(([v, l]) => `<option value="${v}"${String(v) === String(cur) ? " selected" : ""}>${esc(l)}</option>`).join("");

// The diffusion models ComfyUI can load (safetensors and GGUF), for the long video's model picks.
let sviModels: string[] | null = null;
let sviModelsLoading: Promise<void> | null = null;
function loadSviModels() {
  return (sviModelsLoading ??= (async () => {
    const names = new Set<string>();
    for (const [node, input] of [["UNETLoader", "unet_name"], ["UnetLoaderGGUF", "unet_name"]]) {
      try {
        const r = await http(`${COMFY}/object_info/${node}`);
        const list = (await r.json())?.[node]?.input?.required?.[input]?.[0];
        if (Array.isArray(list)) list.forEach((n: string) => names.add(n));
      } catch {}
    }
    sviModels = [...names].sort((a, b) => a.localeCompare(b));
    // Let a later open try again if ComfyUI wasn't running.
    if (!sviModels.length) {
      sviModels = null;
      sviModelsLoading = null;
    }
  })());
}

/** One setting in the form: a pick from a list (Studio's panel, chat's popover and the phone draw it). */
interface Field {
  k: string;
  label: string;
  options: [string | number, string][];
  value: string | number;
  hint?: string;
}

/** The settings a mode has, as data. `src` is the picture it starts from (Wan's "Match the picture" and SVI's sizes). */
function settingsFields(gm: GenMode, src: Source | null = srcAsset): Field[] {
  const m = modeOf(gm);
  const s = settings()[settingsKey(gm)];
  const f: Field[] = [];
  const field = (label: string, k: string, options: Field["options"], value: string | number, hint = "") => f.push({ k, label, options, value, hint });
  if (m.family === "image") {
    const img = settings().image;
    field("Shape", "aspect", ASPECTS, img.aspect);
    field("Size", "size", SIZES.map(([v, l]) => [v, `${l} · ${imageDims(img.aspect, v).join(" × ")}`]), img.size);
  }
  if (m.family === "ltx" || m.family === "ltx1") {
    const v = settings().video;
    field("Resolution", "res", LTX_RES, v.res);
    field("Length", "seconds", LTX_SECONDS.map((n) => [n, `${n} seconds`]), v.seconds);
    field("Frame rate", "fps", LTX_FPS.map((n) => [n, `${n} fps`]), v.fps, `${ltxFrames(v.seconds, v.fps)} frames`);
  }
  if (m.family === "wan") {
    const v = settings().animate;
    const auto = wanAuto(src?.width, src?.height).join(" × ");
    field("Resolution", "res", WAN_RES.map(([r, l]) => [r, r === "auto" ? `${l} (${auto})` : l]), v.res);
    field("Length", "seconds", WAN_SECONDS.map((n) => [n, `${n} seconds`]), v.seconds, `${wanFrames(v.seconds)} frames at 16 fps, Wan's own rate`);
  }
  if (m.family === "svi") {
    const v = settings().long;
    const dims = (n: number) => sviDims(n, src?.width, src?.height).join(" × ");
    field("Size", "size", SVI_SIZES.map((n) => [n, `${dims(n)} · saved at 2×`]), v.size);
    field("Shots", "shots", SVI_SHOTS.map((n) => [n, n === 1 ? "1 shot" : `${n} shots`]), v.shots, "Each continues the last; split the prompt with | to give each its own");
    field("Shot length", "frames", SVI_FRAMES.map((n) => [n, `${n} frames · ${sviSeconds(n, 1)} s`]), v.frames, `${sviSeconds(v.frames, v.shots)} s in all, at ${SVI_FPS * 2} fps after FILM`);
    const models = sviModels ?? [];
    const pick = (label: string, k: "high" | "low", which: string) =>
      field(
        label,
        k,
        [
          ["", `Stock Wan 2.2 4-step (${which})`],
          ...models.map((n): [string, string] => [n, n]),
          ...(v[k] && !models.includes(v[k]!) ? [[v[k]!, `${v[k]} (not found)`] as [string, string]] : []),
        ],
        v[k] ?? "",
        k === "high" ? "From ComfyUI's model folders; kept on this PC only" : "",
      );
    pick("High-noise model", "high", "high noise");
    pick("Low-noise model", "low", "low noise");
  }
  if (m.family === "song") {
    const v = settings().music;
    field("Length", "seconds", SONG_SECONDS.map((n) => [n, songLength(n)]), v.seconds);
    field("Tempo", "bpm", SONG_BPMS.map((n) => [n, `${n} bpm`]), v.bpm);
    field("Key", "key", SONG_KEYS.map((k) => [k, k]), v.key);
    field("Meter", "meter", SONG_METERS, v.meter);
    field("Lyrics language", "language", SONG_LANGUAGES, v.language, "Chat's /song picks the tempo, key and language for each song");
  }
  const quality = "quality" in s ? s.quality : "standard";
  if (m.family === "ltx") field("Quality", "quality", [["draft", "Draft · half size, one pass"], ["standard", "Standard · upscaled 2×"]], quality === "draft" ? "draft" : "standard");
  else if (m.steps) {
    const q = m.steps[quality] != null ? quality : "standard";
    field("Quality", "quality", levels(m).map((l) => [l, `${QUALITY_NAMES[l]} · ${m.steps![l]} steps`]), q);
  }
  if (m.family === "image") field("How many", "count", [1, 2, 3, 4].map((n) => [n, n === 1 ? "1 image" : `${n} images`]), settings().image.count);
  return f;
}

/** A picked option as the setting's value. Numbers stay numbers (length, fps, count, the long video's size…); words
 *  stay words. "size" is both: the long video's longest side, and an image's Small / Standard / Large, which Number()
 *  turned into NaN (saved as null). A song's meter is a digit too, but ACE-Step takes it as text ("4", "6"). */
function fieldValue(k: string, raw: string) {
  const model = k === "high" || k === "low";
  return /^\d+$/.test(raw) && k !== "meter" ? Number(raw) : model ? raw || null : raw;
}

/** The settings form for a mode (Studio's panel and chat's popover). Changes are saved and shared. */
function settingsForm(el: HTMLElement, gm: GenMode, withWarn: boolean) {
  const m = modeOf(gm);
  const key = settingsKey(gm);
  const s = settings()[key];
  const p = plan(gm);
  const f = settingsFields(gm).map(
    (x) => `<label class="field">${x.label}<select data-k="${x.k}">${optionList(x.options, x.value)}</select>${x.hint ? `<small>${x.hint}</small>` : ""}</label>`,
  );
  if (m.family === "svi" && !sviModels && !sviModelsLoading) loadSviModels().then(() => sviModels && el.isConnected && settingsForm(el, gm, withWarn));
  const last = lastSeed(key);
  f.push(
    `<label class="field seed">Seed<span class="seed-row"><input type="number" min="0" step="1" data-k="seed" placeholder="random" value="${s.seed ?? ""}" />` +
      `<button type="button" class="btn mini" data-seed="random" title="A new random seed every time">Random</button>` +
      (last != null ? `<button type="button" class="btn mini" data-seed="last" title="Keep the seed of the last render">Last · ${last}</button>` : "") +
      `</span></label>`,
  );
  el.innerHTML =
    `<div class="set-grid">${f.join("")}</div>` +
    (withWarn && p.warn ? `<p class="vram-warn">${esc(p.warn)}</p>` : "") +
    (p.cards ? `<p class="credit">VRAM: ${esc(p.cards)}</p>` : "") +
    `<div class="set-foot"><span class="credit">${m.label} · ${aboutTime(p.secs)} on an RTX 3060 12 GB · shared by Studio and chat</span><button type="button" class="linkish" data-reset>Reset to defaults</button></div>`;
  $$<HTMLSelectElement>("select", el).forEach((sel) =>
    sel.addEventListener("change", () => {
      const k = sel.dataset.k!;
      update(key, { [k]: fieldValue(k, sel.value) } as any);
    }),
  );
  const seedIn = $<HTMLInputElement>("input[data-k=seed]", el);
  seedIn.addEventListener("change", () => {
    const n = Math.floor(Number(seedIn.value));
    update(key, { seed: seedIn.value.trim() === "" || !Number.isFinite(n) || n < 0 ? null : n });
  });
  $$("[data-seed]", el).forEach((b) => b.addEventListener("click", () => update(key, { seed: b.dataset.seed === "last" ? (lastSeed(key) ?? null) : null })));
  $("[data-reset]", el).addEventListener("click", () => reset(key));
}

async function refresh() {
  try {
    const res = await invoke<{ dir: string; exists: boolean; items: Asset[] }>("gallery_list", { root: deps.root() });
    // A reference render's prompt starts with the wording that keeps the subject; show just the scene.
    items = res.items.map((a) => (a.prompt ? { ...a, prompt: sceneOf(a.prompt) } : a));
    $("#gallery-note").textContent = res.exists
      ? `${items.length} renders in ${res.dir}`
      : `ComfyUI's output folder (${res.dir}) doesn't exist yet. Renders will appear here.`;
  } catch (e) {
    $("#gallery-note").textContent = `Couldn't read the renders: ${errMsg(e)}`;
  }
  render();
}

// Thumbnails are made (or read from cache) only when a tile scrolls into view.
const io = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      const fig = en.target as HTMLElement;
      const a = items.find((x) => x.path === fig.dataset.path);
      if (!a) continue;
      invoke<string>("thumbnail", { path: a.path, mtime: a.mtime })
        .then((t) => {
          const img = document.createElement("img");
          img.alt = "";
          img.src = convertFileSrc(t);
          $(".pic", fig).prepend(img);
          fig.classList.remove("pending");
        })
        .catch(() => fig.classList.remove("pending"));
    }
  },
  { rootMargin: "300px" },
);

function render() {
  const g = $("#gallery");
  g.innerHTML = "";
  const list = items.filter((a) => filter === "all" || a.kind === filter);
  if (!list.length && !job) g.innerHTML = `<p class="note">Nothing here yet.</p>`;
  if (job) {
    const p = document.createElement("div");
    p.className = "thumb pending";
    const vid = isVideo(job.mode);
    const n = job.count;
    const badge = job.mode === "song" ? `<span class="badge song">SONG</span>` : `<span class="badge ${vid ? "vid" : ""}">${vid ? "VIDEO" : n > 1 ? `${n} IMAGES` : "IMAGE"}</span>`;
    p.innerHTML = `<div class="pic">${badge}</div><figcaption><span class="p"></span><span class="m">rendering…</span></figcaption>`;
    $(".p", p).textContent = job.prompt;
    g.appendChild(p);
  }
  for (const a of list) {
    const fig = document.createElement("button");
    const song = a.kind === "audio";
    const model = a.kind === "model";
    fig.className = "thumb" + (song ? " song" : model ? " model" : " pending") + (fresh.has(a.name) ? " fresh" : "");
    fig.dataset.path = a.path;
    // A song has no picture: a note and the first lines of its lyrics instead. A 3D model gets a cube, and a click opens
    // it in the 3D viewer.
    const pic = song
      ? `<span class="song-art" aria-hidden="true">${NOTE_SVG}</span><span class="song-lines"></span>`
      : model
        ? `<span class="model-art" aria-hidden="true">${CUBE_SVG}</span>`
        : "";
    fig.innerHTML = `<div class="pic">${pic}<span class="badge ${a.kind === "video" ? "vid" : song ? "song" : model ? "m3d" : ""}">${song ? "SONG" : model ? "3D" : a.kind.toUpperCase()}</span></div><figcaption><span class="p"></span><span class="m"></span></figcaption>`;
    $(".p", fig).textContent = a.prompt || a.name;
    $(".p", fig).title = a.prompt || a.name;
    $(".m", fig).textContent = [a.model, a.duration ? songLength(Math.round(a.duration)) : "", age(a.mtime)].filter(Boolean).join(" · ");
    if (song) $(".song-lines", fig).textContent = lyricLines(a.lyrics, 4);
    if (a.kind === "video") {
      // Hovering plays the clip, muted.
      fig.addEventListener("mouseenter", () => {
        const v = document.createElement("video");
        v.src = convertFileSrc(a.path);
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.addEventListener("playing", () => v.classList.add("playing"));
        $(".pic", fig).appendChild(v);
        v.play().catch(() => {});
      });
      fig.addEventListener("mouseleave", () => {
        const v = $("video", fig) as HTMLVideoElement | null;
        if (v) {
          v.pause();
          v.removeAttribute("src");
          v.load();
          v.remove();
        }
      });
    }
    fig.addEventListener("click", () => (model ? deps.openModel(a.path, a.name) : openLightbox(a)));
    fig.addEventListener("contextmenu", (e) => showMenu(e, a));
    g.appendChild(fig);
    if (!song && !model) io.observe(fig);
  }
}

const CUBE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l9 5v10l-9 5-9-5V7z" /><path d="M3 7l9 5 9-5M12 12v10" /></svg>`;

/** Picture to 3D: queues Pixal3D on a picture (a render, or a reference picture from chat); the .glb opens in the 3D
 *  viewer when it's done. */
async function toModel(a: Source, from = "Studio", progress?: (pct: number, label: string) => void): Promise<Asset[]> {
  await ensureWorkflows();
  if (!workflows.model3d) throw new Error(`workflows\\${MODES.model3d.file} wasn't found (update the Workstation and add the 3d pack)`);
  return run("model3d", "name" in a ? `3D model of ${a.name}` : "3D model of the picture", a, {}, progress, { from });
}

function makeModel(a: Asset) {
  closeLightbox();
  deps.toast("Making a 3D model: 3 to 8 minutes, longer for detailed subjects. It opens in the 3D viewer when it's done (the render queue shows how far it is).");
  toModel(a)
    .then((got) => got[0] && deps.openModel(got[0].path, got[0].name))
    .catch((e) => errMsg(e) !== "stopped" && deps.toast(`Couldn't make the 3D model: ${errMsg(e)}`, "warn"));
}

const NOTE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></svg>`;

/** The first sung lines of a song's lyrics, without the [Verse] / [Chorus] tags. */
function lyricLines(lyrics: string | null | undefined, n: number) {
  const lines = (lyrics ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !/^\[.*\]$/.test(l));
  return lines.length ? lines.slice(0, n).join("\n") : "Instrumental";
}

// ---------- lightbox ----------
let lbAsset: Asset | null = null;

function openLightbox(a: Asset) {
  closeMenu();
  lbAsset = a;
  const media = $("#lb-media");
  media.innerHTML = "";
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
  ($("#lb-laser") as HTMLButtonElement).hidden = a.kind !== "image";
  $("#lb-laser").onclick = () => laser(a);
  ($("#lb-reuse") as HTMLButtonElement).disabled = !a.prompt;
  $("#lb-reveal").onclick = () => revealFile(a);
  $("#lb-copy").onclick = () => copy(a.prompt || "");
  $("#lb-reuse").onclick = () => reusePrompt(a);
  $("#lb-save").onclick = () => saveAs(a);
  $("#lb-delete").onclick = () => deleteRender(a);
  $("#lb").hidden = false;
}

function closeLightbox() {
  const v = $("#lb-media video, #lb-media audio") as HTMLMediaElement | null;
  v?.pause();
  $("#lb-media").innerHTML = "";
  $("#lb").hidden = true;
  lbAsset = null;
}

// ---------- actions on a render (lightbox buttons and the right-click menu) ----------
/** Edit (Image mode) or animate (Video mode) this image: the create bar takes it as the source. */
function startFrom(a: Asset, m: "image" | "video") {
  deps.show();
  srcAsset = a;
  mode = m;
  ($("#gen-prompt") as HTMLInputElement).value = "";
  closeLightbox();
  renderCreate();
  $("#gen-prompt").focus();
}

/** Paint to change: paint the area on the picture (inpaint.ts) and say what goes there; only that part is redrawn.
 *  With nothing painted it's an instruction edit of the whole picture. The result opens when it's done. */
function paintToChange(a: Asset, selecting = false) {
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
function upscaleItems(a: Asset): MenuItem[] {
  const short = a.width && a.height ? Math.min(a.width, a.height) : 0;
  const out: MenuItem[] = [];
  if (a.kind === "image" && workflows.upimage) {
    if (short < 1080) out.push({ label: "Upscale to 1080p", run: () => upscale(a, 1080), key: "SeedVR2" });
    if (short < 2160) out.push({ label: "Upscale to 4K", run: () => upscale(a, 2160), key: "SeedVR2" });
  }
  if (a.kind === "video" && workflows.upvideo && short < 1080) out.push({ label: "Upscale to 1080p", run: () => upscale(a, 1080), key: "SeedVR2" });
  return out;
}

/** Upscale and enhance: SeedVR2 redraws the picture (or every frame of the video) at 1080p or 4K. The result goes into
 *  the gallery next to the original and opens when it's done. */
async function upscale(a: Asset, size: UpscaleSize) {
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

/** Laser: a PNG to engrave or an SVG to cut from this picture (laser.ts). */
function laser(a: Asset) {
  closeLightbox();
  openLaser(a.path, a.name, a.prompt ?? "");
}

/** Puts a mask in ComfyUI's input folder (named from its content). */
async function uploadMask(mask: Blob): Promise<string> {
  const bytes = new Uint8Array(await mask.arrayBuffer());
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  const hex = Array.from(hash.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
  return invoke<string>("comfy_upload_bytes", bytes, { headers: { "x-name": `prestige-mask-${hex}.png` } });
}

/** Cut out: the selection on a transparent background, saved as a new PNG next to the picture in the gallery. */
async function cutOut(a: Asset, mask: Blob, w: number, h: number) {
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
async function removeBackground(a: Asset) {
  closeLightbox();
  deps.toast("Removing the background…");
  try {
    const out = await run("cutout", `${a.name} without its background`, a, {}, undefined, { from: "Remove background" });
    if (out[0]) openRender(out[0].path);
  } catch (e) {
    if (errMsg(e) !== "stopped") deps.toast(`Couldn't remove the background: ${errMsg(e)}`, "warn");
  }
}

/** Cut out a subject from a video: SAM 3.1 tracks what's named through every frame, and the rest turns green (with
 *  the sound kept), ready to key out in a video editor. */
async function videoCutout(a: Asset) {
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

/** A video's length in seconds, from its own metadata (8 when it can't be read). */
function videoSeconds(path: string): Promise<number> {
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
function ask(title: string, text: string, placeholder: string): Promise<string | null> {
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

// ---------- click to select ----------
// SAM 3.1 answers a click in ~3 s, so it's run straight away instead of waiting in the render queue. A second ComfyUI on
// the small card (start-all.ps1 with "comfyQuick": "on" in data\gpu-settings.json, port 8189) takes it when it runs:
// selecting then doesn't wait for a render on the big card, nor unload anything. Measured: 3 s a selection on the
// RTX 2060 (2.0 GB peak) and on the 3060 (1.7 GB).
const COMFY_QUICK = "http://127.0.0.1:8189";
let quickAt = 0;
let quick: string | null = null;

/** The ComfyUI to select with: the quick one on the small card if it's running (checked every 30 s), else the main one. */
async function selectComfy(): Promise<string> {
  if (Date.now() - quickAt < 30_000) return quick ?? COMFY;
  quickAt = Date.now();
  try {
    quick = (await http(`${COMFY_QUICK}/system_stats`)).ok ? COMFY_QUICK : null;
  } catch {
    quick = null;
  }
  return quick ?? COMFY;
}

/** SAM 3.1's mask for a picture: what's under the clicks (and not under the negative ones), or what's named. White is
 *  selected, at the picture's own size. */
async function segment(src: Source, q: SelectQuery): Promise<Blob> {
  await ensureWorkflows();
  if (!workflows.select) throw new Error(`workflows\\${MODES.select.file} wasn't found (update the Workstation and add the select pack)`);
  const base = await selectComfy();
  const g = structuredClone(workflows.select);
  g["2"].inputs.image = "path" in src ? await invoke<string>("comfy_upload", { path: src.path }) : await uploadReference(src);
  if (q.text) g["3"].inputs.text = q.text;
  else {
    delete g["3"];
    delete g["4"].inputs.conditioning;
    g["4"].inputs.positive_coords = JSON.stringify(q.points);
    g["4"].inputs.negative_coords = JSON.stringify(q.negative);
  }
  // On the main ComfyUI, a chat model filling its card is unloaded first (SAM needs ~2 GB). It waits for a running render.
  if (base === COMFY) {
    try {
      const free = (await (await http(`${COMFY}/system_stats`)).json()).devices?.[0]?.vram_free ?? 0;
      if (free < 2.5 * 2 ** 30) await deps.freeGpu();
    } catch {
      /* ComfyUI answers the prompt below or says why not */
    }
  }
  let r: Response;
  try {
    r = await http(`${base}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: g, client_id: clientId, front: true }) });
  } catch (e) {
    throw new Error(errMsg(e) === "not reachable" ? "ComfyUI isn't running" : errMsg(e));
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.prompt_id) throw new Error(body.error?.message ?? `ComfyUI answered ${r.status}`);
  for (let t0 = Date.now(); Date.now() - t0 < 20 * 60_000; await new Promise((res) => setTimeout(res, 400))) {
    const h = (await (await http(`${base}/history/${body.prompt_id}`)).json())[body.prompt_id];
    if (!h) continue;
    if (h.status?.status_str === "error") {
      const err = (h.status.messages ?? []).find((m: any) => m[0] === "execution_error")?.[1]?.exception_message;
      throw new Error(String(err ?? "SAM 3.1 failed").split("\n")[0]);
    }
    const f = h.outputs?.["6"]?.images?.[0];
    if (!f) throw new Error("SAM 3.1 returned no mask");
    const url = `${base}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder ?? "")}&type=${f.type ?? "temp"}`;
    return await (await http(url)).blob();
  }
  throw new Error("SAM 3.1 took too long");
}

function reusePrompt(a: Asset) {
  deps.show();
  ($("#gen-prompt") as HTMLInputElement).value = a.prompt || "";
  // A song's style and its lyrics both come back.
  if (a.kind === "audio") ($("#song-lyrics-text") as HTMLTextAreaElement).value = isInstrumental(a.lyrics) ? "" : (a.lyrics ?? "");
  srcAsset = null;
  mode = a.kind === "video" ? "video" : a.kind === "audio" ? "music" : "image";
  renderCreate();
  closeLightbox();
  $("#gen-prompt").focus();
}

/** Fixes the seed for the next render of this kind, to vary a render you liked. */
function reuseSeed(a: Asset) {
  deps.toast(fixSeed(a));
}

/** Fixes the next render's seed to this render's, and says so. */
function fixSeed(a: Asset) {
  const key: SettingsKey =
    a.kind === "image" ? "image" : a.kind === "audio" ? "music" : /svi-long/i.test(a.name) ? "long" : /wan/i.test(a.model ?? a.name) ? "animate" : "video";
  update(key, { seed: a.seed ?? null });
  return `The next ${key === "image" ? "image" : key === "music" ? "song" : "video"} uses seed ${a.seed}. Pick Random in Settings to go back.`;
}

const revealFile = (a: Asset) => invoke("reveal", { path: a.path }).catch((e) => deps.toast(errMsg(e), "warn"));

/** Runs a Studio command on a render's file and toasts the outcome. */
async function fileAction(cmd: string, a: Asset, args: Record<string, unknown>, done?: string) {
  try {
    await invoke(cmd, { root: deps.root(), path: a.path, ...args });
    if (done) deps.toast(done);
  } catch (e) {
    deps.toast(errMsg(e), "warn");
  }
}

async function saveAs(a: Asset) {
  try {
    const dest = await invoke<string | null>("save_render_as", { root: deps.root(), path: a.path });
    if (dest) deps.toast(`Saved a copy as ${dest}`);
  } catch (e) {
    deps.toast(`Couldn't save it: ${errMsg(e)}`, "warn");
  }
}

/** Asks first, then moves the file to the Recycle Bin and takes it out of the gallery and chats. */
async function deleteRender(a: Asset) {
  closeMenu();
  const dlg = $("#del-confirm") as HTMLDialogElement;
  $("#del-name").textContent = a.name;
  $("#del-kind").textContent = a.kind === "audio" ? "song" : a.kind;
  dlg.returnValue = "";
  dlg.showModal();
  await new Promise((r) => dlg.addEventListener("close", r, { once: true }));
  if (dlg.returnValue !== "delete") return;
  try {
    await removeRender(a);
  } catch (e) {
    deps.toast(`Couldn't delete ${a.name}: ${errMsg(e)}`, "warn");
    return;
  }
  deps.toast(`Moved ${a.name} to the Recycle Bin.`);
}

/** Moves a render to the Recycle Bin and takes it out of the gallery and chats (asked first, here or on the phone). */
async function removeRender(a: Asset) {
  await invoke("delete_render", { root: deps.root(), path: a.path, mtime: a.mtime });
  if (lbAsset?.path === a.path) closeLightbox();
  items = items.filter((x) => x.path !== a.path);
  render();
  // Chat messages that showed it say it's gone instead of a broken picture.
  $$<HTMLElement>("figure.chat-render").forEach((f) => f.dataset.path === a.path && f.classList.add("missing"));
}

// ---------- right-click menu ----------
type MenuItem = { label: string; run: () => void; key?: string; danger?: boolean } | "-";
let menuEl: HTMLElement | null = null;

function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}

function showMenu(e: MouseEvent, a: Asset) {
  e.preventDefault();
  e.stopPropagation();
  closeMenu();
  const image = a.kind === "image";
  const model = a.kind === "model";
  const list: MenuItem[] = [
    ...(model ? [{ label: "Open in 3D viewer", run: () => deps.openModel(a.path, a.name) }] : []),
    { label: image ? "Open" : model ? "Open in default app" : "Play", run: () => fileAction("open_render", a, {}), key: model ? "3D Viewer, Blender…" : "in default app" },
    { label: "Show info", run: () => openLightbox(a) },
    { label: "Open in folder", run: () => revealFile(a) },
    "-",
    ...(image && workflows.edit ? [{ label: "Edit with Qwen-Image…", run: () => startFrom(a, "image") }] : []),
    ...(image && workflows.inpaint ? [{ label: "Paint to change…", run: () => paintToChange(a) }] : []),
    ...(image && workflows.select ? [{ label: "Select to change or cut out…", run: () => paintToChange(a, true), key: "SAM 3.1" }] : []),
    ...(image && workflows.cutout ? [{ label: "Remove background", run: () => removeBackground(a), key: "transparent PNG" }] : []),
    ...(a.kind === "video" && workflows.vidcut ? [{ label: "Cut out a subject…", run: () => videoCutout(a), key: "green screen" }] : []),
    ...upscaleItems(a),
    ...(image && (workflows.animate || workflows.long) ? [{ label: "Animate (image → video)…", run: () => startFrom(a, "video") }] : []),
    ...(image && (workflows.ref || workflows.reffast) ? [{ label: "Use as reference image", run: () => useAsReference(a) }] : []),
    ...(image && workflows.model3d ? [{ label: "Make a 3D model", run: () => makeModel(a), key: "Pixal3D" }] : []),
    ...(image && workflows.talk ? [{ label: "Make it talk…", run: () => deps.makeTalk(a.path), key: "InfiniteTalk" }] : []),
    ...(image ? [{ label: "Make a laser file…", run: () => laser(a), key: "engrave or cut" }] : []),
    ...(a.prompt ? [{ label: a.kind === "audio" ? "Reuse style and lyrics" : "Reuse prompt", run: () => reusePrompt(a) }] : []),
    ...(a.seed != null ? [{ label: "Reuse seed", run: () => reuseSeed(a), key: String(a.seed) }] : []),
    "-",
    ...(image ? [{ label: "Copy image", run: () => fileAction("copy_render", a, { asImage: true }, "Image copied.") }] : []),
    { label: "Copy file", run: () => fileAction("copy_render", a, { asImage: false }, "File copied. Paste it into a folder or a chat app."), key: "to paste elsewhere" },
    ...(a.prompt ? [{ label: a.kind === "audio" ? "Copy style" : "Copy prompt", run: () => copy(a.prompt || "", a.kind === "audio" ? "Style" : "Prompt") }] : []),
    ...(a.kind === "audio" && a.lyrics && !isInstrumental(a.lyrics) ? [{ label: "Copy lyrics", run: () => copy(a.lyrics || "", "Lyrics") }] : []),
    { label: "Copy file path", run: () => copy(a.path, "Path") },
    { label: "Save a copy as…", run: () => saveAs(a) },
    "-",
    { label: "Delete…", run: () => deleteRender(a), key: "Recycle Bin", danger: true },
  ];
  const m = document.createElement("div");
  m.className = "ctx-menu";
  m.setAttribute("role", "menu");
  let prev: MenuItem | null = "-";
  for (const it of list) {
    if (it === "-") {
      if (prev !== "-") m.appendChild(document.createElement("hr"));
    } else {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      if (it.danger) b.className = "danger";
      b.innerHTML = `<span></span>${it.key ? "<kbd></kbd>" : ""}`;
      $("span", b).textContent = it.label;
      if (it.key) $("kbd", b).textContent = it.key;
      b.addEventListener("click", () => {
        closeMenu();
        it.run();
      });
      m.appendChild(b);
    }
    prev = it;
  }
  if (m.lastElementChild?.tagName === "HR") m.lastElementChild.remove();
  document.body.appendChild(m);
  // Keep it on screen: open up or left when there's no room.
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(e.clientX, innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(e.clientY, innerHeight - r.height - 4))}px`;
  menuEl = m;
  ($("button", m) as HTMLButtonElement | null)?.focus();
}

document.addEventListener("mousedown", (e) => {
  if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (!menuEl) return;
  if (e.key === "Escape") {
    e.stopPropagation();
    closeMenu();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const bs = $$<HTMLButtonElement>("button", menuEl);
    const i = bs.indexOf(document.activeElement as HTMLButtonElement);
    bs[(i + (e.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length]?.focus();
  }
}, true);
addEventListener("blur", closeMenu);
addEventListener("resize", closeMenu);
addEventListener("scroll", closeMenu, true);

async function copy(text: string, what = "Prompt") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  deps.toast(`${what} copied.`);
}

// ---------- generation ----------
async function generate() {
  const prompt = ($("#gen-prompt") as HTMLInputElement).value.trim();
  if (mode === "webcam") return;
  const gm = currentMode();
  if (!prompt || !workflows[gm]) return;
  // Something already rendering: this one waits its turn in the queue.
  const busy = rq.some((j) => j.state === "waiting" || j.state === "running");
  if (busy) deps.toast("Added to the render queue. It starts when the ones ahead of it finish.");
  if (chained(gm)) {
    // Two renders: the reference in a new first frame, then the video from it. Errors arrive as a rejection.
    const t0 = Date.now();
    try {
      const got = await refVideo(prompt, ref!, refPrefs().kind);
      if (studioShown()) deps.toast(`Done in ${Math.round((Date.now() - t0) / 1000)} s: ${got[0].name}`);
    } catch (e) {
      if (errMsg(e) !== "stopped") deps.toast(`The render failed: ${errMsg(e)}`, "warn");
    }
    return;
  }
  const src = gm === "animate" || gm === "long" || gm === "edit" ? srcAsset : gm === "ref" || gm === "reffast" || gm === "refvideo" ? ref : null;
  const lyrics = gm === "song" ? ($("#song-lyrics-text") as HTMLTextAreaElement).value : undefined;
  try {
    enqueue(gm, prompt, src, { kind: refPrefs().kind, lyrics });
  } catch (e) {
    deps.toast(`Couldn't add the render: ${errMsg(e)}`, "warn");
  }
}

/** Adds a render to the queue and resolves with its files when it's done (rejects if it fails or is stopped).
 *  `front`: straight after the running one (a chain's second step); `note`: shown before its progress. */
function run(
  gm: GenMode,
  prompt: string,
  src: Source | null,
  opts: QueueOpts,
  progress?: (pct: number, label: string) => void,
  how: { front?: boolean; note?: string; from?: string; title?: string } = {},
) {
  return new Promise<Asset[]>((resolve, reject) => {
    try {
      enqueue(gm, prompt, src, opts, { ...how, waiter: { progress: progress ?? (() => {}), resolve, reject } });
    } catch (e) {
      reject(e);
    }
  });
}

/** A video featuring the reference: Qwen-Image puts it in a first frame at the video's shape, then LTX animates it. */
async function refVideo(prompt: string, r: Reference, kind: RefKind, progress?: (pct: number, label: string) => void, from?: string) {
  const first = refImageMode();
  const [frame] = await run(first, prompt, r, { kind, override: frameSize() }, progress, { note: "Step 1 of 2 · first frame · ", from });
  return run("refvideo", prompt, frame, {}, progress, { front: true, note: "Step 2 of 2 · video · ", from });
}

interface QueueOpts {
  kind?: RefKind; // how a reference image is described to Qwen-Image
  override?: Override; // size and count for a chain's first frame
  mask?: { name: string; w: number; h: number }; // inpaint: the mask in ComfyUI's input folder, and the picture's size
  lyrics?: string; // a song's (empty: an instrumental)
  song?: Partial<MusicSettings>; // a song's tempo, key or language over the saved settings (chat's songwriter)
  talk?: { audio: Blob; seconds: number }; // a talking video's voice recording and its length
  video?: Partial<VideoSettings>; // a video's length, size or quality over the saved settings (a Director shot)
  upscale?: UpscaleSize; // an upscale's shorter side
}

/** ACE-Step's way of asking for no vocals. */
const INSTRUMENTAL = "[Instrumental]";
const isInstrumental = (l: string | null | undefined) => !l?.trim() || /^\[(instrumental|inst)\]$/i.test(l.trim());

/** What Qwen-Image is asked: it's an edit model, so it redraws the picture it's given unless told what to change, and
 *  it can't see the mask. The painted area is greyed out in its copy and it's told to fill the grey. */
const inpaintPrompt = (p: string) =>
  `Fill the flat gray area with: ${p.replace(/[.\s]+$/, "")}. It should blend naturally with the rest of the picture. Keep everything else exactly the same.`;

/** Turns the edit graph into an inpaint: the painted area is greyed out in the picture Qwen-Image sees, the source is
 *  encoded at the size it works at (its text encoder's latent is empty), only the masked part is noised and redrawn,
 *  and the result is scaled back and pasted over the original through the soft-edged mask, so the unpainted pixels
 *  stay exactly as they were. (Tested: mean change outside the mask 0.002 of 255.) */
function inpaintGraph(g: any, mask: NonNullable<QueueOpts["mask"]>) {
  const res = Number(g["4"]?.inputs?.resolution) || 1024;
  const ratio = mask.w / mask.h;
  const w = Math.max(32, Math.round(Math.sqrt(res * res * ratio) / 32) * 32);
  const h = Math.max(32, Math.round(Math.sqrt((res * res) / ratio) / 32) * 32);
  g["20"] = { class_type: "LoadImageMask", inputs: { image: mask.name, channel: "red" } };
  g["26"] = { class_type: "EmptyImage", inputs: { width: mask.w, height: mask.h, batch_size: 1, color: 0x808080 } };
  g["27"] = { class_type: "ImageCompositeMasked", inputs: { destination: ["9", 0], source: ["26", 0], x: 0, y: 0, resize_source: false, mask: ["20", 0] } };
  g["4"].inputs["images.image_1"] = ["27", 0];
  g["4"].inputs.prompt = inpaintPrompt(g["4"].inputs.prompt);
  g["21"] = { class_type: "ImageScale", inputs: { image: ["27", 0], upscale_method: "lanczos", width: w, height: h, crop: "disabled" } };
  g["22"] = { class_type: "VAEEncode", inputs: { pixels: ["21", 0], vae: ["3", 0] } };
  g["23"] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["22", 0], mask: ["20", 0] } };
  g["6"].inputs.latent_image = ["23", 0];
  g["24"] = { class_type: "ImageScale", inputs: { image: ["7", 0], upscale_method: "lanczos", width: mask.w, height: mask.h, crop: "disabled" } };
  g["25"] = { class_type: "ImageCompositeMasked", inputs: { destination: ["9", 0], source: ["24", 0], x: 0, y: 0, resize_source: false, mask: ["20", 0] } };
  g["8"].inputs.images = ["25", 0];
  g["8"].inputs.filename_prefix = "qwen-image-inpaint";
}

// ---------- the render queue ----------
// Every render (Studio, chat, Paint to change) goes through here and they run one at a time. A render's settings,
// seed and workflow are fixed when it's added, so changing the settings afterwards only affects new ones.
interface QJob {
  id: number;
  gm: GenMode;
  prompt: string;
  label: string; // the model, e.g. "Qwen-Image-2.1"
  from: string; // "Studio", "chat", "Paint to change"
  src: Source | null;
  graph: any;
  nodes: Record<string, string>;
  seed: number;
  count: number;
  note: string; // "Step 1 of 2 · first frame · "
  state: "waiting" | "running" | "done" | "failed" | "stopped";
  pct: number;
  status: string;
  added: number;
  took?: number;
  result?: Asset[];
  error?: string;
  waiter?: { progress: (pct: number, label: string) => void; resolve: (a: Asset[]) => void; reject: (e: Error) => void };
  cancelled?: boolean; // stopped while it was getting ready
  audio?: Blob; // a talking video's voice recording, uploaded with the picture
}
const rq: QJob[] = [];
let current: QJob | null = null;
let jobIds = 1;

/** Renders whose workflow has no Studio settings (and so no seed setting of their own). */
const NO_SETTINGS: Family[] = ["talk", "select", "cutout", "vidcut", "upscale"];

/** Builds a render's workflow now, with the current settings and a fresh seed (it may run much later). */
function prepare(gm: GenMode, prompt: string, src: Source | null, opts: QueueOpts) {
  const wf = workflows[gm];
  if (!wf) throw new Error(`workflows\\${MODES[gm].file} wasn't found`);
  const m = modeOf(gm);
  const graph = structuredClone(wf);
  if (m.promptNode) graph[m.promptNode].inputs[m.promptKey ?? "text"] = gm === "ref" || gm === "reffast" ? refPrompt(opts.kind ?? "auto", prompt) : prompt;
  // Renders without generation settings keep their seed to themselves, rather than taking the Image settings' one.
  const seed = NO_SETTINGS.includes(m.family) ? Math.floor(Math.random() * 2 ** 32) : takeSeed(settingsKey(gm));
  const p = m.family === "talk" ? talkPlan(src, opts.talk?.seconds ?? 0) : plan(gm, src, opts.override, opts.song, opts.video);
  if (m.family === "svi") shotPrompts(prompt, p.shots!).forEach((t, i) => (graph[SVI.shots[i].prompt].inputs.text = t));
  if (m.family === "song") graph[m.promptNode].inputs.lyrics = isInstrumental(opts.lyrics) ? INSTRUMENTAL : opts.lyrics!.trim();
  apply(m, graph, p, seed);
  if (gm === "inpaint") {
    if (!opts.mask) throw new Error("nothing is painted");
    inpaintGraph(graph, opts.mask);
  }
  // An upscale's size: the shorter side becomes 1080 or 2160 (the longer one follows the shape).
  if (m.family === "upscale") {
    graph["3"].inputs["resize_type.shorter_size"] = opts.upscale ?? 2160;
    graph[gm === "upvideo" ? "15" : "12"].inputs.filename_prefix = `${gm === "upvideo" ? "video/" : ""}upscaled-${opts.upscale === 1080 ? "1080p" : "4k"}`;
  }
  // A cut-out of a selection: its mask in place of BiRefNet's.
  if (gm === "cutout" && opts.mask) {
    graph["2"] = { class_type: "LoadImageMask", inputs: { image: opts.mask.name, channel: "red" } };
    graph["3"].inputs.mask = ["2", 0];
    delete graph["6"];
    delete graph["7"];
    graph["5"].inputs.filename_prefix = "selection";
  }
  const nodes: Record<string, string> = {};
  for (const [id, n] of Object.entries<any>(graph))
    nodes[id] =
      (m.family === "song" && SONG_STEPS[n.class_type]) ||
      (m.family === "model3d" && MODEL3D_STEPS[n.class_type]) ||
      (m.family === "talk" && TALK_STEPS[n.class_type]) ||
      ((m.family === "cutout" || m.family === "vidcut") && CUT_STEPS[n.class_type]) ||
      (m.family === "upscale" && UPSCALE_STEPS[n.class_type]) ||
      n.class_type;
  if (m.family === "talk") talkLabels(nodes, p.shots!);
  return { graph, nodes, seed, count: p.count, label: modeOf(gm).label, audio: opts.talk?.audio };
}

/** Adds a render to the queue (throws when its workflow is missing). */
function enqueue(
  gm: GenMode,
  prompt: string,
  src: Source | null,
  opts: QueueOpts,
  how: { front?: boolean; note?: string; from?: string; title?: string; waiter?: QJob["waiter"] } = {},
) {
  const j: QJob = {
    id: jobIds++,
    gm,
    prompt: how.title ?? prompt, // what the queue shows: a talking video's line rather than how they move
    src,
    ...prepare(gm, prompt, src, opts),
    from: how.from ?? "Studio",
    note: how.note ?? "",
    state: "waiting",
    pct: 0,
    status: "Waiting",
    added: Date.now(),
    waiter: how.waiter,
  };
  if (how.front) {
    const at = rq.findIndex((x) => x.state === "waiting");
    rq.splice(at < 0 ? rq.length : at, 0, j);
  } else rq.push(j);
  renderQueue();
  pump();
  return j;
}

/** Starts the next waiting render when nothing is running. */
async function pump() {
  if (current || job || starting) return;
  const next = rq.find((x) => x.state === "waiting");
  if (!next) return;
  current = next;
  next.state = "running";
  stepNote = next.note;
  waiter = next.waiter ?? null;
  renderQueue();
  try {
    await submit(next);
  } catch (e) {
    const msg = errMsg(e);
    next.state = msg === "stopped" ? "stopped" : "failed";
    next.error = msg;
    current = null;
    stepNote = "";
    const w = waiter;
    waiter = null;
    if (w) w.reject(new Error(msg));
    else if (msg !== "stopped") deps.toast(`Couldn't start the render: ${msg}`, "warn");
    notify(next);
    renderQueue();
    pump();
  }
}

/** Stops a render: takes a waiting one out of the queue, or interrupts the running one. */
function cancelJob(j: QJob) {
  if (j.state === "waiting") {
    j.state = "stopped";
    j.waiter?.reject(new Error("stopped"));
    renderQueue();
  } else if (j.state === "running") {
    // Still getting ready (freeing the GPU, uploading): it's dropped before it reaches ComfyUI.
    j.cancelled = true;
    if (job) http(`${COMFY}/interrupt`, { method: "POST" }).catch(() => {});
  }
}

/** Puts a failed or stopped render back in the queue, as it was (same settings and seed). */
function retryJob(j: QJob) {
  rq.push({ ...j, id: jobIds++, state: "waiting", pct: 0, status: "Waiting", error: undefined, result: undefined, took: undefined, added: Date.now(), waiter: undefined, note: "", cancelled: undefined });
  renderQueue();
  pump();
}

/** A finished render while Prestige is in the background (or on another screen) says so. */
async function notify(j: QJob) {
  if (j.state !== "done" && j.state !== "failed") return;
  const away = !document.hasFocus() || document.hidden;
  const title = j.state === "done" ? `${j.result && j.result.length > 1 ? `${j.result.length} renders` : "Your render"} is ready` : "A render failed";
  const body = `${j.label}: ${j.prompt.slice(0, 120)}${j.state === "failed" && j.error ? ` (${j.error.slice(0, 100)})` : ""}`;
  if (away) {
    try {
      let ok = await isPermissionGranted();
      if (!ok) ok = (await requestPermission()) === "granted";
      if (ok) sendNotification({ title, body });
    } catch {
      /* not in the app */
    }
  } else if (!j.waiter && !studioShown()) deps.toast(`${title}: ${j.prompt.slice(0, 60)}`);
}

const ago = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};

const queueListeners = new Set<() => void>();
/** Runs whenever the render queue changes (a render added, its progress, finished), for phones. */
export const onQueueChange = (f: () => void) => queueListeners.add(f);

/** The queue under the create bar, and the count on the Studio button. */
function renderQueue() {
  queueListeners.forEach((f) => f());
  const live = rq.filter((j) => j.state === "waiting" || j.state === "running");
  const badge = document.getElementById("studio-count");
  if (badge) badge.textContent = live.length ? String(live.length) : "";
  // Chat renders that are waiting hear how many are ahead.
  rq.filter((j) => j.state === "waiting" && j.waiter).forEach((j) => {
    const ahead = rq.filter((x) => (x.state === "waiting" || x.state === "running") && rq.indexOf(x) < rq.indexOf(j)).length;
    j.waiter!.progress(0, `Waiting in the render queue (${ahead} ahead)…`);
  });
  const box = document.getElementById("rq");
  if (!box) return;
  box.hidden = rq.length < 2 && !rq.some((j) => j.state === "waiting");
  const waiting = rq.filter((j) => j.state === "waiting").length;
  $("#rq-sum").textContent = [current ? "1 rendering" : "", waiting ? `${waiting} waiting` : "", rq.length - live.length ? `${rq.length - live.length} finished` : ""]
    .filter(Boolean)
    .join(" · ");
  const list = $("#rq-list");
  list.innerHTML = "";
  for (const j of rq) {
    const row = document.createElement("div");
    row.className = `rq-row ${j.state}`;
    const icon = { waiting: "⏳", running: "●", done: "✓", failed: "✗", stopped: "■" }[j.state];
    const status =
      j.state === "running"
        ? j.status
        : j.state === "waiting"
          ? `Waiting · ${rq.filter((x) => (x.state === "waiting" || x.state === "running") && rq.indexOf(x) < rq.indexOf(j)).length} ahead`
          : j.state === "done"
            ? `Done in ${ago((j.took ?? 0) * 1000)}${j.result && j.result.length > 1 ? ` · ${j.result.length} files` : ""}`
            : j.state === "failed"
              ? `Failed: ${j.error ?? ""}`
              : "Stopped";
    row.innerHTML = `<span class="rq-ico"></span><span class="rq-t"><b></b><small></small></span><span class="rq-acts"></span>`;
    $(".rq-ico", row).textContent = icon;
    $("b", row).textContent = j.prompt;
    $("b", row).title = j.prompt;
    $("small", row).textContent = `${j.label} · ${j.from} · ${status}`;
    if (j.state === "running") row.style.setProperty("--v", String(j.pct));
    const act = (label: string, fn: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "linkish";
      b.textContent = label;
      b.addEventListener("click", fn);
      $(".rq-acts", row).appendChild(b);
    };
    if (j.state === "waiting") act("remove", () => cancelJob(j));
    if (j.state === "running") act("stop", () => cancelJob(j));
    if (j.state === "done" && j.result?.[0]) act("open", () => openRender(j.result![0].path));
    if (j.state === "failed" || j.state === "stopped") act("try again", () => retryJob(j));
    list.appendChild(row);
  }
}

/** Puts a voice recording in ComfyUI's input folder (named from its content, so a retry reuses it). */
async function uploadAudio(audio: Blob): Promise<string> {
  const bytes = new Uint8Array(await audio.arrayBuffer());
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  const hex = Array.from(hash.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
  const ext = audio.type.includes("mpeg") ? "mp3" : audio.type.includes("ogg") ? "ogg" : audio.type.includes("flac") ? "flac" : audio.type.includes("webm") ? "webm" : audio.type.includes("mp4") || audio.type.includes("m4a") ? "m4a" : "wav";
  return invoke<string>("comfy_upload_bytes", bytes, { headers: { "x-name": `prestige-voice-${hex}.${ext}` } });
}

/** Sends a prepared render to ComfyUI. Throws if it couldn't be queued; progress then arrives by websocket. */
async function submit(j: QJob) {
  const { gm, graph, nodes, seed, count, prompt, src } = j;
  const m = modeOf(gm);
  starting = true;
  renderCreate();
  setJob(0, "Freeing the GPU (unloading chat models)…");
  $("#job").hidden = false;
  try {
    // ComfyUI needs the 12 GB card to itself.
    await deps.freeGpu();
    await invoke("comfy_listen", { clientId });
    if (src && m.imageNode) {
      setJob(1, "Uploading the image to ComfyUI…");
      graph[m.imageNode].inputs[m.imageKey ?? "image"] = "path" in src ? await invoke<string>("comfy_upload", { path: src.path }) : await uploadReference(src);
    }
    if (j.audio) {
      setJob(1, "Uploading the voice to ComfyUI…");
      graph[TALK.audio].inputs.audio = await uploadAudio(j.audio);
    }
    if (j.cancelled) throw new Error("stopped");
    const r = await http(`${COMFY}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.prompt_id) {
      const why = body.error?.message || body.node_errors ? JSON.stringify(body.node_errors ?? body.error).slice(0, 200) : `HTTP ${r.status}`;
      throw new Error(why);
    }
    job = { id: body.prompt_id, mode: gm, started: Date.now(), prompt, nodes, outputs: [], seed, count };
    setJob(2, "Queued. Loading models…");
    render();
  } catch (e) {
    $("#job").hidden = true;
    job = null;
    const msg = errMsg(e);
    throw new Error(msg === "not reachable" ? "ComfyUI isn't running" : msg);
  } finally {
    starting = false;
    renderCreate();
  }
}

let jobPct = 0;
function setJob(pct: number, label: string) {
  jobPct = pct;
  label = stepNote + label;
  ($("#job .progress") as HTMLElement).style.setProperty("--v", String(pct));
  $("#job-label").textContent = label;
  waiter?.progress(pct, label);
  if (current) {
    current.pct = pct;
    current.status = label;
    renderQueue();
  }
}

function onComfy(msg: any) {
  if (!job) return;
  const d = msg.data ?? {};
  if (d.prompt_id && d.prompt_id !== job.id) return;
  const secs = Math.round((Date.now() - job.started) / 1000);
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
  switch (msg.type) {
    case "progress":
      setJob(Math.max(5, (d.value / d.max) * 100), `${job.nodes[d.node] ?? "Working"} · step ${d.value} of ${d.max} · ${elapsed}`);
      break;
    case "executing":
      if (d.node == null) finish(true);
      else setJob(jobPct, `${job.nodes[d.node] ?? d.node} · ${elapsed}`);
      break;
    case "executed":
      // The files a save node wrote, so the finished render can be found by name.
      for (const list of Object.values<any>(d.output ?? {}))
        if (Array.isArray(list)) for (const f of list) if (f?.filename && f.type !== "temp") job.outputs.push(f.filename);
      break;
    case "execution_success":
      finish(true);
      break;
    case "execution_interrupted":
      finish(false, "stopped");
      break;
    case "execution_error": {
      // PyTorch's out-of-memory message runs to a dozen lines of allocator stats; the first line says enough.
      const raw = String(d.exception_message ?? "").trim();
      const msg = /out of memory|OutOfMemory/i.test(raw)
        ? "the GPU ran out of memory. Close other programs using it, or try a smaller size."
        : raw.split("\n")[0] || "ComfyUI reported an error";
      if (!waiter) deps.toast(`The render failed: ${msg}`, "warn");
      finish(false, msg);
      break;
    }
  }
}

async function finish(ok: boolean, why = "") {
  if (!job) return;
  const done = job;
  const took = Math.round((Date.now() - done.started) / 1000);
  job = null;
  const w = waiter;
  waiter = null;
  $("#job").hidden = true;
  renderCreate();
  const before = new Set(items.map((a) => a.path));
  await refresh();
  const named = items.filter((a) => done.outputs.includes(a.name));
  const added = named.length ? named : items.filter((a) => !before.has(a.path));
  const q = current;
  current = null;
  stepNote = "";
  if (ok && added.length) {
    fresh = new Set(added.map((a) => a.name));
    render();
    if (q) Object.assign(q, { state: "done", result: added, took });
    if (w) w.resolve(added);
    else if (studioShown()) deps.toast(`Done in ${took} s (seed ${done.seed}): ${added[0].name}${added.length > 1 ? ` and ${added.length - 1} more` : ""}`);
  } else {
    const msg = why || "ComfyUI finished, but no new file appeared in its output folder";
    if (q) Object.assign(q, { state: why === "stopped" ? "stopped" : "failed", error: msg, took });
    w?.reject(new Error(msg));
  }
  if (q) notify(q);
  renderQueue();
  // The button goes back from "Add to queue" when nothing else is waiting.
  renderCreate();
  pump();
}

// ---------- used from chat ----------
export type MediaKind = "image" | "video" | "audio";
/** The workflow chat uses: the Studio's Image mode pick, LTX text-to-video, or an ACE-Step song. */
const chatMode = (kind: MediaKind): GenMode => (kind === "audio" ? "song" : kind === "video" ? "video" : workflows[imageMode] ? imageMode : "fast");

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
    if (!workflows[need]) throw new Error(`workflows\\${modeOf(need).file} wasn't found`);
  if (chained(gm)) return refVideo(prompt, r, refKind, progress, "chat");
  return run(gm, prompt, r, gm === "refvideo" ? {} : { kind: refKind }, progress, { from: "chat" });
}

/** Chat's /edit: changes a picture by instruction with Qwen-Image-2.1 Edit (the whole picture, keeping its size). */
export async function editMedia(prompt: string, r: Reference, progress: (pct: number, label: string) => void): Promise<Asset[]> {
  await ensureWorkflows();
  if (!workflows.edit) throw new Error(`workflows\\${MODES.edit.file} wasn't found`);
  return run("edit", prompt, r, {}, progress, { from: "chat" });
}

/** The label for chat's edits. */
export const editLabel = () => MODES.edit.label;

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
const TALK_PROMPT = "A person talking to the camera with natural expressions, blinking and slight head movement.";
/** How long a talking video of this much speech takes, in seconds (measured on an RTX 3060 12 GB). */
export const talkSecs = (seconds: number) => TALK_LOAD_SECS + TALK_PART_SECS * talkParts(seconds);

/** Director: one shot of a music video, LTX-2.5 text-to-video at 768×512 for this long; `quality` is the saved Video
 *  quality unless given ("draft" skips the upscale pass). `title` is what the render queue shows. */
export async function renderShot(
  prompt: string,
  seconds: number,
  progress: (pct: number, label: string) => void,
  how: { title?: string; note?: string; quality?: Quality } = {},
): Promise<Asset[]> {
  await ensureWorkflows();
  if (!workflows.video) throw new Error(`workflows\\${MODES.video.file} wasn't found (update the Workstation and add the video pack)`);
  const video: Partial<VideoSettings> = { seconds, res: "768x512", fps: 24, ...(how.quality ? { quality: how.quality } : {}) };
  return run("video", prompt, null, { video }, progress, { from: "Director", title: how.title, note: how.note });
}
/** The saved Video quality ("draft" makes a Director's shots quicker). */
export const videoQuality = () => settings().video.quality;

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
  if (!workflows[gm]) {
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

let allowed: Promise<void> | null = null;
/** Lets the webview show files from ComfyUI's output folder (needed before showing a saved render in chat). */
export function allowRenders() {
  return (allowed ??= refresh());
}

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

// ---------- the phone: Studio, Renders and the queue on a paired phone (main.ts passes its requests here) ----------
// The phone keeps its own create bar (mode, picture, reference, prompt) and asks for what that would make; the
// settings, the model picks and the reference choices are the PC's, shared with Studio and chat. Renders it starts go
// into the same queue as the PC's, marked "phone".
type PhoneMode = "image" | "video" | "music";
interface PhoneCreate {
  mode: PhoneMode;
  src?: string | null; // a render to edit (Image) or animate (Video)
  ref?: { w: number; h: number } | null; // a reference picture's size, when one is set
}

/** A render by path (looking again when it's new). */
async function findItem(path: string) {
  let a = items.find((x) => x.path === path);
  if (!a) {
    await refresh();
    a = items.find((x) => x.path === path);
  }
  if (!a) throw new Error("That render isn't in ComfyUI's output folder any more.");
  return a;
}

/** The workflow the phone's create bar runs, as currentMode() does for Studio's. */
function phoneGm(c: PhoneCreate, src: Asset | null): GenMode {
  if (c.mode === "music") return "song";
  if (c.mode === "video") return src ? animatePick() : c.ref ? "refvideo" : "video";
  if (src) return "edit";
  if (c.ref) return refImageMode();
  return workflows[imageMode] ? imageMode : "fast";
}

/** The render queue for phones: the last 20, newest last. */
export function phoneQueue() {
  const live = (j: QJob) => j.state === "waiting" || j.state === "running";
  return rq.slice(-20).map((j) => ({
    id: j.id,
    prompt: j.prompt,
    label: j.label,
    from: j.from,
    state: j.state,
    pct: Math.round(j.pct),
    status: j.state === "waiting" ? `Waiting · ${rq.filter((x) => live(x) && rq.indexOf(x) < rq.indexOf(j)).length} ahead` : j.status,
    error: j.error ?? null,
    took: j.took ?? null,
    result: (j.result ?? []).map((a) => ({ path: a.path, kind: a.kind, mtime: a.mtime, name: a.name })),
  }));
}

/** What the phone can do with a render, by what's installed. */
function actsFor(a: Asset): string[] {
  const out: string[] = [];
  const short = a.width && a.height ? Math.min(a.width, a.height) : 0;
  if (a.kind === "image") {
    if (workflows.edit) out.push("edit");
    if (workflows.animate || workflows.long) out.push("animate");
    if (workflows.ref || workflows.reffast) out.push("reference");
    if (workflows.upimage && short < 1080) out.push("up1080");
    if (workflows.upimage && short < 2160) out.push("up4k");
    if (workflows.model3d) out.push("model3d");
    if (workflows.cutout) out.push("removebg");
    if (workflows.talk) out.push("talk");
  }
  if (a.kind === "video") {
    if (workflows.upvideo && short < 1080) out.push("up1080");
    if (workflows.vidcut) out.push("vidcut");
  }
  if (a.seed != null && a.kind !== "model") out.push("seed");
  out.push("delete");
  return out;
}

/** A character's face, small, for the phone's picker (faces are up to 2048 px). */
const faceThumbs = new Map<string, string>();
export async function faceThumb(c: Parameters<typeof faceBlob>[0]) {
  const key = `${c.id}:${c.face!.length}`;
  let t = faceThumbs.get(key);
  if (!t) {
    const bmp = await createImageBitmap(faceBlob(c));
    const k = Math.min(1, 160 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement("canvas");
    cv.width = Math.round(bmp.width * k);
    cv.height = Math.round(bmp.height * k);
    cv.getContext("2d")!.drawImage(bmp, 0, 0, cv.width, cv.height);
    bmp.close();
    t = cv.toDataURL("image/jpeg", 0.8).split(",")[1];
    faceThumbs.set(key, t);
  }
  return t;
}

/** What the phone's create bar would make: the model, the settings as chips and as a form, the warning, the words. */
async function phoneInfo(c: PhoneCreate) {
  await ensureWorkflows();
  const src = c.src ? await findItem(c.src) : null;
  const gm = phoneGm(c, src);
  const m = modeOf(gm);
  if (m.family === "svi" && !sviModels) await loadSviModels().catch(() => {});
  // The picture it starts from, for sizes that follow it (only its size matters here).
  const from: Source | null = src ?? (c.ref ? ({ path: "", name: "", kind: "image", mtime: 0, size: 0, width: c.ref.w, height: c.ref.h } as Asset) : null);
  const chain = chained(gm);
  const first = refImageMode();
  const missing = !workflows[gm] ? m.file : chain && !workflows[first] ? modeOf(first).file : "";
  const p = plan(gm, from);
  const shown = chain ? { ...p, secs: p.secs + plan(first, from, frameSize()).secs } : p;
  const key = settingsKey(gm);
  return {
    gm,
    key,
    label: chain ? `${modeOf(first).label} → ${m.label}` : m.label,
    canPick: canPick(gm),
    missing,
    chips: missing ? [] : summary(gm, shown),
    warn: p.warn,
    cards: p.cards ?? "",
    fields: settingsFields(gm, from),
    seed: settings()[key].seed,
    lastSeed: lastSeed(key) ?? null,
    button: buttonText(gm),
    placeholder: promptHint(gm),
    refOk: !!(workflows.ref || workflows.reffast) && !src && c.mode !== "music",
    refWhat: c.ref ? refWhat(gm) : "",
    refPrefs: refPrefs(),
    refVideo: gm === "refvideo",
    consent: CONSENT,
    faces: await Promise.all(
      characters()
        .filter((x) => x.face)
        .map(async (x) => ({ id: x.id, name: x.name, thumb: await faceThumb(x).catch(() => "") })),
    ),
    srcWhat: src ? `${gm === "edit" ? "Editing" : "Animating"} this picture with ${m.label}` : "",
    song: !!workflows.song,
    queue: phoneQueue(),
  };
}

/** Queues what the phone's create bar asked for. A reference is a base64 JPEG from the phone, or a character's face. */
async function phoneGenerate(a: any) {
  await ensureWorkflows();
  const prompt = String(a.prompt ?? "").trim();
  if (!prompt) throw new Error("Describe what to make first.");
  const src = a.src ? await findItem(a.src) : null;
  let r: Reference | null = null;
  let kind: RefKind = refPrefs().kind;
  if (!src && a.mode !== "music") {
    if (a.ref) r = await referenceFromBase64(String(a.ref));
    else if (a.character) {
      const c = characterById(String(a.character));
      if (!c?.face) throw new Error("That character has no face picture.");
      r = await loadReference(faceBlob(c));
      kind = "character"; // a character's face is always a Character
    }
  }
  const gm = phoneGm({ mode: a.mode, ref: r ? { w: r.width, h: r.height } : null }, src);
  for (const need of chained(gm) ? [gm, refImageMode()] : [gm]) if (!workflows[need]) throw new Error(`workflows\\${modeOf(need).file} wasn't found on the PC`);
  const ahead = rq.filter((j) => j.state === "waiting" || j.state === "running").length;
  if (chained(gm)) refVideo(prompt, r!, kind, undefined, "phone").catch(() => {}); // the queue shows how it went
  else {
    const from = gm === "ref" || gm === "reffast" || gm === "refvideo" ? r : src;
    enqueue(gm, prompt, from, { kind, lyrics: gm === "song" ? String(a.lyrics ?? "") : undefined }, { from: "phone" });
  }
  return { ok: true, ahead, queue: phoneQueue() };
}

/** A render action from the phone's viewer: upscale, 3D, remove the background, cut out of a video, seed, delete. */
async function phoneAct(path: string, what: string, text: string) {
  await ensureWorkflows();
  const a = await findItem(path);
  const queued = (j: QJob) => ({ ok: true, queued: j.id, queue: phoneQueue() });
  switch (what) {
    case "up1080":
    case "up4k": {
      const size: UpscaleSize = what === "up4k" ? 2160 : 1080;
      const video = a.kind === "video";
      if (!workflows[video ? "upvideo" : "upimage"]) throw new Error("Upscaling needs the Workstation's upscale pack.");
      return queued(enqueue(video ? "upvideo" : "upimage", a.prompt || a.name, a, { upscale: size }, { from: "phone", title: `${a.name} to ${size === 1080 ? "1080p" : "4K"}` }));
    }
    case "model3d":
      if (!workflows.model3d) throw new Error("Picture to 3D needs the Workstation's 3d pack.");
      return queued(enqueue("model3d", `3D model of ${a.name}`, a, {}, { from: "phone" }));
    case "removebg":
      if (!workflows.cutout) throw new Error("Remove background needs the Workstation's select pack.");
      return queued(enqueue("cutout", `${a.name} without its background`, a, {}, { from: "phone" }));
    case "vidcut":
      if (!workflows.vidcut) throw new Error("Cutting out of a video needs the Workstation's select pack.");
      if (!text.trim()) throw new Error("Say what should stay.");
      return queued(enqueue("vidcut", text.trim(), a, {}, { from: "phone", title: `${text.trim()}, cut out of ${a.name}` }));
    case "seed":
      return { ok: true, message: fixSeed(a) };
    case "delete":
      await removeRender(a);
      return { ok: true, message: `Moved ${a.name} to the Recycle Bin on the PC.` };
  }
  throw new Error(`unknown action ${what}`);
}

/** The gallery for phones, newest first, a page at a time. */
async function phoneGallery(filter: string, offset: number, limit: number) {
  if (offset === 0) await refresh();
  const list = items.filter((a) => filter === "all" || a.kind === filter);
  return {
    total: list.length,
    items: list.slice(offset, offset + limit).map((a) => ({ ...a, acts: actsFor(a) })),
  };
}

/** A request from a paired phone (phone.rs → main.ts). Throws with words the phone shows. */
export async function phoneStudio(action: string, a: any = {}): Promise<unknown> {
  switch (action) {
    case "info":
      return phoneInfo(a);
    case "set": {
      const key = a.key as SettingsKey;
      if (!(key in settings())) throw new Error("unknown settings");
      if (a.reset) reset(key);
      else if (a.k === "seed") {
        const n = Math.floor(Number(a.value));
        update(key, { seed: a.value === "last" ? (lastSeed(key) ?? null) : a.value == null || a.value === "" || !Number.isFinite(n) || n < 0 ? null : n });
      } else {
        const k = String(a.k);
        if (!["aspect", "size", "quality", "count", "res", "seconds", "fps", "shots", "frames", "high", "low", "bpm", "key", "meter", "language"].includes(k)) throw new Error(`unknown setting ${k}`);
        update(key, { [k]: fieldValue(k, String(a.value ?? "")) } as any);
      }
      return phoneInfo(a.create ?? { mode: "image" });
    }
    case "pick":
      flipModel(a.create?.mode === "video");
      return phoneInfo(a.create ?? { mode: "image" });
    case "refPrefs":
      setRefPrefs({ ...(a.kind ? { kind: a.kind } : {}), ...(a.frame ? { frame: a.frame } : {}) });
      return phoneInfo(a.create ?? { mode: "image" });
    case "generate":
      return phoneGenerate(a);
    case "lyrics": {
      const style = String(a.style ?? "").trim();
      if (!style) throw new Error("Describe the song's style or what it's about first.");
      return { lyrics: await deps.writeLyrics(style, settings().music.seconds, AbortSignal.timeout(280_000)) };
    }
    case "queue":
      return { queue: phoneQueue() };
    case "cancel":
    case "retry":
    case "clear": {
      if (action === "clear") for (let i = rq.length - 1; i >= 0; i--) if (!["waiting", "running"].includes(rq[i].state)) rq.splice(i, 1);
      const j = rq.find((x) => x.id === Number(a.id));
      if (j && action === "cancel") cancelJob(j);
      if (j && action === "retry" && (j.state === "failed" || j.state === "stopped")) retryJob(j);
      renderQueue();
      return { queue: phoneQueue() };
    }
    case "gallery":
      return phoneGallery(String(a.filter ?? "all"), Math.max(0, Number(a.offset) || 0), Math.min(120, Math.max(1, Number(a.limit) || 48)));
    case "act":
      return phoneAct(String(a.path ?? ""), String(a.what ?? ""), String(a.text ?? ""));
  }
  throw new Error(`unknown Studio action ${action}`);
}

export type { Asset };
