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
import { invoke } from "@tauri-apps/api/core";
import { initSystem, onGpu, showSystem, unloadAll, type Gpu } from "./system";
import { initStudio, showStudio } from "./studio";
import { initVoice, showVoice } from "./voice";
import { initCamera, showCameraPane } from "./camera";
import { stopSpeaking } from "./speech";
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
  $("#greeting").innerHTML = online
    ? `${part}, <span>Ryan</span>. Everything is running locally.`
    : `${part}, <span>Ryan</span>. The local services are offline.`;
}

// ---------- GPU readouts ----------
async function pollGpu() {
  if (!inTauri) return;
  try {
    const g = await invoke<Gpu>("gpu_stats");
    onGpu(g);
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
    b.innerHTML = `<span class="n"></span><span class="r"></span><span class="d"></span>`;
    $(".n", b).textContent = m.name;
    $(".r", b).textContent = m.role ?? "";
    $(".d", b).textContent = m.detail;
    b.addEventListener("click", () => {
      selectModel(m);
      menu.hidden = true;
    });
    menu.appendChild(b);
  }
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

function addAiBubble(modelName: string) {
  const m = document.createElement("div");
  m.className = "msg ai";
  m.innerHTML = `<div class="msg-meta"><span class="msg-who"></span><span class="msg-stat"></span></div><div class="msg-body"></div>`;
  $(".msg-who", m).textContent = modelName;
  $("#thread").appendChild(m);
  return m;
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
  for (const msg of chat.messages) {
    if (msg.role === "user") addUserBubble(msg.content, msg.images);
    else {
      const b = addAiBubble(msg.model ?? "Assistant");
      if (msg.error) b.classList.add("error");
      if (msg.note) {
        const chip = document.createElement("div");
        chip.className = "chip";
        chip.textContent = msg.note;
        b.insertBefore(chip, $(".msg-body", b));
      }
      if (msg.thinking) setThinking(b, msg.thinking, false);
      $(".msg-body", b).innerHTML = md(msg.content);
      $(".msg-stat", b).textContent = statText(msg.stats);
    }
  }
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
  const items = await invoke<{ id: string; title: string; updated: number; model?: string }[]>("list_chats");
  list.innerHTML = items.length ? "" : `<p class="muted" style="padding:10px;font-size:12.5px">No saved chats yet.</p>`;
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "history-item" + (it.id === chat.id ? " sel" : "");
    row.innerHTML = `<button class="open"><span class="t"></span><span class="m"></span></button><button class="del" aria-label="Delete chat" title="Delete">✕</button>`;
    $(".t", row).textContent = it.title || "Untitled";
    $(".m", row).textContent = [new Date(it.updated).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), it.model].filter(Boolean).join(" · ");
    $(".open", row).addEventListener("click", async () => {
      if (busy) return toast("Wait for the reply to finish first.");
      chat = await invoke<Chat>("load_chat", { id: it.id });
      renderChat();
      renderHistory();
      $("#history").hidden = true;
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
const SYSTEM_BASE =
  "You are Prestige, a private AI assistant running entirely on Ryan's own PC (RTX 3060, Windows 11). " +
  "Be direct and helpful. Use Markdown when it helps.";

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

async function send(text: string, opts: { images?: string[]; vision?: string; hooks?: ReplyHooks } = {}) {
  text = text.trim();
  if (!text && (opts.images?.length || attachments.length)) text = "What do you see in this picture?";
  if (!text || busy) {
    opts.hooks?.onDone?.(false);
    return;
  }
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
  const bubble = addAiBubble(model.name);
  const body = $(".msg-body", bubble);
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
      { role: "system", content: [SYSTEM_BASE, memoryText].filter(Boolean).join("\n\n") },
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
    const stats = await streamChat(
      model,
      messages,
      {
        onToken: (t) => {
          reply.content += t;
          opts.hooks?.onDelta?.(t);
          if (!pending) {
            pending = true;
            requestAnimationFrame(paint);
          }
        },
        onThinking: (t) => {
          thinking += t;
          setThinking(bubble, thinking, !reply.content);
          if (!reply.content) body.innerHTML = `<span class="status-line">Thinking…</span>`;
        },
        onStats: (s) => (stat.textContent = statText(s, true)),
      },
      busy.signal,
    );
    reply.stats = stats;
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
  $("#stop").addEventListener("click", () => {
    busy?.abort();
    stopSpeaking();
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
  const openSettings = async () => {
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

async function main() {
  greet(true);
  wire();
  initSystem({ toast, nameFor });
  initStudio({
    toast,
    root: () => settings.stackRoot ?? null,
    freeGpu: () => unloadAll(),
    cameraPane: (on: boolean) => showCameraPane(on),
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
  // Like open-app.ps1: opening the app starts the workstation if it isn't running.
  await runSplash(true);
  renderHistory();
  pollGpu();
  setInterval(pollGpu, 1000);
  ($("#prompt") as HTMLTextAreaElement).focus();
}

main();
