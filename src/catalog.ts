// The model catalog: models checked to exist (Ollama registry / Hugging Face) and to run on the
// workstation, with what each is good at. Ollama models are pulled into the workstation's Ollama
// store; GGUF models download into models\gguf and get registered with the llama.cpp router.
// Capabilities listed here are what to expect; once installed, Prestige detects the real ones.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errMsg, http, setFriendlyNames, OLLAMA, LLAMA } from "./backends";
import { chipsHtml, fitFor, nameHints, resetCaps, type Caps } from "./caps";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll(s)) as T[];

type Cap = "tools" | "vision" | "thinking" | "audio" | "code" | "uncensored";

interface Entry {
  name: string;
  maker: string;
  about: string;
  caps: Cap[];
  sizeGB: number; // download size
  license: string;
  ollama?: string; // tag to pull
  gguf?: {
    id: string; repo: string; file: string; mmproj?: string; mmprojAs?: string; nCpuMoe?: number;
    /** Extra llama-server settings for its llama-models.ini section, e.g. ["c", "20480"]. */
    options?: [string, string][];
    /** Fits the GPU whole (a dense model, not experts in RAM). */
    onGpu?: boolean;
  };
}

export const CATALOG: Entry[] = [
  // ---------- fast, everyday (fit fully in 12 GB) ----------
  { name: "Qwen3.5 9B", maker: "Qwen", ollama: "qwen3.5:9b", sizeGB: 6.59, license: "Apache 2.0", caps: ["tools", "vision", "thinking"],
    about: "The best all-rounder that fits fully on the GPU: tools, pictures and step-by-step thinking." },
  { name: "Qwen3.5 4B", maker: "Qwen", ollama: "qwen3.5:4b", sizeGB: 3.39, license: "Apache 2.0", caps: ["tools", "vision", "thinking"],
    about: "A small, quick Qwen3.5 for snappy replies and light tool use." },
  { name: "Qwen3 8B", maker: "Qwen", ollama: "qwen3:8b", sizeGB: 5.23, license: "Apache 2.0", caps: ["tools", "thinking"],
    about: "Reliable text model with solid tool calling and a thinking mode." },
  { name: "Qwen3 14B", maker: "Qwen", ollama: "qwen3:14b", sizeGB: 9.28, license: "Apache 2.0", caps: ["tools", "thinking"],
    about: "Stronger reasoning than the 8B while still fitting the 12 GB card." },
  { name: "Gemma 4 E2B", maker: "Google", ollama: "gemma4:e2b", sizeGB: 4.59, license: "Gemma", caps: ["tools", "vision", "audio", "thinking"],
    about: "Google's tiny multimodal Gemma 4: sees pictures and hears audio, very fast." },
  { name: "Gemma 3 12B", maker: "Google", ollama: "gemma3:12b", sizeGB: 8.15, license: "Gemma", caps: ["vision"],
    about: "Previous-generation Gemma with good image understanding; no tool calling." },
  { name: "Llama 3.2 3B", maker: "Meta", ollama: "llama3.2:3b", sizeGB: 2.02, license: "Llama 3.2", caps: ["tools"],
    about: "Tiny and instant. Good for quick questions and simple tool calls." },
  { name: "Llama 3.2 Vision 11B", maker: "Meta", ollama: "llama3.2-vision:11b", sizeGB: 7.82, license: "Llama 3.2", caps: ["vision"],
    about: "Meta's image-understanding Llama for describing photos and screenshots." },
  { name: "Ministral 3 8B", maker: "Mistral", ollama: "ministral-3:8b", sizeGB: 6.02, license: "Apache 2.0", caps: ["tools", "vision"],
    about: "Mistral's compact model with tool calling and image input." },
  { name: "Phi-4 Mini 3.8B", maker: "Microsoft", ollama: "phi4-mini:3.8b", sizeGB: 2.49, license: "MIT", caps: ["tools"],
    about: "Small but sharp at maths and logic, with tool calling." },
  { name: "Phi-4 14B", maker: "Microsoft", ollama: "phi4:14b", sizeGB: 9.05, license: "MIT", caps: [],
    about: "Strong reasoning and writing for its size; text only, no tools." },
  { name: "DeepSeek-R1 8B", maker: "DeepSeek", ollama: "deepseek-r1:8b", sizeGB: 5.23, license: "MIT", caps: ["thinking", "tools"],
    about: "A reasoning model that thinks out loud before answering. Good for puzzles and maths." },
  { name: "DeepSeek-R1 14B", maker: "DeepSeek", ollama: "deepseek-r1:14b", sizeGB: 8.99, license: "MIT", caps: ["thinking"],
    about: "The larger R1 distill: slower, deeper reasoning." },
  { name: "Granite 3.3 8B", maker: "IBM", ollama: "granite3.3:8b", sizeGB: 4.94, license: "Apache 2.0", caps: ["tools", "thinking"],
    about: "IBM's business-friendly model: summaries, documents and tool use." },
  { name: "Qwen3-VL 8B", maker: "Qwen", ollama: "qwen3-vl:8b", sizeGB: 6.14, license: "Apache 2.0", caps: ["vision", "tools", "thinking"],
    about: "Qwen's vision specialist: reads documents, charts and screenshots well." },
  { name: "MiniCPM-V 8B", maker: "OpenBMB", ollama: "minicpm-v:8b", sizeGB: 5.47, license: "MiniCPM", caps: ["vision"],
    about: "Strong OCR and image detail for its size." },
  { name: "Qwen2.5 Coder 14B", maker: "Qwen", ollama: "qwen2.5-coder:14b", sizeGB: 8.99, license: "Apache 2.0", caps: ["code", "tools"],
    about: "A capable coding assistant that still fits on the GPU." },
  { name: "Dolphin 3 8B", maker: "Cognitive Computations", ollama: "dolphin3:8b", sizeGB: 4.92, license: "Llama 3.1", caps: ["uncensored", "tools"],
    about: "An uncensored Llama 3.1 fine-tune that follows instructions without refusing." },
  { name: "Hermes 3 8B", maker: "Nous Research", ollama: "hermes3:8b", sizeGB: 4.66, license: "Llama 3", caps: ["uncensored", "tools"],
    about: "Steerable, less filtered model popular for role-play and creative writing." },
  // ---------- bigger (part of it runs from system RAM) ----------
  { name: "gpt-oss 20B", maker: "OpenAI", ollama: "gpt-oss:20b", sizeGB: 13.79, license: "Apache 2.0", caps: ["tools", "thinking"],
    about: "OpenAI's open-weight model with adjustable reasoning and strong tool use." },
  { name: "Mistral Small 3.2 24B", maker: "Mistral", ollama: "mistral-small3.2:24b", sizeGB: 15.18, license: "Apache 2.0", caps: ["tools", "vision"],
    about: "A smart mid-size model with images and tools. Slower here, since part of it runs from RAM." },
  { name: "Devstral 24B", maker: "Mistral", ollama: "devstral:24b", sizeGB: 14.33, license: "Apache 2.0", caps: ["code", "tools"],
    about: "Built for agentic coding: editing files and running tools across a project." },
  { name: "Qwen3 Coder 30B", maker: "Qwen", ollama: "qwen3-coder:30b", sizeGB: 18.56, license: "Apache 2.0", caps: ["code", "tools"],
    about: "Qwen's flagship local coder (a mixture of experts, so it stays quick even partly in RAM)." },
  // ---------- llama.cpp router (experts in RAM, like Qwen3.6 35B) ----------
  // nCpuMoe = expert layers kept in system RAM so weights + 32k context (+ vision projector) fit 12 GB.
  // Measured: Qwen3-VL needs 36 (28 ran out of VRAM loading its projector); GLM-4.7 Flash loads at 30.
  { name: "Qwen3 30B-A3B Instruct 2507", maker: "Qwen", sizeGB: 18.56, license: "Apache 2.0", caps: ["tools"],
    gguf: { id: "qwen3-30b-a3b-instruct", repo: "unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF", file: "Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf", nCpuMoe: 32 },
    about: "Fast mixture-of-experts model with experts in RAM, about 25 tok/s on the 3060. Great general chat with tools." },
  { name: "Qwen3 30B-A3B Thinking 2507", maker: "Qwen", sizeGB: 18.56, license: "Apache 2.0", caps: ["tools", "thinking"],
    gguf: { id: "qwen3-30b-a3b-thinking", repo: "unsloth/Qwen3-30B-A3B-Thinking-2507-GGUF", file: "Qwen3-30B-A3B-Thinking-2507-Q4_K_M.gguf", nCpuMoe: 32 },
    about: "The reasoning version of the 30B-A3B: thinks before it answers." },
  { name: "Qwen3-VL 30B-A3B", maker: "Qwen", sizeGB: 19.64, license: "Apache 2.0", caps: ["vision", "tools"],
    gguf: { id: "qwen3-vl-30b-a3b", repo: "unsloth/Qwen3-VL-30B-A3B-Instruct-GGUF", file: "Qwen3-VL-30B-A3B-Instruct-Q4_K_M.gguf",
            mmproj: "mmproj-F16.gguf", mmprojAs: "Qwen3-VL-30B-A3B-Instruct-mmproj-F16.gguf", nCpuMoe: 36 },
    about: "A big vision model run like Qwen3.6: strong at screenshots, documents and the webcam." },
  { name: "GLM-4.7 Flash", maker: "Z.ai", sizeGB: 18.31, license: "MIT", caps: ["tools", "thinking"],
    gguf: { id: "glm-4.7-flash", repo: "unsloth/GLM-4.7-Flash-GGUF", file: "GLM-4.7-Flash-Q4_K_M.gguf", nCpuMoe: 30 },
    about: "Z.ai's fast mixture-of-experts model: strong at agents, coding and tool use." },
  // Dense 27B at 2-bit (HauhauCS's K_P quants keep the important tensors at higher precision), so it fits the GPU whole:
  // ~30-38 tok/s with its built-in MTP drafting, where Q3/IQ3 with layers in RAM ran at 5-8 tok/s. The vision
  // projector runs on the CPU to leave room for 20k of context.
  { name: "Qwen3.8 27B Uncensored", maker: "Qwen · HauhauCS", sizeGB: 11.6, license: "Apache 2.0", caps: ["tools", "vision", "thinking", "uncensored"],
    gguf: { id: "qwen3.8-27b-uncensored", repo: "HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF",
            file: "Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q2_K_P.gguf",
            mmproj: "mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf", onGpu: true,
            options: [["no-mmproj-offload", "true"], ["spec-type", "draft-mtp"], ["spec-draft-n-max", "2"],
                      ["cache-type-k", "q8_0"], ["cache-type-v", "q8_0"], ["c", "20480"],
                      ["temp", "1.0"], ["top-p", "0.95"], ["top-k", "20"], ["min-p", "0.0"]] },
    about: "The strongest reasoner that runs here: thinks before answering, sees pictures, never refuses. About 30 tok/s, fully on the GPU." },
];

