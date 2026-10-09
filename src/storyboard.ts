// Storyboard: the Director's plan, laid out to change before anything is rendered. "/storyboard a fox in a neon city"
// plans the song and the shots like /director (director.ts), then opens the board: the title, the song's style and
// lyrics, the look every shot shares, and one card per 5-second shot with its action and a frame drawn by the image
// model. Change any text, redraw a frame, add, remove or reorder shots; then Render the video, and the Director makes
// the song, animates each shot from its frame with LTX-2.5 image-to-video (text-to-video where there's no frame), and
// joins it all. The board is kept, so /storyboard alone opens it again.
import { convertFileSrc } from "@tauri-apps/api/core";
import { MAX_SECONDS, MIN_SECONDS, SHOT_SECONDS, type VideoPlan } from "./director";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

/** "/storyboard a lonely robot finds a flower" (or /board, /sb). */
export const STORYBOARD_CMD = /^\/(?:storyboard|board|sb)\b\s*/i;

const MIN_SHOTS = MIN_SECONDS / SHOT_SECONDS;
const MAX_SHOTS = MAX_SECONDS / SHOT_SECONDS;

export interface BoardShot {
  id: string;
  action: string;
  frame?: string; // the drawn frame's path
  framePrompt?: string; // what it was drawn from, to tell when the text changed since
}

export interface Board {
  idea: string;
  title: string;
  style: string;
  bpm?: number;
  key?: string;
  language?: string;
  lyrics: string;
  look: string;
  shots: BoardShot[];
  draft: boolean;
  subtitles: boolean;
}

/** What the Director gets from a board: the plan, each shot's frame (if drawn), and how to render it. */
export interface BoardRender {
  plan: VideoPlan;
  frames: (string | undefined)[];
  draft: boolean;
  subtitles: boolean;
}

interface Deps {
  toast: (msg: string, kind?: "warn") => void;
  /** Draws a frame (resolves with its path). */
  drawFrame: (prompt: string, progress: (pct: number, label: string) => void, title: string) => Promise<string>;
  /** Stops the frames being drawn. */
  stopFrames: () => void;
  /** The image model's name, for the button's tooltip. */
  frameModel: () => Promise<string>;
  /** Lets the webview show the frames (ComfyUI's output folder). */
  allowRenders: () => Promise<void>;
  /** Makes the video. */
  render: (r: BoardRender) => void;
}

const KEY = "prestige.storyboard";
let deps: Deps;
let board: Board | null = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
})();
// Shots whose frame is being drawn, and how far along.
const drawing = new Map<string, { pct: number; label: string }>();
let saveTimer: number | undefined;

const newId = () => Math.random().toString(36).slice(2, 10);
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
/** What a shot's frame and video are made from: the look, then the action. */
const promptOf = (b: Board, sh: BoardShot) => (b.look.trim() ? `${b.look.trim()} ${sh.action.trim()}` : sh.action.trim());
const seconds = (b: Board) => b.shots.length * SHOT_SECONDS;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(board));
    } catch {
      /* full or unavailable: the board still works until Prestige closes */
    }
  }, 300);
}

/** A board from the Director's plan. */
export function boardFromPlan(plan: VideoPlan, idea: string, draft: boolean, subtitles: boolean): Board {
  return {
    idea,
    title: plan.title,
    style: plan.style,
    bpm: plan.bpm,
    key: plan.key,
    language: plan.language,
    lyrics: plan.lyrics,
    look: plan.look,
    shots: plan.shots.map((sh) => ({ id: newId(), action: sh.action })),
    draft,
    subtitles,
  };
}

export const hasBoard = () => !!board;

