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
import { initSystem, onGpus, phoneSystem, showSystem, unloadAll } from "./system";
import { ollamaCtx, onPlanChange, readGpus, refreshPlan, shortName, type Gpu } from "./gpus";
import {
  allowRenders, cancelRender, chatSettings, editLabel, editMedia, initStudio, modelLabel, openRender, renderMedia, renderMenu, renderModel, renderSong, renderTalk,
  faceThumb, onQueueChange, phoneQueue, phoneStudio, renderShot, showStudio, songSeconds, talkSecs, videoQuality, type MediaKind,
} from "./studio";
import { DIRECTOR_ASK, DIRECTOR_CMD, SHOT_SECONDS, SONG_SECS, askedSeconds, directorSecs, lyricsSrt, planVideo } from "./director";
import { askSpeech, speakLine } from "./talking";
import { SONG_CMD, writeSong } from "./songwriter";
import { onSettingsChange } from "./gensettings";
import { CONSENT, bindRefChoices, hasFiles, imageIn, imageToBase64, onRefPrefsChange, refChoicesHtml, referenceFromBase64, type Reference } from "./reference";
import { initVoice, showVoice } from "./voice";
import { initCamera, showCameraPane } from "./camera";
import { initLive, startLive, LIVE_CTX, LIVE_MODELS } from "./live";
import {
  isVox, onSpeakingChange, onSpeechError, releaseSpeechGpu, setVoice, speak, speakDelta, speakEnd, stopSpeaking, DEFAULT_VOICE,
} from "./speech";
import { bestFor, capsFor, chipsHtml, supportsTools } from "./caps";
import { initCatalog, openCatalog, phoneCatalog } from "./catalog";
import { checkForUpdates, initUpdates } from "./updates";
import { GROUPS, describeCall, loadTools, runTool, toolContext, toolSpecs, type ToolDef, type ToolStep } from "./tools";
import { errMsg, freeLlamaVram, nameFor, listModels, ping, streamChat, OLLAMA, LLAMA, type ChatMessage, type ModelInfo, type StreamStats } from "./backends";
import { addMemory, memoryContext, listMemories, rememberRequest, DEFAULT_OWUI, type MemoryConfig } from "./memory";
import { addStache } from "./talk";
import { applyCachedLook, applyLook, closeAppearance, initAppearance, openAppearance, type Look } from "./theme";
import { initMesa } from "./mesa";
import { pickReaction, reactFilter, reactedNote, showReaction, stripTags, REACT_HINT } from "./emotes";
import { CANVAS_CMD, CANVAS_HINT, canvasOnChat, canvasReplyStart, findCanvas, initCanvas, openCanvas, openModel, streamCanvas, streamEnded, wantsCanvas } from "./canvas";
import {
  addDropped, addFiles, citeLabel, docById, hasDocs, initKnowledge, knowledgeFor, openKnowledge, openSource, phoneKnowledge, readyDocs, type KbDoc, type Source,
} from "./knowledge";
import { RESEARCH_CMD, deepResearch } from "./research";
import { TRANSCRIBE_CMD, clock, isMedia, summaryPrompt, transcribeMedia, transcriptMd, type MediaSource } from "./transcribe";
import { initMissions, phoneMissions } from "./missions";
import { DO_CMD, brains, describe as describeAct, doItForMe } from "./computer";
import {
  activeCharacter, characterById, characterMemory, characterPrompt, characters, faceScene, initCharacters, remember, renderPicker, setCharacterVoice, voiceOf, wantsFace,
} from "./characters";
import type { RefKind } from "./reference";
import { initPhone, onPhoneAsk, phoneOn, phonePush, phoneState, refreshPhone } from "./phone";
import { initToolStore, openToolStore } from "./toolstore";
import { listen } from "@tauri-apps/api/event";

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
  // Every copy of the mark moves its mustache while Prestige speaks (talk.ts).
  addStache(sym);
  // Last run's colours, before the launch screen shows (the saved settings are applied again once they load).
  applyCachedLook();
  // Molded surfaces: panels rise into place and popovers grow from their buttons (mesa.ts).
  initMesa();
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
  // An image (or several, or a video) made from chat. "more" holds the other images of a batch.
  // reply: the model made it with a tool, so its content is the reply to show under it (not a note for later turns).
  // A song (kind "audio") has its title; prompt is its style. A "model" is a .glb (/3d).
  render?: { path: string; prompt: string; seconds?: number; more?: string[]; kind?: MediaKind | "model"; reply?: boolean; title?: string };
  react?: string; // an emote reaction: yours on a reply, Prestige's on your message
  sources?: Source[]; // passages from Knowledge this reply was given (shown under it, cited in it)
}
interface Chat {
  id: string;
  title: string;
  created: number;
  updated: number;
  model?: string;
  messages: StoredMessage[];
  files?: string[]; // Knowledge files attached to this chat (dropped or attached here)
  character?: string; // the character it was with (picked again when the chat is opened)
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
  liveCamera?: boolean; // Live calls start with the camera on
  look?: Look; // Appearance: theme colours, glow, ember drift, emote reactions (theme.ts)
  kbAll?: boolean; // Knowledge: search every file for every chat (undefined = on)
  kbTool?: boolean; // the "Your files" tool group was added to saved tool groups
  character?: string; // the character being talked to (characters.ts); undefined = Prestige itself
  phone?: boolean; // phone access is on (phone.rs)
  phonePort?: number; // its port, 8765 unless set
  liveStt?: "phonon"; // Live calls listen with Phonon-2 (CPU, :8891) instead of Whisper
  computerModel?: string; // the model that drives the PC for /do (its key); undefined = the best one there
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
// A GPU and a VRAM meter per card (named by model number when there are several), then the hottest card's temperature.
let hudCards = "";
function renderHud(list: Gpu[]) {
  const box = $("#hud-gpus");
  box.closest(".hud")?.classList.toggle("multi-gpu", list.length > 1);
  const key = list.map((g) => g.index).join();
  if (key !== hudCards) {
    hudCards = key;
    const tag = (g: Gpu) => (list.length > 1 ? ` ${escapeHtml(shortName(g).replace(/^(RTX|GTX|Quadro|Tesla)\s+/i, ""))}` : "");
    box.innerHTML =
      list
        .map(
          (g) =>
            `<div class="cell meter" data-m="gpu" data-i="${g.index}"><b>GPU${tag(g)}</b><div class="bar"><i></i></div><span class="val">–</span></div>` +
            `<div class="cell meter" data-m="vram" data-i="${g.index}"><b>VRAM</b><div class="bar"><i></i></div><span class="val">–</span></div>`,
        )
        .join("") + `<div class="cell meter" data-m="temp"><b>TEMP</b><span class="val">–</span></div>`;
  }
  const set = (el: HTMLElement, pct: number, text: string, hot: boolean, tip: string) => {
    el.style.setProperty("--v", String(Math.max(0, Math.min(100, pct))));
    $(".val", el).textContent = text;
    el.classList.toggle("hot", hot);
    el.title = tip;
  };
  for (const g of list) {
    const name = shortName(g);
    set($(`[data-m="gpu"][data-i="${g.index}"]`, box), g.util, `${Math.round(g.util)}%`, g.util > 95, `${name}: load`);
    const vp = g.mem_total ? (g.mem_used / g.mem_total) * 100 : 0;
    set($(`[data-m="vram"][data-i="${g.index}"]`, box), vp, `${(g.mem_used / 1024).toFixed(1)}/${(g.mem_total / 1024).toFixed(0)} GB`, vp > 92, `${name}: VRAM`);
  }
  const hot = list.reduce((a, b) => (b.temp > a.temp ? b : a));
  set($(`[data-m="temp"]`, box), hot.temp, `${Math.round(hot.temp)}°C`, hot.temp >= 80, list.map((g) => `${shortName(g)} ${Math.round(g.temp)}°C`).join(" · "));
}

let gpuTicks = 0;
async function pollGpu() {
  if (!inTauri) return;
  // Which card each service is on: re-read every 10 s, so a restart of the services (or a new mode) shows up.
  if (gpuTicks++ % 10 === 0) await refreshPlan(settings.stackRoot ?? null);
  try {
    const list = await readGpus();
    onGpus(list);
    if (!pcInfo.gpu) pcInfo.gpu = list.map((g) => `${shortName(g)} ${Math.round(g.mem_total / 1024)} GB`).join(" + ");
    renderHud(list);
  } catch {
    $$("#hud-gpus .val").forEach((e) => (e.textContent = "n/a"));
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
  refreshMemoryStatus();
  syncPhone();
}

/** What phones show in their header: the models, the current one and character, and whether a reply is running. */
function syncPhone() {
  phoneState({
    models: models.map((m) => ({ key: m.key, name: m.name, role: m.role })),
    model: current?.key ?? null,
    character: activeCharacter()?.name ?? null,
    characterId: activeCharacter()?.id ?? null,
    busy: !!busy,
    chatId: chat.id,
    // The phone speaks replies with the PC's voice (the character's, if one is on), and offers Live when a Live model is installed.
    voice: activeCharacter()?.voice || settings.voice || DEFAULT_VOICE,
    live: liveModels().length > 0,
    liveModel: phoneLive?.name ?? null,
  });
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

/** The selected model's context: Ollama's from the GPU plan (sized to its card), a llama.cpp model's from its preset. */
function ctxLabel() {
  const a = current?.backend === "llama" ? (current.args ?? []) : null;
  const n = a ? Number(a[a.indexOf("--ctx-size") + 1]) || 32768 : ollamaCtx();
  return `${Math.round(n / 1024)}k context`;
}
onPlanChange(() => refreshMemoryStatus());

async function refreshMemoryStatus() {
  const el = $("#memory-status");
  const cfg = memCfg();
  if (!cfg) {
    el.textContent = "Shared memory off · connect Open WebUI";
    return;
  }
  try {
    memoryTotal = (await listMemories(cfg)).length;
    el.textContent = `Shared memory on · ${facts(memoryTotal)} · ${ctxLabel()}`;
  } catch (e) {
    el.textContent = `Shared memory unavailable · ${errMsg(e)}`;
  }
}

// ---------- rendering ----------
function md(text: string) {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string);
}

// Building a page, only web search stays on (for real data in a chart, say): with file, command or image tools the models
// try to "edit" a page file that doesn't exist, or make pictures for it.
const CANVAS_TOOLS = new Set(["web"]);

/** An older reply with its page swapped for a note (a newer version comes later in the chat). */
function withoutPage(text: string) {
  const c = findCanvas(text);
  return c ? `${text.slice(0, c.start)}\n(An earlier version of the page "${c.title}" was here; the newest version is further down.)\n${text.slice(c.end)}` : text;
}

/** A reply's text, with the page it wrote for the Canvas shown as a card that opens it (the code is in the canvas).
 *  `live`: the reply is still streaming, so an unclosed page is being written rather than cut off. */
function renderBody(body: HTMLElement, text: string, live = false) {
  const c = findCanvas(text);
  if (!c) {
    body.innerHTML = md(text);
    return null;
  }
  body.innerHTML = md(`${text.slice(0, c.start)}\n\n<div class="canvas-card"></div>\n\n${text.slice(c.end)}`);
  const card = $(".canvas-card", body);
  card.innerHTML = `<span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 8h18M9 13l-2 2 2 2M15 13l2 2-2 2" /></svg></span><span class="t"><b></b><small></small></span><button type="button" class="btn"></button>`;
  $("b", card).textContent = c.title;
  const lines = c.html.split("\n").length;
  $("small", card).textContent = c.done
    ? `${lines} lines of HTML · runs in the Canvas`
    : live ? `Writing… ${lines} lines` : `Unfinished: the reply stopped after ${lines} lines`;
  const btn = $("button", card) as HTMLButtonElement;
  btn.textContent = c.done ? "Open in Canvas" : live ? "Writing…" : "Open anyway";
  btn.disabled = !c.done && live;
  btn.addEventListener("click", () => openCanvas(c));
  return c;
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
      img.alt = "attached picture";
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

/** Images or a video made from chat: each picture (click to open it in the lightbox) and the prompt. */
function renderFigure(bubble: HTMLElement, r: NonNullable<StoredMessage["render"]>) {
  let body = $(".msg-body", bubble);
  // A render a model made with a tool sits above its reply, which is shown as usual.
  if (r.reply) {
    let box = $(".msg-figure", bubble);
    if (!box) {
      box = document.createElement("div");
      box.className = "msg-figure";
      bubble.insertBefore(box, body);
    }
    body = box;
  }
  body.innerHTML = `<div class="chat-renders"></div><p class="render-caption"></p>`;
  const paths = [r.path, ...(r.more ?? [])];
  $(".chat-renders", body).classList.toggle("multi", paths.length > 1);
  for (const path of paths) {
    const fig = document.createElement("figure");
    fig.className = "chat-render";
    fig.dataset.path = path;
    if (r.kind === "model") {
      // A 3D model: a card that opens it in the Canvas's 3D viewer; right-click for the rest.
      fig.classList.add("model");
      fig.innerHTML = `<button type="button" class="model-card"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 2l9 5v10l-9 5-9-5V7z" /><path d="M3 7l9 5 9-5M12 12v10" /></svg><span><b></b><small>Open in the 3D viewer</small></span></button>`;
      $("b", fig).textContent = path.split(/[\\/]/).pop() ?? "3D model";
      $(".model-card", fig).addEventListener("click", () => openModel(path, path.split(/[\\/]/).pop() ?? "3D model"));
    } else if (r.kind === "audio") {
      // A song: its title and a player; right-click for the rest (save, copy, open in folder…).
      fig.classList.add("song");
      fig.innerHTML = `<span class="song-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></svg><b></b></span><audio controls preload="metadata"></audio>`;
      $("b", fig).textContent = r.title || "Song";
      const au = $("audio", fig) as HTMLAudioElement;
      if (inTauri) allowRenders().then(() => (au.src = convertFileSrc(path)));
      au.addEventListener("error", () => fig.classList.add("missing"), { once: true });
    } else if (r.kind === "video") {
      // Plays inline; right-click for the rest.
      fig.innerHTML = `<video controls loop playsinline preload="metadata"></video>`;
      const v = $("video", fig) as HTMLVideoElement;
      if (inTauri) allowRenders().then(() => (v.src = convertFileSrc(path)));
      v.addEventListener("error", () => fig.classList.add("missing"), { once: true });
      v.addEventListener("loadedmetadata", () => scrollDown());
    } else {
      fig.innerHTML = `<button type="button" class="pic" title="Open it (right-click for more: copy, save, edit, delete…)"><img alt="" /></button>`;
      const img = $("img", fig) as HTMLImageElement;
      img.alt = r.prompt;
      if (inTauri) allowRenders().then(() => (img.src = convertFileSrc(path)));
      img.addEventListener("error", () => fig.classList.add("missing"), { once: true });
      img.addEventListener("load", () => scrollDown());
      $(".pic", fig).addEventListener("click", () => openRender(path));
    }
    fig.addEventListener("contextmenu", (e) => renderMenu(e, path));
    $(".chat-renders", body).appendChild(fig);
  }
  $(".render-caption", body).textContent = `${r.prompt}${r.seconds ? ` · ${r.seconds} s` : ""}`;
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
      b = addAiBubble(msg.model ?? "Assistant", msg.error || (msg.render && !msg.render.reply) ? undefined : () => msg.content);
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
      if (!msg.render || msg.render.reply) renderBody($(".msg-body", b), msg.content);
      if (msg.sources?.length) renderSources(b, msg.sources, msg.content);
      if (msg.note?.startsWith("deep research")) foldSteps(b);
      $(".msg-stat", b).textContent = statText(msg.stats);
      if (!msg.error) reactButton(b, msg);
    }
    showReaction(b, msg.react);
    b.dataset.i = String(i);
  });
  renderChatFiles();
  const empty = chat.messages.length === 0;
  $("#hello").hidden = !empty;
  $("#suggests").hidden = !empty;
  scrollDown(true);
}