// Installed catalog models show their catalog name in the model menu.
setFriendlyNames(CATALOG.map((e) => [e.ollama ?? e.gguf!.id, e.name] as [string, string]));

interface Deps {
  toast: (msg: string, kind?: string) => void;
  root: () => string | null;
  onInstalled: () => void;
}

let deps: Deps;
let filter: Cap | "all" | "fits" = "all";
let query = "";
const busy = new Map<string, { pct: number; label: string; cancel?: () => void }>();
let installedOllama = new Set<string>();
let installedLlama = new Set<string>();

export function initCatalog(d: Deps) {
  deps = d;
  $$("#catalog .cat-filters [data-f]").forEach((b) =>
    b.addEventListener("click", () => {
      filter = b.dataset.f as typeof filter;
      $$("#catalog .cat-filters [data-f]").forEach((x) => x.classList.toggle("on", x === b));
      render();
    }),
  );
  $("#cat-search").addEventListener("input", () => {
    query = ($("#cat-search") as HTMLInputElement).value.trim().toLowerCase();
    render();
  });
  $("#cat-close").addEventListener("click", () => ($("#catalog") as HTMLDialogElement).close());
  listen<any>("download", (e) => onDownload(e.payload));
}

export async function openCatalog() {
  ($("#catalog") as HTMLDialogElement).showModal();
  await refreshInstalled();
  render();
  try {
    const free = await invoke<number>("disk_free", { path: `${await stackRoot()}\\models` });
    $("#cat-disk").textContent = `${(free / 1e9).toFixed(0)} GB free on the models drive`;
  } catch {
    $("#cat-disk").textContent = "";
  }
}

