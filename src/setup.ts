// Setup: makes (or repairs) the Workstation from inside Prestige (setup.rs). Three steps on one sheet: where it goes
// and this PC, the model packs, then the install with a live checklist. Opens by itself when there's no Workstation.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errMsg } from "./backends";

interface Probe {
  root: string;
  defaultRoot: string;
  found: boolean;
  gpus: { index: number; name: string; gb: number }[];
  ramGB: number;
  freeBytes: number;
  comfyDesktop: boolean;
  tools: { name: string; have: boolean }[];
  winget: boolean;
  bundled: boolean;
  suggested: string[];
  packs: { id: string; title: string; text: string; gb: number }[];
}
interface SetupEvent {
  step: string;
  state: "running" | "done" | "failed" | "skipped";
  text: string;
  root?: string;
}
interface Deps {
  root: () => string | null;
  toast: (msg: string, kind?: string) => void;
  /** Setup finished in `root`: remember it and start using it. */
  done: (root: string) => Promise<void>;
}

const STEPS: [string, string][] = [
  ["tools", "Tools (Git, uv, Node.js, FFmpeg, Ollama, eSpeak)"],
  ["files", "The Workstation's files"],
  ["gpu", "Graphics cards"],
  ["llama", "llama.cpp"],
  ["python", "Python environments (tool server, Kokoro voice)"],
  ["comfyui", "ComfyUI"],
  ["packs", "Model packs"],
  ["check", "Starting everything once"],
];
let deps: Deps;
let probe: Probe | null = null;
let running = false;
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const GB = 1e9;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function show(pane: "where" | "packs" | "run") {
  for (const p of ["where", "packs", "run"]) $(`#setup-${p}`).hidden = p !== pane;
  $("#setup-back").hidden = pane !== "packs";
  $("#setup-next").hidden = pane !== "where";
  $("#setup-go").hidden = pane !== "packs";
  ($("#setup-close") as HTMLButtonElement).textContent = pane === "run" ? (running ? "Hide" : "Close") : "Not now";
}

function renderWhere(p: Probe, keepFolder = false) {
  if (!keepFolder) ($("#setup-root") as HTMLInputElement).value = p.root || p.defaultRoot;
  const gpus = p.gpus.length ? p.gpus.map((g) => `${esc(g.name)} ${g.gb} GB`).join(" + ") : "no NVIDIA GPU found";
  const missing = p.tools.filter((t) => !t.have).map((t) => t.name);
  $("#setup-pc").innerHTML = `
    <li>${gpus}</li><li>${p.ramGB} GB of RAM</li><li>${Math.round(p.freeBytes / GB)} GB free on that drive</li>
    <li>${missing.length ? `To install: ${esc(missing.join(", "))}${p.winget ? "" : " (needs winget: install App Installer from the Microsoft Store first)"}` : "All the tools are already here"}</li>
    ${p.found ? `<li>A Workstation is already in this folder: Setup only adds what's missing</li>` : ""}`;
  $("#setup-gpu-row").hidden = p.gpus.length < 2;
  $("#setup-comfy-row").hidden = !p.comfyDesktop;
}

function renderPacks(p: Probe) {
  const box = $("#setup-packs-list");
  box.innerHTML = "";
  for (const k of p.packs) {
    const l = document.createElement("label");
    l.className = "check setup-pack";
    l.innerHTML = `<input type="checkbox" value="${k.id}" ${p.suggested.includes(k.id) ? "checked" : ""}/> <b>${esc(k.title)}</b> <span class="muted">${k.gb} GB · ${esc(k.text)}</span>`;
    box.append(l);
  }
  box.querySelectorAll("input").forEach((i) => i.addEventListener("change", total));
  total();
}

function picked() {
  return [...document.querySelectorAll<HTMLInputElement>("#setup-packs-list input:checked")].map((i) => i.value);
}

function total() {
  if (!probe) return;
  const gb = 12 + picked().reduce((n, id) => n + (probe!.packs.find((p) => p.id === id)?.gb ?? 0), 0);
  const free = probe.freeBytes / GB;
  $("#setup-total").innerHTML = `About ${Math.round(gb)} GB with the software, ${Math.round(free)} GB free${gb > free ? ` · <span class="pack-warn">not enough space</span>` : ""}`;
}

function renderRun() {
  $("#setup-steps").innerHTML = STEPS.map(([id, label]) => `<li data-step="${id}"><i></i><b>${label}</b><small class="muted"></small></li>`).join("");
}

function onEvent(e: SetupEvent) {
  if (e.step === "all") {
    running = false;
    $("#setup-result").textContent = e.state === "done" ? "Done. The Workstation is ready." : `Setup stopped: ${e.text}. Fix that and run Setup again; it carries on where it stopped.`;
    $("#setup-result").className = e.state === "done" ? "ok" : "pack-warn";
    show("run");
    if (e.state === "done" && e.root) deps.done(e.root).catch(() => {});
    else if (!$<HTMLDialogElement>("#setup").open) deps.toast(`Setup stopped: ${e.text}`, "warn");
    return;
  }
  const li = document.querySelector<HTMLElement>(`#setup-steps li[data-step="${e.step}"]`);
  if (!li) return;
  li.className = e.state;
  li.querySelector("small")!.textContent = e.text;
}

export async function openSetup() {
  const dlg = $<HTMLDialogElement>("#setup");
  if (!dlg.open) dlg.showModal();
  if (running) return show("run");
  show("where");
  $("#setup-pc").innerHTML = `<li class="muted">Looking at this PC…</li>`;
  probe = await invoke<Probe>("setup_probe", { root: deps.root() });
  renderWhere(probe);
  renderPacks(probe);
}

export function initSetup(d: Deps) {
  deps = d;
  listen<SetupEvent>("setup", (e) => onEvent(e.payload));
  $("#open-setup")?.addEventListener("click", () => openSetup());
  $("#setup-next").addEventListener("click", () => show("packs"));
  $("#setup-back").addEventListener("click", () => show("where"));
  // A different folder: look again (what's already there, the free space on its drive).
  let again = 0;
  $("#setup-root").addEventListener("input", () => {
    clearTimeout(again);
    again = window.setTimeout(async () => {
      const root = ($("#setup-root") as HTMLInputElement).value.trim();
      if (!root || running) return;
      const p = await invoke<Probe>("setup_probe", { root }).catch(() => null);
      if (!p || ($("#setup-root") as HTMLInputElement).value.trim() !== root) return;
      probe = p;
      renderWhere(p, true);
      total();
    }, 600);
  });
  $("#setup-go").addEventListener("click", async () => {
    const root = ($("#setup-root") as HTMLInputElement).value.trim();
    const gpuMode = probe && probe.gpus.length > 1 ? ($("#setup-gpu") as HTMLSelectElement).value : null;
    renderRun();
    $("#setup-result").textContent = "";
    running = true;
    show("run");
    try {
      await invoke("setup_run", { opts: { root, gpuMode, packs: picked(), ownComfy: ($("#setup-own-comfy") as HTMLInputElement).checked, check: ($("#setup-check") as HTMLInputElement).checked } });
    } catch (e) {
      running = false;
      $("#setup-result").textContent = errMsg(e);
      $("#setup-result").className = "pack-warn";
      show("run");
    }
  });
}