export function initStoryboard(d: Deps) {
  deps = d;
  const dlg = $("#storyboard") as HTMLDialogElement;
  const field = (id: string, k: "title" | "style" | "lyrics" | "look") =>
    $(id).addEventListener("input", (e) => {
      if (!board) return;
      board[k] = (e.target as HTMLInputElement).value;
      persist();
      if (k === "look") renderShots(); // every frame's prompt changed
      summary();
    });
  field("#sb-title", "title");
  field("#sb-style", "style");
  field("#sb-lyrics", "lyrics");
  field("#sb-look", "look");
  for (const [id, k] of [["#sb-draft", "draft"], ["#sb-subs", "subtitles"]] as const)
    $(id).addEventListener("change", (e) => {
      if (!board) return;
      board[k] = (e.target as HTMLInputElement).checked;
      persist();
      summary();
    });
  // The shot cards: one listener for all their buttons and text.
  const list = $("#sb-shots");
  list.addEventListener("input", (e) => {
    const ta = e.target as HTMLTextAreaElement;
    const sh = shotOf(ta);
    if (!board || !sh || !ta.matches(".sb-action")) return;
    sh.action = ta.value;
    persist();
    stale(ta.closest(".sb-shot") as HTMLElement, sh);
  });
  list.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!board || !b) return;
    const sh = shotOf(b);
    const i = sh ? board.shots.indexOf(sh) : -1;
    if (!sh || i < 0) return;
    const act = b.dataset.act;
    if (act === "draw") drawShots([sh]);
    // A frame opens across the whole board (and back) to see it closely.
    else if (act === "open") return b.closest(".sb-shot")?.classList.toggle("zoom");
    else if (act === "up" && i > 0) board.shots.splice(i - 1, 0, ...board.shots.splice(i, 1));
    else if (act === "down" && i < board.shots.length - 1) board.shots.splice(i + 1, 0, ...board.shots.splice(i, 1));
    else if (act === "add") {
      if (board.shots.length >= MAX_SHOTS) return deps.toast(`A video has ${MAX_SHOTS} shots at most (${MAX_SECONDS} s).`);
      board.shots.splice(i + 1, 0, { id: newId(), action: "" });
    } else if (act === "remove") {
      if (board.shots.length <= MIN_SHOTS) return deps.toast(`A video has ${MIN_SHOTS} shots at least (${MIN_SECONDS} s).`);
      board.shots.splice(i, 1);
    } else return;
    persist();
    renderShots();
    summary();
    if (act === "add") ($(`[data-id="${board.shots[i + 1].id}"] .sb-action`, list) as HTMLTextAreaElement | null)?.focus();
  });
  $("#sb-draw-all").addEventListener("click", () => board && drawShots(board.shots.filter((sh) => !upToDate(sh) && sh.action.trim())));
  $("#sb-stop").addEventListener("click", () => deps.stopFrames());
  $("#sb-close").addEventListener("click", () => dlg.close());
  $("#sb-render").addEventListener("click", startRender);
  deps.frameModel().then((m) => ($("#sb-draw-all").title = `Draw every shot that has no frame, or whose text changed since (${m})`)).catch(() => {});
}

const shotOf = (el: Element) => board?.shots.find((sh) => sh.id === (el.closest(".sb-shot") as HTMLElement | null)?.dataset.id);
const upToDate = (sh: BoardShot) => !!sh.frame && !!board && sh.framePrompt === promptOf(board, sh);

/** Opens the board: a new one from a plan (its frames start drawing), or the last one. */
export async function openStoryboard(b?: Board, drawFrames = false) {
  if (b) {
    board = b;
    drawing.clear();
    persist();
  }
  if (!board) {
    deps.toast("There's no storyboard yet. Type /storyboard and what the video is about.");
    return;
  }
  await deps.allowRenders().catch(() => {});
  ($("#sb-title") as HTMLInputElement).value = board.title;
  ($("#sb-style") as HTMLInputElement).value = board.style;
  ($("#sb-lyrics") as HTMLTextAreaElement).value = board.lyrics;
  ($("#sb-look") as HTMLTextAreaElement).value = board.look;
  ($("#sb-draft") as HTMLInputElement).checked = board.draft;
  ($("#sb-subs") as HTMLInputElement).checked = board.subtitles;
  renderShots();
  summary();
  const dlg = $("#storyboard") as HTMLDialogElement;
  if (!dlg.open) dlg.showModal();
  if (drawFrames) drawShots(board.shots.filter((sh) => sh.action.trim()));
}

function renderShots() {
  if (!board) return;
  const b = board;
  $("#sb-shots").innerHTML = b.shots
    .map((sh, i) => {
      const d = drawing.get(sh.id);
      const frame = sh.frame
        ? `<button type="button" class="sb-frame" data-act="open" title="See it larger (click again to go back)"><img src="${convertFileSrc(sh.frame)}" alt="Shot ${i + 1}" loading="lazy" /></button>`
        : `<div class="sb-frame empty">${d ? "" : "No frame yet: this shot is made from the text alone"}</div>`;
      return `<div class="sb-shot${d ? " busy" : ""}" data-id="${sh.id}">
        <div class="sb-pic">${frame}<div class="sb-progress"${d ? "" : " hidden"}><div class="progress"><i style="--v:${d?.pct ?? 0}"></i></div><span>${esc(d?.label ?? "")}</span></div></div>
        <div class="sb-head"><b>Shot ${i + 1}</b><span class="credit">${i * SHOT_SECONDS}–${(i + 1) * SHOT_SECONDS} s</span><span class="sb-stale credit" hidden>text changed</span>
          <span class="sb-tools"><button type="button" class="icon-btn" data-act="up" title="Move earlier"${i ? "" : " disabled"}>↑</button><button type="button" class="icon-btn" data-act="down" title="Move later"${i < b.shots.length - 1 ? "" : " disabled"}>↓</button><button type="button" class="icon-btn" data-act="add" title="Add a shot after this one">+</button><button type="button" class="icon-btn" data-act="remove" title="Remove this shot">×</button></span></div>
        <textarea class="sb-action" rows="4" placeholder="What happens: the setting, the lighting and one camera move">${esc(sh.action)}</textarea>
        <button type="button" class="btn sb-draw" data-act="draw"${d ? " disabled" : ""}>${sh.frame ? "Redraw frame" : "Draw frame"}</button>
      </div>`;
    })
    .join("");
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("#sb-shots .sb-shot"))) {
    const sh = b.shots.find((x) => x.id === el.dataset.id);
    if (sh) stale(el, sh);
  }
}