async function refreshInstalled() {
  try {
    const tags = await (await http(`${OLLAMA}/api/tags`)).json();
    installedOllama = new Set((tags.models ?? []).map((m: any) => norm(m.name)));
  } catch {
    installedOllama = new Set();
  }
  try {
    const lm = await (await http(`${LLAMA}/models`)).json();
    installedLlama = new Set((lm.data ?? []).map((m: any) => m.id));
  } catch {
    installedLlama = new Set();
  }
}

/** The Workstation folder: the one set in Settings, or Prestige's default (resolved by the Rust side). */
async function stackRoot(): Promise<string> {
  const info = await invoke<{ root: string }>("stack_info", { root: deps.root() });
  return info.root;
}

const norm = (tag: string) => (tag.includes(":") ? tag : `${tag}:latest`);
const isInstalled = (e: Entry) => (e.ollama ? installedOllama.has(norm(e.ollama)) : installedLlama.has(e.gguf!.id));
const keyOf = (e: Entry) => e.ollama ?? e.gguf!.id;

function expectedCaps(e: Entry): Caps {
  const has = (c: Cap) => e.caps.includes(c);
  const hint = nameHints(e.name);
  return {
    tools: has("tools"),
    vision: has("vision"),
    thinking: has("thinking"),
    audio: has("audio"),
    code: has("code") || hint.code,
    uncensored: has("uncensored"),
    computerUse: false,
    embedding: false,
    sizeGB: e.sizeGB,
    fit: e.gguf?.onGpu ? "gpu" : fitFor(e.sizeGB, !!e.gguf?.nCpuMoe),
  };
}

