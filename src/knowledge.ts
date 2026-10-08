// Knowledge: chat with your files. Files and folders added here (or dropped into a chat) are read on this PC, cut into
// passages that remember their page, and embedded by a small Ollama embedding model (knowledge.rs keeps the vectors in
// the app data folder). Each chat message then gets the passages most like the question, and the reply cites them by
// file and page. Files dropped into a chat belong to that chat; "Use my files in every chat" searches the whole library.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errMsg, http, OLLAMA } from "./backends";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const inTauri = "__TAURI_INTERNALS__" in window;

export interface KbDoc {
  id: string;
  name: string;
  path: string;
  kind: string;
  bytes: number;
  added: number;
  pages: number;
  chunks: number;
  model: string;
  state: "queued" | "reading" | "embedding" | "ready" | "error";
  error?: string;
  folder?: string;
}

interface KbHit {
  doc: string;
  name: string;
  path: string;
  page?: number | null;
  line?: number | null;
  text: string;
  score: number;
}

/** A passage a reply was given, shown under it as a source. */
export interface Source {
  doc: string;
  name: string;
  page?: number;
  line?: number;
  text: string;
}

/** The embedding model Prestige gets when none is installed: Qwen3-Embedding 0.6B (0.6 GB, 100+ languages, long passages). */
export const EMBED_MODEL = "qwen3-embedding:0.6b";
const EMBED_RE = /embed|^bge-|minilm|^e5-|^gte-|paraphrase-multilingual/i;
/** Embedding models aren't for chat; the model menus leave them out. */
export const isEmbedModel = (id: string) => EMBED_RE.test(id);

/** How alike a passage must be to the question to go into a chat that didn't attach files (cosine similarity). */
// (Qwen3-Embedding 0.6B: an answering passage scores about 0.55-0.7, unrelated ones under 0.43.)
const LIBRARY_MIN = 0.45;
const PER_REPLY = 6;
const DOC_EXTS = /\.(pdf|docx|html?|txt|md|markdown|rst|csv|tsv|jsonl?|ya?ml|toml|ini|cfg|conf|log|xml|py|m?js|cjs|tsx?|jsx|rs|go|java|kt|c|h|cpp|hpp|cc|cs|ps1|psm1|sh|bat|cmd|sql|s?css|lua|rb|php|swift|r|tex|srt|vtt)$/i;

interface Deps {
  toast: (msg: string, kind?: string) => void;
  useAll: () => boolean;
  setUseAll: (on: boolean) => void;
  /** Files added from the panel while a chat is open can be attached to it. */
  onChange: () => void;
}
let deps: Deps;
let docs: KbDoc[] = [];
const progress = new Map<string, { done: number; total: number }>();
let embedModel: string | null = null;
let embedChecked = false;
let ollamaUp = true;
let pulling: AbortController | null = null;

export const kbDocs = () => docs;
export const readyDocs = () => docs.filter((d) => d.state === "ready");
export const docById = (id: string) => docs.find((d) => d.id === id);

/** The installed embedding model (Qwen3-Embedding preferred), or null. */
async function findEmbedModel(): Promise<string | null> {
  try {
    const tags = await (await http(`${OLLAMA}/api/tags`)).json();
    ollamaUp = true;
    const names: string[] = (tags.models ?? []).map((m: any) => String(m.name));
    embedModel = names.find((n) => n.startsWith("qwen3-embedding")) ?? names.find((n) => EMBED_RE.test(n)) ?? null;
  } catch {
    ollamaUp = false;
  }
  embedChecked = true;
  return embedModel;
}

/** The model to embed new files with; asks for it (in the panel) when there isn't one. */
async function modelOrAsk(): Promise<string | null> {
  if (!embedModel) await findEmbedModel();
  if (embedModel) return embedModel;
  openKnowledge();
  deps.toast(ollamaUp ? "Get the embedding model first (one click in Knowledge)." : "Ollama isn't running, so files can't be read yet.", "warn");
  return null;
}

export async function refreshDocs() {
  if (!inTauri) return;
  try {
    docs = await invoke<KbDoc[]>("kb_list");
  } catch {
    docs = [];
  }
  renderList();
  deps?.onChange();
}

