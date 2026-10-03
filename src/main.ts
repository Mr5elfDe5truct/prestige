// Prestige by R.G. Studios · developed by Ryan B. Gyles. Phase 2: core chat.
import "@fontsource/rye/400.css";
import "@fontsource/oxanium/500.css";
import "@fontsource/oxanium/600.css";
import "@fontsource/oxanium/700.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "./styles.css";
import markSvg from "./assets/rg-mark.svg?raw";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { initSystem, onGpu, showSystem, unloadAll, type Gpu } from "./system";
import { allowRenders, cancelRender, imageModelLabel, initStudio, openRender, renderImage, renderMenu, showStudio } from "./studio";
import { initVoice, showVoice } from "./voice";
import { initCamera, showCameraPane } from "./camera";
import { onSpeakingChange, speak, speakDelta, speakEnd, stopSpeaking } from "./speech";
import { bestFor, capsFor, chipsHtml, supportsTools } from "./caps";
import { initCatalog, openCatalog } from "./catalog";
import { checkForUpdates, initUpdates } from "./updates";
import { GROUPS, describeCall, loadTools, runTool, toolContext, toolSpecs, type ToolDef, type ToolStep } from "./tools";
import { errMsg, nameFor, listModels, ping, streamChat, OLLAMA, LLAMA, type ChatMessage, type ModelInfo, type StreamStats } from "./backends";
import { addMemory, memoryContext, listMemories, rememberRequest, DEFAULT_OWUI, type MemoryConfig } from "./memory";

const inTauri = "__TAURI_INTERNALS__" in window;
const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll(s)) as T[];

// ---------- the logo mark, shared by every <use href="#rg-mark"> ----------
{
  const doc = new DOMParser().parseFromString(markSvg, "image/svg+xml").documentElement;
  const sprite = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  sprite.setAttribute("width", "0");
  sprite.setAttribute("height", "0");
  sprite.setAttribute("aria-hidden", "true");
  sprite.style.position = "absolute";
  const sym = document.createElementNS("http://www.w3.org/2000/svg", "symbol");
  sym.id = "rg-mark";
  sym.setAttribute("viewBox", doc.getAttribute("viewBox") ?? "0 0 600 600");
  for (const child of Array.from(doc.children)) {
    const el = document.importNode(child, true) as Element;
    el.removeAttribute("fill"); // colours come from .eye-glow / .sil in CSS
    sym.appendChild(el);
  }
  sprite.appendChild(sym);
  document.body.prepend(sprite);
}

// ---------- state ----------
interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  model?: string;
  thinking?: string;
  stats?: StreamStats;
  note?: string;
  error?: boolean;
  images?: string[]; // webcam frames sent with a user message (base64 JPEG)
  tools?: ToolStep[]; // tools the model used for this reply
  render?: { path: string; prompt: string; seconds?: number }; // an image made from chat
}
interface Chat {
  id: string;
  title: string;
  created: number;
  updated: number;
  model?: string;
  messages: StoredMessage[];
}
interface Settings {
  model?: string;
  owuiKey?: string;
  owuiUrl?: string;
  stackRoot?: string;
  keepRunning?: boolean;
  voice?: string;
  camera?: string;
  toolGroups?: string[]; // tool groups switched on (undefined = the defaults)
  userName?: string; // what Prestige calls the user
  aboutUser?: string; // optional note every model sees
  welcomed?: boolean; // the first-run welcome has been shown
  speakReplies?: boolean; // read every chat reply aloud as it streams
}

let settings: Settings = {};
let models: ModelInfo[] = [];
let current: ModelInfo | null = null;
let chat: Chat = newChat();
let busy: AbortController | null = null;
let memoryTotal: number | null = null;

function newChat(): Chat {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, title: "New chat", created: Date.now(), updated: Date.now(), messages: [] };
}

function memCfg(): MemoryConfig | null {
  return settings.owuiKey ? { key: settings.owuiKey, url: settings.owuiUrl || DEFAULT_OWUI } : null;
}

async function loadSettings() {
  if (inTauri) settings = (await invoke<Settings>("get_settings")) ?? {};
  else {
    try { settings = JSON.parse(localStorage.getItem("prestige-settings") || "{}"); } catch { settings = {}; }
  }
}
async function saveSettings() {
  if (inTauri) await invoke("save_settings", { settings });
  else {
    try { localStorage.setItem("prestige-settings", JSON.stringify(settings)); } catch { /* preview only */ }
  }
}

// ---------- toast ----------
function toast(msg: string, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout((t as any)._h);
  (t as any)._h = setTimeout(() => (t.className = "toast"), 3000);
}