/** Marks a shot whose frame was drawn from different text (a changed action or look). */
function stale(el: HTMLElement, sh: BoardShot) {
  ($(".sb-stale", el) as HTMLElement).hidden = !sh.frame || upToDate(sh);
}

/** The length, what will be made, and whether it can start. */
function summary() {
  if (!board) return;
  const n = board.shots.length;
  const framed = board.shots.filter((sh) => sh.frame).length;
  const s = seconds(board);
  // Measured (director.ts): ~95 s for the song, ~230 s a shot (~145 s as a draft), ~15 s to finish.
  const mins = Math.max(1, Math.round((95 + n * (board.draft ? 145 : 230) + 15) / 60));
  $("#sb-summary").textContent =
    `${s} s · ${n} shots · ${framed === n ? "every shot starts on its frame" : framed ? `${framed} of ${n} shots start on their frame, the rest are made from text` : "no frames yet: shots are made from text"} · about ${mins} min to render`;
  ($("#sb-stop") as HTMLElement).hidden = drawing.size === 0;
  ($("#sb-render") as HTMLButtonElement).disabled = drawing.size > 0 || board.shots.some((sh) => !sh.action.trim());
  ($("#sb-render") as HTMLButtonElement).title = drawing.size ? "Wait for the frames being drawn" : board.shots.some((sh) => !sh.action.trim()) ? "Every shot needs an action" : "";
}

/** Draws these shots' frames, one after another through the render queue. */
async function drawShots(shots: BoardShot[]) {
  if (!board) return;
  const b = board;
  const todo = shots.filter((sh) => !drawing.has(sh.id));
  if (!todo.length) return deps.toast(shots.length ? "Those frames are already being drawn." : "Every frame is up to date.");
  for (const sh of todo) drawing.set(sh.id, { pct: 0, label: "Waiting…" });
  renderShots();
  summary();
  for (const sh of todo) {
    if (board !== b || !drawing.has(sh.id)) continue;
    const prompt = promptOf(b, sh);
    const card = () => document.querySelector<HTMLElement>(`#sb-shots [data-id="${sh.id}"]`);
    try {
      const path = await deps.drawFrame(
        prompt,
        (pct, label) => {
          drawing.set(sh.id, { pct, label });
          const el = card();
          if (!el) return;
          ($(".progress i", el) as HTMLElement | null)?.style.setProperty("--v", String(pct));
          const l = $(".sb-progress span", el);
          if (l) l.textContent = label;
        },
        `${b.title}: frame for shot ${b.shots.indexOf(sh) + 1}`,
      );
      sh.frame = path;
      sh.framePrompt = prompt;
      persist();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Stopping cancels the rest too.
      if (msg === "stopped") {
        for (const x of todo) drawing.delete(x.id);
      } else deps.toast(`Couldn't draw the frame for shot ${b.shots.indexOf(sh) + 1}: ${msg}`, "warn");
    }
    drawing.delete(sh.id);
    if (board === b) {
      renderShots();
      summary();
    }
  }
}

function startRender() {
  if (!board || drawing.size) return;
  const b = board;
  const s = seconds(b);
  const plan: VideoPlan = {
    title: b.title.trim() || b.idea.slice(0, 60) || "Storyboard",
    style: b.style.trim() || b.idea,
    bpm: b.bpm,
    key: b.key,
    language: b.language,
    lyrics: b.lyrics.trim(),
    look: b.look.trim(),
    shots: b.shots.map((sh) => ({ action: sh.action.trim(), prompt: promptOf(b, sh) })),
    seconds: s,
  };
  // A frame drawn from older text still starts its shot (it's what was seen on the board).
  const frames = b.shots.map((sh) => sh.frame);
  ($("#storyboard") as HTMLDialogElement).close();
  deps.render({ plan, frames, draft: b.draft, subtitles: b.subtitles });
}