// ---------- adding files ----------

/** True when a drop holds something other than pictures (documents or a folder). */
export function hasDocs(data: DataTransfer | null) {
  for (const it of Array.from(data?.items ?? [])) {
    if (it.kind !== "file") continue;
    const entry = it.webkitGetAsEntry?.();
    if (entry?.isDirectory) return true;
    if (!it.type.startsWith("image/")) return true;
  }
  return false;
}

async function readEntry(entry: FileSystemEntry, out: { file: File; folder?: string }[], folder?: string) {
  if (out.length >= 3000) return;
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    if (DOC_EXTS.test(file.name)) out.push({ file, folder });
    return;
  }
  const name = entry.name;
  if (/^(\.|node_modules$|target$|dist$|build$|__pycache__$|\.?venv$)/i.test(name)) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries hands them over in batches until it returns none.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const e of batch) await readEntry(e, out, folder ?? name);
  }
}

/** Adds the documents (and folders) in a drop and returns them. Pictures in the drop are left for the caller. */
export async function addDropped(data: DataTransfer): Promise<KbDoc[]> {
  const entries = Array.from(data.items)
    .filter((it) => it.kind === "file")
    .map((it) => ({ entry: it.webkitGetAsEntry?.() ?? null, file: it.getAsFile() }));
  const files: { file: File; folder?: string }[] = [];
  for (const { entry, file } of entries) {
    if (entry) await readEntry(entry, files);
    else if (file && DOC_EXTS.test(file.name)) files.push({ file });
  }
  if (!files.length) {
    deps.toast("Prestige can read PDF, Word, text, Markdown, HTML and code files.", "warn");
    return [];
  }
  return addFiles(files);
}

/** Adds picked or dropped files (their bytes: a drop doesn't say where a file is, so Prestige keeps a copy). */
export async function addFiles(files: { file: File; folder?: string }[]): Promise<KbDoc[]> {
  const model = await modelOrAsk();
  if (!model) return [];
  const added: KbDoc[] = [];
  const failed: string[] = [];
  for (const { file, folder } of files) {
    if (file.size > 300 * 1024 * 1024) {
      failed.push(`${file.name} (over 300 MB)`);
      continue;
    }
    try {
      const body = new Uint8Array(await file.arrayBuffer());
      const headers: Record<string, string> = { "x-name": encodeURIComponent(file.name), "x-model": model };
      if (folder) headers["x-folder"] = encodeURIComponent(folder);
      added.push(...(await invoke<KbDoc[]>("kb_add_bytes", body, { headers })));
    } catch (e) {
      failed.push(`${file.name} (${errMsg(e)})`);
    }
  }
  if (failed.length) deps.toast(`Couldn't add ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? ` and ${failed.length - 3} more` : ""}`, "warn");
  await refreshDocs();
  return added;
}

async function pick(folder: boolean) {
  const model = await modelOrAsk();
  if (!model) return;
  try {
    const added = await invoke<KbDoc[]>("kb_pick", { folder, model });
    if (added.length) deps.toast(`Reading ${added.length} file${added.length === 1 ? "" : "s"}…`);
  } catch (e) {
    deps.toast(errMsg(e), "warn");
  }
  await refreshDocs();
}

/** Downloads the embedding model into the workstation's Ollama, with progress in the panel. */
async function pullModel() {
  if (pulling) return;
  pulling = new AbortController();
  const line = $("#kb-model");
  try {
    const r = await http(`${OLLAMA}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, stream: true }),
      signal: pulling.signal,
    });
    if (!r.ok || !r.body) throw new Error(`Ollama answered ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const j = JSON.parse(buf.slice(0, i) || "{}");
        buf = buf.slice(i + 1);
        if (j.error) throw new Error(j.error);
        const pct = j.total ? Math.round(((j.completed ?? 0) / j.total) * 100) : null;
        line.textContent = `Getting ${EMBED_MODEL}: ${j.status ?? ""}${pct != null ? ` ${pct}%` : ""}`;
      }
    }
    await findEmbedModel();
    deps.toast(embedModel ? "The embedding model is ready. Add some files." : "The download finished, but Ollama doesn't list the model yet.");
    // Files that were waiting for the model.
    if (embedModel) await invoke("kb_resume", { model: embedModel }).catch(() => {});
  } catch (e) {
    if (!pulling?.signal.aborted) deps.toast(`Couldn't get the embedding model: ${errMsg(e)}`, "warn");
  } finally {
    pulling = null;
    renderModel();
  }
}

