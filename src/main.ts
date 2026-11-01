// Prestige by R.G. Studios · developed by Ryan B. Gyles. Phase 2: core chat.
import "@fontsource/rye/400.css";
import "@fontsource/oxanium/500.css";
import "@fontsource/oxanium/600.css";
import "@fontsource/oxanium/700.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
// the living styles' display fonts (Settings → Appearance → Style), bundled so they work offline
import "@fontsource/share-tech-mono/400.css";
import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/fraunces/500.css";
import "@fontsource/fraunces/600.css";
import "@fontsource/quicksand/500.css";
import "@fontsource/quicksand/600.css";
import "@fontsource/cinzel/600.css";
import "@fontsource/jura/500.css";
import "@fontsource/jura/600.css";
import "@fontsource/marcellus/400.css";
import "@fontsource/space-mono/400.css";
import "./styles.css";
import markSvg from "./assets/rg-mark.svg?raw";
import DOMPurify from "dompurify";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { initSystem, onGpus, phoneSystem, showSystem, unloadAll } from "./system";
import { ollamaCtx, onPlanChange, readGpus, refreshPlan, shortName, type Gpu } from "./gpus";
import { initStudio, onQueueChange, showStudio } from "./studio";
import { allowRenders, cancelRender, chatSettings, openRender, frameLabel, renderFrame, type MediaKind } from "./renderapi";
import { phoneStudio } from "./studiophone";
import { LASER_CMD, laserPrompt, openLaser } from "./laser";
import { DIRECTOR_ASK, DIRECTOR_CMD } from "./director";
import { STORYBOARD_CMD, hasBoard, initStoryboard, openStoryboard } from "./storyboard";
import { filmMode, initFilm } from "./film";
import { SONG_CMD, writeSong } from "./songwriter";
import { WORLD_CMD, WORLD_NEXT, type WorldState } from "./world";
import { DRAMA_CMD } from "./drama";
import { onSettingsChange } from "./gensettings";
import { CONSENT, bindRefChoices, hasFiles, hasRender, imageIn, imageToBase64, onRefPrefsChange, refChoicesHtml, referenceFromBase64, renderIn } from "./reference";
import { initVoice, showVoice } from "./voice";
import { initCamera, showCameraPane } from "./camera";
import { initLive, startLive, LIVE_CTX, LIVE_MODELS } from "./live";
import { onSpeakingChange, onSpeechError, releaseSpeechGpu, setVoice, speakDelta, speakEnd, stopSpeaking, DEFAULT_VOICE } from "./speech";
import { bestFor, capsFor, chipsHtml, nameHints, supportsTools } from "./caps";
import { initCatalog, openCatalog, phoneCatalog } from "./catalog";
import { checkForUpdates, initUpdates } from "./updates";
import { GROUPS, LAST_ROUND, LOAD_TOOLS, TOOL_ROUNDS, fitToolResults, groupsWithin, withoutToolCalls, loadTools, loadToolsSpec, runTool, splitGroups, toolContext, tokensIn, toolSpecs, type ToolDef, type ToolStep } from "./tools";
import { ctxOf, errMsg, nameFor, listModels, streamChat, type ChatMessage, type ModelInfo, type StreamStats } from "./backends";
import { initMemoryWriter, pauseMemoryWrite, queueMemoryWrite } from "./memwriter";
import { addFact, memoryContext, factCount, listOwui, syncFromOwui, rememberRequest, DEFAULT_OWUI, type MemoryConfig } from "./memory";
import { initMemoryPanel, openMemoryPanel } from "./memorypanel";
import { initPacks } from "./packs";
import { initSetup, openSetup } from "./setup";
import { addStache } from "./talk";
import { applyCachedLook, applyLook, closeAppearance, initAppearance, openAppearance, type Look } from "./theme";
import { initMesa } from "./mesa";
import { initScrollLock } from "./scrolllock";
import { setupChatWidth, setupPanels } from "./panels";
import { initWorkstation } from "./workstation";
// the living styles: their shared hooks, then each one (theme.ts lists them; skins/backgrounds.ts draws behind them)
import "./skins/living.css";
import "./skins/matrix.css";
import "./skins/cyber.css";
import "./skins/nature.css";
import "./skins/electric.css";
import "./skins/waves.css";
import "./skins/bio.css";
import "./skins/clock.css";
import "./skins/cosmic.css";
import "./skins/crystal.css";
import { reactFilter, reactedNote, showReaction, stripTags, REACT_HINT } from "./emotes";
import { CANVAS_CMD, CANVAS_HINT, canvasOnChat, canvasReplyStart, findCanvas, initCanvas, openCanvas, openModel, streamCanvas, streamEnded, wantsCanvas } from "./canvas";
import { addDropped, addFiles, hasDocs, initKnowledge, knowledgeFor, openKnowledge, openSource, phoneKnowledge, readyDocs, type Source } from "./knowledge";
import { initSearch, openSearch } from "./search";
import { initOcr } from "./ocr";
import { initHumanize } from "./humanize";
import { initTranslate } from "./translate";
import { RESEARCH_CMD } from "./research";
import { TRANSCRIBE_CMD, isMedia } from "./transcribe";
import { initMissions, phoneMissions } from "./missions";
import { DO_CMD } from "./computer";
import { activeCharacter, characterById, characterMemory, characterPrompt, faceScene, initCharacters, remember, renderPicker, voiceOf, wantsFace } from "./characters";
import { initSprites, makeSprites } from "./sprites";
import { initPhone, onPhoneAsk, phoneState, refreshPhone } from "./phone";
import { initToolStore, openToolStore } from "./toolstore";
import { listen } from "@tauri-apps/api/event";
import { beginWork, endWork, initWorking, stepWork, toolDoing } from "./working";
import { bootRows, runSplash, startStack } from "./launch";
import { fromPhone, livePersona, phoneCharacters, phoneDelta, phoneLive, phoneLiveCall, phoneQueueChanged, phoneReplyEnd, phoneReplyStart, type PhoneSend, phoneSettings, queueWork, setVoicePref, watchReplySteps } from "./phoneaccess";
import { pickAndTranscribe, runComputer, runResearch, runTranscribe } from "./chatagents";
import { makeDirector, makeDrama, makeStoryboard } from "./chatstories";
import { make3d, makeMedia, makeSong, makeTalk, makeWorld, talkFromPicture } from "./chatmedia";
import { confirmTool, enabledGroups, LOAD_HINT, loadedGroups, RENDER_HINT, RENDER_TOOL, renderToolsMenu, renderToolStep, toolRender, TOOLS_HINT, updateSpeakButton, updateToolsButton } from "./chattools";
import { openSavedChat, persist, renderHistory } from "./chathistory";
import { attachDocs, renderChatFiles, renderSources } from "./chatknowledge";
import { addAiBubble, CANVAS_TOOLS, cutOffNote, md, markSpeaking, reactButton, renderBody, renderChat, setThinking, speakingBubble, statText, withoutPage } from "./chatrender";

