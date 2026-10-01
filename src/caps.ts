// What each model can do, detected automatically so newly pulled or added models need no setup:
// - Ollama models: /api/show reports capabilities (tools, vision, thinking, audio), context and size
// - llama.cpp models: the GGUF file's own metadata (chat template, context) plus the router's
//   preset (a vision projector means images work)
// Coding and uncensored are read from the model's name, and VRAM fit from its size.
import { invoke } from "@tauri-apps/api/core";
import { http, OLLAMA, type ModelInfo } from "./backends";

export interface Caps {
  tools: boolean;
  vision: boolean;
  thinking: boolean;
  audio: boolean;
  code: boolean;
  uncensored: boolean;
  computerUse: boolean;
  embedding: boolean;
  context?: number; // what Prestige runs it with
  maxContext?: number; // what the model supports
  params?: string; // "11.9B"
  quant?: string;
  sizeGB?: number;
  fit: "gpu" | "split" | "big" | "unknown";
}

export const VRAM_GB = 12;
const inTauri = "__TAURI_INTERNALS__" in window;

/** Name hints that metadata can't tell us. */
export function nameHints(id: string) {
  return {
    code: /coder|code|devstral|starcoder/i.test(id),
    uncensored: /uncensored|abliterat|heretic|dolphin|uncensor/i.test(id),
    computerUse: /ui-tars/i.test(id),
    embedding: /embed/i.test(id),
  };
}

/** How a model of this size sits on the 12 GB card (Ollama adds ~1.2 GB for the 32k context). */
export function fitFor(sizeGB: number | undefined, moeOffload = false): Caps["fit"] {
  if (!sizeGB) return "unknown";
  if (moeOffload) return "split";
  if (sizeGB + 1.2 <= VRAM_GB - 0.8) return "gpu";
  if (sizeGB <= 26) return "split";
  return "big";
}

const cache = new Map<string, Promise<Caps>>();

export function capsFor(m: ModelInfo): Promise<Caps> {
  let p = cache.get(m.key);
  if (!p) {
    p = (m.backend === "ollama" ? ollamaCaps(m) : llamaCaps(m)).catch(() => ({ ...emptyCaps(m.id) }));
    cache.set(m.key, p);
  }
  return p;
}

/** Forget cached capabilities (after models are added or removed). */
export function resetCaps() {
  cache.clear();
}

function emptyCaps(id: string): Caps {
  return { tools: false, vision: false, thinking: false, audio: false, ...nameHints(id), fit: "unknown" };
}

async function ollamaCaps(m: ModelInfo): Promise<Caps> {
  const r = await http(`${OLLAMA}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: m.id }),
  });
  const j = await r.json();
  const caps: string[] = j.capabilities ?? [];
  const info = j.model_info ?? {};
  const arch = info["general.architecture"];
  const maxCtx = arch ? info[`${arch}.context_length`] : undefined;
  return {
    tools: caps.includes("tools"),
    vision: caps.includes("vision"),
    thinking: caps.includes("thinking"),
    audio: caps.includes("audio"),
    ...nameHints(m.id),
    embedding: caps.includes("embedding") || nameHints(m.id).embedding,
    context: Math.min(32768, maxCtx ?? 32768),
    maxContext: maxCtx,
    params: j.details?.parameter_size,
    quant: j.details?.quantization_level,
    sizeGB: m.sizeBytes ? m.sizeBytes / 1e9 : undefined,
    fit: fitFor(m.sizeBytes ? m.sizeBytes / 1e9 : undefined),
  };
}

async function llamaCaps(m: ModelInfo): Promise<Caps> {
  const a = m.args ?? [];
  const arg = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const path = arg("--model");
  const hints = nameHints(m.id);
  let g: any = {};
  let size: number | undefined;
  if (inTauri && path) {
    try {
      g = await invoke("gguf_info", { path });
    } catch {
      g = {};
    }
    try {
      size = ((await invoke<number[]>("file_sizes", { paths: [path] }))[0] || 0) / 1e9 || undefined;
    } catch {
      /* size unknown */
    }
  }
  const params = g.params ? `${(g.params / 1e9).toFixed(g.params > 1e10 ? 0 : 1)}B` : g.size_label;
  return {
    tools: !hints.computerUse && (g.has_template ? !!g.template_tools : true),
    vision: !!arg("--mmproj") || (m.inputModalities ?? []).includes("image"),
    thinking: !!g.template_thinking,
    audio: (m.inputModalities ?? []).includes("audio"),
    ...hints,
    context: Number(arg("--ctx-size")) || undefined,
    maxContext: g.context,
    params,
    sizeGB: size,
    fit: fitFor(size, !!arg("--n-cpu-moe") || !!arg("--cpu-moe")),
  };
}

// ---------- presentation ----------

export interface Chip {
  icon: string;
  label: string;
  tip: string;
}

export function chips(c: Caps): Chip[] {
  const out: Chip[] = [];
  if (c.tools) out.push({ icon: "🔧", label: "Tools", tip: "Can use tools: web search, files, PowerShell, browser" });
  if (c.vision) out.push({ icon: "👁", label: "Vision", tip: "Understands images and webcam frames" });
  if (c.thinking) out.push({ icon: "🧠", label: "Thinking", tip: "Reasons step by step before answering (slower, smarter)" });
  if (c.audio) out.push({ icon: "🎧", label: "Audio", tip: "Can take audio input" });
  if (c.code) out.push({ icon: "💻", label: "Code", tip: "Tuned for programming" });
  if (c.uncensored) out.push({ icon: "🔓", label: "Uncensored", tip: "Fewer refusals than the original model" });
  if (c.computerUse) out.push({ icon: "🖱", label: "Computer use", tip: "Drives the mouse and keyboard through UI-TARS Desktop" });
  if (c.embedding) out.push({ icon: "🧩", label: "Embeddings", tip: "For search and memory, not chat" });
  return out;
}

export function fitText(c: Caps) {
  return {
    gpu: { icon: "✅", label: "Fits in VRAM", tip: "Runs fully on the 12 GB card: fastest" },
    split: { icon: "⚖", label: "Partly in RAM", tip: "Part of it runs from system RAM: works, but slower" },
    big: { icon: "⚠", label: "Too big", tip: "Larger than this PC can run comfortably" },
    unknown: { icon: "", label: "", tip: "" },
  }[c.fit];
}

/** A one-line "best for …" from the capabilities. */
export function bestFor(c: Caps): string {
  if (c.computerUse) return "controlling the PC with UI-TARS Desktop";
  if (c.embedding) return "search and memory (not chat)";
  const parts: string[] = [];
  if (c.code) parts.push("coding");
  if (c.vision) parts.push("pictures and the webcam");
  if (c.tools) parts.push("tools and web search");
  if (c.thinking) parts.push("hard questions");
  if (c.uncensored) parts.push("unfiltered answers");
  if (!parts.length) parts.push("everyday chat");
  if (c.fit === "gpu" && (c.sizeGB ?? 99) < 5.5) parts.push("fast replies");
  return parts.slice(0, 3).join(", ");
}

export function chipsHtml(c: Caps, withFit = true): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const list = chips(c).map((x) => `<span class="cap" title="${esc(x.tip)}">${x.icon} ${esc(x.label)}</span>`);
  const f = fitText(c);
  if (withFit && f.label) list.push(`<span class="cap fit-${c.fit}" title="${esc(f.tip)}">${f.icon} ${esc(f.label)}</span>`);
  return list.join("");
}

/** Whether a model can call functions (used to decide if tools are offered). */
export async function supportsTools(m: ModelInfo): Promise<boolean> {
  return (await capsFor(m)).tools;
}