// ---------- greeting ----------
function greet(online: boolean) {
  const now = new Date();
  const h = now.getHours();
  const part = h < 5 ? "Evening" : h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
  $("#date-eyebrow").textContent = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const name = settings.userName?.trim();
  const hello = name ? `${part}, <span>${escapeHtml(name)}</span>.` : `Good ${part.toLowerCase()}.`;
  $("#greeting").innerHTML = `${hello} ${online ? "Everything is running locally." : "The local services are offline."}`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------- GPU readouts ----------
async function pollGpu() {
  if (!inTauri) return;
  try {
    const g = await invoke<Gpu>("gpu_stats");
    onGpu(g);
    if (g.name && !pcInfo.gpu) pcInfo.gpu = `${g.name.replace(/^NVIDIA\s+/i, "")} ${Math.round(g.mem_total / 1024)} GB`;
    const set = (id: string, pct: number, text: string, hot: boolean) => {
      const el = $(`#${id}`);
      el.style.setProperty("--v", String(Math.max(0, Math.min(100, pct))));
      $(".val", el).textContent = text;
      el.classList.toggle("hot", hot);
    };
    set("m-gpu", g.util, `${Math.round(g.util)}%`, g.util > 95);
    const vp = g.mem_total ? (g.mem_used / g.mem_total) * 100 : 0;
    set("m-vram", vp, `${(g.mem_used / 1024).toFixed(1)}/${(g.mem_total / 1024).toFixed(0)} GB`, vp > 92);
    set("m-temp", g.temp, `${Math.round(g.temp)}°C`, g.temp >= 80);
  } catch {
    $$("#m-gpu .val, #m-vram .val, #m-temp .val").forEach((e) => (e.textContent = "n/a"));
  }
}

// ---------- models ----------
function renderModelMenu() {
  const menu = $("#model-menu");
  menu.innerHTML = "";
  if (!models.length) {
    menu.innerHTML = `<div class="empty">No models answered. Start the services, then reopen this menu.</div>`;
  }
  for (const m of models) {
    const b = document.createElement("button");
    b.setAttribute("role", "menuitem");
    b.className = m.key === current?.key ? "sel" : "";
    b.innerHTML = `<span class="n"></span><span class="r"></span><span class="caps"></span><span class="bf"></span><span class="d"></span>`;
    $(".n", b).textContent = m.name;
    $(".r", b).textContent = m.role ?? "";
    $(".d", b).textContent = m.detail;
    // Capabilities are detected per model (Ollama /api/show or the GGUF file) and filled in as they arrive.
    capsFor(m).then((c) => {
      $(".caps", b).innerHTML = chipsHtml(c);
      $(".bf", b).textContent = `Best for ${bestFor(c)}`;
      const extra = [c.params, c.context ? `${Math.round(c.context / 1024)}k ctx` : ""].filter(Boolean).join(" · ");
      if (extra && !m.detail.includes("ctx")) $(".d", b).textContent = `${m.detail} · ${extra}`;
    });
    b.addEventListener("click", () => {
      selectModel(m);
      menu.hidden = true;
    });
    menu.appendChild(b);
  }
  const more = document.createElement("button");
  more.className = "more";
  more.setAttribute("role", "menuitem");
  more.innerHTML = `<span class="n">＋ Get more models</span><span class="d">Browse the catalog: what each model is good at, one-click download</span>`;
  more.addEventListener("click", () => {
    menu.hidden = true;
    openCatalog();
  });
  menu.appendChild(more);
}

function selectModel(m: ModelInfo | null) {
  current = m;
  $("#model-name").textContent = m ? m.name : "No models found";
  $("#model-dot").classList.toggle("ok", !!m);
  if (m) {
    settings.model = m.key;
    saveSettings();
  }
  renderModelMenu();
}

async function refreshModels() {
  const res = await listModels();
  models = res.models;
  const keep = models.find((m) => m.key === (current?.key ?? settings.model)) ?? models[0] ?? null;
  selectModel(keep);
  const online = res.ollama || res.llama;
  $("#offline").hidden = online;
  if (!online) $("#offline-detail").textContent = "Ollama (11434) and llama.cpp (8081) didn't answer.";
  greet(online);
  return res;
}

// ---------- memory status ----------
const facts = (n: number | null) => `${n ?? 0} ${n === 1 ? "fact" : "facts"}`;

async function refreshMemoryStatus() {
  const el = $("#memory-status");
  const cfg = memCfg();
  if (!cfg) {
    el.textContent = "Shared memory off · connect Open WebUI";
    return;
  }
  try {
    memoryTotal = (await listMemories(cfg)).length;
    el.textContent = `Shared memory on · ${facts(memoryTotal)} · 32k context`;
  } catch (e) {
    el.textContent = `Shared memory unavailable · ${errMsg(e)}`;
  }
}

// ---------- rendering ----------
function md(text: string) {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string);
}

function statText(s?: StreamStats, live = false) {
  if (!s) return "";
  const parts = [];
  if (s.tps) parts.push(`${s.tps.toFixed(1)} tok/s`);
  parts.push(`${s.tokens} tokens`);
  if (!live) parts.push(`${s.seconds.toFixed(1)} s`);
  return parts.join(" · ");
}

function addUserBubble(text: string, images?: string[]) {
  const m = document.createElement("div");
  m.className = "msg you";
  if (images?.length) {
    const row = document.createElement("div");
    row.className = "msg-imgs";
    for (const b64 of images) {
      const img = document.createElement("img");
      img.src = `data:image/jpeg;base64,${b64}`;
      img.alt = "webcam frame";
      row.appendChild(img);
    }
    m.appendChild(row);
  }
  m.append(text);
  $("#thread").appendChild(m);
  return m;
}

/** `text` gives what the speaker button reads aloud (the reply as it is now, while it streams). */
function addAiBubble(modelName: string, text?: () => string) {
  const m = document.createElement("div");
  m.className = "msg ai";
  m.innerHTML = `<div class="msg-meta"><span class="msg-who"></span><span class="msg-stat"></span></div><div class="msg-body"></div>`;
  $(".msg-who", m).textContent = modelName;
  if (text) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "msg-speak";
    b.title = "Read aloud";
    b.setAttribute("aria-label", "Read aloud");
    b.innerHTML = SPEAKER_SVG;
    b.addEventListener("click", () => {
      const again = speakingBubble === m;
      stopSpeaking();
      if (again) return;
      speak(text());
      markSpeaking(m);
    });
    $(".msg-meta", m).appendChild(b);
  }
  $("#thread").appendChild(m);
  return m;
}

const SPEAKER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z" /><path class="w" d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /></svg>`;

// The reply being read aloud, so its speaker button shows as playing (click again to stop).
let speakingBubble: HTMLElement | null = null;
function markSpeaking(b: HTMLElement | null) {
  speakingBubble?.classList.remove("speaking");
  speakingBubble = b;
  b?.classList.add("speaking");
}

/** An image made from chat: the picture (click to open it in the lightbox) and where it was saved. */
function renderFigure(bubble: HTMLElement, r: NonNullable<StoredMessage["render"]>) {
  const body = $(".msg-body", bubble);
  body.innerHTML = `<figure class="chat-render"><button type="button" class="pic" title="Open it (right-click for more: copy, save, edit, delete…)"><img alt="" /></button><figcaption></figcaption></figure>`;
  const img = $("img", body) as HTMLImageElement;
  img.alt = r.prompt;
  if (inTauri) allowRenders().then(() => (img.src = convertFileSrc(r.path)));
  img.addEventListener("error", () => body.querySelector("figure")?.classList.add("missing"), { once: true });
  img.addEventListener("load", () => scrollDown());
  $("figcaption", body).textContent = `${r.prompt}${r.seconds ? ` · ${r.seconds} s` : ""}`;
  $(".pic", body).addEventListener("click", () => openRender(r.path));
  const fig = $("figure", body) as HTMLElement;
  fig.dataset.path = r.path;
  fig.addEventListener("contextmenu", (e) => renderMenu(e, r.path));
}