// ---------- the panel ----------

const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function stateText(d: KbDoc) {
  const p = progress.get(d.id);
  switch (d.state) {
    case "queued":
      return "Waiting…";
    case "reading":
      return "Reading…";
    case "embedding":
      return p?.total ? `Embedding ${p.done}/${p.total}` : "Embedding…";
    case "error":
      return d.error ?? "Couldn't read it";
    default:
      return [d.pages ? `${d.pages} page${d.pages === 1 ? "" : "s"}` : "", `${d.chunks} passage${d.chunks === 1 ? "" : "s"}`, size(d.bytes)]
        .filter(Boolean)
        .join(" · ");
  }
}

function renderModel() {
  const line = $("#kb-model");
  const get = $("#kb-get") as HTMLButtonElement;
  if (!line) return;
  get.hidden = !!embedModel || !ollamaUp;
  get.disabled = !!pulling;
  if (pulling) return;
  line.textContent = !embedChecked
    ? "Checking for an embedding model…"
    : embedModel
      ? `Embeddings by ${embedModel} (Ollama), stored on this PC.`
      : ollamaUp
        ? `Reading files needs a small embedding model: ${EMBED_MODEL}, about 0.6 GB.`
        : "Ollama isn't running. Start the services to add files.";
}

function docRow(d: KbDoc) {
  const row = document.createElement("div");
  row.className = `kb-doc ${d.state}`;
  row.dataset.id = d.id;
  row.innerHTML = `<span class="kb-ico"></span><span class="kb-t"><b></b><small></small></span><span class="kb-acts"><button type="button" class="linkish" data-a="open">open</button><button type="button" class="linkish" data-a="again">read again</button><button type="button" class="linkish" data-a="del">remove</button></span>`;
  $(".kb-ico", row).textContent = d.kind === "pdf" ? "PDF" : d.kind === "docx" ? "DOC" : d.kind.slice(0, 4).toUpperCase() || "TXT";
  $("b", row).textContent = d.name;
  $("b", row).title = d.path;
  $("small", row).textContent = stateText(d);
  const p = progress.get(d.id);
  if (d.state === "embedding" && p?.total) row.style.setProperty("--v", String((p.done / p.total) * 100));
  row.querySelectorAll<HTMLButtonElement>("[data-a]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        if (b.dataset.a === "open") await invoke("kb_open", { id: d.id });
        else if (b.dataset.a === "again") {
          const model = await modelOrAsk();
          if (model) await invoke("kb_reindex", { ids: [d.id], model });
        } else await invoke("kb_remove", { ids: [d.id] });
      } catch (e) {
        deps.toast(errMsg(e), "warn");
      }
      refreshDocs();
    }),
  );
  return row;
}