/** The smiley beside a reply: react to it with an emote (Prestige hears about it in its next turn). */
function reactButton(bubble: HTMLElement, msg: StoredMessage) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "msg-react";
  b.title = "React";
  b.setAttribute("aria-label", "React to this reply");
  b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" /></svg>`;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    pickReaction(b, msg.react, (emoji) => {
      msg.react = emoji;
      showReaction(bubble, emoji, true);
      persist().catch(() => {});
    });
  });
  const meta = $(".msg-meta", bubble);
  meta.insertBefore(b, $(".msg-speak", meta));
}

// ---------- Knowledge in chat ----------
/** Under a reply: the passages it was given, as file · page chips (the ones it cited first), and its [file, p. N]
 *  citations turned into buttons that open the file. */
function renderSources(bubble: HTMLElement, sources: Source[], text: string) {
  bubble.querySelector(".sources")?.remove();
  const body = $(".msg-body", bubble);
  const labels = new Map(sources.map((s) => [citeLabel(s).toLowerCase(), s]));
  // In-text citations: text nodes only, so code blocks and links stay as they are.
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const n of nodes) {
    if (n.parentElement?.closest("pre, code, a, button") || !/\[[^\[\]]+\]/.test(n.data)) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of n.data.matchAll(/\[([^\[\]]{2,200})\]/g)) {
      // A citation can name several sources: [a.pdf, p. 2; b.pdf, p. 7].
      const parts = m[1].split(/\s*;\s*/).map((p) => labels.get(p.trim().toLowerCase()));
      if (!parts.every(Boolean)) continue;
      frag.append(n.data.slice(last, m.index));
      parts.forEach((s) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "cite";
        b.textContent = citeLabel(s!);
        b.title = `${s!.text.slice(0, 400)}${s!.text.length > 400 ? "…" : ""}\n\nClick to open the file.`;
        b.addEventListener("click", () => openSource(s!));
        frag.append(b);
      });
      last = m.index! + m[0].length;
    }
    if (!last) continue;
    frag.append(n.data.slice(last));
    n.replaceWith(frag);
  }
  // The chips: one per file and page, cited ones first.
  const seen = new Map<string, { s: Source; cited: boolean }>();
  const said = text.toLowerCase();
  for (const s of sources) {
    const key = citeLabel(s).toLowerCase();
    if (!seen.has(key)) seen.set(key, { s, cited: said.includes(key) });
  }
  const row = document.createElement("div");
  row.className = "sources";
  row.innerHTML = `<span class="eyebrow">Sources</span>`;
  for (const { s, cited } of [...seen.values()].sort((a, b) => Number(b.cited) - Number(a.cited))) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cited ? "cited" : "";
    b.textContent = citeLabel(s);
    b.title = `${cited ? "" : "Given to the model but not cited. "}${s.text.slice(0, 400)}${s.text.length > 400 ? "…" : ""}\n\nClick to open the file.`;
    b.addEventListener("click", () => openSource(s));
    row.appendChild(b);
  }
  body.after(row);
}

/** Above the message box: the files attached to this chat (their passages go with every message). */
function renderChatFiles() {
  const box = $("#chat-files");
  const ids = chat.files ?? [];
  box.hidden = !ids.length;
  box.innerHTML = "";
  for (const id of ids) {
    const d = docById(id);
    const chip = document.createElement("span");
    chip.className = "cf";
    chip.innerHTML = `<span></span><small></small><button type="button" aria-label="Detach from this chat" title="Stop using it in this chat (it stays in Knowledge)">✕</button>`;
    $("span", chip).textContent = d?.name ?? "a removed file";
    $("small", chip).textContent = !d ? "gone" : d.state === "ready" ? (d.pages ? `${d.pages} p.` : "ready") : d.state === "error" ? "error" : "reading…";
    chip.title = d?.error ?? d?.path ?? "";
    $("button", chip).addEventListener("click", () => {
      chat.files = (chat.files ?? []).filter((x) => x !== id);
      if (!chat.files.length) chat.files = undefined;
      renderChatFiles();
      if (chat.messages.length) persist().catch(() => {});
    });
    box.appendChild(chip);
  }
  if (ids.length) {
    const note = document.createElement("span");
    note.className = "cf-note";
    note.textContent = "Ask about them: answers cite the file and page.";
    box.appendChild(note);
  }
  const badge = document.getElementById("kb-count-badge");
  if (badge) badge.textContent = readyDocs().length ? String(readyDocs().length) : "";
}

/** Adds documents to Knowledge and attaches them to this chat. */
function attachDocs(added: KbDoc[]) {
  if (!added.length) return;
  chat.files = [...new Set([...(chat.files ?? []), ...added.map((d) => d.id)])];
  renderChatFiles();
  if (chat.messages.length) persist().catch(() => {});
  toast(`Reading ${added.length === 1 ? added[0].name : `${added.length} files`}. Ask about ${added.length === 1 ? "it" : "them"} any time.`);
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
  phonePush({ type: "saved", chatId: chat.id });
  await renderHistory();
}

/** Opens a saved chat (from Past chats, or a mission's result); false when a reply is still running. */
async function openSavedChat(id: string): Promise<boolean> {
  if (busy) {
    toast("Wait for the reply to finish first.");
    return false;
  }
  chat = await invoke<Chat>("load_chat", { id });
  // Carry on with whoever the chat was with.
  if ((chat.character ?? undefined) !== settings.character && (!chat.character || characterById(chat.character))) choosePersona(chat.character, true);
  renderChat();
  renderHistory();
  return true;
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
      if (!(await openSavedChat(it.id))) return;
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
/** `live`: for a call, where the Live hint says how to talk instead. */
function systemBase(live = false): string {
  const name = settings.userName?.trim();
  const char = activeCharacter();
  if (char) return characterPrompt(char, name, settings.aboutUser, live);
  const hw = [pcInfo.gpu, pcInfo.ramGB ? `${pcInfo.ramGB} GB RAM` : ""].filter(Boolean).join(", ");
  const owner = name ? `${name}'s own PC` : "the user's own PC";
  const lines = [
    `You are Prestige by R.G. Studios, a private AI assistant running entirely on ${owner}${hw ? ` (${hw}, Windows)` : ""}. ` +
      "Nothing you see or say leaves this computer.",
    name ? `The user's name is ${name}.${live ? "" : " Address them by name when it feels natural."}` : "",
    settings.aboutUser?.trim() ? `What the user wants you to know about them: ${settings.aboutUser.trim()}` : "",
    live ? "" : "Be direct and helpful. Use Markdown when it helps.",
  ];
  return lines.filter(Boolean).join("\n");
}

// ---------- tools ----------
/** The tool server's render tools. Prestige runs these itself (toolRender) so the result shows in the reply. */
const RENDER_TOOL = /^(make_image|make_video|edit_image)$/;
const RENDER_HINT =
  "When the user wants a picture or a video, call make_image or make_video (edit_image changes a picture); " +
  "it waits for the render and the result is shown in this chat, so don't paste file paths or links.";

/** Makes the picture or clip a model asked for with a tool, through the render queue, and shows it in the reply (above
 *  its text). Resolves with what the model is told. */
async function toolRender(
  op: string,
  args: any,
  r: { reply: StoredMessage; bubble: HTMLElement; body: HTMLElement; chatId: string; images?: string[]; signal: AbortSignal },
): Promise<string> {
  if (!inTauri) throw new Error("pictures and videos are made in the desktop app");
  const kind: MediaKind = op === "make_video" ? "video" : "image";
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) throw new Error("say what to make in prompt");
  // edit_image changes a picture; make_video with image_path starts from one.
  const src = op === "edit_image" || args.image_path ? await toolSource(String(args.image_path ?? ""), r.images) : undefined;
  if (op === "edit_image" && !src) throw new Error("there's no picture to edit. Ask the user to attach one.");
  const ref = src ? await referenceFromBase64(src) : undefined;
  let last = 0;
  const progress = (pct: number, label: string) => {
    if (!r.reply.content) r.body.innerHTML = `<span class="status-line">${escapeHtml(label)} (${Math.round(pct)}%)</span>`;
    if (Date.now() - last > 2000) {
      last = Date.now();
      phonePush({ type: "status", chatId: r.chatId, text: `${label} (${Math.round(pct)}%)` });
    }
  };
  const stop = () => cancelRender();
  r.signal.addEventListener("abort", stop, { once: true });
  const t0 = Date.now();
  try {
    const got = op === "edit_image" && ref ? await editMedia(prompt, ref, progress) : await renderMedia(kind, prompt, progress, ref);
    const paths = got.map((x) => x.path);
    const prev = r.reply.render;
    // A second render of the same kind in one reply joins the first.
    r.reply.render =
      prev && prev.kind === kind
        ? { ...prev, more: [...(prev.more ?? []), ...paths] }
        : { path: paths[0], prompt, seconds: Math.round((Date.now() - t0) / 1000), kind, reply: true, ...(paths.length > 1 ? { more: paths.slice(1) } : {}) };
    renderFigure(r.bubble, r.reply.render);
    if (!r.reply.content) r.body.innerHTML = "";
    scrollDown();
    const names = got.map((x) => x.name).join(", ");
    return `Done. The ${kind === "video" ? "video" : got.length > 1 ? `${got.length} pictures` : "picture"} (${names}) is already shown to the user in this chat. Don't repeat file paths or links; say a sentence or two about it.`;
  } finally {
    r.signal.removeEventListener("abort", stop);
    if (ref) URL.revokeObjectURL(ref.url);
  }
}

/** The picture a render tool starts from: the path the model gave (a render), else the user's attached picture, else
 *  the last picture made in this chat. */