function setThinking(bubble: HTMLElement, text: string, open: boolean) {
  let box = $(".thinking-box", bubble) as HTMLDetailsElement | null;
  if (!text) return;
  if (!box) {
    box = document.createElement("details");
    box.className = "thinking-box";
    box.innerHTML = `<summary>Thinking</summary><div></div>`;
    bubble.insertBefore(box, $(".msg-body", bubble));
  }
  box.open = open;
  $("div", box).textContent = text;
}

function renderChat() {
  const th = $("#thread");
  th.innerHTML = "";
  markSpeaking(null);
  chat.messages.forEach((msg, i) => {
    let b: HTMLElement;
    if (msg.role === "user") b = addUserBubble(msg.content, msg.images);
    else {
      b = addAiBubble(msg.model ?? "Assistant", msg.error || msg.render ? undefined : () => msg.content);
      if (msg.error) b.classList.add("error");
      if (msg.note) {
        const chip = document.createElement("div");
        chip.className = "chip";
        chip.textContent = msg.note;
        b.insertBefore(chip, $(".msg-body", b));
      }
      if (msg.thinking) setThinking(b, msg.thinking, false);
      for (const step of msg.tools ?? []) renderToolStep(b, step);
      if (msg.render) renderFigure(b, msg.render);
      else $(".msg-body", b).innerHTML = md(msg.content);
      $(".msg-stat", b).textContent = statText(msg.stats);
    }
    b.dataset.i = String(i);
  });
  const empty = chat.messages.length === 0;
  $("#hello").hidden = !empty;
  $("#suggests").hidden = !empty;
  scrollDown(true);
}

function scrollDown(force = false) {
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 220;
  if (force || nearBottom) window.scrollTo({ top: document.body.scrollHeight });
}

// ---------- history ----------
interface ChatHit {
  id: string;
  title: string;
  updated: number;
  model?: string;
  hits?: number;
  index?: number | null;
  snippet?: string;
}

/** Escapes `text` and wraps each search word in <mark>. */
function highlight(text: string, terms: string[]) {
  if (!terms.length) return escapeHtml(text);
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  // split() with a capture group alternates plain text and matches.
  return text.split(re).map((part, i) => (i % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part))).join("");
}

async function persist() {
  chat.updated = Date.now();
  if (inTauri) await invoke("save_chat", { id: chat.id, chat });
  await renderHistory();
}

async function renderHistory() {
  const list = $("#history-list");
  if (!inTauri) {
    list.innerHTML = `<p class="muted" style="padding:10px">History is saved in the desktop app.</p>`;
    return;
  }
  // With words in the search box, the list is the chats that contain all of them, each with the matching passage.
  const query = ($("#history-search") as HTMLInputElement).value.trim();
  const items = query
    ? await invoke<ChatHit[]>("search_chats", { query, exclude: null, width: 140 })
    : await invoke<ChatHit[]>("list_chats");
  if (query !== ($("#history-search") as HTMLInputElement).value.trim()) return; // a newer search is on its way
  list.innerHTML = items.length
    ? ""
    : `<p class="muted" style="padding:10px;font-size:12.5px">${query ? "No chats mention that." : "No saved chats yet."}</p>`;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "history-item" + (it.id === chat.id ? " sel" : "");
    row.innerHTML = `<button class="open"><span class="t"></span><span class="m"></span></button><button class="del" aria-label="Delete chat" title="Delete">✕</button>`;
    $(".t", row).textContent = it.title || "Untitled";
    $(".m", row).textContent = [
      new Date(it.updated).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      it.model,
      query && it.hits ? `${it.hits} ${it.hits === 1 ? "match" : "matches"}` : "",
    ].filter(Boolean).join(" · ");
    if (it.snippet) {
      const s = document.createElement("span");
      s.className = "s";
      s.innerHTML = highlight(it.snippet, terms);
      $(".open", row).appendChild(s);
    }
    $(".open", row).addEventListener("click", async () => {
      if (busy) return toast("Wait for the reply to finish first.");
      chat = await invoke<Chat>("load_chat", { id: it.id });
      renderChat();
      renderHistory();
      $("#history").hidden = true;
      // Jump to the message that matched.
      if (it.index != null) {
        const hit = $(`#thread [data-i="${it.index}"]`);
        hit?.scrollIntoView({ block: "center" });
        hit?.classList.add("found");
        setTimeout(() => hit?.classList.remove("found"), 2400);
      }
    });
    $(".del", row).addEventListener("click", async () => {
      if (!confirm(`Delete "${it.title}"?`)) return;
      await invoke("delete_chat", { id: it.id });
      if (it.id === chat.id) {
        chat = newChat();
        renderChat();
      }
      renderHistory();
    });
    list.appendChild(row);
  }
}

// ---------- sending ----------
// What the PC has, filled in from nvidia-smi and the OS so the prompt fits whoever runs Prestige.
const pcInfo: { gpu?: string; ramGB?: number } = {};

/** The instructions every model gets, personalised with the user's name and note from Settings. */
function systemBase(): string {
  const name = settings.userName?.trim();
  const hw = [pcInfo.gpu, pcInfo.ramGB ? `${pcInfo.ramGB} GB RAM` : ""].filter(Boolean).join(", ");
  const owner = name ? `${name}'s own PC` : "the user's own PC";
  const lines = [
    `You are Prestige by R.G. Studios, a private AI assistant running entirely on ${owner}${hw ? ` (${hw}, Windows)` : ""}. ` +
      "Nothing you see or say leaves this computer.",
    name ? `The user's name is ${name}. Address them by name when it feels natural.` : "",
    settings.aboutUser?.trim() ? `What the user wants you to know about them: ${settings.aboutUser.trim()}` : "",
    "Be direct and helpful. Use Markdown when it helps.",
  ];
  return lines.filter(Boolean).join("\n");
}