export const inTauri = "__TAURI_INTERNALS__" in window;
export const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll(s)) as T[];

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
export interface StoredMessage {
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
  render?: { path: string; prompt: string; seconds?: number; more?: string[]; kind?: MediaKind | "model"; reply?: boolean; title?: string; world?: WorldState };
  react?: string; // an emote reaction: yours on a reply, Prestige's on your message
  sources?: Source[]; // passages from Knowledge this reply was given (shown under it, cited in it)
}
export interface Chat {
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
  liveQuick?: boolean; // Live calls use Quick mode: LFM3-Audio hears and speaks (quicktalk.ts)
  computerModel?: string; // the model that drives the PC for /do (its key); undefined = the best one there
  autoUpdate?: boolean; // look for a new version on GitHub without being asked (undefined = on)
}

export let settings: Settings = {};
export let models: ModelInfo[] = [];
export let current: ModelInfo | null = null;
export let chat: Chat = newChat();
export function setChat(c: Chat) {
  chat = c;
}
export let busy: AbortController | null = null;
export function setBusy(b: AbortController | null) {
  busy = b;
}
let memoryTotal: number | null = null;

export function newChat(): Chat {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, title: "New chat", created: Date.now(), updated: Date.now(), messages: [] };
}

export function memCfg(): MemoryConfig | null {
  return settings.owuiKey ? { key: settings.owuiKey, url: settings.owuiUrl || DEFAULT_OWUI } : null;
}

async function loadSettings() {
  if (inTauri) settings = (await invoke<Settings>("get_settings")) ?? {};
  else {
    try { settings = JSON.parse(localStorage.getItem("prestige-settings") || "{}"); } catch { settings = {}; }
  }
}
export async function saveSettings() {
  if (inTauri) await invoke("save_settings", { settings });
  else {
    try { localStorage.setItem("prestige-settings", JSON.stringify(settings)); } catch { /* preview only */ }
  }
}

