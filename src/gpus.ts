// Every NVIDIA card in the PC and which services run on which, so meters, fit warnings and "make room" steps use the
// right card. The cards come from nvidia-smi (gpu_stats, every second); the plan from the workstation's
// data\runtime\gpu.json, which start-all.ps1 writes on every start (single, split or pool; see docs\GPUS.md there).
// Without a plan (an older workstation, or services not started yet) everything is on the biggest card.
import { invoke } from "@tauri-apps/api/core";

export interface Gpu {
  index: number; // nvidia-smi's (PCI order)
  uuid?: string;
  name?: string;
  util: number;
  mem_used: number; // MiB
  mem_total: number;
  temp: number;
  fan?: number | null;
  power?: number | null;
  power_limit?: number | null;
  slowdown_temp?: number | null;
  target_temp?: number | null;
}

export type Service = "ollama" | "openwebui" | "voice" | "llama" | "comfyui";

export interface GpuPlan {
  mode: "none" | "single" | "split" | "pool";
  gpus: { index: number; uuid: string; name: string; gb: number }[];
  services: Partial<Record<Service, number[]>>;
  ollamaContext: number;
  llamaFit: boolean;
  tensorSplit: string | null;
  /** What ComfyUI loads on its second card ("upscaler", "vae", "text_encoder"); empty with one card. */
  comfyAux?: string[];
}

export const SERVICE_NAMES: Record<Service, string> = {
  ollama: "Ollama",
  openwebui: "Open WebUI",
  voice: "voice server",
  llama: "llama.cpp",
  comfyui: "ComfyUI",
};

const inTauri = "__TAURI_INTERNALS__" in window;
let gpus: Gpu[] = [];
let plan: GpuPlan | null = null;
const listeners: (() => void)[] = [];

/** Fresh numbers for every card (also what the meters poll). */
export async function readGpus(): Promise<Gpu[]> {
  if (!inTauri) return gpus;
  gpus = await invoke<Gpu[]>("gpu_stats");
  return gpus;
}

export const allGpus = () => gpus;

/** Re-reads data\runtime\gpu.json; tells listeners when the plan changed (after start-all.ps1 ran). */
export async function refreshPlan(root: string | null) {
  if (!inTauri) return;
  const next = await invoke<GpuPlan | null>("gpu_plan", { root }).catch(() => null);
  if (next) {
    // PowerShell writes a one-element list as a bare value in some versions.
    next.gpus = [].concat((next.gpus ?? []) as never);
    for (const k of Object.keys(next.services ?? {}) as Service[]) next.services[k] = [].concat(next.services[k] as never);
    next.comfyAux = [].concat((next.comfyAux ?? []) as never);
  }
  const changed = JSON.stringify(next) !== JSON.stringify(plan);
  plan = next && next.mode !== "none" ? next : null;
  if (changed) listeners.forEach((f) => f());
}

export function onPlanChange(f: () => void) {
  listeners.push(f);
}

export const gpuPlan = () => plan;

/** The card everything runs on without a plan: the one with the most memory. */
function biggest(): Gpu | undefined {
  return [...gpus].sort((a, b) => b.mem_total - a.mem_total || a.index - b.index)[0];
}

/** The cards a service runs on, in the plan's order (its main card first), empty when nvidia-smi has nothing. */
export function cardsFor(s: Service): Gpu[] {
  const idx = plan?.services[s];
  const cards = idx?.length ? idx.map((i) => gpus.find((g) => g.index === i)).filter((g): g is Gpu => !!g) : [];
  if (cards.length) return cards;
  const b = biggest();
  return b ? [b] : [];
}

/** Services on this card. */
export function servicesOn(index: number): Service[] {
  return (Object.keys(SERVICE_NAMES) as Service[]).filter((s) => cardsFor(s).some((g) => g.index === index));
}

const GB = 1024;
/** Total VRAM of a service's cards in GB (12, the reference card, before nvidia-smi has answered). */
export function vramGB(s: Service): number {
  const c = cardsFor(s);
  return c.length ? c.reduce((t, g) => t + g.mem_total, 0) / GB : 12;
}

/** Free VRAM on a service's cards in GB, or null before nvidia-smi has answered. */
export function freeGB(s: Service): number | null {
  const c = cardsFor(s);
  return c.length ? c.reduce((t, g) => t + g.mem_total - g.mem_used, 0) / GB : null;
}

/** ComfyUI's main card, which runs the diffusion model, and the second card with what it holds there (if any). */
export function comfyCards(): { main?: Gpu; aux?: Gpu; parts: string[] } {
  const [main, aux] = cardsFor("comfyui");
  const parts = aux ? (plan?.comfyAux ?? []) : [];
  return { main, aux: parts.length ? aux : undefined, parts };
}

/** Whether two services have a card in common, so one has to make room for the other. */
export function sharesCard(a: Service, b: Service): boolean {
  const x = cardsFor(a).map((g) => g.index);
  return x.length === 0 || cardsFor(b).some((g) => x.includes(g.index));
}

/** The context Ollama models run with: 32k on 12 GB, less on small cards (the plan sizes it to Ollama's card). */
export function ollamaCtx(): number {
  return plan?.ollamaContext ?? 32768;
}

/** "RTX 3060" from "NVIDIA GeForce RTX 3060". */
export function shortName(g: Gpu): string {
  return (g.name ?? `GPU ${g.index}`).replace(/^NVIDIA\s+/i, "").replace(/^GeForce\s+/i, "");
}

/** "the RTX 3060's 12 GB" / "the 18 GB of the RTX 3060 and RTX 2060": where a service's models go, for messages. */
export function cardsText(s: Service): string {
  const c = cardsFor(s);
  if (!c.length) return "the GPU";
  const gb = Math.round(c.reduce((t, g) => t + g.mem_total, 0) / GB);
  return c.length === 1 ? `the ${shortName(c[0])}'s ${gb} GB` : `the ${gb} GB of the ${c.map(shortName).join(" and ")}`;
}