// ---------- tools ----------
const TOOLS_HINT =
  "You can call tools to look things up or act on this PC. Use a tool when it actually helps; otherwise just answer. " +
  "For current events or facts you aren't sure of, use web_search, then fetch to read a page. " +
  "Never invent tool results, and say which tool you used when it matters.";

function enabledGroups(): Set<string> {
  return new Set(settings.toolGroups ?? GROUPS.filter((g) => g.defaultOn).map((g) => g.id));
}

function renderToolStep(bubble: HTMLElement, step: ToolStep) {
  let box = $(".tool-steps", bubble) as HTMLElement | null;
  if (!box) {
    box = document.createElement("div");
    box.className = "tool-steps";
    bubble.insertBefore(box, $(".msg-body", bubble));
  }
  const steps = Array.from(box.children) as (HTMLElement & { _step?: ToolStep })[];
  let el = steps.find((x) => x._step === step) as (HTMLDetailsElement & { _step?: ToolStep }) | undefined;
  if (!el) {
    el = document.createElement("details") as HTMLDetailsElement & { _step?: ToolStep };
    el._step = step;
    el.className = "tool-step";
    el.innerHTML = `<summary><span class="ico"></span><span class="what"></span><span class="ms"></span></summary><pre></pre>`;
    box.appendChild(el);
  }
  const state = step.denied ? "denied" : step.ok === true ? "ok" : step.ok === false ? "fail" : "run";
  el.dataset.state = state;
  $(".ico", el).textContent = { ok: "✓", fail: "✗", denied: "⛔", run: "…" }[state]!;
  $(".what", el).textContent = describeCall(step.name, step.args);
  $(".ms", el).textContent = step.denied ? "not allowed" : step.ms != null ? `${(step.ms / 1000).toFixed(1)} s` : "running";
  $("pre", el).textContent =
    `Arguments\n${JSON.stringify(step.args ?? {}, null, 2)}` + (step.result != null ? `\n\nResult\n${step.result}` : "");
  scrollDown();
}

/** An inline "Allow this?" card in the reply; resolves when the user decides (or the reply is stopped). */
function confirmTool(bubble: HTMLElement, def: ToolDef, args: any, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const card = document.createElement("div");
    card.className = "tool-confirm";
    const group = GROUPS.find((g) => g.id === def.group)?.label ?? def.group;
    card.innerHTML = `<div class="q">Allow <b></b>? <span class="grp"></span></div><pre></pre>
      <div class="acts"><button class="btn" data-a="no">Don't allow</button><button class="btn primary" data-a="yes">Allow</button></div>`;
    $("b", card).textContent = def.name;
    $(".grp", card).textContent = `(${group})`;
    $("pre", card).textContent = JSON.stringify(args ?? {}, null, 2);
    bubble.insertBefore(card, $(".msg-body", bubble));
    scrollDown(true);
    const done = (ok: boolean) => {
      card.remove();
      resolve(ok);
    };
    card.querySelectorAll<HTMLButtonElement>("[data-a]").forEach((b) => b.addEventListener("click", () => done(b.dataset.a === "yes")));
    signal.addEventListener("abort", () => done(false), { once: true });
    toast(`${model_name(def)} wants to run ${def.name}. Allow it in the chat.`);
  });
}
const model_name = (_: ToolDef) => current?.name ?? "The model";

