// Search everything: one box that finds renders (by what's in the picture or the video's frame, and by their prompt),
// songs (by style and lyrics), chats and Knowledge files by meaning. search.rs keeps the index (EmbeddingGemma 2 on
// the Workstation's search service) and brings it up to date each time this opens; the results open where they live.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errMsg } from "./backends";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll(s)) as T[];
const inTauri = "__TAURI_INTERNALS__" in window;

interface Hit {
  kind: "image" | "video" | "audio" | "chat" | "file";
  score: number;
  title: string;
  text: string;
  group: string; // the render's path, the chat's id or the file's id
  path?: string;
  page?: number;
  mtime?: number;
}

interface Status {
  working: boolean;
  counts: Partial<Record<Hit["kind"], number>>;
  updated: number | null;
}

interface Deps {
  toast: (msg: string, kind?: string) => void;
  root: () => string | null;
  openRender: (path: string) => void;
  openChat: (id: string) => void;
  openFile: (id: string) => void;
}

let deps: Deps;
let kind = "";
let progress = "";
let lastError = "";
let seq = 0;
let timer = 0;

const BADGE: Record<Hit["kind"], string> = { image: "IMAGE", video: "VIDEO", audio: "SONG", chat: "CHAT", file: "FILE" };
const NOUN: Record<Hit["kind"], [string, string]> = {
  image: ["picture", "pictures"],
  video: ["video", "videos"],
  audio: ["song", "songs"],
  chat: ["chat", "chats"],
  file: ["file", "files"],
};

/** What's indexed, or what the index is doing. */
async function renderStatus() {
  const el = $("#search-status");
  let s: Status;
  try {
    s = await invoke<Status>("search_status");
  } catch {
    return;
  }
  el.classList.toggle("working", s.working);
  if (s.working) {
    el.textContent = progress || "Updating the index…";
    return;
  }
  if (lastError) {
    el.textContent = lastError;
    return;
  }
  const parts = (Object.keys(NOUN) as Hit["kind"][]).filter((k) => s.counts[k]).map((k) => `${s.counts[k]} ${NOUN[k][s.counts[k] === 1 ? 0 : 1]}`);
  el.textContent = parts.length ? `${parts.join(", ")} indexed` : "Nothing indexed yet";
}

/** Brings the index up to date (only what's new or changed is read). */
async function update() {
  lastError = "";
  try {
    await invoke<boolean>("search_index", { root: deps.root() });
  } catch (e) {
    lastError = errMsg(e);
  }
  renderStatus();
}

async function run() {
  const q = ($("#search-q") as HTMLInputElement).value.trim();
  const box = $("#search-results");
  const mine = ++seq;
  if (!q) {
    box.innerHTML = "";
    return;
  }
  let hits: Hit[];
  try {
    hits = await invoke<Hit[]>("search_everything", { root: deps.root(), query: q, kinds: kind ? [kind] : null, k: 30 });
  } catch (e) {
    if (mine !== seq) return;
    box.innerHTML = `<p class="muted sr-empty"></p>`;
    $("p", box).textContent = `Couldn't search: ${errMsg(e)}.`;
    return;
  }
  if (mine !== seq) return;
  box.innerHTML = "";
  if (!hits.length) {
    box.innerHTML = `<p class="muted sr-empty">Nothing found yet. If the index is still being made, try again in a moment.</p>`;
    return;
  }
  for (const h of hits) box.appendChild(row(h));
}

function row(h: Hit): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "sr-row";
  const media = (h.kind === "image" || h.kind === "video") && h.path;
  b.innerHTML = `${media ? `<img class="sr-thumb" alt="" />` : `<span class="sr-badge"></span>`}<span class="sr-t"><b></b><small></small></span><span class="sr-score"></span>`;
  if (media) {
    invoke<string>("thumbnail", { path: h.path, mtime: h.mtime ?? 0 })
      .then((t) => (($("img", b) as HTMLImageElement).src = convertFileSrc(t)))
      .catch(() => {});
  } else $(".sr-badge", b).textContent = BADGE[h.kind];
  $("b", b).textContent = h.kind === "file" && h.page ? `${h.title} · page ${h.page}` : h.title;
  $("small", b).textContent = h.text || (h.kind === "video" ? "a video" : "");
  $(".sr-score", b).textContent = h.score.toFixed(2);
  b.title = h.kind === "chat" ? "Open this chat" : h.kind === "file" ? "Open this file" : "Open it in Studio";
  b.addEventListener("click", () => {
    ($("#search") as HTMLDialogElement).close();
    if (h.kind === "chat") deps.openChat(h.group);
    else if (h.kind === "file") deps.openFile(h.group);
    else if (h.path) deps.openRender(h.path);
  });
  return b;
}

export function openSearch() {
  const dlg = $("#search") as HTMLDialogElement;
  if (!dlg.open) dlg.showModal();
  const q = $("#search-q") as HTMLInputElement;
  q.focus();
  q.select();
  if (!inTauri) return;
  update();
  if (q.value.trim()) run();
}

export function initSearch(d: Deps) {
  deps = d;
  $("#search-close").addEventListener("click", () => ($("#search") as HTMLDialogElement).close());
  $("#search-q").addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(run, 250);
  });
  $("#search-q").addEventListener("keydown", (e) => {
    // Enter opens the best match; arrow down goes into the results.
    if (e.key === "Enter") ($(".sr-row") as HTMLButtonElement | null)?.click();
    if (e.key === "ArrowDown") ($(".sr-row") as HTMLButtonElement | null)?.focus();
  });
  $("#search-results").addEventListener("keydown", (e) => {
    const rows = $$<HTMLButtonElement>(".sr-row");
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" && i < rows.length - 1) rows[i + 1].focus();
    else if (e.key === "ArrowUp") (i > 0 ? rows[i - 1] : $("#search-q")).focus();
    else return;
    e.preventDefault();
  });
  $$<HTMLButtonElement>("#search-kinds button").forEach((b) =>
    b.addEventListener("click", () => {
      kind = b.dataset.kind ?? "";
      $$("#search-kinds button").forEach((x) => x.classList.toggle("on", x === b));
      run();
    }),
  );
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openSearch();
    }
  });
  if (!inTauri) return;
  listen<{ done: number; total: number }>("search-progress", (e) => {
    const { done, total } = e.payload;
    progress = total ? `Reading ${done} of ${total} new or changed things…` : "";
    renderStatus();
  });
  listen<{ count?: number; error?: string }>("search-done", (e) => {
    progress = "";
    lastError = e.payload.error ? `Couldn't update the index: ${e.payload.error}.` : "";
    renderStatus();
    // New things may match what's typed.
    if (($("#search") as HTMLDialogElement).open && !e.payload.error) run();
  });
}