function render() {
  const grid = $("#cat-grid");
  grid.innerHTML = "";
  const list = CATALOG.filter((e) => {
    if (filter === "fits" && !e.gguf?.onGpu && fitFor(e.sizeGB, !!e.gguf) !== "gpu") return false;
    if (filter !== "all" && filter !== "fits" && !e.caps.includes(filter)) return false;
    if (query && !`${e.name} ${e.maker} ${e.about} ${e.caps.join(" ")}`.toLowerCase().includes(query)) return false;
    return true;
  });
  for (const e of list) {
    const k = keyOf(e);
    const card = document.createElement("div");
    card.className = "cat-card" + (isInstalled(e) ? " installed" : "");
    card.innerHTML = `<div class="cat-top"><div><b class="n"></b><span class="mk"></span></div><span class="be"></span></div>
      <p class="ab"></p><div class="caps"></div>
      <div class="cat-foot"><span class="meta"></span><button class="btn"></button></div>
      <div class="progress" hidden><i></i></div><span class="plabel progress-label" hidden></span>`;
    $(".n", card).textContent = e.name;
    $(".mk", card).textContent = ` · ${e.maker}`;
    $(".be", card).textContent = e.ollama ? "Ollama" : "llama.cpp";
    $(".ab", card).textContent = e.about;
    $(".caps", card).innerHTML = chipsHtml(expectedCaps(e));
    $(".meta", card).textContent = `${e.sizeGB.toFixed(1)} GB download · ${e.license}`;
    const btn = $("button", card) as HTMLButtonElement;
    const b = busy.get(k);
    if (isInstalled(e)) {
      btn.textContent = "Installed";
      btn.disabled = true;
    } else if (b) {
      btn.textContent = "Cancel";
      btn.onclick = () => b.cancel?.();
      $(".progress", card).hidden = false;
      ($(".progress", card) as HTMLElement).style.setProperty("--v", String(b.pct));
      const pl = $(".plabel", card);
      pl.hidden = false;
      pl.textContent = b.label;
    } else {
      btn.textContent = "Download";
      btn.classList.add("primary");
      btn.onclick = () => install(e);
    }
    card.dataset.key = k;
    grid.appendChild(card);
  }
  if (!list.length) grid.innerHTML = `<p class="note">No models match.</p>`;
}

function setBusy(k: string, pct: number, label: string, cancel?: () => void) {
  const prev = busy.get(k);
  busy.set(k, { pct, label, cancel: cancel ?? prev?.cancel });
  const card = $(`#cat-grid .cat-card[data-key="${CSS.escape(k)}"]`);
  if (card) {
    ($(".progress", card) as HTMLElement).hidden = false;
    ($(".progress", card) as HTMLElement).style.setProperty("--v", String(pct));
    const pl = $(".plabel", card);
    pl.hidden = false;
    pl.textContent = label;
  } else render();
}

const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;

async function install(e: Entry) {
  try {
    const free = await invoke<number>("disk_free", { path: `${await stackRoot()}\\models` });
    if (free < e.sizeGB * 1e9 * 1.1) {
      deps.toast(`Not enough disk space: ${e.name} needs ${e.sizeGB.toFixed(1)} GB and ${(free / 1e9).toFixed(1)} GB is free.`, "warn");
      return;
    }
  } catch {
    /* carry on; the download itself will fail if the disk fills */
  }
  if (e.ollama) pullOllama(e);
  else downloadGguf(e);
}