async function renderToolsMenu() {
  const pop = $("#tools-pop");
  const list = $("#tools-list");
  const on = enabledGroups();
  list.innerHTML = "";
  const { tools, errors } = await loadTools();
  for (const g of GROUPS) {
    const n = tools.filter((t) => t.group === g.id).length;
    const ask = tools.filter((t) => t.group === g.id && t.confirm).length;
    const row = document.createElement("label");
    row.className = "tool-group";
    row.innerHTML = `<input type="checkbox" /><span><b></b><small></small></span>`;
    const cb = $("input", row) as HTMLInputElement;
    cb.checked = on.has(g.id);
    cb.disabled = n === 0;
    $("b", row).textContent = g.label;
    $("small", row).textContent = n ? `${g.hint} · ${n} tools${ask ? `, ${ask} ask first` : ""}` : `${g.hint} · not available`;
    cb.addEventListener("change", () => {
      const next = enabledGroups();
      cb.checked ? next.add(g.id) : next.delete(g.id);
      settings.toolGroups = [...next];
      saveSettings();
      updateToolsButton();
    });
    list.appendChild(row);
  }
  const note = $("#tools-note");
  const can = current ? await supportsTools(current) : false;
  note.textContent = [
    errors.length ? `Not reachable: ${errors.join("; ")}` : "",
    current && !can ? `${current.name} can't call tools; pick Qwen3.6 35B, Qwen3.5 9B, Gemma 4 or Llama 3.1.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  pop.hidden = false;
}

function updateSpeakButton() {
  const btn = $("#composer-speak");
  btn.classList.toggle("on", !!settings.speakReplies);
  btn.title = settings.speakReplies ? "Reading replies aloud (click to turn off)" : "Read replies aloud";
  btn.setAttribute("aria-pressed", String(!!settings.speakReplies));
}

function updateToolsButton() {
  const n = enabledGroups().size;
  const btn = $("#composer-tools");
  btn.classList.toggle("on", n > 0);
  btn.title = n ? `Tools: ${n} group${n === 1 ? "" : "s"} on` : "Tools are off";
  $("#tools-count").textContent = n ? String(n) : "";
}

// ---------- attachments (webcam frames for the next message) ----------
let attachments: string[] = [];

function renderAttachments() {
  const box = $("#attachments");
  box.hidden = !attachments.length;
  box.innerHTML = "";
  attachments.forEach((b64, i) => {
    const d = document.createElement("div");
    d.className = "att";
    d.innerHTML = `<img alt="attached frame" /><button type="button" aria-label="Remove">✕</button>`;
    ($("img", d) as HTMLImageElement).src = `data:image/jpeg;base64,${b64}`;
    $("button", d).addEventListener("click", () => {
      attachments.splice(i, 1);
      renderAttachments();
    });
    box.appendChild(d);
  });
}

const VISION = /gemma|qwen3\.6|llava|vision|-vl/i;

export interface ReplyHooks {
  onDelta?: (t: string) => void;
  onDone?: (ok: boolean) => void;
}

// ---------- images from chat ----------
// "/image a lighthouse at dusk" (or /imagine, /img), or a plain ask like "draw me…" / "make an image of…".
const IMAGE_CMD = /^\/(?:image|imagine|img)\b\s*/i;
const IMAGE_ASK =
  /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:(?:draw|paint|sketch)\s+me\s+|(?:draw|paint|sketch|make|generate|create|render)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|illustration|drawing|painting|wallpaper)\s+of\s+)/i;

/** The image prompt in a message, "" for a bare /image, or null when it isn't an image request. */
function imageRequest(text: string): string | null {
  const m = text.match(IMAGE_CMD) ?? text.match(IMAGE_ASK);
  return m ? text.slice(m[0].length).trim().replace(/[.?!]+$/, "") : null;
}

function setBusyUi(on: boolean) {
  document.body.classList.toggle("busy", on);
  $("#thinking").hidden = !on;
  $("#stop").hidden = !on;
  ($("#send") as HTMLButtonElement).disabled = on;
}

/** Makes an image with the Studio's image model (Qwen-Image-2.1 or its turbo) and shows it in the chat. */
async function makeImage(text: string, prompt: string, hooks?: ReplyHooks) {
  if (!inTauri) {
    toast("Images are made in the desktop app.");
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = text.replace(/\s+/g, " ").slice(0, 60);
  chat.messages.push({ role: "user", content: text });
  renderChat();
  const label = await imageModelLabel();
  const reply: StoredMessage = { role: "assistant", content: "", model: label };
  const bubble = addAiBubble(label);
  const body = $(".msg-body", bubble);
  body.innerHTML = `<div class="render-progress"><div class="progress"><i></i></div><span class="status-line">Starting…</span></div>`;
  scrollDown(true);
  busy = new AbortController();
  busy.signal.addEventListener("abort", () => cancelRender(), { once: true });
  setBusyUi(true);
  const t0 = Date.now();
  try {
    const a = await renderImage(prompt, (pct, label) => {
      ($(".progress", body) as HTMLElement | null)?.style.setProperty("--v", String(pct));
      const l = $(".status-line", body);
      if (l) l.textContent = label;
    });
    reply.render = { path: a.path, prompt, seconds: Math.round((Date.now() - t0) / 1000) };
    // What chat models see in later turns.
    reply.content = `(I made an image with ${label} for: "${prompt}". It's saved as ${a.name}.)`;
    renderFigure(bubble, reply.render);
  } catch (e) {
    if (busy?.signal.aborted) reply.content = "*(stopped)*";
    else {
      reply.error = true;
      reply.content = `Couldn't make the image: ${errMsg(e)}`;
      bubble.classList.add("error");
    }
    body.innerHTML = md(reply.content);
  } finally {
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    busy = null;
    setBusyUi(false);
    scrollDown();
    persist().catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"));
    if (hooks) {
      hooks.onDelta?.(reply.render ? "Here's your image." : "I couldn't make that image.");
      hooks.onDone?.(!!reply.render);
    }
  }
}

async function send(text: string, opts: { images?: string[]; vision?: string; hooks?: ReplyHooks } = {}) {
  text = text.trim();
  if (!text && (opts.images?.length || attachments.length)) text = "What do you see in this picture?";
  if (!text || busy) {
    opts.hooks?.onDone?.(false);
    return;
  }
  const imagePrompt = opts.images?.length || attachments.length ? null : imageRequest(text);
  if (imagePrompt === "") {
    toast("Describe the image after /image, e.g. /image a lighthouse at dusk in the rain");
    opts.hooks?.onDone?.(false);
    return;
  }
  if (imagePrompt) return makeImage(text, imagePrompt, opts.hooks);
  const images = opts.images ?? (attachments.length ? attachments : undefined);
  if (!opts.images) {
    attachments = [];
    renderAttachments();
  }
  // Pictures need a model that can see; switch to Gemma 4 (or the one asked for) if needed.
  if (images?.length && (!current || !VISION.test(current.id) || (opts.vision && current.id !== opts.vision))) {
    const want = models.find((m) => m.id === opts.vision) ?? models.find((m) => m.id === "gemma4:12b") ?? models.find((m) => VISION.test(m.id));
    if (want && want.key !== current?.key) {
      selectModel(want);
      toast(`Switched to ${want.name} to look at the picture.`);
    }
  }
  if (!current) {
    toast("No model is available. Start the services first.", "warn");
    return;
  }
  const model = current;
  if (chat.messages.length === 0) chat.title = text.replace(/\s+/g, " ").slice(0, 60);
  chat.model = model.name;
  chat.messages.push({ role: "user", content: text, images });
  renderChat();

  const reply: StoredMessage = { role: "assistant", content: "", model: model.name };
  const bubble = addAiBubble(model.name, () => reply.content);
  const body = $(".msg-body", bubble);
  // "Speak replies" reads typed chats aloud too (voice chats already speak through their own hooks).
  const speakIt = !!settings.speakReplies && !opts.hooks;
  if (speakIt) stopSpeaking();
  toolContext.chatId = chat.id;
  const stat = $(".msg-stat", bubble);
  body.innerHTML = `<span class="status-line">Preparing…</span>`;
  scrollDown(true);

  busy = new AbortController();
  document.body.classList.add("busy");
  $("#thinking").hidden = false;
  $("#stop").hidden = false;
  ($("#send") as HTMLButtonElement).disabled = true;

  try {
    // Shared memory: "remember that …" saves a fact; every reply gets the relevant facts.
    const cfg = memCfg();
    let memoryText = "";
    if (cfg) {
      const fact = rememberRequest(text);
      if (fact) {
        try {
          await addMemory(cfg, fact);
          reply.note = `saved to shared memory: ${fact}`;
          const chip = document.createElement("div");
          chip.className = "chip";
          chip.textContent = reply.note;
          bubble.insertBefore(chip, body);
        } catch (e) {
          toast(`Couldn't save that memory: ${errMsg(e)}`, "warn");
        }
      }
      try {
        const recent = chat.messages.filter((m) => m.role === "user").slice(-7).map((m) => m.content).join("\n\n");
        const mem = await memoryContext(cfg, recent);
        memoryText = mem.text;
        memoryTotal = mem.total;
        $("#memory-status").textContent = `Shared memory on · ${facts(mem.total)} · ${mem.count} in this reply`;
      } catch (e) {
        $("#memory-status").textContent = `Shared memory unavailable · ${errMsg(e)}`;
      }
    }

    const messages: ChatMessage[] = [
      { role: "system", content: [systemBase(), memoryText].filter(Boolean).join("\n\n") },
      ...chat.messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content, images: m.images })),
    ];

    body.innerHTML = `<span class="status-line">${model.backend === "llama" ? "Loading the model if it's asleep (up to a minute)…" : "Waiting for the first token…"}</span>`;
    let thinking = "";
    let pending = false;
    const paint = () => {
      pending = false;
      if (!busy) return; // the stream already ended and the final render is in place
      body.innerHTML = md(reply.content);
      // Put the cursor at the end of the last paragraph, not on a line of its own.
      let last: Element = body;
      while (last.lastElementChild && !["PRE", "TABLE"].includes(last.lastElementChild.tagName)) last = last.lastElementChild;
      const caret = document.createElement("span");
      caret.className = "caret";
      last.appendChild(caret);
      scrollDown();
    };
    // Tools: offered when any group is on and the model can call functions.
    const groups = enabledGroups();
    let toolDefs: ToolDef[] = [];
    let specs: any[] | undefined;
    if (groups.size && (await supportsTools(model))) {
      const t = await loadTools();
      toolDefs = t.tools.filter((x) => groups.has(x.group));
      specs = toolDefs.length ? toolSpecs(t.tools, groups) : undefined;
      if (specs) messages[0].content += "\n\n" + TOOLS_HINT;
    }
    const handlers = {
      onToken: (t: string) => {
        reply.content += t;
        opts.hooks?.onDelta?.(t);
        if (speakIt) {
          if (speakingBubble !== bubble) markSpeaking(bubble);
          speakDelta(t);
        }
        if (!pending) {
          pending = true;
          requestAnimationFrame(paint);
        }
      },
      onThinking: (t: string) => {
        thinking += t;
        setThinking(bubble, thinking, !reply.content);
        if (!reply.content) body.innerHTML = `<span class="status-line">Thinking…</span>`;
      },
      onStats: (s: StreamStats) => (stat.textContent = statText(s, true)),
    };
    let stats: StreamStats | undefined;
    for (let round = 0; round < 6; round++) {
      const before = reply.content.length;
      const res = await streamChat(model, messages, handlers, busy.signal, specs);
      stats = res;
      if (!res.toolCalls.length || !busy || busy.signal.aborted) break;
      messages.push({ role: "assistant", content: reply.content.slice(before), tool_calls: res.toolCalls });
      for (const call of res.toolCalls) {
        const def = toolDefs.find((d) => d.name === call.name);
        const step: ToolStep = { name: call.name, args: call.arguments };
        (reply.tools ??= []).push(step);
        renderToolStep(bubble, step);
        let result: string;
        if (!def) {
          result = `There is no tool called ${call.name}.`;
          step.ok = false;
        } else if (def.confirm && !(await confirmTool(bubble, def, call.arguments, busy.signal))) {
          step.denied = true;
          result = "The user did not allow this action. Don't retry it; tell them what you would have done instead.";
        } else {
          if (!reply.content) body.innerHTML = `<span class="status-line">Running ${def.name}…</span>`;
          const t0 = performance.now();
          try {
            result = await runTool(def, call.arguments);
            step.ok = true;
          } catch (e) {
            result = `Error: ${errMsg(e)}`;
            step.ok = false;
          }
          step.ms = Math.round(performance.now() - t0);
        }
        step.result = result.length > 2000 ? result.slice(0, 2000) + "…" : result;
        renderToolStep(bubble, step);
        messages.push({ role: "tool", content: result, tool_call_id: call.id, tool_name: call.name });
      }
      if (!reply.content) body.innerHTML = `<span class="status-line">Reading the results…</span>`;
    }
    reply.stats = stats;
    // Llama 3.1 sometimes types a pretend tool call as plain text ({"name": ..., "parameters": ...}) instead
    // of calling a tool. Drop it when it doesn't name a real tool, so only the actual answer is shown.
    const fake = reply.content.match(/^\s*\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*\{[^}]*\}\s*\}\s*/);
    if (fake && !toolDefs.some((d) => d.name === fake[1])) reply.content = reply.content.slice(fake[0].length);
    reply.thinking = thinking || undefined;
    if (thinking) setThinking(bubble, thinking, false);
  } catch (e) {
    if (busy?.signal.aborted) {
      reply.content += reply.content ? "\n\n*(stopped)*" : "*(stopped)*";
    } else {
      reply.error = true;
      const m = errMsg(e);
      const engine = model.backend === "llama" ? "llama.cpp" : "Ollama";
      reply.content = `Couldn't get a reply from ${model.name}: ${m === "not reachable" ? `${engine} isn't running` : m}`;
      bubble.classList.add("error");
    }
  } finally {
    body.innerHTML = md(reply.content);
    stat.textContent = statText(reply.stats);
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (speakIt && !busy?.signal.aborted) speakEnd();
    busy = null;
    document.body.classList.remove("busy");
    $("#thinking").hidden = true;
    $("#stop").hidden = true;
    ($("#send") as HTMLButtonElement).disabled = false;
    scrollDown();
    persist().catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"));
    opts.hooks?.onDone?.(!reply.error && !reply.content.endsWith("*(stopped)*"));
  }
}

