// The settings under Studio's create bar: the fields each mode has (size, steps, length, models…), as a form.
import { diffusionModels, STOCK } from "./uncensored";
import { aboutTime, ASPECTS, imageDims, lastSeed, LTX_FPS, LTX_RES, LTX_SECONDS, ltxFrames, QUALITY_NAMES, reset, settings, SIZES, SONG_BPMS, SONG_KEYS, SONG_LANGUAGES, SONG_METERS, SONG_SECONDS, SVI_FPS, SVI_FRAMES, SVI_SHOTS, SVI_SIZES, sviSeconds, update, WAN_RES, WAN_SECONDS, wanAuto, wanFrames } from "./gensettings";
import { trainedLoras } from "./train";
import { $, $$, esc, modeOf, MOSS_EDIT_MODES, QWEN_LORA_MODES, ref, SAGE_FAMILIES, SAGE_HINT, srcAsset, workflows } from "./studio";
import { type GenMode, levels, LIGHTNING_MODES, plan, settingsKey, songLength, type Source, sviDims } from "./modes";

export const optionList = (pairs: [string | number, string][], cur: string | number) =>
  pairs.map(([v, l]) => `<option value="${v}"${String(v) === String(cur) ? " selected" : ""}>${esc(l)}</option>`).join("");

// The diffusion models ComfyUI can load (safetensors and GGUF), for Wan 2.2's model picks (Animate and long video).
export let sviModels: string[] | null = null;
export let sviModelsLoading: Promise<void> | null = null;
export function loadSviModels() {
  return (sviModelsLoading ??= (async () => {
    sviModels = await diffusionModels();
    // Let a later open try again if ComfyUI wasn't running.
    if (!sviModels.length) {
      sviModels = null;
      sviModelsLoading = null;
    }
  })());
}

/** One setting in the form: a pick from a list (Studio's panel, chat's popover and the phone draw it). */
export interface Field {
  k: string;
  label: string;
  options: [string | number, string][];
  value: string | number;
  hint?: string;
}

/** Wan 2.2's high- and low-noise model picks. Auto runs an uncensored pair when one is installed (uncensored.ts). */
export function wanPicks(field: (label: string, k: string, options: Field["options"], value: string | number, hint?: string) => void, v: { high?: string | null; low?: string | null }) {
  const models = sviModels ?? [];
  const pick = (label: string, k: "high" | "low", which: string) =>
    field(
      label,
      k,
      [
        ["", "Auto · uncensored if installed"],
        [STOCK, `Stock Wan 2.2 4-step (${which})`],
        ...models.map((n): [string, string] => [n, n]),
        ...(v[k] && v[k] !== STOCK && !models.includes(v[k]!) ? [[v[k]!, `${v[k]} (not found)`] as [string, string]] : []),
      ],
      v[k] ?? "",
      k === "high" ? "From ComfyUI's model folders; kept on this PC only. Photos brought in from outside run the stock models on Auto" : "",
    );
  pick("High-noise model", "high", "high noise");
  pick("Low-noise model", "low", "low noise");
}