function renderList() {
  const list = $("#kb-list");
  if (!list) return;
  list.innerHTML = "";
  if (!docs.length) {
    list.innerHTML = `<p class="muted kb-empty">No files yet. Drop PDFs, Word documents, notes or a whole folder here.</p>`;
  }
  // Files that came in with a folder are listed under it, and the folder can be removed as one.
  const folders = new Map<string, KbDoc[]>();
  for (const d of [...docs].sort((a, b) => b.added - a.added)) {
    if (d.folder) {
      if (!folders.has(d.folder)) folders.set(d.folder, []);
      folders.get(d.folder)!.push(d);
    } else list.appendChild(docRow(d));
  }
  for (const [folder, group] of folders) {
    const box = document.createElement("details");
    box.className = "kb-folder";
    const ready = group.filter((d) => d.state === "ready").length;
    box.innerHTML = `<summary><span class="kb-ico">DIR</span><span class="kb-t"><b></b><small></small></span><button type="button" class="linkish">remove folder</button></summary>`;
    $("b", box).textContent = folder.split(/[\\/]/).pop() || folder;
    $("b", box).title = folder;
    $("small", box).textContent = `${group.length} files${ready < group.length ? ` · ${ready} ready` : ""}`;
    $("button", box).addEventListener("click", async (e) => {
      e.preventDefault();
      if (!confirm(`Remove the ${group.length} files from "${$("b", box).textContent}" from Knowledge? (The files themselves stay where they are.)`)) return;
      await invoke("kb_remove", { ids: group.map((d) => d.id) }).catch((err) => deps.toast(errMsg(err), "warn"));
      refreshDocs();
    });
    for (const d of group) box.appendChild(docRow(d));
    list.appendChild(box);
  }
  const ready = readyDocs();
  $("#kb-count").textContent = docs.length ? `${ready.length} of ${docs.length} ready · ${ready.reduce((n, d) => n + d.chunks, 0)} passages` : "";
}

export function openKnowledge() {
  const dlg = $("#knowledge") as HTMLDialogElement;
  ($("#kb-all") as HTMLInputElement).checked = deps.useAll();
  renderModel();
  refreshDocs();
  if (!dlg.open) dlg.showModal();
  findEmbedModel().then(renderModel);
}

export function initKnowledge(d: Deps) {
  deps = d;
  if (!inTauri) return;
  listen<{ doc: KbDoc; done: number; total: number }>("kb-progress", (e) => {
    const { doc, done, total } = e.payload;
    progress.set(doc.id, { done, total });
    const i = docs.findIndex((x) => x.id === doc.id);
    if (i >= 0) docs[i] = doc;
    else docs.push(doc);
    if (doc.state === "ready" || doc.state === "error") {
      progress.delete(doc.id);
      deps.onChange();
    }
    // Repaint just this row while it embeds (the list can be long).
    const row = document.querySelector<HTMLElement>(`#kb-list [data-id="${doc.id}"]`);
    if (row && doc.state === "embedding") {
      $("small", row).textContent = stateText(doc);
      if (total) row.style.setProperty("--v", String((done / total) * 100));
    } else renderList();
    if (doc.state === "error") deps.toast(`${doc.name}: ${doc.error}`, "warn");
  });
  $("#kb-close").addEventListener("click", () => ($("#knowledge") as HTMLDialogElement).close());
  $("#kb-add").addEventListener("click", () => pick(false));
  $("#kb-add-folder").addEventListener("click", () => pick(true));
  $("#kb-get").addEventListener("click", pullModel);
  $("#kb-all").addEventListener("change", (e) => deps.setUseAll((e.target as HTMLInputElement).checked));
  const zone = $("#knowledge");
  zone.addEventListener("dragover", (e) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    zone.classList.add("drop");
  });
  zone.addEventListener("dragleave", (e) => {
    if (!zone.contains(e.relatedTarget as Node)) zone.classList.remove("drop");
  });
  zone.addEventListener("drop", async (e) => {
    zone.classList.remove("drop");
    if (!e.dataTransfer) return;
    e.preventDefault();
    const added = await addDropped(e.dataTransfer);
    if (added.length) deps.toast(`Reading ${added.length} file${added.length === 1 ? "" : "s"}…`);
  });
  // Pick up files that were still being read when Prestige closed, once Ollama has an embedding model.
  refreshDocs().then(async () => {
    if (!docs.some((x) => x.state === "queued")) return;
    for (let i = 0; i < 40 && !(await findEmbedModel()); i++) await new Promise((r) => setTimeout(r, 5000));
    if (embedModel) invoke("kb_resume", { model: embedModel }).catch(() => {});
  });
}

// ---------- answering from files ----------

const where = (h: { page?: number | null; line?: number | null }) => (h.page ? `p. ${h.page}` : h.line ? `line ${h.line}` : "");
export const citeLabel = (s: { name: string; page?: number | null; line?: number | null }) => [s.name, where(s)].filter(Boolean).join(", ");