// ---------- launch screen ----------
const BOOT: { label: string; url: string }[] = [
  { label: "Ollama", url: `${OLLAMA}/api/version` },
  { label: "llama.cpp · Qwen3.6 35B", url: `${LLAMA}/models` },
  { label: "Open WebUI · shared memory", url: `${DEFAULT_OWUI}/api/config` },
  { label: "ComfyUI", url: "http://127.0.0.1:8188/system_stats" },
  { label: "Kokoro voice", url: "http://127.0.0.1:8880/v1/models" },
];

function bootRows() {
  const boot = $("#boot");
  boot.innerHTML = "";
  return BOOT.map((b) => {
    const s = document.createElement("span");
    s.textContent = b.label;
    boot.appendChild(s);
    return s;
  });
}

async function checkAll(spans: HTMLElement[]) {
  const ok = await Promise.all(BOOT.map((b) => ping(b.url)));
  ok.forEach((up, i) => {
    spans[i].className = up ? "ok" : "off";
    spans[i].textContent = up ? BOOT[i].label : `${BOOT[i].label} · offline`;
  });
  return ok;
}

let starting: Promise<boolean> | null = null;

/** Runs start-all.ps1 and ticks each service as it comes up. True once a chat backend answers. */
function startStack(spans: HTMLElement[]): Promise<boolean> {
  if (starting) return starting;
  starting = (async () => {
    try {
      await invoke("start_services", { root: settings.stackRoot ?? null });
    } catch (e) {
      toast(`Couldn't start the services: ${errMsg(e)}`, "warn");
      return false;
    }
    spans.forEach((s, i) => {
      if (!s.classList.contains("ok")) {
        s.className = "";
        s.textContent = `${BOOT[i].label} · starting…`;
      }
    });
    // Open WebUI takes the longest (about a minute); give everything up to 3 minutes.
    const until = performance.now() + 180_000;
    let chatUp = false;
    while (performance.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
      const ok = await Promise.all(BOOT.map((b) => ping(b.url)));
      ok.forEach((up, i) => {
        if (up) {
          spans[i].className = "ok";
          spans[i].textContent = BOOT[i].label;
        }
      });
      chatUp = ok[0] || ok[1];
      if (ok[0] && ok[1] && ok[2]) break;
    }
    return chatUp;
  })().finally(() => (starting = null));
  return starting;
}