/** The settings a mode has, as data. `src` is the picture it starts from (Wan's "Match the picture" and SVI's sizes). */
export function settingsFields(gm: GenMode, src: Source | null = srcAsset): Field[] {
  const m = modeOf(gm);
  const s = settings()[settingsKey(gm)];
  const f: Field[] = [];
  const field = (label: string, k: string, options: Field["options"], value: string | number, hint = "") => f.push({ k, label, options, value, hint });
  if (m.family === "image") {
    const img = settings().image;
    field("Shape", "aspect", ASPECTS, img.aspect);
    field("Size", "size", SIZES.map(([v, l]) => [v, `${l} · ${imageDims(img.aspect, v).join(" × ")}`]), img.size);
    if (workflows.moss && !ref)
      field(
        "Background",
        "transparent",
        [["off", "Normal"], ["on", "Transparent · MOSS-Image, a PNG with alpha"]],
        img.transparent ?? "off",
        "Transparent draws one subject on nothing (a sticker, a sprite, a logo) with MOSS-Image's Alpha LoRA. That LoRA is for non-commercial research and evaluation only",
      );
  }
  if (m.family === "ltx" || m.family === "ltx1") {
    const v = settings().video;
    field("Resolution", "res", LTX_RES, v.res);
    field("Length", "seconds", LTX_SECONDS.map((n) => [n, `${n} seconds`]), v.seconds);
    field("Frame rate", "fps", LTX_FPS.map((n) => [n, `${n} fps`]), v.fps, `${ltxFrames(v.seconds, v.fps)} frames`);
  }
  if (gm === "refvideo" && workflows.animate)
    field(
      "Model",
      "fromPicture",
      [
        ["wan", "Wan 2.2 · uncensored, no sound"],
        ["ltx", "LTX-2.5 · with sound"],
      ],
      settings().video.fromPicture ?? "wan",
      "For a video made from a picture",
    );
  if (m.family === "wan") {
    const v = settings().animate;
    const auto = wanAuto(src?.width, src?.height).join(" × ");
    field("Resolution", "res", WAN_RES.map(([r, l]) => [r, r === "auto" ? `${l} (${auto})` : l]), v.res);
    field("Length", "seconds", WAN_SECONDS.map((n) => [n, `${n} seconds`]), v.seconds, `${wanFrames(v.seconds)} frames at 16 fps, Wan's own rate`);
  }
  if (m.family === "wan" || m.family === "svi") wanPicks(field, settings()[m.family === "svi" ? "long" : "animate"]);
  if (SAGE_FAMILIES.includes(m.family))
    field("Faster video", "sage", [["on", "On · SageAttention"], ["off", "Off"]], settings().video.sage ?? "on", SAGE_HINT);
  if (m.family === "svi") {
    const v = settings().long;
    const dims = (n: number) => sviDims(n, src?.width, src?.height).join(" × ");
    field("Size", "size", SVI_SIZES.map((n) => [n, `${dims(n)} · saved at 2×`]), v.size);
    field("Shots", "shots", SVI_SHOTS.map((n) => [n, n === 1 ? "1 shot" : `${n} shots`]), v.shots, "Each continues the last; split the prompt with | to give each its own");
    field("Shot length", "frames", SVI_FRAMES.map((n) => [n, `${n} frames · ${sviSeconds(n, 1)} s`]), v.frames, `${sviSeconds(v.frames, v.shots)} s in all, at ${SVI_FPS * 2} fps after FILM`);
  }
  if (m.family === "song") {
    const v = settings().music;
    field("Length", "seconds", SONG_SECONDS.map((n) => [n, songLength(n)]), v.seconds);
    field("Tempo", "bpm", SONG_BPMS.map((n) => [n, `${n} bpm`]), v.bpm);
    field("Key", "key", SONG_KEYS.map((k) => [k, k]), v.key);
    field("Meter", "meter", SONG_METERS, v.meter);
    field("Lyrics language", "language", SONG_LANGUAGES, v.language, "Chat's /song picks the tempo, key and language for each song");
    field("Quality", "quality", [["standard", "Standard · ACE-Step 1.5 turbo"], ["high", "High · ACE-Step 1.5 XL, ~3 min"]], v.quality, "High needs the Workstation's music-xl pack and most of a 12 GB card; the song editor uses it too");
  }
  const quality = "quality" in s ? s.quality : "standard";
  const fast = LIGHTNING_MODES.includes(gm) && settings().image.edits !== "quality";
  if (MOSS_EDIT_MODES.includes(gm))
    field(
      "Edit with",
      "editModel",
      [["qwen", "Qwen-Image-2.1"], ["moss", "MOSS-Image · edit LoRA, up to 3 pictures"]],
      settings().image.editModel ?? "qwen",
      "For edits, Paint to change and Reference. MOSS-Image Fast is 8 steps, Quality 30; it needs the moss pack",
    );
  if (LIGHTNING_MODES.includes(gm))
    field("Speed", "edits", [["fast", "Fast · Lightning, 4 steps"], ["quality", "Quality · more steps"]], fast ? "fast" : "quality", "Fast is about 4× quicker; Quality keeps a little more colour and fine detail");
  if (m.family === "ltx") field("Quality", "quality", [["draft", "Draft · half size, one pass"], ["standard", "Standard · upscaled 2×"]], quality === "draft" ? "draft" : "standard");
  else if (m.steps && !fast) {
    const q = m.steps[quality] != null ? quality : "standard";
    field("Quality", "quality", levels(m).map((l) => [l, `${QUALITY_NAMES[l]} · ${m.steps![l]} steps`]), q);
  }
  if (gm === "moss")
    field("MOSS model", "moss", [["sft", "MOSS-Image · best with text and layouts"], ["kromoss", "Kromoss · more natural people"]], settings().image.moss ?? "sft", "Kromoss comes with the Workstation's Kromoss pack");
  if (m.family === "image") field("How many", "count", [1, 2, 3, 4].map((n) => [n, n === 1 ? "1 image" : `${n} images`]), settings().image.count);
  // A face or style taught with Fizgig; its trigger word goes into the prompt by itself.
  if (QWEN_LORA_MODES.includes(gm) && trainedLoras().length) {
    const cur = settings().image.lora ?? "";
    field(
      "Your LoRA",
      "lora",
      [["", "None"], ...trainedLoras().map((l): [string, string] => [l.file, `${l.name || l.trigger} · ${l.kind === "style" ? "style" : "face"}`])],
      cur,
      "Taught with ✦ Teach a face or style; its word goes into the prompt by itself",
    );
  }
  return f;
}

/** A picked option as the setting's value. Numbers stay numbers (length, fps, count, the long video's size…); words
 *  stay words. "size" is both: the long video's longest side, and an image's Small / Standard / Large, which Number()
 *  turned into NaN (saved as null). A song's meter is a digit too, but ACE-Step takes it as text ("4", "6"). */
export function fieldValue(k: string, raw: string) {
  const model = k === "high" || k === "low" || k === "lora";
  return /^\d+$/.test(raw) && k !== "meter" ? Number(raw) : model ? raw || null : raw;
}

/** The settings form for a mode (Studio's panel and chat's popover). Changes are saved and shared. */
export function settingsForm(el: HTMLElement, gm: GenMode, withWarn: boolean) {
  const m = modeOf(gm);
  const key = settingsKey(gm);
  const s = settings()[key];
  const p = plan(gm);
  const f = settingsFields(gm).map(
    (x) => `<label class="field">${x.label}<select data-k="${x.k}">${optionList(x.options, x.value)}</select>${x.hint ? `<small>${x.hint}</small>` : ""}</label>`,
  );
  if ((m.family === "svi" || m.family === "wan") && !sviModels && !sviModelsLoading) loadSviModels().then(() => sviModels && el.isConnected && settingsForm(el, gm, withWarn));
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
      update(k === "fromPicture" || k === "sage" ? "video" : key, { [k]: fieldValue(k, sel.value) } as any);
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