const KB_HINT =
  "Below are passages from the user's own files (Knowledge, on this PC), found by searching for their question. " +
  "Answer from them when they're relevant, and cite each fact with its source in square brackets right after it, " +
  "exactly as labelled, e.g. [report.pdf, p. 4]. If the passages don't answer the question, say so instead of guessing " +
  "(and answer from general knowledge only if you make clear that's what you're doing).";

/** The passages for this turn: from the chat's own files, plus (when switched on) close matches from the whole library. */
export async function knowledgeFor(query: string, chatFiles: string[]): Promise<{ text: string; sources: Source[] } | null> {
  if (!inTauri || !query.trim()) return null;
  const own = chatFiles.filter((id) => docById(id)?.state === "ready");
  const all = deps.useAll() && readyDocs().length > 0;
  if (!own.length && !all) return null;
  const hits: KbHit[] = [];
  if (own.length) hits.push(...(await invoke<KbHit[]>("kb_search", { query, ids: own, k: PER_REPLY })));
  if (all) {
    const more = await invoke<KbHit[]>("kb_search", { query, ids: null, k: PER_REPLY });
    for (const h of more) {
      if (h.score < LIBRARY_MIN || hits.length >= PER_REPLY + 2) continue;
      if (!hits.some((x) => x.doc === h.doc && x.text === h.text)) hits.push(h);
    }
  }
  if (!hits.length) return null;
  const sources: Source[] = hits.map((h) => ({ doc: h.doc, name: h.name, page: h.page ?? undefined, line: h.line ?? undefined, text: h.text }));
  const text = `${KB_HINT}\n\n${sources.map((s, i) => `[${citeLabel(s)}] (passage ${i + 1})\n${s.text}`).join("\n\n")}`;
  return { text, sources };
}

/** The search_my_files tool: the same search, as text for the model. */
export async function searchFilesTool(query: string): Promise<string> {
  if (!inTauri) throw new Error("Knowledge is only in the desktop app");
  if (!readyDocs().length) return "There are no files in Knowledge yet. The user can add them with the Knowledge button or by dropping them into the chat.";
  const hits = await invoke<KbHit[]>("kb_search", { query, ids: null, k: 8 });
  if (!hits.length) return `Nothing in the user's files matches "${query}".`;
  return (
    "Cite these as [file, p. N] (or [file, line N]).\n\n" +
    hits.map((h) => `[${citeLabel({ name: h.name, page: h.page, line: h.line })}] (similarity ${h.score.toFixed(2)})\n${h.text}`).join("\n\n")
  );
}

/** The names of the files in Knowledge, for the tool's description. */
export function libraryNote() {
  const r = readyDocs();
  if (!r.length) return "";
  const names = r.slice(0, 12).map((d) => d.name).join(", ");
  return ` Files there now: ${names}${r.length > 12 ? ` and ${r.length - 12} more` : ""}.`;
}

/** Opens a cited file (a dropped file opens Prestige's copy). */
export function openSource(s: Source) {
  invoke("kb_open", { id: s.doc }).catch((e) => deps.toast(errMsg(e), "warn"));
}

// ---------- the phone (Knowledge on a paired phone; main.ts passes its requests here) ----------
/** "list" the files, "add" one sent from the phone (base64), or "remove" one. */
export async function phoneKnowledge(action: string, a: any): Promise<unknown> {
  if (action === "add") {
    const name = String(a.name ?? "file").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
    const bin = atob(String(a.b64 ?? ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!(await modelOrAsk())) throw new Error(ollamaUp ? "Get the embedding model first (one click in Knowledge on the PC)." : "Ollama isn't running on the PC, so files can't be read yet.");
    const added = await addFiles([{ file: new File([bytes], name) }]);
    if (!added.length) throw new Error(`Couldn't add ${name}.`);
  } else if (action === "remove") {
    await invoke("kb_remove", { ids: [String(a.id)] });
    await refreshDocs();
  } else if (action === "list") await refreshDocs();
  else throw new Error(`unknown Knowledge action ${action}`);
  return {
    docs: docs.map((d) => ({ id: d.id, name: d.name, folder: d.folder ?? "", state: d.state, what: stateText(d), added: d.added })),
    ready: !!embedModel,
  };
}