async function runSplash(autoStart: boolean) {
  const splash = $("#splash");
  splash.classList.remove("gone");
  const spans = bootRows();
  const started = performance.now();
  const ok = await checkAll(spans);
  if (autoStart && inTauri && !ok[0] && !ok[1]) {
    await startStack(spans);
  }
  await refreshModels();
  refreshMemoryStatus();
  const wait = Math.max(0, 2200 - (performance.now() - started));
  setTimeout(() => splash.classList.add("gone"), wait);
}

// ---------- wiring ----------
function autosize() {
  const ta = $("#prompt") as HTMLTextAreaElement;
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
}

function wire() {
  const ta = $("#prompt") as HTMLTextAreaElement;
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = ta.value;
    ta.value = "";
    autosize();
    send(v);
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ($("#composer") as HTMLFormElement).requestSubmit();
    }
  });
  ta.addEventListener("input", autosize);
  $("#composer-tools").addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = $("#tools-pop");
    if (pop.hidden) renderToolsMenu();
    else pop.hidden = true;
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest("#tools-pop, #composer-tools")) $("#tools-pop").hidden = true;
  });
  $("#stop").addEventListener("click", () => {
    busy?.abort();
    stopSpeaking();
  });
  // Image button: starts the message with /image, so whatever is typed next becomes the picture.
  $("#composer-image").addEventListener("click", () => {
    const v = ta.value.replace(IMAGE_CMD, "");
    ta.value = `/image ${v}`;
    autosize();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
  $("#composer-speak").addEventListener("click", () => {
    settings.speakReplies = !settings.speakReplies || undefined;
    saveSettings();
    updateSpeakButton();
    if (!settings.speakReplies) stopSpeaking();
    toast(settings.speakReplies ? "Replies will be read aloud." : "Replies won't be read aloud.");
  });
  // Searching past chats: type in the box at the top of the Past chats panel (Ctrl+K opens it).
  let searchTimer = 0;
  $("#history-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(renderHistory, 180);
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      go("chat");
      $("#history").hidden = false;
      renderHistory();
      const s = $("#history-search") as HTMLInputElement;
      s.focus();
      s.select();
    } else if (e.key === "Escape" && !$("#history").hidden) $("#history").hidden = true;
  });
  $$("[data-suggest]").forEach((b) => b.addEventListener("click", () => send(b.textContent ?? "")));

  $("#model-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const menu = $("#model-menu");
    menu.hidden = !menu.hidden;
    $("#model-btn").setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) refreshModels();
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".model-pick")) $("#model-menu").hidden = true;
    if (!(e.target as HTMLElement).closest("#history, #history-btn")) $("#history").hidden = true;
  });

  $("#history-btn").addEventListener("click", () => {
    const h = $("#history");
    h.hidden = !h.hidden;
    if (!h.hidden) renderHistory();
  });
  $("#new-chat").addEventListener("click", () => {
    if (busy) return toast("Wait for the reply to finish first.");
    chat = newChat();
    renderChat();
    renderHistory();
    $("#history").hidden = true;
    ta.focus();
  });

  $$("[data-soon]").forEach((b) => b.addEventListener("click", () => toast(b.dataset.soon!)));
  $$("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go!)));

  $("#brand").addEventListener("click", () => ($("#about") as HTMLDialogElement).showModal());
  $("#replay-splash").addEventListener("click", () => {
    ($("#about") as HTMLDialogElement).close();
    runSplash(false);
  });

  // services
  $("#start-services").addEventListener("click", async () => {
    const btn = $("#start-services") as HTMLButtonElement;
    if (!inTauri) return toast("Run start-all.ps1 in the Workstation folder.");
    btn.disabled = true;
    btn.textContent = "Starting… (about a minute)";
    try {
      const up = await startStack(bootRows());
      await refreshModels();
      refreshMemoryStatus();
      toast(up ? "Services are up." : "The services didn't come up. Check the Workstation folder in Settings.", up ? "" : "warn");
    } finally {
      btn.disabled = false;
      btn.textContent = "Start them";
    }
  });

  // settings
  const dlg = $("#settings") as HTMLDialogElement;
  const keyInput = $("#owui-key") as HTMLInputElement;
  const urlInput = $("#owui-url") as HTMLInputElement;
  const rootInput = $("#stack-root") as HTMLInputElement;
  const keepInput = $("#keep-running") as HTMLInputElement;
  const nameInput = $("#user-name") as HTMLInputElement;
  const aboutInput = $("#user-about") as HTMLTextAreaElement;
  const openSettings = async () => {
    nameInput.value = settings.userName ?? "";
    aboutInput.value = settings.aboutUser ?? "";
    keyInput.value = settings.owuiKey ?? "";
    urlInput.value = settings.owuiUrl ?? DEFAULT_OWUI;
    const info = inTauri ? await invoke<{ root: string }>("stack_info", { root: settings.stackRoot ?? null }) : { root: "" };
    rootInput.value = info.root;
    keepInput.checked = !!settings.keepRunning;
    $("#settings-test").textContent = "";
    dlg.showModal();
  };
  $("#memory-status").addEventListener("click", openSettings);
  $("#settings-btn").addEventListener("click", openSettings);
  $("#test-key").addEventListener("click", async () => {
    const out = $("#settings-test");
    const url = urlInput.value.trim() || DEFAULT_OWUI;
    if (!keyInput.value.trim()) {
      out.textContent = "Paste a key first.";
      return;
    }
    out.textContent = "Testing…";
    try {
      const n = (await listMemories({ key: keyInput.value.trim(), url })).length;
      out.textContent = `Connected. ${n} memories found.`;
    } catch (e) {
      const m = errMsg(e);
      out.textContent = m.includes("isn't running")
        ? `${m}, so the key can't be checked yet. Save it anyway; it's used once the services are up.`
        : `Didn't work: ${m}`;
    }
  });
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "save") return;
    settings.userName = nameInput.value.trim() || undefined;
    settings.aboutUser = aboutInput.value.trim() || undefined;
    greet($("#offline").hidden);
    settings.owuiKey = keyInput.value.trim() || undefined;
    const url = urlInput.value.trim();
    settings.owuiUrl = url && url !== DEFAULT_OWUI ? url : undefined;
    settings.stackRoot = rootInput.value.trim() || undefined;
    settings.keepRunning = keepInput.checked || undefined;
    await saveSettings();
    if (inTauri) {
      const info = await invoke<{ startScript: boolean }>("stack_info", { root: settings.stackRoot ?? null });
      if (!info.startScript) toast("start-all.ps1 isn't in that folder.", "warn");
    }
    refreshMemoryStatus();
  });
}