async function pullOllama(e: Entry) {
  const k = keyOf(e);
  const ctl = new AbortController();
  setBusy(k, 0, "Starting…", () => ctl.abort());
  render();
  try {
    const r = await http(`${OLLAMA}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: e.ollama, stream: true }),
      signal: ctl.signal,
    });
    if (!r.ok || !r.body) throw new Error(`Ollama answered ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let last = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        if (performance.now() - last < 300 && j.status !== "success") continue;
        last = performance.now();
        // Ollama reports each layer as "pulling <digest>"; the big one is the model itself.
        const what = String(j.status).startsWith("pulling") ? "Downloading" : j.status;
        if (j.total) setBusy(k, (j.completed / j.total) * 100, `${what} · ${gb(j.completed ?? 0)} of ${gb(j.total)}`);
        else setBusy(k, 100, j.status);
      }
    }
    busy.delete(k);
    deps.toast(`${e.name} is ready. Pick it in the model menu.`);
    done();
  } catch (err) {
    busy.delete(k);
    deps.toast(ctl.signal.aborted ? `Stopped downloading ${e.name}.` : `Couldn't download ${e.name}: ${errMsg(err)}`, ctl.signal.aborted ? "" : "warn");
    render();
  }
}

// GGUF downloads run in Rust; one model may need two files (weights + vision projector).
const ggufJobs = new Map<string, { entry: Entry; files: { id: string; dest: string; done: boolean; got: number; total: number }[] }>();

async function downloadGguf(e: Entry) {
  const g = e.gguf!;
  const k = keyOf(e);
  const dir = `${await stackRoot()}\\models\\gguf`;
  const files = [{ id: `${k}:model`, url: hf(g.repo, g.file), dest: `${dir}\\${g.file}` }];
  if (g.mmproj) files.push({ id: `${k}:mmproj`, url: hf(g.repo, g.mmproj), dest: `${dir}\\${g.mmprojAs ?? g.mmproj}` });
  ggufJobs.set(k, { entry: e, files: files.map((f) => ({ id: f.id, dest: f.dest, done: false, got: 0, total: 0 })) });
  setBusy(k, 0, "Starting…", () => files.forEach((f) => invoke("cancel_download", { id: f.id })));
  render();
  try {
    for (const f of files) await invoke("download_file", { id: f.id, url: f.url, dest: f.dest });
  } catch (err) {
    busy.delete(k);
    ggufJobs.delete(k);
    deps.toast(`Couldn't download ${e.name}: ${errMsg(err)}`, "warn");
    render();
  }
}

const hf = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`;

async function onDownload(p: { id: string; done: number; total: number; state: string; error?: string }) {
  const k = p.id.replace(/:(model|mmproj)$/, "");
  const job = ggufJobs.get(k);
  if (!job) return;
  const f = job.files.find((x) => x.id === p.id)!;
  if (p.state === "downloading") {
    f.got = p.done;
    f.total = p.total;
    const got = job.files.reduce((s, x) => s + x.got, 0);
    const total = job.files.reduce((s, x) => s + (x.total || 0), 0) || job.entry.sizeGB * 1e9;
    setBusy(k, (got / total) * 100, `Downloading · ${gb(got)} of ${gb(total)}`);
    return;
  }
  if (p.state === "failed" || p.state === "cancelled") {
    job.files.forEach((x) => invoke("cancel_download", { id: x.id }));
    ggufJobs.delete(k);
    busy.delete(k);
    deps.toast(p.state === "cancelled" ? `Stopped downloading ${job.entry.name}.` : `Couldn't download ${job.entry.name}: ${p.error}`, p.state === "cancelled" ? "" : "warn");
    render();
    return;
  }
  f.done = true;
  if (!job.files.every((x) => x.done)) return;
  // All files are in place: register with the router and restart it so the model appears.
  const g = job.entry.gguf!;
  try {
    setBusy(k, 100, "Adding it to llama.cpp…");
    await invoke("add_llama_model", {
      root: deps.root(),
      id: g.id,
      model: job.files[0].dest,
      mmproj: job.files[1]?.dest ?? null,
      nCpuMoe: g.nCpuMoe ?? null,
      note: `${job.entry.name} (${g.repo}), added from the Prestige model catalog.`,
      options: g.options ?? null,
    });
    setBusy(k, 100, "Restarting llama.cpp…");
    await invoke("restart_llama", { root: deps.root() });
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const lm = await (await http(`${LLAMA}/models`)).json();
        if ((lm.data ?? []).some((m: any) => m.id === g.id)) break;
      } catch {
        /* still restarting */
      }
    }
    deps.toast(`${job.entry.name} is ready. Pick it in the model menu.`);
  } catch (err) {
    deps.toast(`Downloaded ${job.entry.name}, but couldn't add it to llama.cpp: ${errMsg(err)}`, "warn");
  }
  ggufJobs.delete(k);
  busy.delete(k);
  done();
}

async function done() {
  resetCaps();
  await refreshInstalled();
  render();
  deps.onInstalled();
}