// ---------- toast ----------
export function toast(msg: string, kind = "") {
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

export function escapeHtml(s: string) {
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

export function selectModel(m: ModelInfo | null) {
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
export function syncPhone() {
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

export async function refreshModels() {
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
  const n = current ? ctxOf(current) : ollamaCtx();
  return `${Math.round(n / 1024)}k context`;
}
onPlanChange(() => refreshMemoryStatus());

// The memory is Prestige's own (memory.ts); with Open WebUI connected, what it learns is copied in here too.
export async function refreshMemoryStatus() {
  const el = $("#memory-status");
  const cfg = memCfg();
  if (cfg) await syncFromOwui(cfg).catch(() => 0);
  memoryTotal = await factCount();
  el.textContent = `Memory · ${facts(memoryTotal)} · ${ctxLabel()}`;
}

export function scrollDown(force = false) {
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 220;
  if (force || nearBottom) window.scrollTo({ top: document.body.scrollHeight });
}

// ---------- sending ----------
// What the PC has, filled in from nvidia-smi and the OS so the prompt fits whoever runs Prestige.
const pcInfo: { gpu?: string; ramGB?: number } = {};

/** The instructions every model gets, personalised with the user's name and note from Settings. */
/** `live`: for a call, where the Live hint says how to talk instead. */
export function systemBase(live = false): string {
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

// ---------- attachments (webcam frames and pictures for the next message) ----------
// A question about them goes to a model that can see; with /image or /video the first one is a reference image.
export let attachments: string[] = [];
export function setAttachments(list: string[]) {
  attachments = list;
}

export function renderAttachments() {
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
/** Whether a model can look at pictures: llama.cpp reports it (a vision projector), otherwise its name says so.
 *  Qwen3.8 27B sees through its mmproj but its name doesn't say so, and a picture used to hand the chat to Gemma. */
export const canSee = (m: ModelInfo) => !!m.inputModalities?.includes("image") || (m.args ?? []).includes("--mmproj") || VISION.test(m.id);
/** The model to look at a picture with: the one asked for, else the current one if it can see, else a seeing model
 *  that doesn't refuse, else Gemma 4. */
export const seeingModel = (asked?: string) =>
  models.find((m) => m.id === asked) ??
  (current && canSee(current) ? current : undefined) ??
  models.find((m) => canSee(m) && nameHints(m.id).uncensored) ??
  models.find((m) => m.id === "gemma4:12b") ??
  models.find(canSee);

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
export const liveModels = () =>
  LIVE_MODELS.map((x) => models.find((m) => m.backend === "ollama" && m.id === x.id)).filter((m): m is ModelInfo => !!m);
// Shared memory is looked up once when a call starts, not on every turn, to keep replies quick.
let liveMemory: Promise<string> = Promise.resolve("");

export function beginLiveChat() {
  if (chat.messages.length) chat = newChat();
  const when = new Date().toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const c = activeCharacter();
  chat.title = `Live call${c ? ` with ${c.name}` : ""} · ${when}`;
  renderChat();
  renderHistory();
  liveMemory = activeCharacter()?.sharedMemory === false ? Promise.resolve("") : memoryContext("").then((m) => m.text).catch(() => "");
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

/** `what` names the job in the working readout ("Picture", "Deep research"…), `who` the model doing it. */
export function setBusyUi(on: boolean, what = "Prestige", who?: string) {
  document.body.classList.toggle("busy", on);
  if (on) beginWork("reply", what, who);
  else endWork("reply");
  $("#thinking").hidden = !on;
  $("#stop").hidden = !on;
  ($("#send") as HTMLButtonElement).disabled = on;
}

/** A finished research report's steps (often 15 or more) fold into one line, a click away. */
export function foldSteps(bubble: HTMLElement) {
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

export async function send(text: string, opts: { images?: string[]; vision?: string; hooks?: ReplyHooks; live?: ModelInfo } = {}) {
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
  if (!live && !opts.images && WORLD_CMD.test(text)) {
    const request = text.replace(WORLD_CMD, "").trim();
    if (!request && !attachments[0]) {
      toast("Say what the world is after /world (e.g. /world a fox walking through a misty forest), or /world then what happens next");
      opts.hooks?.onDone?.(false);
      return;
    }
    const picture = WORLD_NEXT.test(request) ? undefined : attachments[0];
    attachments = [];
    renderAttachments();
    return makeWorld(text, request, opts.hooks, picture);
  }
  if (!live && !opts.images && EDIT_CMD.test(text)) {
    const instruction = text.replace(EDIT_CMD, "").trim();
    const src = await pictureToUse();
    if (!instruction || !src) {
      toast(!src ? "Attach a picture to edit (or make one in this chat first), then /edit and what to change." : "Say what to change after /edit, e.g. /edit make it night");
      opts.hooks?.onDone?.(false);
      return;
    }
    // Further attached pictures go along as images 2 and 3 ("put the hat from image 2 on her").
    const more = attachments.slice(1, 3);
    attachments = [];
    renderAttachments();
    return makeMedia(text, "image", instruction, opts.hooks, src, undefined, true, more);
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
  // "/laser a celtic knot coaster": the image model draws a design made to engrave or cut (bold black on white), and it
  // opens in the Laser panel as line art, to save as a PNG or trace to an SVG.
  if (!live && !opts.images && LASER_CMD.test(text)) {
    const idea = text.replace(LASER_CMD, "").trim();
    if (!idea || attachments.length) {
      toast(idea ? "To use a picture you have, right-click it in Studio and pick Make a laser file." : "Describe the design after /laser, e.g. /laser a celtic knot coaster");
      opts.hooks?.onDone?.(false);
      return;
    }
    const inChat = chat;
    await makeMedia(text, "image", laserPrompt(idea), opts.hooks);
    const made = inChat.messages[inChat.messages.length - 1]?.render;
    if (made?.kind === "image") openLaser(made.path, made.path.split(/[\\/]/).pop() ?? "design", idea, "lineart");
    return;
  }
  // "/storyboard a fox in a neon city": the Director plans it, and the plan opens as a storyboard to change, with a frame
  // drawn for every shot, before it's rendered. "/storyboard" alone opens the last one again.
  if (!live && !opts.images && STORYBOARD_CMD.test(text)) {
    const idea = text.replace(STORYBOARD_CMD, "").trim();
    if (!idea) {
      if (hasBoard()) openStoryboard();
      else toast("Say what the video is about after /storyboard, e.g. /storyboard a lonely robot finds a flower, 30 seconds");
      opts.hooks?.onDone?.(false);
      return;
    }
    return makeStoryboard(text, idea, opts.hooks);
  }
  // "/drama a ghost story in a lighthouse" or "/podcast …": a script for several voices, performed by Drama 3.
  if (!live && DRAMA_CMD.test(text)) {
    const idea = text.replace(DRAMA_CMD, "").trim();
    if (!idea) {
      toast("Say what it's about after /drama, e.g. /drama two astronauts arguing about who left the airlock open, 1 minute");
      opts.hooks?.onDone?.(false);
      return;
    }
    return makeDrama(text, idea, opts.hooks);
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
  if (songAsk) {
    // "/song" with pictures attached: a song about them.
    const pics = live ? undefined : opts.images?.length ? opts.images : attachments.length ? [...attachments] : undefined;
    if (pics && !opts.images) {
      attachments = [];
      renderAttachments();
    }
    return makeSong(text, songAsk, opts.hooks, pics);
  }
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
  // Pictures need a model that can see; switch to one (the one asked for, else an uncensored one) if needed. (Live has its own model.)
  if (!live && images?.length && (!current || !canSee(current) || (opts.vision && current.id !== opts.vision))) {
    const want = seeingModel(opts.vision);
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
  pauseMemoryWrite();
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
  setBusyUi(true, char ? `Chat · ${char.name}` : "Chat", model.name);

  try {
    // Shared memory: "remember that …" saves a fact; every reply gets the relevant facts. Talking to a character, the
    // fact goes into its own memory, and it gets the shared memory only when that's switched on for it.
    const shared = char?.sharedMemory !== false;
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
    if (fact && !char) {
      try {
        await addFact(fact, memCfg());
        savedNote(`saved to memory: ${fact}`);
      } catch (e) {
        toast(`Couldn't save that memory: ${errMsg(e)}`, "warn");
      }
    }
    if (shared) {
      if (live) memoryText = await liveMemory;
      else try {
        const recent = chat.messages.filter((m) => m.role === "user").slice(-7).map((m) => m.content).join("\n\n");
        const mem = await memoryContext(recent);
        memoryText = mem.text;
        memoryTotal = mem.total;
        $("#memory-status").textContent = `Memory · ${facts(mem.total)} · ${mem.count} in this reply`;
      } catch (e) {
        $("#memory-status").textContent = `Memory unavailable · ${errMsg(e)}`;
      }
    }
    // The model mustn't go looking for a way to save what Prestige already saved.
    if (fact && reply.note)
      memoryText += `${memoryText ? "\n\n" : ""}Prestige has already saved this to memory: "${fact}". Confirm it in a few words; don't call any tool to save or look for it.`;

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
    // A group's full tools are sent once the model asks for it with load_tools (or the message clearly needs it), and
    // stay for the rest of this chat. `later` is what's still offered by name.
    let allTools: ToolDef[] = [];
    let later: string[] = [];
    let offer = new Set<string>();
    const loaded = loadedGroups.get(replyChat) ?? new Set<string>();
    loadedGroups.set(replyChat, loaded);
    const toolBudget = Math.round(ctxOf(model) / 3);
    const offerTools = () => {
      toolDefs = allTools.filter((x) => offer.has(x.group));
      const list = toolSpecs(allTools, offer);
      if (later.length) list.push(loadToolsSpec(allTools, later));
      specs = list.length ? list : undefined;
    };
    if (!live && groups.size && (await supportsTools(model))) {
      const t = await loadTools();
      allTools = t.tools;
      const split = canvasTurn ? { full: new Set([...groups].filter((g) => CANVAS_TOOLS.has(g))), later: [] } : splitGroups(t.tools, groups, text, loaded);
      // A third of the context at most, so the chat and the answer keep the rest.
      const fit = groupsWithin(t.tools, split.full, toolBudget);
      offer = fit.keep;
      // Left out for room: still loadable by name, if a smaller group goes first.
      later = [...split.later, ...fit.dropped.map((d) => d.id)];
      offerTools();
      if (specs) messages[0].content += "\n\n" + TOOLS_HINT + (later.length ? " " + LOAD_HINT : "");
      if (t.tools.some((d) => d.server === "workstation" && RENDER_TOOL.test(d.op) && (offer.has(d.group) || later.includes(d.group)))) messages[0].content += " " + RENDER_HINT;
    }
    /** load_tools: adds a group's tools for the next round (and the rest of the chat), if they fit. */
    const loadGroup = (id: string) => {
      const label = GROUPS.find((g) => g.id === id)?.label ?? id;
      if (offer.has(id)) return `${label} is already loaded.`;
      if (!later.includes(id)) return `There's no tool group called ${id}. Groups you can load: ${later.join(", ") || "none"}.`;
      const fit = groupsWithin(allTools, new Set([...offer, id]), toolBudget);
      if (!fit.keep.has(id)) return `${label}'s tools don't fit in ${model.name}'s context next to the ones already loaded. Tell the user.`;
      offer.add(id);
      loaded.add(id);
      later = later.filter((g) => g !== id);
      offerTools();
      return `Loaded ${label}: ${allTools.filter((x) => x.group === id).map((x) => x.name).join(", ")}. Call them now.`;
    };
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
    let cutOff = false;
    // Room the answer needs: a Canvas page is rewritten whole, so about as long as the newest one; else a quarter.
    const ctx = ctxOf(model);
    const reserve = canvasTurn && newestPage >= 0 ? tokensIn(history[newestPage].content) + 1024 : Math.round(ctx / 4);
    for (let round = 0; round <= TOOL_ROUNDS; round++) {
      const before = reply.content.length;
      // Out of rounds, or out of room for more results: answer with what's here.
      const last = round === TOOL_ROUNDS || (round > 0 && !fitToolResults(messages, ctx, reserve));
      if (last) messages.push(LAST_ROUND);
      const res = await streamChat(model, messages, handlers, busy.signal, last ? undefined : specs, live ? { think: false, numCtx: LIVE_CTX, keepAlive: "30m" } : {});
      stats = res;
      cutOff = res.cutOff;
      if (last || !res.toolCalls.length || !busy || busy.signal.aborted) break;
      messages.push({ role: "assistant", content: reply.content.slice(before), tool_calls: res.toolCalls });
      for (const call of res.toolCalls) {
        // A tool from a group that isn't loaded yet, called by name anyway: its group is loaded and the call runs.
        const unloaded = !toolDefs.some((d) => d.name === call.name) && allTools.find((d) => d.name === call.name && later.includes(d.group));
        if (unloaded) loadGroup(unloaded.group);
        const def = toolDefs.find((d) => d.name === call.name);
        const step: ToolStep = { name: call.name, args: call.arguments, by: model.name };
        (reply.tools ??= []).push(step);
        renderToolStep(bubble, step);
        stepWork("reply", toolDoing(call.name, call.arguments), undefined, call.name);
        let result: string;
        if (call.name === LOAD_TOOLS) {
          result = loadGroup(String(call.arguments?.group ?? ""));
          step.ok = result.startsWith("Loaded") || result.endsWith("already loaded.");
          step.ms = 0;
        } else if (!def) {
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
          if (!reply.content) body.innerHTML = `<span class="status-line">${escapeHtml(toolDoing(def.name, call.arguments))}</span>`;
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
      stepWork("reply", "Reading the results…", undefined, null);
      if (!reply.content) body.innerHTML = `<span class="status-line">Reading the results…</span>`;
    }
    reply.stats = stats;
    reply.content = withoutToolCalls(reply.content);
    // Without this the reply just stopped mid-sentence (or mid-page), as if Prestige had hung.
    if (cutOff) reply.content += `\n\n*(${cutOffNote(model, stats)})*`;
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
    // The memory writer reads the exchange once the chat goes quiet (not in a call, or as a character, who keeps its
    // own memory).
    if (!live && !char && !reply.error && !busy?.signal.aborted) queueMemoryWrite(text, reply.content, model);
    if (speakIt && !busy?.signal.aborted) speakEnd();
    busy = null;
    setBusyUi(false);
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    opts.hooks?.onDone?.(!reply.error && !reply.content.endsWith("*(stopped)*"));
  }
}

// ---------- characters ----------
/** Talk to a character (or, with undefined, Prestige itself): its prompt, voice and memory from the next reply on. */
export function choosePersona(id: string | undefined, quiet = false) {
  const c = characterById(id);
  settings.character = c?.id;
  saveSettings();
  stopSpeaking();
  setVoice(voiceOf(c));
  renderPicker();
  syncPhone();
  if (!quiet) toast(c ? `Now talking to ${c.name}.` : "Back to Prestige.");
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
    if (!(hasFiles(e) || hasRender(e))) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    chatScreen.classList.add("drop");
  });
  chatScreen.addEventListener("dragleave", (e) => {
    if (!chatScreen.contains(e.relatedTarget as Node)) chatScreen.classList.remove("drop");
  });
  chatScreen.addEventListener("drop", async (e) => {
    chatScreen.classList.remove("drop");
    // A render dragged from chat or Studio is attached like a picked image (the reference for /image and /video).
    const path = renderIn(e.dataTransfer);
    if (path) {
      e.preventDefault();
      try {
        await allowRenders();
        attachImage(await (await fetch(convertFileSrc(path))).blob());
      } catch (err) {
        toast(`Couldn't read ${path.split(/[\/]/).pop()}: ${errMsg(err)}`, "warn");
      }
      return;
    }
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
  // Storyboard button: starts the message with /storyboard (what's typed is the idea); with an empty box and a storyboard
  // already made, it opens that one.
  $("#composer-storyboard").addEventListener("click", () => {
    const v = ta.value.replace(STORYBOARD_CMD, "").trim();
    if (!v && hasBoard()) return openStoryboard();
    ta.value = `/storyboard ${v}`;
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
  // Holding a dragged render over Chat or Studio in the menu opens that screen, to drop it there.
  let springTimer = 0;
  $$<HTMLElement>("nav [data-go]").forEach((b) => {
    b.addEventListener("dragenter", (e) => {
      if (!hasRender(e) || !["chat", "studio"].includes(b.dataset.go!)) return;
      clearTimeout(springTimer);
      springTimer = window.setTimeout(() => go(b.dataset.go!), 500);
    });
    b.addEventListener("dragleave", (e) => {
      if (!b.contains(e.relatedTarget as Node)) clearTimeout(springTimer);
    });
    b.addEventListener("drop", () => clearTimeout(springTimer));
  });

  $("#brand").addEventListener("click", () => {
    ($("#auto-update") as HTMLInputElement).checked = settings.autoUpdate !== false;
    ($("#about") as HTMLDialogElement).showModal();
  });
  $("#auto-update").addEventListener("change", () => {
    settings.autoUpdate = ($("#auto-update") as HTMLInputElement).checked ? undefined : false;
    saveSettings();
  });
  $("#replay-splash").addEventListener("click", () => {
    ($("#about") as HTMLDialogElement).close();
    runSplash(false);
  });

  // services
  $("#start-services").addEventListener("click", async () => {
    const btn = $("#start-services") as HTMLButtonElement;
    if (!inTauri) return toast("Run start-all.ps1 in the Workstation folder.");
    const have = await invoke<{ startScript: boolean }>("stack_info", { root: settings.stackRoot ?? null }).catch(() => ({ startScript: true }));
    if (!have.startScript) return openSetup();
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
  $("#memory-status").addEventListener("click", () => openMemoryPanel());
  $("#open-memory").addEventListener("click", () => openMemoryPanel());
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
      const n = (await listOwui({ key: keyInput.value.trim(), url })).length;
      out.textContent = `Connected. Open WebUI has ${n} memories; they're copied into Prestige's memory when you save.`;
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
    const cfg = memCfg();
    if (cfg) syncFromOwui(cfg, true).then((n) => n && toast(`Copied ${facts(n)} from Open WebUI into Prestige's memory.`)).catch(() => {});
    if (inTauri) {
      const info = await invoke<{ startScript: boolean }>("stack_info", { root: settings.stackRoot ?? null });
      if (!info.startScript) toast("start-all.ps1 isn't in that folder.", "warn");
    }
    refreshMemoryStatus();
  });
}

/** A yes / no question in Prestige's own style; true for the OK button. */
function confirmBox(title: string, text: string, ok = "OK"): Promise<boolean> {
  const dlg = $("#confirm") as HTMLDialogElement;
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = ok;
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((res) => dlg.addEventListener("close", () => res(dlg.returnValue === "ok"), { once: true }));
}

// ---------- screens ----------
export function go(name: string) {
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
  initScrollLock();
  // Studio and System fill the window with panels you can move and resize; the Chat column can be widened (panels.ts).
  setupPanels("studio", [
    { w: 2, panels: [{ id: "create", h: 3 }, { id: "queue", h: 1 }] },
    { w: 3, panels: [{ id: "renders", h: 1 }] },
  ]);
  setupPanels("system", [
    { w: 3, panels: [{ id: "gpus", h: 2 }, { id: "models", h: 3 }] },
    { w: 2, panels: [{ id: "vram", h: 3 }, { id: "services", h: 2 }] },
  ]);
  setupChatWidth();
  greet(true);
  wire();
  initSystem({ toast, nameFor, openCatalog: () => openCatalog(), root: () => settings.stackRoot ?? null });
  initWorkstation({
    toast,
    root: () => settings.stackRoot ?? null,
    restartAll: async () => {
      toast("Restarting the AI services with the new settings…");
      await invoke("ws_stop_and_wait", { root: settings.stackRoot ?? null });
      const up = await startStack(bootRows());
      await refreshPlan(settings.stackRoot ?? null);
      await refreshModels();
      refreshMemoryStatus();
      toast(up ? "Services are back up with the new settings." : "The services didn't come back up. Check the Workstation folder in Settings.", up ? "" : "warn");
    },
  });
  initSetup({
    toast,
    root: () => settings.stackRoot ?? null,
    done: async (root) => {
      const info = await invoke<{ default: string }>("stack_info", { root: null });
      settings.stackRoot = root.toLowerCase() === info.default.toLowerCase() ? undefined : root;
      await saveSettings();
      const up = await startStack(bootRows());
      await refreshModels();
      refreshMemoryStatus();
      toast(up ? "The Workstation is ready." : "Setup finished, but the services didn't answer yet. See System.", up ? "" : "warn");
      if (!settings.welcomed && !settings.userName) setTimeout(showWelcome, 1200);
    },
  });
  initPacks({
    toast,
    root: () => settings.stackRoot ?? null,
    confirm: confirmBox,
    restartServices: async () => {
      await invoke("ws_stop_and_wait", { root: settings.stackRoot ?? null });
      await startStack(bootRows());
      await refreshModels();
    },
  });
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
  initMemoryPanel({ owui: memCfg, toast, onChange: () => refreshMemoryStatus() });
  initMemoryWriter({ root: () => settings.stackRoot ?? null, owui: memCfg, toast, onChange: () => refreshMemoryStatus() });
  initKnowledge({
    toast,
    useAll: () => settings.kbAll !== false,
    setUseAll: (on) => {
      settings.kbAll = on ? undefined : false;
      saveSettings();
    },
    onChange: () => renderChatFiles(),
  });
  initOcr({ toast, root: () => settings.stackRoot ?? null });
  initHumanize({ toast, root: () => settings.stackRoot ?? null, md });
  initTranslate({ toast, root: () => settings.stackRoot ?? null });
  $("#kb-btn").addEventListener("click", () => openKnowledge());
  initSearch({
    toast,
    root: () => settings.stackRoot ?? null,
    openRender: (path) => openRender(path),
    openChat: async (id) => {
      if (await openSavedChat(id)) go("chat");
    },
    openFile: (id) => openSource({ doc: id, name: "", text: "" }),
  });
  // What Prestige is doing right now, in the HUD (working.ts).
  initWorking($("#hud-gpus"));
  watchReplySteps();
  $("#search-btn").addEventListener("click", () => openSearch());
  $("#ide-btn").addEventListener("click", async () => {
    try {
      const r = await invoke<string>("open_ide");
      toast(r === "download" ? "Prestige IDE isn't installed yet: its download page is open" : "Opening Prestige IDE");
    } catch (e) {
      toast(`Couldn't open Prestige IDE: ${errMsg(e)}`, "warn");
    }
  });
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
    // Right-click a picture → Make a song about it: in the chat, written by a model that can see it.
    songFromPicture: async (path) => {
      if (busy) return toast("Wait for the reply that's running (or stop it), then make the song.");
      try {
        const pic = await imageToBase64(await (await fetch(convertFileSrc(path))).blob());
        go("chat");
        makeSong("/song about this picture", "a song about this picture", undefined, [pic]);
      } catch (e) {
        toast(`Couldn't read the picture: ${errMsg(e)}`, "warn");
      }
    },
    // Studio's Storyboard mode: planned in the chat, where the Director's reply shows (the board opens over it).
    storyboard: (idea) => {
      if (!idea) return openStoryboard();
      if (busy) return toast("Wait for the reply that's running (or stop it), then plan the storyboard.");
      go("chat");
      makeStoryboard(`/storyboard ${idea}`, idea);
    },
    hasStoryboard: hasBoard,
    film: filmMode,
  });
  initFilm({
    toast,
    root: () => settings.stackRoot ?? null,
    model: () => current ?? undefined,
    voice: () => settings.voice || DEFAULT_VOICE,
    // The viewer is part of Studio's page, under the film's sheet: the sheet closes (the film is kept) to show it.
    openRender: (path) => {
      ($("#film") as HTMLDialogElement).close();
      go("studio");
      openRender(path);
    },
  });
  initStoryboard({
    toast,
    drawFrame: async (prompt, progress, title) => (await renderFrame(prompt, progress, title))[0].path,
    stopFrames: () => cancelRender("Storyboard"),
    frameModel: frameLabel,
    allowRenders,
    // The video is made in the chat, where the Director shows each step.
    render: (b) => {
      if (busy) {
        toast("Wait for the reply that's running (or stop it), then render the storyboard.");
        return openStoryboard();
      }
      go("chat");
      makeDirector(`🎬 Render the storyboard: ${b.plan.title}`, b.plan.title, undefined, b);
    },
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
    getQuick: () => !!settings.liveQuick,
    setQuick: (on) => {
      settings.liveQuick = on || undefined;
      saveSettings();
    },
    root: () => settings.stackRoot ?? null,
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
    makeSprites,
  });
  initSprites({ toast, root: () => settings.stackRoot ?? null, openRender });
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
    onQueueChange(queueWork);
  }
  updateToolsButton();
  updateSpeakButton();
  // Like open-app.ps1: opening the app starts the workstation if it isn't running. With no Workstation yet, Setup
  // makes one (setup.ts) and the welcome waits until it's done.
  const info = inTauri ? await invoke<{ startScript: boolean }>("stack_info", { root: settings.stackRoot ?? null }).catch(() => ({ startScript: true })) : { startScript: true };
  await runSplash(info.startScript);
  // Check for a new version shortly after start, then every 6 hours while Prestige stays open, unless that's
  // switched off in About (then only Check for updates goes online).
  const autoCheck = () => settings.autoUpdate !== false && checkForUpdates(true);
  initUpdates(toast).then(() => {
    setTimeout(autoCheck, 4000);
    setInterval(autoCheck, 6 * 60 * 60 * 1000);
  });
  greet($("#offline").hidden);
  if (!info.startScript) setTimeout(openSetup, 2400);
  else if (!settings.welcomed && !settings.userName) setTimeout(showWelcome, 2600);
  renderHistory();
  pollGpu();
  setInterval(pollGpu, 1000);
  if (inTauri) invoke<{ total: number }>("sys_memory").then((m) => (pcInfo.ramGB = Math.round(m.total / 1024))).catch(() => {});
  ($("#prompt") as HTMLTextAreaElement).focus();
}

main();
