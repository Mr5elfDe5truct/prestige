// Teach it a face or style: train.rs runs Fizgig to make a Qwen-Image-2.1 LoRA from 10-30 photos of a person (or a
// character, a pet, an object) or of a look. Photos come from the PC or from the pictures selected in Studio's
// gallery. The finished LoRA is picked in Studio's image settings ("Your LoRA"), and its trigger word goes into the
// prompt by itself.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errMsg } from "./backends";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

export interface TrainedLora {
  file: string;
  name: string;
  trigger: string;
  kind: "face" | "style";
  created: number;
  photos: number;
}

interface Job {
  name: string;
  trigger: string;
  kind: string;
  stage: "setup" | "caption" | "latents" | "text" | "train" | "done" | "failed" | "stopped";
  pct: number;
  line: string;
  started: number;
  error?: string;
}

interface Status {
  installed: boolean;
  weights: boolean;
  missing: string[];
  job: Job | null;
  loras: TrainedLora[];
}

interface Deps {
  toast: (msg: string, kind?: string) => void;
  root: () => string | null;
  freeGpu: () => Promise<void>;
  onLoras: () => void; // Studio redraws its settings when the list changes
}

let deps: Deps;
let loras: TrainedLora[] = [];
let photos: string[] = [];
let ready = false;

/** The LoRAs trained so far (for Studio's image settings). */
export const trainedLoras = () => loras;

const STAGES: Record<string, string> = {
  setup: "Setting up",
  caption: "Describing the photos",
  latents: "Reading the photos",
  text: "Reading the captions",
  train: "Training",
  done: "Done",
  failed: "Stopped with an error",
  stopped: "Stopped",
};

const busy = (j: Job | null) => !!j && !["done", "failed", "stopped"].includes(j.stage);

export async function refreshTrain() {
  let s: Status;
  try {
    s = await invoke<Status>("train_status", { root: deps.root() });
  } catch {
    return;
  }
  const changed = JSON.stringify(s.loras) !== JSON.stringify(loras);
  loras = s.loras;
  ready = s.installed && s.weights;
  if (changed) deps.onLoras();
  render(s);
}

function render(s: Status) {
  $("#tn-setup").hidden = ready || busy(s.job);
  $("#tn-form").hidden = !ready;
  showJob(s.job);
  const list = $("#tn-list");
  list.innerHTML = loras.length ? "" : `<p class="muted">Nothing trained yet.</p>`;
  for (const l of loras) {
    const row = document.createElement("div");
    row.className = "tn-lora";
    row.innerHTML = `<b></b><small></small>`;
    $("b", row).textContent = l.name || l.trigger;
    $("small", row).textContent = `${l.kind === "style" ? "Style" : "Face"} · trigger word "${l.trigger}" · ${l.photos} photos · ${new Date(l.created).toLocaleDateString()}`;
    list.appendChild(row);
  }
}

function showJob(j: Job | null) {
  const box = $("#tn-job");
  box.hidden = !j;
  if (!j) return;
  ($("#tn-go") as HTMLButtonElement).disabled = busy(j);
  $("#tn-stop").hidden = !busy(j) || j.stage === "setup";
  box.style.setProperty("--v", String(j.pct));
  const mins = Math.round((Date.now() - j.started) / 60000);
  $("#tn-stage").textContent = `${j.name}: ${STAGES[j.stage] ?? j.stage}${busy(j) ? ` · ${Math.round(j.pct)}% · ${mins} min so far` : ""}`;
  $("#tn-line").textContent = j.error ? j.error : j.stage === "done" && j.trigger ? `Pick "${j.name}" under Your LoRA in Studio's image settings; "${j.trigger}" goes into the prompt by itself.` : friendly(j.line);
}

/** Fizgig's progress lines in words: "PROGRESS: 5 8" and tqdm's "steps: 71%|…| 17/24 [02:04<00:51, 7.30s/it…]". */
function friendly(line: string) {
  const cap = /^PROGRESS:\s*(\d+)\s+(\d+)/.exec(line);
  if (cap) return `Described photo ${cap[1]} of ${cap[2]}`;
  const step = /^steps:.*?(\d+)\/(\d+) \[[^<]*<([^,]+),\s*([\d.]+)s\/it/.exec(line);
  if (step) return `Step ${step[1]} of ${step[2]} · ${step[4]} s a step · ${step[3]} to go`;
  return line;
}

function showPhotos() {
  const box = $("#tn-photos");
  box.innerHTML = "";
  for (const p of photos.slice(0, 40)) {
    const img = document.createElement("img");
    img.src = convertFileSrc(p);
    img.alt = "";
    box.appendChild(img);
  }
  $("#tn-count").textContent = photos.length ? `${photos.length} photo${photos.length === 1 ? "" : "s"}${photos.length < 10 ? " (10-30 is best)" : ""}` : "";
  const epochs = Number(($("#tn-epochs") as HTMLSelectElement).value);
  // Measured on an RTX 3060 (Fizgig picks 4-bit NF4 there, ~7 GB): 7.3 s a step, one step a photo each epoch, plus
  // ~5 min of captions and caches.
  const mins = Math.round(5 + (photos.length * epochs * 7.3) / 60);
  $("#tn-est").textContent = photos.length ? `About ${mins} min on an RTX 3060. Chat and renders wait while it trains.` : "";
}

/** Opens the window; `paths` are pictures to start from (the ones selected in Studio). */
export function openTrain(paths: string[] = []) {
  photos = paths;
  showPhotos();
  const dlg = $("#train") as HTMLDialogElement;
  if (!dlg.open) dlg.showModal();
  refreshTrain();
}

async function start() {
  const name = ($("#tn-name") as HTMLInputElement).value.trim();
  if (!name) return deps.toast("Give it a name: it becomes the word that calls it up in prompts.");
  if (photos.length < 5) return deps.toast("Pick at least 5 photos (10-30 is best).");
  try {
    await deps.freeGpu();
    await invoke<string>("train_start", {
      root: deps.root(),
      name,
      kind: ($("#tn-kind") as HTMLSelectElement).value,
      photos,
      epochs: Number(($("#tn-epochs") as HTMLSelectElement).value),
    });
    refreshTrain();
  } catch (e) {
    deps.toast(`Couldn't start training: ${errMsg(e)}`, "warn");
  }
}

export function initTrain(d: Deps) {
  deps = d;
  $("#tn-close").addEventListener("click", () => ($("#train") as HTMLDialogElement).close());
  $("#tn-pick").addEventListener("click", async () => {
    try {
      const picked = await invoke<string[]>("train_pick");
      if (picked.length) {
        photos = [...new Set([...photos, ...picked])];
        showPhotos();
      }
    } catch (e) {
      deps.toast(errMsg(e), "warn");
    }
  });
  $("#tn-clear").addEventListener("click", () => {
    photos = [];
    showPhotos();
  });
  $("#tn-epochs").addEventListener("change", showPhotos);
  $("#tn-go").addEventListener("click", start);
  $("#tn-stop").addEventListener("click", () => invoke("train_stop"));
  $("#tn-setup-go").addEventListener("click", async () => {
    try {
      await invoke("train_setup", { root: deps.root() });
      refreshTrain();
    } catch (e) {
      deps.toast(errMsg(e), "warn");
    }
  });
  listen<Job>("train-progress", (e) => {
    showJob(e.payload);
    if (!busy(e.payload)) refreshTrain();
    if (e.payload.stage === "done" && e.payload.trigger) deps.toast(`Finished training ${e.payload.name}. Pick it under Your LoRA in Studio's image settings.`);
  });
  refreshTrain();
}