async function toolSource(path: string, images?: string[]): Promise<string | undefined> {
  const load = async (p: string) => {
    await allowRenders();
    return imageToBase64(await (await fetch(convertFileSrc(p))).blob());
  };
  if (path && /\.(png|jpe?g|webp)$/i.test(path)) {
    try {
      return await load(path);
    } catch {
      /* not a render Prestige can open: fall back below */
    }
  }
  if (images?.length) return images[0];
  const lastPic = [...chat.messages].reverse().find((m) => m.render && (m.render.kind ?? "image") === "image");
  if (lastPic?.render) return load(lastPic.render.path).catch(() => undefined);
  return undefined;
}

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

// ---------- attachments (webcam frames and pictures for the next message) ----------
// A question about them goes to a model that can see; with /image or /video the first one is a reference image.
let attachments: string[] = [];

function renderAttachments() {
  const box = $("#attachments");
  box.hidden = !attachments.length;
  box.innerHTML = "";
  attachments.forEach((b64, i) => {
    const d = document.createElement("div");
    d.className = "att";
    d.innerHTML = `<img alt="attached picture" /><button type="button" aria-label="Remove">✕</button>`;
    ($("img", d) as HTMLImageElement).src = `data:image/jpeg;base64,${b64}`;
    $("button", d).addEventListener("click", () => {
      attachments.splice(i, 1);
      renderAttachments();
    });
    box.appendChild(d);
  });
  if (attachments.length) {
    const note = document.createElement("p");
    note.className = "ref-note";
    note.id = "ref-note";
    box.appendChild(note);
  }
  updateRefNote();
}

/** Under the attachments: what /image or /video will do with them and, when it's a reference, the same choices as
 *  Studio's reference slot (Auto / Character / Item, and a video's first frame) and the consent note. */
function updateRefNote() {
  const note = document.getElementById("ref-note");
  if (!note) return;
  const media = mediaRequest(($("#prompt") as HTMLTextAreaElement).value.trim());
  note.classList.toggle("on", !!media);
  if (!media) {
    note.textContent = "Ask about it, /edit and what to change (\"/edit make it night\"), or /image or /video and a scene to put its character or item in a new picture or clip.";
    return;
  }
  note.innerHTML = `<span class="ref-picks">${refChoicesHtml(media.kind === "video")}</span><span class="ref-note-text"></span>`;
  $(".ref-note-text", note).textContent = `${attachments.length > 1 ? "The first picture" : "This picture"} is the reference. ${CONSENT}`;
}

/** Adds a picked, pasted or dropped picture to the next message. */
async function attachImage(f: Blob) {
  try {
    attachments.push(await imageToBase64(f));
    renderAttachments();
    $("#prompt").focus();
  } catch (e) {
    toast(errMsg(e), "warn");
  }
}

const VISION = /gemma|qwen3\.6|llava|vision|-vl/i;

export interface ReplyHooks {
  onDelta?: (t: string) => void;
  onDone?: (ok: boolean) => void;
}

// ---------- Live mode ----------
const LIVE_HINT =
  "You are in a live voice call. Everything you write is spoken aloud the moment you write it, so talk the way a person " +
  "does on a call: short, natural replies (usually one to three sentences, starting with a short one), no Markdown, " +
  "lists, headings, code or emoji, and don't greet the user or say their name in every reply. " +
  "Ask a short question back when it keeps the conversation going. When a camera frame is attached to a message, it is " +
  "what the user's webcam sees right now; use it when it's relevant, and don't describe it unprompted. Without a frame " +
  "the camera is off: if they ask what you see, tell them to turn it on with the Camera button.";

/** The Live models that are installed, best first (the call picks the one that fits beside the voice). */
const liveModels = () =>
  LIVE_MODELS.map((x) => models.find((m) => m.backend === "ollama" && m.id === x.id)).filter((m): m is ModelInfo => !!m);
// Shared memory is looked up once when a call starts, not on every turn, to keep replies quick.
let liveMemory: Promise<string> = Promise.resolve("");

function beginLiveChat() {
  if (chat.messages.length) chat = newChat();
  const when = new Date().toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const c = activeCharacter();
  chat.title = `Live call${c ? ` with ${c.name}` : ""} · ${when}`;
  renderChat();
  renderHistory();
  const cfg = memCfg();
  liveMemory = cfg ? memoryContext(cfg, "").then((m) => m.text).catch(() => "") : Promise.resolve("");
}

/** Takes the last turn back out of the chat (a reply cut off before it said anything) and returns what the user said. */
function retractLiveTurn(): string | null {
  const n = chat.messages.length;
  if (n < 2 || chat.messages[n - 2].role !== "user" || chat.messages[n - 1].role !== "assistant") return null;
  const said = chat.messages[n - 2].content;
  chat.messages.splice(n - 2, 2);
  renderChat();
  persist().catch(() => {});
  return said;
}

// ---------- images and videos from chat ----------
// "/image a lighthouse at dusk" (or /imagine, /img), or a plain ask like "draw me…" / "make an image of…".
// "/video waves on rocks at dawn" (or /clip), or "make a video of…".
const IMAGE_CMD = /^\/(?:image|imagine|img)\b\s*/i;
const EDIT_CMD = /^\/edit\b\s*/i;
// "/3d" (or /model): a textured 3D model of the attached picture, or of the last one made in the chat.
const MODEL_CMD = /^\/(?:3d|model)\b\s*/i;
// "/talk Hello there!": the attached picture (or the character being talked to, or the last picture made in the chat)
// says that line in the character's voice, as a lip-synced video.
const TALK_CMD = /^\/(?:talk|say)\b\s*/i;
const VIDEO_CMD = /^\/(?:video|clip)\b\s*/i;
// "Can you make…", "I'd like…", "give me…", "show me…" a picture (or clip) "of…" / "showing…".
const ASK_LEAD = String.raw`^(?:(?:hey|ok|okay)[,!]?\s+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?`;
const ASK_VERB = String.raw`(?:(?:make|generate|create|render|produce)\s+(?:me\s+)?|(?:i(?:'d|\s+would)?\s+(?:like|want|need)|give\s+me|show\s+me|send\s+me|can\s+i\s+(?:get|have|see))\s+)(?:an?\s+|another\s+|some\s+)?`;
const VIDEO_ASK = new RegExp(String.raw`${ASK_LEAD}${ASK_VERB}(?:video|clip|animation)s?\s+(?:of|showing)\s+`, "i");
const IMAGE_ASK = new RegExp(
  String.raw`${ASK_LEAD}(?:(?:draw|paint|sketch)\s+me\s+|(?:(?:draw|paint|sketch)\s+(?:me\s+)?(?:an?\s+)?|${ASK_VERB})(?:image|picture|pic|photo|illustration|drawing|painting|wallpaper|portrait)s?\s+(?:of|showing)\s+)`,
  "i",
);

// "/song a sea shanty about debugging" (or /music), or "write me a song about…" / "make a lo-fi track for…".
const SONG_ASK = new RegExp(
  String.raw`${ASK_LEAD}(?:(?:write|make|compose|generate|create|produce|sing)\s+(?:me\s+|us\s+)?|(?:i(?:'d|\s+would)?\s+(?:like|want|need)|give\s+me|can\s+i\s+(?:get|have|hear))\s+)(?:an?\s+|another\s+)?(?:[\w'-]+\s+){0,3}?(?:song|tune|track|jingle|anthem|ballad|lullaby)(?=\s+(?:about|for|of|called|named|that|where|with|in)\b|\s*[,.!?:]|\s*$)`,
  "i",
);

/** What a song request asks for ("" for a bare /song), or null when it isn't one. A plain ask keeps its wording. */
function songRequest(text: string): string | null {
  if (SONG_CMD.test(text)) return text.replace(SONG_CMD, "").trim();
  return SONG_ASK.test(text) ? text.trim() : null;
}

/** The prompt in an image or video request ("" for a bare /image or /video), or null when it isn't one. */
function mediaRequest(text: string): { kind: MediaKind; prompt: string } | null {
  const v = text.match(VIDEO_CMD) ?? text.match(VIDEO_ASK);
  const m = v ?? text.match(IMAGE_CMD) ?? text.match(IMAGE_ASK);
  return m ? { kind: v ? "video" : "image", prompt: text.slice(m[0].length).trim().replace(/[.?!]+$/, "") } : null;
}

function setBusyUi(on: boolean) {
  document.body.classList.toggle("busy", on);
  $("#thinking").hidden = !on;
  $("#stop").hidden = !on;
  ($("#send") as HTMLButtonElement).disabled = on;
}

