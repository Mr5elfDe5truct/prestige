import DOMPurify from "dompurify";
import { marked } from "marked";
import { findCanvas, openCanvas, openModel } from "./canvas";
import { ctxOf, type ModelInfo, type StreamStats } from "./backends";
import { humanizeButton } from "./humanize";
import { speak, stopSpeaking } from "./speech";
import { allowRenders, openRender, renderMenu } from "./renderapi";
import { convertFileSrc } from "@tauri-apps/api/core";
import { dragRender } from "./reference";
import { renderToolStep } from "./chattools";
import { renderChatFiles, renderSources } from "./chatknowledge";
import { pickReaction, showReaction } from "./emotes";
import { persist } from "./chathistory";
import { $, chat, foldSteps, inTauri, scrollDown, type StoredMessage } from "./main";

// ---------- rendering ----------
export function md(text: string) {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string);
}

// Building a page, only web search stays on (for real data in a chart, say): with file, command or image tools the models
// try to "edit" a page file that doesn't exist, or make pictures for it.
export const CANVAS_TOOLS = new Set(["web"]);

/** An older reply with its page swapped for a note (a newer version comes later in the chat). */
export function withoutPage(text: string) {
  const c = findCanvas(text);
  return c ? `${text.slice(0, c.start)}\n(An earlier version of the page "${c.title}" was here; the newest version is further down.)\n${text.slice(c.end)}` : text;
}

/** A reply's text, with the page it wrote for the Canvas shown as a card that opens it (the code is in the canvas).
 *  `live`: the reply is still streaming, so an unclosed page is being written rather than cut off. */
export function renderBody(body: HTMLElement, text: string, live = false) {
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

export function statText(s?: StreamStats, live = false) {
  if (!s) return "";
  const parts = [];
  if (s.tps) parts.push(`${s.tps.toFixed(1)} tok/s`);
  parts.push(`${s.tokens} tokens`);
  if (!live) parts.push(`${s.seconds.toFixed(1)} s`);
  return parts.join(" · ");
}

/** Why a reply stopped short. The reply itself is often the small part: the system notes and tool descriptions
 *  sent with every question can take most of a 20k context, so it says how much went where. */
export function cutOffNote(model: ModelInfo, s?: StreamStats) {
  const k = (n: number) => `${(n / 1024).toFixed(1).replace(/\.0$/, "")}k`;
  const ctx = ctxOf(model);
  const head = `Cut off: ${model.name}'s ${k(ctx)} context is full.`;
  if (!s?.promptTokens) return `${head} Start a new chat, or pick a model with more context, to go further.`;
  const share = s.promptTokens / ctx;
  const split = ` ${k(s.promptTokens)} of it went to the chat so far, Prestige's notes and the tool descriptions, leaving ${k(Math.max(0, ctx - s.promptTokens))} for this reply.`;
  // Mostly the prompt: fewer tools (the wrench) frees the most; else the reply itself ran long.
  const fix = share > 0.5
    ? " Switch off tool groups you don't need with the wrench, start a new chat, or give the model more context in Settings > Workstation settings > Models."
    : " Start a new chat, or give the model more context in Settings > Workstation settings > Models, to go further.";
  return head + split + fix;
}

export function addUserBubble(text: string, images?: string[]) {
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
export function addAiBubble(modelName: string, text?: () => string) {
  const m = document.createElement("div");
  m.className = "msg ai";
  m.innerHTML = `<div class="msg-meta"><span class="msg-who"></span><span class="msg-stat"></span></div><div class="msg-body"></div>`;
  $(".msg-who", m).textContent = modelName;
  if (text) {
    $(".msg-meta", m).appendChild(humanizeButton(m, text));
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

export const SPEAKER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z" /><path class="w" d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /></svg>`;

// The reply being read aloud, so its speaker button shows as playing (click again to stop).
export let speakingBubble: HTMLElement | null = null;
export function markSpeaking(b: HTMLElement | null) {
  speakingBubble?.classList.remove("speaking");
  speakingBubble = b;
  b?.classList.add("speaking");
}

/** Images or a video made from chat: each picture (click to open it in the lightbox) and the prompt. */
export function renderFigure(bubble: HTMLElement, r: NonNullable<StoredMessage["render"]>) {
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
      // Drag it into the chat box to use it again, or onto Studio's create bar (via the Studio tab) as a reference.
      dragRender($(".pic", fig), path);
    }
    fig.addEventListener("contextmenu", (e) => renderMenu(e, path));
    $(".chat-renders", body).appendChild(fig);
  }
  $(".render-caption", body).textContent = `${r.prompt}${r.seconds ? ` · ${r.seconds} s` : ""}`;
}

export function setThinking(bubble: HTMLElement, text: string, open: boolean) {
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

export function renderChat() {
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
export function reactButton(bubble: HTMLElement, msg: StoredMessage) {
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
