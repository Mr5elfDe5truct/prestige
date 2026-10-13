// Uncensored models for Prestige's own renders, picked when a render is sent to ComfyUI. They apply to text-to-image
// and text-to-video and to pictures Prestige made (renders, and references taken from them); a photo brought in
// from outside (picked, pasted, dropped, attached, webcam, phone) keeps the standard models.
// - Qwen-Image-2.1 (edits, Paint to change, new angles, outfits, reference images, text to image): the stock
//   Qwen3-VL-8B-Instruct text encoder steers prompts toward modesty, so "nude" edits came back clothed. The Heretic
//   build of the same encoder has that refusal direction removed (abliterated) and drops in unchanged.
// - Wan 2.2 (Animate, long video, video from a picture): a model pick of null means "uncensored if one is installed"
//   (the Dasiwa SynthSeduction pair Ryan has, or any high/low pair named uncensored or NSFW), "stock" the workflow's own
//   4-step models, and anything else that file from ComfyUI's model folders.
import { http } from "./backends";

const COMFY = "http://127.0.0.1:8188";

/** The Heretic Qwen3-VL-8B text encoder (pottokao/Qwen-Image-2.1-Text-Encoder-Heretic-GGUF). ComfyUI-GGUF finds its
 *  vision part by name, so mmproj-qwen3vl_8b_heretic-f16.gguf must sit beside it in text_encoders. */
export const HERETIC_TE = "qwen3vl_8b_heretic-Q4_K_M.gguf";
export const HERETIC_MMPROJ = "mmproj-qwen3vl_8b_heretic-f16.gguf";
const STOCK_TE = /^Qwen3-VL-8B-Instruct/i;

/** Model files whose names say they're uncensored. */
export const UNCENSORED = /dasiwa|synthseduction|nsfw|uncensor|heretic|abliterat/i;

/** "stock": the workflow's own model, not an uncensored one. */
export const STOCK = "stock";

// ComfyUI's model lists, read again after a minute (a pack may have been added since).
const lists = new Map<string, { at: number; names: Promise<string[]> }>();
function comfyList(node: string, input: string): Promise<string[]> {
  const hit = lists.get(node);
  if (hit && Date.now() - hit.at < 60_000) return hit.names;
  const names = (async () => {
    try {
      const r = await http(`${COMFY}/object_info/${node}`);
      const list = (await r.json())?.[node]?.input?.required?.[input]?.[0];
      return Array.isArray(list) ? (list as string[]) : [];
    } catch {
      return [];
    }
  })();
  lists.set(node, { at: Date.now(), names });
  names.then((n) => n.length || lists.delete(node)); // ComfyUI wasn't up: ask again next time
  return names;
}

/** The diffusion models ComfyUI can load, safetensors and GGUF. */
export async function diffusionModels(): Promise<string[]> {
  const [a, b] = await Promise.all([comfyList("UNETLoader", "unet_name"), comfyList("UnetLoaderGGUF", "unet_name")]);
  return [...new Set([...a, ...b])].sort((x, y) => x.localeCompare(y));
}

/** The uncensored Wan 2.2 model for one noise level, if one is installed. */
export function uncensoredWan(models: string[], which: "high" | "low"): string | undefined {
  const level = which === "high" ? /high/i : /low/i;
  return models.find((n) => UNCENSORED.test(n) && level.test(n) && /wan|dasiwa/i.test(n));
}

/** The file a Wan model pick runs: null picks the uncensored one if there is one (and `auto` allows it); "stock" or
 *  nothing keeps the workflow's own. */
export function wanPick(pick: string | null | undefined, models: string[], which: "high" | "low", auto = true): string | undefined {
  if (pick === STOCK) return undefined;
  return pick || (auto ? uncensoredWan(models, which) : undefined);
}

/** Puts the picked Wan 2.2 models into a workflow (high-noise node, low-noise node), with the loader each file type
 *  needs. `fp16`: each model's fp16-accumulation patch, which speeds up safetensors models but breaks GGUF ones.
 *  `auto`: whether an unpicked model may be the uncensored one (only for pictures Prestige made). */
export async function applyWanModels(
  g: any,
  ids: readonly [string, string],
  picks: { high?: string | null; low?: string | null },
  fp16?: readonly string[],
  auto = true,
): Promise<void> {
  const models = await diffusionModels();
  ids.forEach((id, i) => {
    const which = i === 0 ? "high" : "low";
    const name = wanPick(picks[which], models, which, auto);
    if (!name || !g[id]) return;
    const gguf = /\.gguf$/i.test(name);
    g[id] = gguf
      ? { class_type: "UnetLoaderGGUF", inputs: { unet_name: name } }
      : { class_type: "UNETLoader", inputs: { unet_name: name, weight_dtype: "default" } };
    if (fp16 && g[fp16[i]]) g[fp16[i]].inputs.enable_fp16_accumulation = !gguf;
  });
}

/** Swaps the stock Qwen3-VL text encoder for the Heretic one in a Qwen-Image workflow, when it and its vision part
 *  are installed. Resolves with whether it did. */
export async function uncensorTextEncoder(g: any): Promise<boolean> {
  const loaders = Object.values<any>(g).filter((n) => n?.class_type === "CLIPLoaderGGUF" && STOCK_TE.test(String(n.inputs?.clip_name ?? "")));
  if (!loaders.length) return false;
  const names = await comfyList("CLIPLoaderGGUF", "clip_name");
  if (!names.includes(HERETIC_TE) || !names.includes(HERETIC_MMPROJ)) return false;
  loaders.forEach((n) => (n.inputs.clip_name = HERETIC_TE));
  return true;
}