/** Makes images with the Studio's image model (Qwen-Image-2.1 or its turbo), or a video with LTX, and shows them in the chat. */
async function makeMedia(text: string, kind: MediaKind, prompt: string, hooks?: ReplyHooks, refB64?: string, refKind?: RefKind, edit = false) {
  const what = kind === "video" ? "video" : "image";
  if (!inTauri) {
    toast(`${kind === "video" ? "Videos" : "Images"} are made in the desktop app.`);
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = text.replace(/\s+/g, " ").slice(0, 60);
  chat.messages.push({ role: "user", content: text, images: refB64 ? [refB64] : undefined });
  renderChat();
  const label = edit ? editLabel() : await modelLabel(kind, !!refB64);
  const reply: StoredMessage = { role: "assistant", content: "", model: label };
  const bubble = addAiBubble(label);
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart(label, text);
  let lastStatus = 0;
  body.innerHTML = `<div class="render-progress"><div class="progress"><i></i></div><span class="status-line">Starting…</span></div>`;
  scrollDown(true);
  busy = new AbortController();
  busy.signal.addEventListener("abort", () => cancelRender(), { once: true });
  setBusyUi(true);
  const t0 = Date.now();
  try {
    const ref = refB64 ? await referenceFromBase64(refB64) : undefined;
    const progress = (pct: number, label: string) => {
      ($(".progress", body) as HTMLElement | null)?.style.setProperty("--v", String(pct));
      const l = $(".status-line", body);
      if (l) l.textContent = label;
      // Phones see the render's progress too (at most every 2 s).
      if (Date.now() - lastStatus > 2000) {
        lastStatus = Date.now();
        phonePush({ type: "status", chatId: replyChat, text: `${label} (${Math.round(pct)}%)` });
      }
    };
    // /edit changes the picture itself; otherwise it's a new picture (with the reference's subject in it, if any).
    const got = edit && ref ? await editMedia(prompt, ref, progress) : await renderMedia(kind, prompt, progress, ref, refKind);
    if (ref) URL.revokeObjectURL(ref.url);
    const [a, ...more] = got;
    reply.render = { path: a.path, prompt, seconds: Math.round((Date.now() - t0) / 1000), kind, ...(more.length ? { more: more.map((x) => x.path) } : {}) };
    // What chat models see in later turns.
    const names = got.map((x) => x.name).join(", ");
    reply.content = edit
      ? `(I edited the picture with ${label}: "${prompt}". Saved as ${names}.)`
      : `(I made ${got.length > 1 ? `${got.length} images` : `a ${what}`} with ${label}${refB64 ? " from the attached reference picture" : ""} for: "${prompt}". Saved as ${names}.)`;
    renderFigure(bubble, reply.render);
  } catch (e) {
    if (busy?.signal.aborted) reply.content = "*(stopped)*";
    else {
      reply.error = true;
      reply.content = `Couldn't make the ${what}: ${errMsg(e)}`;
      bubble.classList.add("error");
    }
    body.innerHTML = md(reply.content);
  } finally {
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    busy = null;
    setBusyUi(false);
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    if (hooks) {
      hooks.onDelta?.(reply.render ? `Here's your ${what}.` : `I couldn't make that ${what}.`);
      hooks.onDone?.(!!reply.render);
    }
  }
}

/** /3d: Pixal3D turns the picture into a textured .glb (about 5 minutes), shown in the Canvas's 3D viewer and saved with
 *  the renders. */
async function make3d(text: string, srcB64: string, hooks?: ReplyHooks) {
  if (!inTauri) {
    toast("3D models are made in the desktop app.");
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = text.replace(/\s+/g, " ").slice(0, 60) || "3D model";
  chat.messages.push({ role: "user", content: text, images: [srcB64] });
  renderChat();
  const reply: StoredMessage = { role: "assistant", content: "", model: "Pixal3D" };
  const bubble = addAiBubble("Pixal3D");
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart("Pixal3D", text);
  body.innerHTML = `<div class="render-progress"><div class="progress"><i></i></div><span class="status-line">Starting…</span></div>`;
  scrollDown(true);
  busy = new AbortController();
  busy.signal.addEventListener("abort", () => cancelRender(), { once: true });
  setBusyUi(true);
  const t0 = Date.now();
  try {
    const ref = await referenceFromBase64(srcB64);
    const got = await renderModel(ref, (pct, label) => {
      ($(".progress", body) as HTMLElement | null)?.style.setProperty("--v", String(pct));
      const l = $(".status-line", body);
      if (l) l.textContent = label;
    });
    URL.revokeObjectURL(ref.url);
    const a = got[0];
    reply.render = { path: a.path, prompt: "3D model of the picture", seconds: Math.round((Date.now() - t0) / 1000), kind: "model" };
    reply.content = `(I made a textured 3D model of the picture with Pixal3D. Saved as ${a.name}.)`;
    renderFigure(bubble, reply.render);
    openModel(a.path, a.name);
  } catch (e) {
    if (busy?.signal.aborted) reply.content = "*(stopped)*";
    else {
      reply.error = true;
      reply.content = `Couldn't make the 3D model: ${errMsg(e)}`;
      bubble.classList.add("error");
    }
    body.innerHTML = md(reply.content);
  } finally {
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    busy = null;
    setBusyUi(false);
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    hooks?.onDone?.(!!reply.render);
  }
}

/** /talk: the line is spoken in the voice (Kokoro or VoxCPM2), then InfiniteTalk lip-syncs the picture to it (about
 *  4 minutes per 3 seconds of speech). The video is shown in the chat and saved with the renders. */
async function makeTalk(text: string, line: string, srcB64: string, voice: string, hooks?: ReplyHooks) {
  if (!inTauri) {
    toast("Talking videos are made in the desktop app.");
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = text.replace(/\s+/g, " ").slice(0, 60) || "Talking video";
  chat.messages.push({ role: "user", content: text, images: [srcB64] });
  renderChat();
  const reply: StoredMessage = { role: "assistant", content: "", model: "InfiniteTalk" };
  const bubble = addAiBubble("InfiniteTalk");
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart("InfiniteTalk", text);
  body.innerHTML = `<div class="render-progress"><div class="progress"><i></i></div><span class="status-line">Speaking the line…</span></div>`;
  scrollDown(true);
  busy = new AbortController();
  busy.signal.addEventListener("abort", () => cancelRender(), { once: true });
  setBusyUi(true);
  const t0 = Date.now();
  try {
    const speech = await speakLine(line, voice);
    if (busy.signal.aborted) throw new Error("stopped");
    const ref = await referenceFromBase64(srcB64);
    const got = await renderTalk(
      ref,
      speech.audio,
      speech.seconds,
      "",
      (pct, label) => {
        ($(".progress", body) as HTMLElement | null)?.style.setProperty("--v", String(pct));
        const l = $(".status-line", body);
        if (l) l.textContent = label;
      },
      "chat",
      speech.title,
    );
    URL.revokeObjectURL(ref.url);
    const a = got[0];
    reply.render = { path: a.path, prompt: line, seconds: Math.round((Date.now() - t0) / 1000), kind: "video", reply: true };
    reply.content = `(A talking video of the picture saying: "${line}". Saved as ${a.name}.)`;
    renderFigure(bubble, reply.render);
  } catch (e) {
    if (busy?.signal.aborted) reply.content = "*(stopped)*";
    else {
      reply.error = true;
      reply.content = `Couldn't make the talking video: ${errMsg(e)}`;
      bubble.classList.add("error");
    }
    body.innerHTML = md(reply.content);
  } finally {
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    busy = null;
    setBusyUi(false);
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    hooks?.onDone?.(!!reply.render);
  }
}

/** "Make it talk…" on a picture (a render's path, or a character's face): asks what to say and in which voice, then
 *  queues InfiniteTalk. The video opens when it's done; the render queue shows how far it is. */
async function talkFromPicture(shown: string, pic: string | Reference, voice?: string) {
  if (!inTauri) return toast("Talking videos are made in the desktop app.");
  let speech;
  try {
    await allowRenders();
    speech = await askSpeech(shown, voice || settings.voice, toast);
  } catch (e) {
    return toast(`Couldn't make the speech: ${errMsg(e)}`, "warn");
  }
  if (!speech) return;
  toast(`Making it talk: about ${Math.max(1, Math.round(talkSecs(speech.seconds) / 60))} min. It opens when it's done (the render queue in Studio shows how far it is).`);
  renderTalk(pic, speech.audio, speech.seconds, speech.prompt, () => {}, "Make it talk", speech.title)
    .then((got) => got[0] && openRender(got[0].path))
    .catch((e) => errMsg(e) !== "stopped" && toast(`Couldn't make the talking video: ${errMsg(e)}`, "warn"));
}

/** Lyrics as Markdown: each sung line on its own line, the [Verse] / [Chorus] tags in italics. */
const lyricsMd = (lyrics: string) =>
  lyrics
    .split("\n")
    .map((l) => l.trim())
    .map((l) => (/^\[.+\]$/.test(l) ? `*${l}*` : l.replace(/([*_`])/g, "\\$1")))
    .join("  \n")
    .replace(/(  \n){2,}/g, "\n\n");

/** /song: the chat model writes the song (title, style, tempo, key, lyrics; songwriter.ts), then ACE-Step sings it. The
 *  song plays in the chat with its lyrics under it, and is saved with the other renders. */
async function makeSong(text: string, request: string, hooks?: ReplyHooks) {
  if (!inTauri) {
    toast("Songs are made in the desktop app.");
    return hooks?.onDone?.(false);
  }
  const model = current;
  if (!model) {
    toast("No model is available to write the song. Start the services first.", "warn");
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = text.replace(/\s+/g, " ").slice(0, 60);
  // The conversation so far, so "a song about that" knows what "that" is.
  const before = chat.messages.filter((m) => !m.error && !m.render).slice(-6);
  chat.messages.push({ role: "user", content: text });
  renderChat();
  const label = await modelLabel("audio");
  const reply: StoredMessage = { role: "assistant", content: "", model: label };
  const bubble = addAiBubble(label, () => reply.content);
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart(label, text);
  let lastStatus = 0;
  body.innerHTML = `<div class="render-progress"><div class="progress"><i></i></div><span class="status-line">Starting…</span></div>`;
  const progress = (pct: number, label: string) => {
    ($(".progress", body) as HTMLElement | null)?.style.setProperty("--v", String(pct));
    const l = $(".status-line", body);
    if (l) l.textContent = label;
    if (Date.now() - lastStatus > 2000) {
      lastStatus = Date.now();
      phonePush({ type: "status", chatId: replyChat, text: `${label} (${Math.round(pct)}%)` });
    }
  };
  scrollDown(true);
  busy = new AbortController();
  busy.signal.addEventListener("abort", () => cancelRender(), { once: true });
  setBusyUi(true);
  const t0 = Date.now();
  try {
    const context = before.length ? `Conversation so far:\n${before.map((m) => `${m.role}: ${m.content.slice(0, 800)}`).join("\n")}\n\nWrite this song: ` : "";
    progress(1, `${model.name} is writing the song…`);
    const song = await writeSong(model, context + request, songSeconds(), busy.signal, (n) => progress(1, `${model.name} is writing the song… ${n} characters`));
    // The lyrics show while ACE-Step sings them.
    reply.content = `**${song.title}**\n\n${song.lyrics ? lyricsMd(song.lyrics) : "*Instrumental*"}`;
    const lyr = document.createElement("div");
    lyr.className = "song-draft";
    renderBody(lyr, reply.content);
    body.appendChild(lyr);
    scrollDown();
    const got = await renderSong(song.style, song.lyrics, progress, { bpm: song.bpm, key: song.key, language: song.language });
    reply.render = { path: got[0].path, prompt: song.style, seconds: Math.round((Date.now() - t0) / 1000), kind: "audio", reply: true, title: song.title };
    renderFigure(bubble, reply.render);
    renderBody(body, reply.content);
    const au = bubble.querySelector<HTMLAudioElement>(".chat-render audio");
    au?.addEventListener("loadedmetadata", () => scrollDown(), { once: true });
  } catch (e) {
    if (busy?.signal.aborted) reply.content = reply.content ? `${reply.content}\n\n*(stopped)*` : "*(stopped)*";
    else {
      reply.error = true;
      reply.content = `Couldn't make the song: ${errMsg(e)}`;
      bubble.classList.add("error");
    }
    body.innerHTML = md(reply.content);
  } finally {
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    busy = null;
    setBusyUi(false);
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    if (hooks) {
      hooks.onDelta?.(reply.render ? "Here's your song." : "I couldn't make that song.");
      hooks.onDone?.(!!reply.render);
    }
  }
}

/** The Director: one prompt becomes a short music video (director.ts). The chat model plans the song and the shots,
 *  ACE-Step makes the song, LTX-2.5 renders each shot (one model at a time, through the render queue), Whisper times the
 *  lyrics for subtitles, and ffmpeg joins it all. Each step shows in the reply as it happens. */
async function makeDirector(text: string, idea: string, hooks?: ReplyHooks) {
  if (!inTauri) {
    toast("Music videos are made in the desktop app.");
    return hooks?.onDone?.(false);
  }
  const model = current;
  if (!model) {
    toast("No model is available to plan the video. Start the services first.", "warn");
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = text.replace(/\s+/g, " ").slice(0, 60);
  chat.messages.push({ role: "user", content: text });
  renderChat();
  const reply: StoredMessage = { role: "assistant", content: "", model: "Director" };
  const bubble = addAiBubble("Director", () => reply.content);
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart("Director", text);
  body.innerHTML = `<div class="director"><div class="director-plan"></div><div class="render-progress"><div class="progress"><i></i></div><span class="status-line">Starting…</span></div></div>`;
  const planEl = $(".director-plan", body);
  let lastStatus = 0;
  const status = (pct: number, label: string) => {
    ($(".progress", body) as HTMLElement | null)?.style.setProperty("--v", String(pct));
    const l = $(".status-line", body);
    if (l) l.textContent = label;
    if (Date.now() - lastStatus > 2000) {
      lastStatus = Date.now();
      phonePush({ type: "status", chatId: replyChat, text: `${label} (${Math.round(pct)}%)` });
    }
  };
  scrollDown(true);
  busy = new AbortController();
  busy.signal.addEventListener("abort", () => (cancelRender(), cancelRender("Director")), { once: true });
  setBusyUi(true);
  const t0 = Date.now();
  const seconds = askedSeconds(idea);
  const quality = /\b(draft|quick|fast)\b/i.test(idea) ? "draft" : videoQuality();
  const subtitles = !/\b(no|without)\s+(subtitles|captions|lyrics on screen)\b/i.test(idea);
  try {
    status(1, `${model.name} is planning the song and the shots…`);
    const plan = await planVideo(model, idea, seconds, busy.signal, (n) => status(1, `${model.name} is planning the song and the shots… ${n} characters`));
    const n = plan.shots.length;
    // The time it'll take (measured; see director.ts), and each part's share of the progress bar.
    const total = directorSecs(seconds, quality === "draft");
    // The plan shows straight away: the title and style, then each shot with its state.
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    planEl.innerHTML =
      `<p class="director-title">🎬 <b>${esc(plan.title)}</b> · ${seconds} s · ${n} shots · about ${Math.max(1, Math.round(total / 60))} min${quality === "draft" ? " (draft)" : ""}</p>` +
      `<p class="credit">${esc(plan.style)}</p>` +
      `<ol class="director-steps"><li data-s="song">The song (ACE-Step)</li>${plan.shots.map((sh, i) => `<li data-s="${i}" title="${esc(sh.prompt)}">Shot ${i + 1}: ${esc(sh.action)}</li>`).join("")}${subtitles && plan.lyrics ? `<li data-s="subs">Lyrics as subtitles (Whisper)</li>` : ""}<li data-s="join">Joining it all (ffmpeg)</li></ol>`;
    const step = (k: string, state: "on" | "done") => planEl.querySelector(`[data-s="${k}"]`)?.setAttribute("class", state);
    scrollDown();
    const span = (from: number, to: number) => (pct: number, label: string) => status(from + ((to - from) * pct) / 100, label);
    // The song first: its length is the video's.
    step("song", "on");
    const songT = SONG_SECS / total;
    const song = (await renderSong(plan.style, plan.lyrics, span(2, 2 + 90 * songT), { seconds, bpm: plan.bpm, key: plan.key, language: plan.language }))[0];
    step("song", "done");
    // Then each shot, one at a time.
    const shots: string[] = [];
    const shotT = (90 * (1 - songT)) / n;
    for (let i = 0; i < n; i++) {
      if (busy.signal.aborted) throw new Error("stopped");
      step(String(i), "on");
      const from = 2 + 90 * songT + shotT * i;
      const got = await renderShot(plan.shots[i].prompt, SHOT_SECONDS, span(from, from + shotT), {
        title: `${plan.title}: shot ${i + 1} of ${n}`,
        note: `Shot ${i + 1} of ${n} · `,
        quality,
      });
      shots.push(got[0].path);
      step(String(i), "done");
    }
    // The lyrics, timed by Whisper (optional: the video is still made without them).
    let srt = "";
    if (subtitles && plan.lyrics) {
      step("subs", "on");
      status(93, "Timing the lyrics (Whisper)…");
      try {
        await allowRenders();
        srt = await lyricsSrt(await (await fetch(convertFileSrc(song.path))).blob(), plan.lyrics, seconds);
      } catch (e) {
        toast(`The video is made without subtitles: couldn't time the lyrics (${errMsg(e)}).`, "warn");
      }
      step("subs", "done");
    }
    step("join", "on");
    status(97, "Joining the shots, the song and the lyrics…");
    const out = await invoke<string>("director_assemble", {
      root: settings.stackRoot ?? null,
      shots,
      song: song.path,
      seconds,
      width: 768,
      height: 512,
      fps: 24,
      srt: srt || null,
      title: plan.title,
    });
    step("join", "done");
    reply.render = { path: out, prompt: idea, seconds: Math.round((Date.now() - t0) / 1000), kind: "video", reply: true, title: plan.title };
    reply.content =
      `**${plan.title}** · ${seconds} s music video, ${n} shots\n\n*${plan.style}*\n\n` +
      `${plan.look}\n\n` +
      plan.shots.map((sh, i) => `${i + 1}. ${sh.action}`).join("\n") +
      (plan.lyrics ? `\n\n**Lyrics**\n\n${lyricsMd(plan.lyrics)}` : "");
    renderFigure(bubble, reply.render);
    renderBody(body, reply.content);
  } catch (e) {
    if (busy?.signal.aborted) reply.content = "*(stopped)*";
    else {
      reply.error = true;
      reply.content = `Couldn't make the music video: ${errMsg(e)}`;
      bubble.classList.add("error");
    }
    body.innerHTML = md(reply.content);
  } finally {
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    busy = null;
    setBusyUi(false);
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    if (hooks) {
      hooks.onDelta?.(reply.render ? "Here's your music video." : "I couldn't make that music video.");
      hooks.onDone?.(!!reply.render);
    }
  }
}

/** Deep Research: searches, reads pages and writes a cited report with the current model (research.ts). Each search and
 *  page read shows as a step in the reply, with its notes inside. */
async function runResearch(text: string, question: string, hooks?: ReplyHooks) {
  const model = current;
  if (!model) {
    toast("No model is available. Start the services first.", "warn");
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = `Research: ${question.replace(/\s+/g, " ").slice(0, 50)}`;
  chat.model = model.name;
  chat.messages.push({ role: "user", content: text });
  renderChat();
  const reply: StoredMessage = { role: "assistant", content: "", model: model.name, tools: [] };
  const bubble = addAiBubble(model.name, () => reply.content);
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart(model.name, text);
  body.innerHTML = `<span class="status-line">Starting deep research…</span>`;
  scrollDown(true);
  busy = new AbortController();
  setBusyUi(true);
  const t0 = Date.now();
  let thinking = "";
  let pending = false;
  try {
    // The conversation so far, so "research that" or a follow-up knows what "that" is.
    const before = chat.messages.slice(0, -1).filter((m) => !m.error && !m.render).slice(-6);
    const context = before.length ? `Conversation so far:\n${before.map((m) => `${m.role}: ${m.content.slice(0, 1500)}`).join("\n")}` : "";
    const res = await deepResearch(
      question,
      model,
      {
        step: (name, arg) => {
          const step: ToolStep = { name, args: name === "read" ? { url: arg } : name === "plan" ? { goal: arg } : { query: arg } };
          reply.tools!.push(step);
          renderToolStep(bubble, step);
          const t = performance.now();
          return {
            done: (ok, result) => {
              step.ok = ok;
              step.ms = Math.round(performance.now() - t);
              step.result = result && result.length > 2000 ? result.slice(0, 2000) + "…" : result;
              renderToolStep(bubble, step);
            },
          };
        },
        status: (s) => {
          if (!reply.content) body.innerHTML = `<span class="status-line">${escapeHtml(s)}</span>`;
          phonePush({ type: "status", chatId: replyChat, text: s });
        },
        thinking: (t) => {
          thinking += t;
          setThinking(bubble, thinking, !reply.content);
        },
        token: (t) => {
          reply.content += t;
          hooks?.onDelta?.(t);
          phoneDelta(replyChat, t);
          if (!pending) {
            pending = true;
            requestAnimationFrame(() => {
              pending = false;
              if (busy) {
                renderBody(body, reply.content, true);
                scrollDown();
              }
            });
          }
        },
      },
      busy.signal,
      context,
    );
    reply.content = res.report;
    const mins = Math.max(1, Math.round((Date.now() - t0) / 60000));
    reply.note = `deep research · ${res.sources.length} sources used of ${res.pages} pages read · ${mins} min`;
  } catch (e) {
    if (busy?.signal.aborted) reply.content += reply.content ? "\n\n*(stopped)*" : "*(stopped)*";
    else {
      reply.error = true;
      reply.content = `Deep research didn't finish: ${errMsg(e)}`;
      bubble.classList.add("error");
    }
  } finally {
    busy = null;
    setBusyUi(false);
    if (thinking) setThinking(bubble, thinking, false);
    reply.thinking = thinking || undefined;
    renderBody(body, reply.content);
    if (reply.note) {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = reply.note;
      bubble.insertBefore(chip, $(".tool-steps", bubble) ?? body);
    }
    if (!reply.error) foldSteps(bubble);
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    hooks?.onDone?.(!reply.error);
  }
}

/** Transcribe (transcribe.ts): a recording or video in, the words with who said them out, then a summary by the chat
 *  model. The reply is the summary with the full transcript folded under it, so later questions can use both. */
async function runTranscribe(src: MediaSource, hooks?: ReplyHooks) {
  if (!inTauri) {
    toast("Transcribe runs in the desktop app.");
    return hooks?.onDone?.(false);
  }
  if (busy) {
    toast("Wait for the reply to finish first.");
    return hooks?.onDone?.(false);
  }
  const name = "file" in src ? src.file.name : src.name;
  if (chat.messages.length === 0) chat.title = `Transcript: ${name}`.slice(0, 60);
  chat.messages.push({ role: "user", content: `🎧 Transcribe ${name}` });
  renderChat();
  const reply: StoredMessage = { role: "assistant", content: "", model: "Transcribe · Phonon-2" };
  const bubble = addAiBubble(reply.model!, () => reply.content);
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart(reply.model!, name);
  body.innerHTML = `<div class="render-progress"><div class="progress"><i></i></div><span class="status-line">Starting…</span></div>`;
  const progress = (pct: number, what: string) => {
    ($(".progress", body) as HTMLElement | null)?.style.setProperty("--v", String(pct));
    const l = $(".status-line", body);
    if (l) l.textContent = what;
  };
  scrollDown(true);
  busy = new AbortController();
  setBusyUi(true);
  try {
    const t = await transcribeMedia(src, settings.stackRoot ?? null, (pct, what) => progress(pct * 0.8, what));
    if (!t.turns.length) throw new Error("no speech was found in it");
    const facts = [
      clock(t.duration),
      t.speakers ? `${t.speakers} speaker${t.speakers === 1 ? "" : "s"}` : "speakers not told apart",
      `transcribed in ${Math.round(t.seconds.total)} s`,
    ].join(" · ");
    reply.note = `transcript · ${facts}`;
    if (t.engines.speakers_error) toast(`Couldn't tell the speakers apart (${t.engines.speakers_error.slice(0, 120)}); the words are all there.`, "warn");
    const folded = `<details><summary>Transcript · ${facts}</summary>\n\n${transcriptMd(t)}\n\n</details>`;
    let summary = "";
    const model = current;
    const compose = () => (summary ? `${summary.replace(/<think>[\s\S]*?<\/think>/g, "").trim()}\n\n${folded}` : folded);
    if (model) {
      progress(82, `${model.name} is writing a summary…`);
      reply.model = `Transcribe · Phonon-2 · ${model.name}`;
      $(".msg-who", bubble).textContent = reply.model;
      try {
        await streamChat(
          model,
          [
            { role: "system", content: systemBase() },
            { role: "user", content: summaryPrompt(name, t) },
          ],
          {
            onToken: (x) => {
              summary += x;
              renderBody(body, compose(), true);
              scrollDown();
            },
            onThinking: () => {},
            onStats: () => {},
          },
          busy.signal,
          undefined,
          { think: false },
        );
      } catch (e) {
        if (!busy.signal.aborted) toast(`The transcript is here, but the summary failed: ${errMsg(e)}`, "warn");
      }
    }
    reply.content = compose();
  } catch (e) {
    reply.error = true;
    reply.content = `Couldn't transcribe ${name}: ${errMsg(e)}`;
    bubble.classList.add("error");
  } finally {
    busy = null;
    setBusyUi(false);
    renderBody(body, reply.content);
    if (reply.note) {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = reply.note;
      bubble.insertBefore(chip, body);
    }
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    hooks?.onDone?.(!reply.error);
  }
}

/** /transcribe: the file picker, then Transcribe. */
async function pickAndTranscribe(hooks?: ReplyHooks) {
  if (!inTauri) return hooks?.onDone?.(false);
  const path = await invoke<string | null>("pick_media").catch((e) => {
    toast(errMsg(e), "warn");
    return null;
  });
  if (!path) return hooks?.onDone?.(false);
  return runTranscribe({ path, name: path.split(/[\\/]/).pop() ?? path }, hooks);
}

/** /do: a vision model works through the task on this PC (computer.ts). A card first says what will happen and which
 *  model drives; Start shrinks Prestige to the step-by-step panel. Afterwards every step and the model's summary are
 *  posted in this reply. */
async function runComputer(text: string, task: string, hooks?: ReplyHooks) {
  if (!inTauri) {
    toast("Computer use runs in the desktop app.");
    return hooks?.onDone?.(false);
  }
  const canSee = (m: ModelInfo) => !!m.inputModalities?.includes("image") || VISION.test(m.id);
  const list = brains(models, canSee);
  if (!list.length) {
    toast("No model that can see the screen is available. Start the services, or get Qwen3.8 27B or Nex-N2.5-mini from the catalog.", "warn");
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = `Do: ${task.replace(/\s+/g, " ").slice(0, 54)}`;
  chat.messages.push({ role: "user", content: text });
  renderChat();
  const reply: StoredMessage = { role: "assistant", content: "", model: "Computer use", tools: [] };
  const bubble = addAiBubble("Computer use");
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  const pick = list.find((m) => m.key === settings.computerModel) ?? list[0];
  body.innerHTML = `<div class="cu-card">
      <p><b>Do it for me:</b> <span class="cu-card-task"></span></p>
      <p class="credit">The model looks at your screen and uses the mouse and keyboard, one step at a time. Prestige shrinks to a
      panel in the corner where you approve each step (or turn that off) and can stop it any time. It won't type passwords,
      pay for anything or send messages; it stops and tells you instead.</p>
      <label class="field">Model<select class="cu-card-model"></select></label>
      <div class="acts"><button type="button" class="btn" data-a="no">Cancel</button><button type="button" class="btn primary" data-a="yes">Start</button></div>
    </div>`;
  $(".cu-card-task", body).textContent = task;
  const sel = $(".cu-card-model", body) as HTMLSelectElement;
  sel.innerHTML = list.map((m) => `<option value="${escapeHtml(m.key)}"${m.key === pick.key ? " selected" : ""}>${escapeHtml(m.name)}</option>`).join("");
  scrollDown(true);
  busy = new AbortController();
  setBusyUi(true);
  const go = await new Promise<boolean>((resolve) => {
    body.querySelectorAll<HTMLButtonElement>("[data-a]").forEach((b) => b.addEventListener("click", () => resolve(b.dataset.a === "yes"), { once: true }));
    busy!.signal.addEventListener("abort", () => resolve(false), { once: true });
  });
  const model = list.find((m) => m.key === sel.value) ?? pick;
  try {
    if (!go) {
      reply.content = "*(not started)*";
      return;
    }
    if (model.key !== settings.computerModel) {
      settings.computerModel = model.key;
      saveSettings().catch(() => {});
    }
    reply.model = `Computer use · ${model.name}`;
    $(".msg-who", bubble).textContent = reply.model;
    body.innerHTML = `<span class="status-line">Working on it in the panel…</span>`;
    phonePush({ type: "status", chatId: replyChat, text: `Computer use: ${task}` });
    const r = await doItForMe(task, model);
    for (const s of r.steps) {
      const step: ToolStep = {
        name: "computer",
        args: { action: describeAct(s.act) },
        ok: s.state === "done",
        denied: s.state === "skipped",
        ms: s.ms,
        result: [s.thought, s.state === "skipped" ? "(you skipped this step)" : "", s.note ? `Failed: ${s.note}` : ""].filter(Boolean).join("\n"),
      };
      reply.tools!.push(step);
      renderToolStep(bubble, step);
    }
    const head = { done: "Done.", failed: "It stopped before finishing.", stopped: "You stopped it.", limit: "It ran out of steps." }[r.status];
    reply.content = r.status === "done" || r.status === "failed" ? r.summary : `${head} ${r.summary === "Stopped." ? "" : r.summary}`.trim();
    reply.note = `computer use · ${r.steps.length} step${r.steps.length === 1 ? "" : "s"} · ${r.status} · ${r.seconds < 90 ? `${r.seconds} s` : `${Math.round(r.seconds / 60)} min`}`;
    if (r.status === "failed") bubble.classList.add("warn");
  } catch (e) {
    reply.error = true;
    reply.content = `Computer use didn't run: ${errMsg(e)}`;
    bubble.classList.add("error");
  } finally {
    busy = null;
    setBusyUi(false);
    renderBody(body, reply.content);
    if (reply.note) {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = reply.note;
      bubble.insertBefore(chip, $(".tool-steps", bubble) ?? body);
    }
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    scrollDown();
    persist().catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"));
    hooks?.onDone?.(!reply.error);
  }
}

/** A finished research report's steps (often 15 or more) fold into one line, a click away. */
function foldSteps(bubble: HTMLElement) {
  const box = bubble.querySelector<HTMLElement>(".tool-steps");
  if (!box || box.children.length < 3 || box.querySelector(".steps-toggle")) return;
  box.classList.add("folded");
  const n = box.querySelectorAll(".tool-step").length;
  const read = box.querySelectorAll('.tool-step[data-state="ok"]').length;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "steps-toggle linkish";
  b.textContent = `Show the ${n} research steps (${read} useful)`;
  b.addEventListener("click", () => {
    const folded = box.classList.toggle("folded");
    b.textContent = folded ? `Show the ${n} research steps (${read} useful)` : "Hide the research steps";
  });
  box.prepend(b);
}

async function send(text: string, opts: { images?: string[]; vision?: string; hooks?: ReplyHooks; live?: ModelInfo } = {}) {
  text = text.trim();
  if (!text && (opts.images?.length || attachments.length)) text = "What do you see in this picture?";
  if (!text || busy) {
    opts.hooks?.onDone?.(false);
    return;
  }
  const live = !!opts.live;
  // "/edit make it night": changes the attached picture, or the last one made in this chat, by instruction.
  // The attached picture, or else the last one made in this chat (for /edit and /3d).
  const pictureToUse = async () => {
    if (attachments[0]) return attachments[0];
    const last = [...chat.messages].reverse().find((m) => m.render && (m.render.kind ?? "image") === "image");
    if (!last?.render || !inTauri) return undefined;
    try {
      await allowRenders();
      return await imageToBase64(await (await fetch(convertFileSrc(last.render.path))).blob());
    } catch {
      return undefined; // gone from disk: the caller asks for a picture
    }
  };
  // "/talk Hello!": the attached picture, the character's face or the last picture says it, in the character's voice.
  if (!live && !opts.images && TALK_CMD.test(text)) {
    const line = text.replace(TALK_CMD, "").trim();
    const char = activeCharacter();
    const src = attachments[0] ?? char?.face ?? (await pictureToUse());
    if (!line || !src) {
      toast(
        !src
          ? "Attach a picture of a face (or talk to a character with a face, or make a picture in this chat first), then /talk and what they should say."
          : "Say what they should say after /talk, e.g. /talk Hi, I'm so glad you're here!",
      );
      opts.hooks?.onDone?.(false);
      return;
    }
    attachments = [];
    renderAttachments();
    return makeTalk(text, line, src, voiceOf(char) || settings.voice || DEFAULT_VOICE, opts.hooks);
  }
  // "/3d": a textured 3D model of that picture.
  if (!live && !opts.images && MODEL_CMD.test(text)) {
    const src = await pictureToUse();
    if (!src) {
      toast("Attach a picture of an object or a character (or make one in this chat first), then /3d.");
      opts.hooks?.onDone?.(false);
      return;
    }
    attachments = [];
    renderAttachments();
    return make3d(text, src, opts.hooks);
  }
  if (!live && !opts.images && EDIT_CMD.test(text)) {
    const instruction = text.replace(EDIT_CMD, "").trim();
    const src = await pictureToUse();
    if (!instruction || !src) {
      toast(!src ? "Attach a picture to edit (or make one in this chat first), then /edit and what to change." : "Say what to change after /edit, e.g. /edit make it night");
      opts.hooks?.onDone?.(false);
      return;
    }
    attachments = [];
    renderAttachments();
    return makeMedia(text, "image", instruction, opts.hooks, src, undefined, true);
  }
  if (!live && RESEARCH_CMD.test(text)) {
    const question = text.replace(RESEARCH_CMD, "").trim();
    if (!question) {
      toast("Ask a question after /research, e.g. /research which heat pumps work best below -20 °C");
      opts.hooks?.onDone?.(false);
      return;
    }
    return runResearch(text, question, opts.hooks);
  }
  if (!live && TRANSCRIBE_CMD.test(text)) return pickAndTranscribe(opts.hooks);
  // "/do open Notepad and write a haiku": a vision model does it on this PC (asks first; not from Live calls).
  if (!live && DO_CMD.test(text)) {
    const task = text.replace(DO_CMD, "").trim();
    if (!task) {
      toast("Say what to do after /do, e.g. /do open Notepad and type a shopping list");
      opts.hooks?.onDone?.(false);
      return;
    }
    return runComputer(text, task, opts.hooks);
  }
  // "/director a fox in a neon city" or "make me a music video about…": the Director plans, renders and joins it.
  if (!live && !opts.images && !attachments.length && (DIRECTOR_CMD.test(text) || DIRECTOR_ASK.test(text))) {
    const idea = text.replace(DIRECTOR_CMD, "").trim();
    if (!idea) {
      toast("Say what the music video is about after /director, e.g. /director a lonely robot finds a flower, 30 seconds");
      opts.hooks?.onDone?.(false);
      return;
    }
    return makeDirector(text, idea, opts.hooks);
  }
  // "/song …" or "write me a song about…": the chat model writes it and ACE-Step sings it. (Not with pictures attached,
  // unless asked for with /song: those messages are about the pictures.)
  const songAsk = live || (!SONG_CMD.test(text) && (opts.images?.length || attachments.length)) ? null : songRequest(text);
  if (songAsk === "") {
    toast("Say what the song is about after /song, e.g. /song an upbeat pop song about Monday mornings");
    opts.hooks?.onDone?.(false);
    return;
  }
  if (songAsk) return makeSong(text, songAsk, opts.hooks);
  // With pictures attached, /image or /video uses the first as a reference image (Live and the camera ask don't make media).
  // "Draw me a chart of…" or "make a snake game" is for the Canvas, unless it asks for a picture or a clip.
  const forCanvas = CANVAS_CMD.test(text) || (wantsCanvas(text) && !/\b(image|picture|photo|illustration|painting|wallpaper|video|clip)s?\b/i.test(text));
  const media = live || opts.images?.length || forCanvas ? null : mediaRequest(text);
  if (media?.prompt === "") {
    toast(
      media.kind === "video"
        ? "Describe the clip after /video, e.g. /video waves crashing on rocks at dawn, gulls calling"
        : "Describe the image after /image, e.g. /image a lighthouse at dusk in the rain",
    );
    opts.hooks?.onDone?.(false);
    return;
  }
  if (media) {
    const ref = attachments[0];
    if (attachments.length > 1) toast("Using the first picture as the reference.");
    attachments = [];
    renderAttachments();
    // Without a picture attached, a prompt about the character ("Vex on a beach", "you as a knight") uses its face.
    const char = activeCharacter();
    if (!ref && char && wantsFace(char, media.prompt)) {
      return makeMedia(text, media.kind, faceScene(char, media.prompt), opts.hooks, char.face, "character");
    }
    return makeMedia(text, media.kind, media.prompt, opts.hooks, ref);
  }
  const images = live ? opts.images : opts.images ?? (attachments.length ? attachments : undefined);
  if (!opts.images && !live) {
    attachments = [];
    renderAttachments();
  }
  // Pictures need a model that can see; switch to Gemma 4 (or the one asked for) if needed. (Live has its own model.)
  if (!live && images?.length && (!current || !VISION.test(current.id) || (opts.vision && current.id !== opts.vision))) {
    const want = models.find((m) => m.id === opts.vision) ?? models.find((m) => m.id === "gemma4:12b") ?? models.find((m) => VISION.test(m.id));
    if (want && want.key !== current?.key) {
      selectModel(want);
      toast(`Switched to ${want.name} to look at the picture.`);
    }
  }
  const model = opts.live ?? current;
  if (!model) {
    toast("No model is available. Start the services first.", "warn");
    opts.hooks?.onDone?.(false);
    return;
  }
  if (chat.messages.length === 0 && !live) chat.title = text.replace(/\s+/g, " ").slice(0, 60);
  chat.model = model.name;
  // Emote reactions (not in a call: everything there is spoken). The reply to react to is the one before this message.
  const emotes = !live && settings.look?.emotes !== false;
  const lastReply = [...chat.messages].reverse().find((m) => m.role === "assistant" && !m.error);
  const youMsg: StoredMessage = { role: "user", content: text, images };
  chat.messages.push(youMsg);
  renderChat();

  // A character answers as itself (named on the reply, with the model underneath).
  const char = activeCharacter();
  chat.character = char?.id;
  const who = char ? `${char.name} · ${model.name}` : model.name;
  const reply: StoredMessage = { role: "assistant", content: "", model: who };
  const bubble = addAiBubble(who, () => reply.content);
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart(who, text);
  // "Speak replies" reads typed chats aloud too (voice chats already speak through their own hooks).
  const speakIt = !!settings.speakReplies && !opts.hooks;
  if (speakIt) stopSpeaking();
  toolContext.chatId = chat.id;
  const stat = $(".msg-stat", bubble);
  body.innerHTML = `<span class="status-line">Preparing…</span>`;
  scrollDown(true);

  busy = new AbortController();
  let reacts: ReturnType<typeof reactFilter> | null = null;
  document.body.classList.add("busy");
  $("#thinking").hidden = false;
  $("#stop").hidden = false;
  ($("#send") as HTMLButtonElement).disabled = true;

  try {
    // Shared memory: "remember that …" saves a fact; every reply gets the relevant facts. Talking to a character, the
    // fact goes into its own memory, and it gets the shared memory only when that's switched on for it.
    const cfg = char?.sharedMemory === false ? null : memCfg();
    let memoryText = "";
    const fact = rememberRequest(text);
    const savedNote = (note: string) => {
      reply.note = note;
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = note;
      bubble.insertBefore(chip, body);
    };
    if (char && fact) {
      await remember(char, fact);
      savedNote(`saved to ${char.name}'s memory: ${fact}`);
    }
    if (cfg) {
      if (fact && !char) {
        try {
          await addMemory(cfg, fact);
          savedNote(`saved to shared memory: ${fact}`);
        } catch (e) {
          toast(`Couldn't save that memory: ${errMsg(e)}`, "warn");
        }
      }
      if (live) memoryText = await liveMemory;
      else try {
        const recent = chat.messages.filter((m) => m.role === "user").slice(-7).map((m) => m.content).join("\n\n");
        const mem = await memoryContext(cfg, recent);
        memoryText = mem.text;
        memoryTotal = mem.total;
        $("#memory-status").textContent = `Shared memory on · ${facts(mem.total)} · ${mem.count} in this reply`;
      } catch (e) {
        $("#memory-status").textContent = `Shared memory unavailable · ${errMsg(e)}`;
      }
    }

    // Knowledge: passages from the user's files that match this question (and the one before, for follow-ups).
    let kbText = "";
    if (!live && (chat.files?.length || (settings.kbAll !== false && readyDocs().length))) {
      body.innerHTML = `<span class="status-line">Searching your files…</span>`;
      try {
        const asked = chat.messages.filter((m) => m.role === "user").slice(-2).map((m) => m.content).join("\n");
        const kb = await knowledgeFor(asked, chat.files ?? []);
        if (kb) {
          kbText = kb.text;
          reply.sources = kb.sources;
        }
      } catch (e) {
        toast(`Couldn't search your files: ${errMsg(e)}`, "warn");
      }
    }

    const history = chat.messages.filter((m) => !m.error);
    const last = history.length - 1;
    // Canvas pages are long: the model re-reads only the newest one, so a few rounds of fixes still fit its context.
    let newestPage = -1;
    history.forEach((m, i) => {
      if (m.role === "assistant" && findCanvas(m.content)) newestPage = i;
    });
    const canvasTurn = !live && (wantsCanvas(text) || newestPage >= 0);
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          systemBase(live),
          live ? LIVE_HINT : "",
          emotes ? REACT_HINT : "",
          emotes && lastReply?.react ? reactedNote(lastReply.react) : "",
          memoryText,
          char ? characterMemory(char) : "",
          kbText,
        ].filter(Boolean).join("\n\n"),
      },
      ...history.map((m, i) => {
        if (!live) return { role: m.role, content: i < newestPage ? withoutPage(m.content) : m.content, images: m.images };
        // In a call only the newest camera frame is sent (the older ones aren't what the camera sees now), and
        // the small Live models are told what it is.
        const cam = i === last && !!m.images?.length;
        return { role: m.role, content: cam ? `${m.content}\n\n(My webcam view right now is attached, in case it helps.)` : m.content, images: cam ? m.images : undefined };
      }),
    ];

    body.innerHTML = `<span class="status-line">${model.backend === "llama" ? "Loading the model if it's asleep (up to a minute)…" : "Waiting for the first token…"}</span>`;
    // A VoxCPM2 voice gives the GPU back to the chat model (in a call the Live model and the voice share it).
    if (!live) await releaseSpeechGpu(model.backend);
    let thinking = "";
    let pending = false;
    const paint = () => {
      pending = false;
      if (!busy) return; // the stream already ended and the final render is in place
      const page = renderBody(body, reply.content, true);
      if (page && !page.done) streamCanvas(page);
      // Put the cursor at the end of the last paragraph, not on a line of its own.
      let last: Element = body;
      while (last.lastElementChild && !["PRE", "TABLE"].includes(last.lastElementChild.tagName)) last = last.lastElementChild;
      const caret = document.createElement("span");
      caret.className = "caret";
      last.appendChild(caret);
      scrollDown();
    };
    // The Canvas: asked to build something (or changing what an earlier reply built), the model writes a page.
    if (canvasTurn) {
      messages[0].content += "\n\n" + CANVAS_HINT;
      canvasReplyStart();
    }
    // Tools: offered when any group is on and the model can call functions.
    const groups = enabledGroups();
    let toolDefs: ToolDef[] = [];
    let specs: any[] | undefined;
    // (Not in a call: tool rounds and "Allow?" cards don't work by voice, and they'd hold up the answer.)
    if (!live && groups.size && (await supportsTools(model))) {
      const t = await loadTools();
      const offer = canvasTurn ? new Set([...groups].filter((g) => CANVAS_TOOLS.has(g))) : groups;
      toolDefs = t.tools.filter((x) => offer.has(x.group));
      specs = toolDefs.length ? toolSpecs(t.tools, offer) : undefined;
      if (specs) messages[0].content += "\n\n" + TOOLS_HINT;
      if (toolDefs.some((d) => d.server === "workstation" && RENDER_TOOL.test(d.op))) messages[0].content += " " + RENDER_HINT;
    }
    // A reply can open with [react: 😂]: that becomes a reaction on the user's message and is never shown or spoken.
    reacts = reactFilter(
      (t) => {
        reply.content += t;
        opts.hooks?.onDelta?.(t);
        phoneDelta(replyChat, t);
        if (speakIt) {
          if (speakingBubble !== bubble) markSpeaking(bubble);
          speakDelta(t);
        }
        if (!pending) {
          pending = true;
          requestAnimationFrame(paint);
        }
      },
      (emoji) => {
        if (!emotes) return;
        youMsg.react = emoji;
        const mine = $(`#thread [data-i="${chat.messages.indexOf(youMsg)}"]`);
        if (mine) showReaction(mine, emoji, true);
      },
    );
    const handlers = {
      onToken: (t: string) => reacts!.push(t),
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
      const res = await streamChat(model, messages, handlers, busy.signal, specs, live ? { think: false, numCtx: LIVE_CTX, keepAlive: "30m" } : {});
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
        } else if (def.server === "workstation" && RENDER_TOOL.test(def.op)) {
          // A picture or clip the model makes (however it was asked for) goes through Prestige's own render queue,
          // so it's posted in this reply, here and on phones, when it's done. No "Allow?" card: like /image, it's
          // what was asked for, and a phone couldn't answer one.
          const t0 = performance.now();
          try {
            result = await toolRender(def.op, call.arguments ?? {}, { reply, bubble, body, chatId: replyChat, images, signal: busy.signal });
            step.ok = true;
          } catch (e) {
            result = `Error: ${errMsg(e)}`;
            step.ok = false;
          }
          step.ms = Math.round(performance.now() - t0);
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
    reacts?.flush();
    if (!reply.error) reply.content = stripTags(reply.content);
    const page = renderBody(body, reply.content);
    if (reply.sources?.length && !reply.error) renderSources(bubble, reply.sources, reply.content);
    if (page?.done && !reply.error) openCanvas(page, true);
    else streamEnded();
    stat.textContent = statText(reply.stats);
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    if (speakIt && !busy?.signal.aborted) speakEnd();
    busy = null;
    document.body.classList.remove("busy");
    $("#thinking").hidden = true;
    $("#stop").hidden = true;
    ($("#send") as HTMLButtonElement).disabled = false;
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    opts.hooks?.onDone?.(!reply.error && !reply.content.endsWith("*(stopped)*"));
  }
}

// ---------- characters ----------
/** Talk to a character (or, with undefined, Prestige itself): its prompt, voice and memory from the next reply on. */
function choosePersona(id: string | undefined, quiet = false) {
  const c = characterById(id);
  settings.character = c?.id;
  saveSettings();
  stopSpeaking();
  setVoice(voiceOf(c));
  renderPicker();
  syncPhone();
  if (!quiet) toast(c ? `Now talking to ${c.name}.` : "Back to Prestige.");
}

// ---------- phone access ----------
/** A reply is starting in this chat: it's saved first (with the user's message), so a phone can open it straight away,
 *  then phones are told, with the message, so they can show it before they've fetched anything. Every reply does this,
 *  typed here or on a phone. */
function phoneReplyStart(who: string, text: string) {
  if (!phoneOn() || !inTauri) return;
  const id = chat.id;
  chat.updated = Date.now();
  invoke("save_chat", { id, chat })
    .catch(() => {})
    .finally(() => {
      phonePush({ type: "started", chatId: id, who, text, title: chat.title });
      syncPhone();
    });
}
const phoneDelta = (id: string, text: string) => phonePush({ type: "delta", chatId: id, text });
const phoneReplyEnd = (id: string) => {
  phonePush({ type: "done", chatId: id });
  syncPhone();
};

/** A message from a paired phone (phone.rs): it runs in the app's own chat, so everything works from the phone, and the
 *  reply streams back to it. A phone message for another chat opens that chat here first; no chat id starts a new one. */
async function fromPhone(p: PhoneSend) {
  if (busy && (p.interrupt || (p.live && phoneLive))) {
    // Talking over a reply in a call cuts it off, as on the PC; the next turn starts once it has wrapped up.
    busy.abort();
    for (let i = 0; busy && i < 60; i++) await new Promise((r) => setTimeout(r, 50));
  }
  if (busy) {
    phonePush({ type: "error", text: "Prestige is busy with another reply. Try again when it's done.", busy: true });
    return;
  }
  try {
    if (p.chatId && p.chatId !== chat.id) {
      chat = await invoke<Chat>("load_chat", { id: p.chatId });
      if ((chat.character ?? undefined) !== settings.character && (!chat.character || characterById(chat.character))) choosePersona(chat.character, true);
    } else if (!p.chatId && chat.messages.length) chat = newChat();
  } catch {
    chat = newChat();
  }
  go("chat");
  renderChat();
  renderHistory();
  // The reply streams to phones like every reply (phoneReplyStart / phoneDelta / phoneReplyEnd); this only refreshes
  // the phone's header afterwards. The hooks also keep the reply from being read aloud on the PC.
  const hooks = { onDone: () => syncPhone() };
  // A turn of a Live call on the phone: what was said, with the camera's frame, answered by the Live model.
  if (p.live && phoneLive) return send(p.text, { images: p.images?.length ? p.images : undefined, live: phoneLive, hooks });
  const m = p.model ? models.find((x) => x.key === p.model) : null;
  if (m && m.key !== current?.key) selectModel(m);
  // Photos from the phone are attachments, like pictures added here: a vision model looks at them, /image uses the
  // first as its reference and /edit changes it.
  if (p.images?.length) {
    attachments = p.images.slice(0, 4);
    renderAttachments();
  }
  send(p.text, { hooks });
}

/** Phones see the render queue as it changes: at most once a second while a render's progress moves, straight away
 *  when one is added or finishes (and then the gallery is new too). */
let queueSent = 0;
let queueTimer: number | undefined;
let queueShape = "";
function phoneQueueChanged() {
  if (!phoneOn()) return;
  const q = phoneQueue();
  const shape = q.map((j) => `${j.id}:${j.state}`).join(",");
  const send = () => {
    queueSent = Date.now();
    phonePush({ type: "queue", queue: phoneQueue() });
  };
  clearTimeout(queueTimer);
  if (shape !== queueShape) {
    const before = new Set(queueShape.split(","));
    const finished = q.some((j) => j.state === "done" && !before.has(`${j.id}:done`));
    queueShape = shape;
    send();
    if (finished) phonePush({ type: "gallery" });
  } else if (Date.now() - queueSent >= 1000) send();
  else queueTimer = window.setTimeout(send, 1000 - (Date.now() - queueSent));
}

/** Characters on the phone: who there is to talk to (with a small face), and picking one (or Prestige, with no id). */
async function phoneCharacters(action: string, a: any) {
  if (action === "choose") {
    if (a.id && !characterById(String(a.id))) throw new Error("That character isn't there any more.");
    choosePersona(a.id ? String(a.id) : undefined, true);
    return { ok: true };
  }
  if (action !== "list") throw new Error(`unknown Characters action ${action}`);
  return {
    active: activeCharacter()?.id ?? null,
    list: await Promise.all(
      characters().map(async (c) => ({
        id: c.id,
        name: c.name,
        about: c.personality.slice(0, 160),
        voice: c.voice ?? "",
        memories: c.memory.length,
        thumb: c.face ? await faceThumb(c).catch(() => "") : "",
      })),
    ),
  };
}

/** Settings on the phone: the tool groups models may use in chat, "use my files in every chat", and shared memory. */
async function phoneSettings(action: string, a: any) {
  if (action === "tool") {
    const next = enabledGroups();
    a.on ? next.add(String(a.id)) : next.delete(String(a.id));
    settings.toolGroups = [...next];
    saveSettings();
    updateToolsButton();
  } else if (action === "kbAll") {
    settings.kbAll = a.on ? undefined : false;
    saveSettings();
  } else if (action === "remember") {
    const cfg = memCfg();
    if (!cfg) throw new Error("Shared memory isn't set up (Settings → Shared memory on the PC).");
    const fact = String(a.fact ?? "").trim();
    if (!fact) throw new Error("Say what to remember.");
    await addMemory(cfg, fact);
  } else if (action === "memories") {
    const cfg = memCfg();
    if (!cfg) return { memories: null };
    return { memories: (await listMemories(cfg)).map((m) => m.content) };
  } else if (action !== "list") throw new Error(`unknown Settings action ${action}`);
  const on = enabledGroups();
  const { tools } = await loadTools();
  return {
    tools: GROUPS.map((g) => ({ id: g.id, label: g.label, hint: g.hint, on: on.has(g.id), count: tools.filter((t) => t.group === g.id).length })),
    kbAll: settings.kbAll !== false,
    memory: !!memCfg(),
  };
}

interface PhoneSend {
  chatId?: string | null;
  text: string;
  model?: string | null;
  images?: string[];
  live?: boolean;
  interrupt?: boolean; // a turn of a voice call: it cuts off a reply that's still running
}

/** The Live model a call on the phone uses (null when no call is on). */
let phoneLive: ModelInfo | null = null;

/** A Live call starting on the phone: makes room on the GPU, picks the Live model and opens the call's chat. The phone
 *  does the listening and speaking; each turn arrives as a phone message with live set. */
async function phoneLiveCall(on: boolean) {
  if (!on) {
    phoneLive = null;
    syncPhone();
    return;
  }
  const have = liveModels();
  if (!have.length) {
    phonePush({ type: "error", text: "Live needs Qwen3.5 2B or 4B. Add one from the model catalog on the PC." });
    return;
  }
  busy?.abort();
  // A VoxCPM2 voice takes ~6 GB, so it gets the smaller Live model (as on the PC).
  phoneLive = isVox(activeCharacter()?.voice || settings.voice) ? have[have.length - 1] : have[0];
  await freeLlamaVram(["ollama", "voice"]).catch(() => {});
  beginLiveChat();
  go("chat");
  syncPhone();
  phonePush({ type: "live", on: true, model: phoneLive.name, chatId: chat.id });
}

/** A voice picked on the Voice screen or in a call: the character's new voice while talking to one, else Prestige's. */
function setVoicePref(v: string) {
  const c = activeCharacter();
  if (c) setCharacterVoice(c, v);
  else {
    settings.voice = v;
    saveSettings();
  }
}

/** Live calls show the character's face in place of the top hat. */
function livePersona() {
  const c = activeCharacter();
  const img = $("#live-face") as HTMLImageElement;
  img.hidden = !c?.face;
  if (c?.face) img.src = `data:image/jpeg;base64,${c.face}`;
  $("#live").classList.toggle("has-face", !!c?.face);
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
  $("#tools-more").addEventListener("click", () => {
    $("#tools-pop").hidden = true;
    openToolStore();
  });
  $("#composer-tools").addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = $("#tools-pop");
    if (pop.hidden) renderToolsMenu();
    else pop.hidden = true;
  });
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest("#tools-pop, #composer-tools")) $("#tools-pop").hidden = true;
    // isConnected: the form re-renders on each change, so the clicked control may already be gone.
    if (t.isConnected && !t.closest("#gen-pop, #composer-gen")) $("#gen-pop").hidden = true;
  });
  // Image and video settings (the same ones as Studio's), with an Image / Video switch.
  let genTab: MediaKind = "image";
  const genTabs = () => Array.from(document.querySelectorAll<HTMLElement>("#gen-pop [data-tab]"));
  const renderGenPop = () => {
    genTabs().forEach((b) => b.classList.toggle("on", b.dataset.tab === genTab));
    chatSettings($("#gen-pop-body"), genTab);
  };
  $("#composer-gen").addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = $("#gen-pop");
    pop.hidden = !pop.hidden;
    if (!pop.hidden) renderGenPop();
  });
  genTabs().forEach((b) =>
    b.addEventListener("click", () => {
      genTab = b.dataset.tab as MediaKind;
      renderGenPop();
    }),
  );
  onSettingsChange(() => {
    if (!$("#gen-pop").hidden) renderGenPop();
  });
  $("#stop").addEventListener("click", () => {
    busy?.abort();
    stopSpeaking();
  });
  // Attach a picture: the paperclip, pasting one into the message box, or dropping one on the chat.
  const attachIn = $("#attach-file") as HTMLInputElement;
  $("#composer-attach").addEventListener("click", () => attachIn.click());
  // Pictures are attached to the next message; documents go into Knowledge and are attached to this chat.
  attachIn.addEventListener("change", async () => {
    const files = Array.from(attachIn.files ?? []);
    attachIn.value = "";
    // A recording or video is transcribed (one at a time).
    const media = files.filter(isMedia);
    if (media.length) {
      if (media.length > 1) toast("Transcribing the first one; add the others when it's done.");
      runTranscribe({ file: media[0] });
    }
    for (const f of files) if (f.type.startsWith("image/")) attachImage(f);
    const docs = files.filter((f) => !f.type.startsWith("image/") && !isMedia(f));
    if (docs.length) attachDocs(await addFiles(docs.map((file) => ({ file }))));
  });
  ta.addEventListener("paste", (e) => {
    const f = imageIn(e.clipboardData);
    if (!f) return;
    e.preventDefault();
    attachImage(f);
  });
  ta.addEventListener("input", updateRefNote);
  // The choice buttons in the note under the attachments (shared with Studio).
  bindRefChoices($("#attachments"));
  onRefPrefsChange(updateRefNote);
  const chatScreen = $('[data-screen="chat"]');
  chatScreen.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    chatScreen.classList.add("drop");
  });
  chatScreen.addEventListener("dragleave", (e) => {
    if (!chatScreen.contains(e.relatedTarget as Node)) chatScreen.classList.remove("drop");
  });
  chatScreen.addEventListener("drop", async (e) => {
    chatScreen.classList.remove("drop");
    // A dropped recording or video is transcribed.
    const rec = Array.from(e.dataTransfer?.files ?? []).find(isMedia);
    if (rec) {
      e.preventDefault();
      runTranscribe({ file: rec });
      return;
    }
    const f = imageIn(e.dataTransfer);
    const docs = hasDocs(e.dataTransfer);
    if (!f && !docs) return;
    e.preventDefault();
    if (f) attachImage(f);
    if (docs && e.dataTransfer) attachDocs(await addDropped(e.dataTransfer));
  });
  // Image button: starts the message with /image, so whatever is typed next becomes the picture.
  $("#composer-image").addEventListener("click", () => {
    const v = ta.value.replace(IMAGE_CMD, "").replace(VIDEO_CMD, "");
    ta.value = `/image ${v}`;
    autosize();
    updateRefNote();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
  // Do it for me: starts the message with /do, so what's typed becomes the task.
  $("#composer-do").addEventListener("click", () => {
    const v = ta.value.replace(DO_CMD, "");
    ta.value = `/do ${v}`;
    autosize();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
  // Research button: starts the message with /research, so what's typed becomes the question.
  $("#composer-research").addEventListener("click", () => {
    const v = ta.value.replace(RESEARCH_CMD, "");
    ta.value = `/research ${v}`;
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
    ($("#live-phonon") as HTMLInputElement).checked = settings.liveStt === "phonon";
    $("#settings-test").textContent = "";
    openAppearance(settings.look);
    refreshPhone().catch(() => {});
    dlg.returnValue = ""; // Esc keeps the last return value: don't let it count as Save
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
  initAppearance();
  dlg.addEventListener("close", async () => {
    // Appearance shows as you change it: Save keeps it, anything else puts the saved look back.
    const look = closeAppearance(dlg.returnValue === "save");
    if (dlg.returnValue !== "save") return;
    settings.look = Object.values(look).some((v) => v !== undefined) ? look : undefined;
    settings.userName = nameInput.value.trim() || undefined;
    settings.aboutUser = aboutInput.value.trim() || undefined;
    greet($("#offline").hidden);
    settings.owuiKey = keyInput.value.trim() || undefined;
    const url = urlInput.value.trim();
    settings.owuiUrl = url && url !== DEFAULT_OWUI ? url : undefined;
    settings.stackRoot = rootInput.value.trim() || undefined;
    settings.keepRunning = keepInput.checked || undefined;
    settings.liveStt = ($("#live-phonon") as HTMLInputElement).checked ? "phonon" : undefined;
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
  canvasOnChat(name === "chat");
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
  initCanvas({
    toast,
    send: (text) => {
      if (busy) return false;
      go("chat");
      send(text);
      return true;
    },
    draft: (text) => {
      go("chat");
      const ta = $("#prompt") as HTMLTextAreaElement;
      ta.value = text;
      autosize();
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
    },
  });
  initKnowledge({
    toast,
    useAll: () => settings.kbAll !== false,
    setUseAll: (on) => {
      settings.kbAll = on ? undefined : false;
      saveSettings();
    },
    onChange: () => renderChatFiles(),
  });
  $("#kb-btn").addEventListener("click", () => openKnowledge());
  if (inTauri)
    initMissions({
      toast,
      models: () => models,
      current: () => current,
      system: () => systemBase(),
      toolsHint: TOOLS_HINT,
      busy: () => !!busy,
      saved: () => renderHistory().catch(() => {}),
      openChat: (id) => {
        go("chat");
        openSavedChat(id).catch((e) => toast(`Couldn't open it: ${errMsg(e)}`, "warn"));
      },
    });
  initCatalog({
    toast,
    root: () => settings.stackRoot ?? null,
    onInstalled: () => refreshModels(),
  });
  initStudio({
    toast,
    root: () => settings.stackRoot ?? null,
    freeGpu: () => unloadAll(undefined, "comfyui"),
    cameraPane: (on: boolean) => showCameraPane(on),
    show: () => go("studio"),
    // The 3D viewer lives in the Canvas, which is on the chat screen.
    openModel: (path, name) => {
      go("chat");
      openModel(path, name);
    },
    // Music mode's "Write lyrics": the chat model picked in Chat writes them for the style typed in Studio.
    writeLyrics: async (style, seconds, signal) => {
      if (!current) throw new Error("no chat model is available (start the services first)");
      return (await writeSong(current, style, seconds, signal)).lyrics;
    },
    // Right-click a picture > Make it talk: in the voice of the character being talked to, or Prestige's.
    makeTalk: (path) => talkFromPicture(convertFileSrc(path), path, activeCharacter()?.voice),
  });
  onSpeakingChange((on) => {
    if (!on) markSpeaking(null);
  });
  onSpeechError((msg) => toast(msg, "warn"));
  // The Voice screen's avatar is an inline copy of the mark, so its eye can follow the audio.
  $("#voice-mark").innerHTML = markSvg;
  addStache($("#voice-mark svg"));
  initVoice({
    toast,
    memCfg,
    send: (text, hooks) => {
      send(text, { hooks });
    },
    stopReply: () => busy?.abort(),
    isReplying: () => !!busy,
    getVoice: () => activeCharacter()?.voice || settings.voice,
    setVoiceSetting: (v) => setVoicePref(v),
  });
  initLive({
    toast,
    memCfg,
    liveModels,
    phonon: () => settings.liveStt === "phonon",
    beginChat: beginLiveChat,
    send: (text, images, model, hooks) => {
      send(text, { images, hooks, live: model });
    },
    stopReply: () => busy?.abort(),
    isReplying: () => !!busy,
    retractTurn: retractLiveTurn,
    getVoice: () => activeCharacter()?.voice || settings.voice,
    setVoiceSetting: (v) => {
      setVoicePref(v);
      setVoice(v);
    },
    getCamera: () => settings.camera,
    getLiveCamera: () => !!settings.liveCamera,
    setLiveCamera: (on) => {
      settings.liveCamera = on || undefined;
      saveSettings();
    },
    openCatalog: () => openCatalog(),
    ended: () => {
      go("chat");
      if (chat.messages.length) toast("The call is saved in Past chats.");
    },
  });
  $$("[data-live]").forEach((b) =>
    b.addEventListener("click", () => {
      if (busy) return toast("Wait for the reply to finish first.");
      stopSpeaking();
      go("chat"); // leaving the Voice screen also ends its hands-free listening
      livePersona();
      startLive();
    }),
  );
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
  // Tool groups saved before Knowledge existed: switch its search on once (it can be switched off like the rest).
  if (settings.toolGroups && !settings.kbTool) {
    settings.toolGroups = [...new Set([...settings.toolGroups, "knowledge"])];
    settings.kbTool = true;
    saveSettings();
  }
  applyLook(settings.look);
  await initCharacters({
    toast,
    active: () => settings.character,
    choose: (id) => choosePersona(id),
    defaultVoice: () => settings.voice ?? DEFAULT_VOICE,
    // "Make a talking video": their face in their voice.
    makeTalk: async (c) => talkFromPicture(`data:image/jpeg;base64,${c.face}`, await referenceFromBase64(c.face!), voiceOf(c)),
  });
  if (settings.character && !characterById(settings.character)) settings.character = undefined;
  // The saved voice, or the character's (initVoice ran before settings were loaded).
  setVoice(activeCharacter()?.voice || settings.voice || DEFAULT_VOICE);
  // Tools added from the tool store become groups in the Tools menu.
  await initToolStore({
    toast,
    root: () => settings.stackRoot ?? null,
    enableGroup: (id) => {
      if (settings.toolGroups && !settings.toolGroups.includes(id)) {
        settings.toolGroups = [...settings.toolGroups, id];
        saveSettings();
      }
      updateToolsButton();
    },
  }).catch(() => {});
  updateToolsButton();
  // Phone access (off unless it was switched on in Settings).
  await initPhone({
    toast,
    enabled: () => !!settings.phone,
    setEnabled: (on) => {
      settings.phone = on || undefined;
      saveSettings();
      if (on) syncPhone();
    },
    port: () => settings.phonePort,
  }).catch((e) => toast(`Phone access: ${errMsg(e)}`, "warn"));
  if (inTauri) {
    listen<PhoneSend>("phone-send", (e) => fromPhone(e.payload));
    listen<{ on: boolean }>("phone-live", (e) => phoneLiveCall(e.payload.on));
    listen("phone-stop", () => {
      busy?.abort();
      stopSpeaking();
    });
    // Studio, Renders and the render queue on the phone.
    onPhoneAsk("studio", (action, args) => phoneStudio(action, args));
    onPhoneAsk("system", (action, args) => phoneSystem(action, args));
    onPhoneAsk("characters", phoneCharacters);
    onPhoneAsk("knowledge", (action, args) => phoneKnowledge(action, args));
    onPhoneAsk("missions", (action, args) => phoneMissions(action, args));
    onPhoneAsk("catalog", (action, args) => phoneCatalog(action, args));
    onPhoneAsk("settings", phoneSettings);
    onQueueChange(phoneQueueChanged);
  }
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