// ---------- screens ----------
function go(name: string) {
  $$("[data-screen]").forEach((s) => (s.hidden = s.dataset.screen !== name));
  $$("[data-go]").forEach((b) => b.classList.toggle("active", b.dataset.go === name));
  $("#history").hidden = true;
  showSystem(name === "system");
  showStudio(name === "studio");
  showVoice(name === "voice");
  if (name !== "studio") showCameraPane(false);
  window.scrollTo({ top: 0 });
}

// ---------- first run ----------
function showWelcome() {
  const dlg = $("#welcome") as HTMLDialogElement;
  const name = $("#welcome-name") as HTMLInputElement;
  const about = $("#welcome-about") as HTMLTextAreaElement;
  name.value = settings.userName ?? "";
  about.value = settings.aboutUser ?? "";
  dlg.returnValue = "";
  dlg.addEventListener(
    "close",
    async () => {
      if (dlg.returnValue === "save") {
        settings.userName = name.value.trim() || undefined;
        settings.aboutUser = about.value.trim() || undefined;
      }
      settings.welcomed = true; // skipping counts too; it's in Settings any time
      await saveSettings();
      greet($("#offline").hidden);
      if (settings.userName) toast(`Nice to meet you, ${settings.userName}.`);
    },
    { once: true },
  );
  dlg.showModal();
  name.focus();
}

async function main() {
  greet(true);
  wire();
  initSystem({ toast, nameFor, openCatalog: () => openCatalog() });
  initCatalog({
    toast,
    root: () => settings.stackRoot ?? null,
    onInstalled: () => refreshModels(),
  });
  initStudio({
    toast,
    root: () => settings.stackRoot ?? null,
    freeGpu: () => unloadAll(),
    cameraPane: (on: boolean) => showCameraPane(on),
    show: () => go("studio"),
  });
  onSpeakingChange((on) => {
    if (!on) markSpeaking(null);
  });
  // The Voice screen's avatar is an inline copy of the mark, so its eye can follow the audio.
  $("#voice-mark").innerHTML = markSvg;
  initVoice({
    toast,
    memCfg,
    send: (text, hooks) => {
      send(text, { hooks });
    },
    stopReply: () => busy?.abort(),
    isReplying: () => !!busy,
    getVoice: () => settings.voice,
    setVoiceSetting: (v) => {
      settings.voice = v;
      saveSettings();
    },
  });
  initCamera({
    toast,
    ask: (text, images, vision) => {
      go("chat");
      send(text, { images, vision });
    },
    attach: (b64) => {
      attachments.push(b64);
      renderAttachments();
      $("#prompt").focus();
    },
    getCamera: () => settings.camera,
    setCamera: (id) => {
      settings.camera = id;
      saveSettings();
    },
  });
  renderChat();
  await loadSettings();
  updateToolsButton();
  updateSpeakButton();
  // Like open-app.ps1: opening the app starts the workstation if it isn't running.
  await runSplash(true);
  // Check for a new version shortly after start, then every 6 hours while Prestige stays open.
  initUpdates(toast).then(() => {
    setTimeout(() => checkForUpdates(true), 4000);
    setInterval(() => checkForUpdates(true), 6 * 60 * 60 * 1000);
  });
  greet($("#offline").hidden);
  if (!settings.welcomed && !settings.userName) setTimeout(showWelcome, 2600);
  renderHistory();
  pollGpu();
  setInterval(pollGpu, 1000);
  if (inTauri) invoke<{ total: number }>("sys_memory").then((m) => (pcInfo.ramGB = Math.round(m.total / 1024))).catch(() => {});
  ($("#prompt") as HTMLTextAreaElement).focus();
}

main();
