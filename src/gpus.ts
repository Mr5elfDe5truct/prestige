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

// ---------- who holds the VRAM, measured ----------
// nvidia-smi can't say per process on Windows, so gpu_procs (vram.rs) reads Windows' own GPU counters: each process's
// dedicated memory on each card. Here each process becomes something a person recognises.

/** What a process is, for the VRAM bars and warnings. `service`: one of the Workstation's, which Prestige can unload. */
export interface Holder {
  gpu: number;
  pid: number;
  label: string; // "llama.cpp", "ComfyUI", "Windows desktop", "chrome"…
  service?: Service | "kokoro" | "phonon";
  model?: boolean; // llama.cpp's process for a model (not the router itself)
  mib: number;
}

interface ProcVram {
  gpu: number;
  pid: number;
  path: string;
  name: string;
  parent: number;
  parent_path: string;
  mib: number;
}

const has = (p: ProcVram, re: RegExp) => re.test(p.path) || re.test(p.parent_path);

/** A process's label and service, from its path (or its parent's: a venv's python.exe starts the real interpreter). */
export function classify(p: ProcVram): Holder {
  const base = { gpu: p.gpu, pid: p.pid, mib: p.mib };
  const exe = (p.name || p.path.split("\\").pop() || `pid ${p.pid}`).replace(/\.exe$/i, "");
  if (/\\Programs\\Ollama\\|\\ollama(\.exe)?$/i.test(p.path) || /\\Programs\\Ollama\\/i.test(p.parent_path)) return { ...base, label: "Ollama", service: "ollama" };
  if (/llama-server/i.test(exe)) return { ...base, label: "llama.cpp", service: "llama", model: /llama-server\.exe$/i.test(p.parent_path) };
  if (has(p, /Comfy-Desktop|\\apps\\ComfyUI\\|\\envs\\comfyui\\/i)) return { ...base, label: "ComfyUI", service: "comfyui" };
  if (has(p, /\\envs\\voice\\/i)) return { ...base, label: "Voice server", service: "voice" };
  if (has(p, /\\envs\\open-webui\\/i)) return { ...base, label: "Open WebUI", service: "openwebui" };
  if (has(p, /\\envs\\kokoro\\/i)) return { ...base, label: "Kokoro", service: "kokoro" };
  if (has(p, /\\envs\\transcribe\\/i)) return { ...base, label: "Phonon", service: "phonon" };
  if (/^(dwm|csrss|explorer|ShellExperienceHost|StartMenuExperienceHost|SearchHost|TextInputHost|ShellHost|ApplicationFrameHost|LockApp|SystemSettings)$/i.test(exe))
    return { ...base, label: "Windows desktop" };
  if (/^msedgewebview2$/i.test(exe)) return { ...base, label: "Web views (Prestige and other apps)" };
  return { ...base, label: exe };
}

let holders: Holder[] = [];
let holdersAt = 0;

/** Each process's VRAM on each card, measured now (cached for 2 s; the counters take ~0.4 s to read). */
export async function readHolders(force = false): Promise<Holder[]> {
  if (!inTauri) return holders;
  if (!force && Date.now() - holdersAt < 2000) return holders;
  try {
    holders = (await invoke<ProcVram[]>("gpu_procs")).map(classify);
    holdersAt = Date.now();
  } catch {
    /* no counters: callers fall back to nvidia-smi's totals */
  }
  return holders;
}

export const lastHolders = () => holders;

/** On one card: the VRAM the Workstation's services hold (which Prestige can free) and what everything else holds,
 *  grouped by name, largest first. MiB. */
export function heldOn(index: number): { services: number; others: number; byLabel: [string, number][] } {
  const here = holders.filter((h) => h.gpu === index);
  const services = here.filter((h) => h.service).reduce((s, h) => s + h.mib, 0);
  const groups = new Map<string, number>();
  for (const h of here) if (!h.service) groups.set(h.label, (groups.get(h.label) ?? 0) + h.mib);
  return { services, others: here.filter((h) => !h.service).reduce((s, h) => s + h.mib, 0), byLabel: [...groups].sort((a, b) => b[1] - a[1]) };
}

/** "Chrome 1.2 GB, a game 3.0 GB": the biggest non-Workstation users of a card, for warnings. */
export function othersText(index: number, minMiB = 300): string {
  const { byLabel } = heldOn(index);
  return byLabel
    .filter(([l, m]) => m >= minMiB && l !== "Windows desktop")
    .slice(0, 3)
    .map(([l, m]) => `${l} ${(m / 1024).toFixed(1)} GB`)
    .join(", ");
}

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
