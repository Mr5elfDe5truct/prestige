// Prestige by R.G. Studios · developed by Ryan B. Gyles. The Canvas: when a chat model writes an HTML page (a game, a
// chart, a 3D scene…), it opens in a panel beside the chat and runs there, playable. The page is served on its own
// origin by canvas.rs and runs in a sandboxed iframe, so it can't touch Prestige or the local services. Errors it
// throws are caught and can be sent back to the model with "Fix it".
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

const inTauri = "__TAURI_INTERNALS__" in window;
const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

// ---------- finding the page in a reply ----------
// One fenced block per match: the language, the code, and whether the closing fence has arrived yet.
const FENCE = /```[ \t]*([\w+#.-]*)[^\n]*\n([\s\S]*?)(\n[ \t]*```|$)/g;
const PAGE_START = /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html[\s>])/i;

export interface CanvasCode {
  html: string; // the runnable page
  title: string;
  done: boolean; // false while the model is still writing it
  start: number; // where the code block sits in the reply
  end: number;
}

/** The page in a reply: its ```html block (or a bare <!doctype html>… document), plus any ```css / ```js blocks it uses. */
export function findCanvas(text: string): CanvasCode | null {
  const blocks = [...text.matchAll(FENCE)].map((m) => ({
    lang: m[1].toLowerCase(),
    code: m[2],
    done: !!m[3],
    start: m.index!,
    end: m.index! + m[0].length,
  }));
  const pages = blocks.filter((b) => /^(html|htm|xhtml)$/.test(b.lang) || PAGE_START.test(b.code));
  let page = pages.sort((a, b) => b.code.length - a.code.length)[0];
  if (!page) {
    // Some models skip the fence and just write the document.
    const at = text.search(/<!doctype\s+html|<html[\s>]/i);
    if (at < 0 || blocks.some((b) => b.start <= at && at < b.end)) return null;
    const close = text.toLowerCase().indexOf("</html>", at);
    const end = close < 0 ? text.length : close + 7;
    page = { lang: "html", code: text.slice(at, end), done: close >= 0, start: at, end };
  }
  // A whole page, or something that runs; not a snippet of markup in an answer about HTML.
  if (!PAGE_START.test(page.code) && !/<(script|canvas|svg)\b/i.test(page.code)) return null;
  const css = blocks.filter((b) => b !== page && b.lang === "css").map((b) => b.code);
  const js = blocks.filter((b) => b !== page && /^(js|javascript|mjs)$/.test(b.lang)).map((b) => b.code);
  return { html: assemble(page.code, css, js), title: titleOf(page.code), done: page.done, start: page.start, end: page.end };
}

function titleOf(html: string) {
  return html.match(/<title[^>]*>([^<]{1,80})<\/title>/i)?.[1].trim() || "Canvas";
}

/** Makes a full document, putting separate CSS and JS blocks in where the page links to them (or at the end). */
function assemble(code: string, css: string[], js: string[]) {
  let html = /<html[\s>]|<body[\s>]|<head[\s>]/i.test(code)
    ? code
    : `<!doctype html><html><head><meta charset="utf-8"></head><body>\n${code}\n</body></html>`;
  const local = (u: string) => !/^(https?:)?\/\//i.test(u) && !u.startsWith("data:");
  if (css.length) {
    let used = false;
    html = html.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, (tag) => {
      const href = tag.match(/href=["']?([^"'\s>]+)/i)?.[1] ?? "";
      if (!local(href) || used) return local(href) ? "" : tag;
      used = true;
      return `<style>\n${css.join("\n")}\n</style>`;
    });
    if (!used) html = insertBefore(html, "</head>", `<style>\n${css.join("\n")}\n</style>`);
  }
  if (js.length) {
    let used = false;
    html = html.replace(/<script\b([^>]*)\bsrc=["']?([^"'\s>]+)["']?([^>]*)>\s*<\/script>/gi, (tag, a, src, b) => {
      if (!local(src)) return tag;
      if (used) return "";
      used = true;
      return `<script${a}${b}>\n${js.join("\n")}\n</script>`;
    });
    if (!used && !/<script\b[^>]*>\s*\S/i.test(html)) html = insertBefore(html, "</body>", `<script>\n${js.join("\n")}\n</script>`);
  }
  return html;
}

function insertBefore(html: string, tag: string, add: string) {
  const i = html.toLowerCase().lastIndexOf(tag);
  return i < 0 ? html + add : html.slice(0, i) + add + html.slice(i);
}

// ---------- what runs inside the frame first ----------
// Reports errors to Prestige, stands in for storage (a sandboxed page has none), and keeps arrow keys and space from
// scrolling the page while a game is being played. One line, so error line numbers match the model's code.
const BOOT = `<script>(function(){var P=parent,S=function(t,m){try{P.postMessage({__canvas:1,type:t,msg:String(m).split(location.href).join("page").slice(0,1500)},"*")}catch(_){}};` +
  `addEventListener("error",function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href)){S("error","Couldn't load "+(t.src||t.href));return}` +
  `S("error",(e.message||"Error")+(e.lineno?" (line "+e.lineno+(e.colno?", column "+e.colno:"")+")":"")+(e.error&&e.error.stack?"\\n"+e.error.stack.split("\\n").slice(1,4).join("\\n"):""))},true);` +
  `addEventListener("unhandledrejection",function(e){var r=e.reason;S("error","Unhandled promise rejection: "+(r&&(r.stack||r.message)||r))});` +
  `var ce=console.error;console.error=function(){S("console",[].map.call(arguments,function(a){try{return a&&a.stack||(typeof a=="object"?JSON.stringify(a):String(a))}catch(_){return String(a)}}).join(" "));return ce.apply(console,arguments)};` +
  `var M=function(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}};` +
  `["localStorage","sessionStorage"].forEach(function(n){try{window[n].getItem("x")}catch(_){try{Object.defineProperty(window,n,{value:M(),configurable:true})}catch(_){}}});` +
  `try{Object.defineProperty(document,"cookie",{get:function(){return""},set:function(){},configurable:true})}catch(_){}` +
  `addEventListener("keydown",function(e){var t=e.target;if(t&&(/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)||t.isContentEditable))return;if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].indexOf(e.key)>=0)e.preventDefault()});` +
  `addEventListener("load",function(){S("ready","")})})()</script>`;

function withBoot(html: string) {
  // Right after <head> (or <html>, or at the very top), on the same line.
  const m = html.match(/<head\b[^>]*>/i) ?? html.match(/<html\b[^>]*>/i);
  if (m) return html.slice(0, m.index! + m[0].length) + BOOT + html.slice(m.index! + m[0].length);
  const d = html.match(/^\s*<!doctype[^>]*>/i);
  return d ? d[0] + BOOT + html.slice(d[0].length) : BOOT + html;
}

// ---------- the panel ----------
interface Deps {
  toast: (msg: string, kind?: string) => void;
  /** Sends a message in the chat (the "Fix it" request); false when a reply is already running. */
  send: (text: string) => boolean;
  /** Puts text in the message box for the user to finish. */
  draft: (text: string) => void;
}

let deps: Deps;
let panel: HTMLElement;
let frame: HTMLIFrameElement | null = null;
let code = ""; // what's running (or about to)
let title = "Canvas";
let errors: string[] = [];
let tab: "run" | "code" = "run";
let shown = false; // the panel is open (it shows on the chat screen)
let onChat = true;
let streaming = false;
let muted = false; // closed while a reply was writing a page: don't pop it open again for that reply

const WIDTH_KEY = "prestige-canvas-width";

export function initCanvas(d: Deps) {
  deps = d;
  panel = $("#canvas");
  const w = Number(read(WIDTH_KEY));
  if (w > 0) setWidth(w);
  $("#canvas-close").addEventListener("click", () => closeCanvas());
  $("#canvas-rerun").addEventListener("click", () => {
    if (tab === "code") code = ($("#canvas-code") as HTMLTextAreaElement).value;
    showTab("run");
    run();
  });
  $("#canvas-fix").addEventListener("click", fixIt);
  $("#canvas-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(currentCode());
      deps.toast("Copied the code.");
    } catch {
      deps.toast("Couldn't copy the code.", "warn");
    }
  });
  panel.querySelectorAll<HTMLButtonElement>("[data-ctab]").forEach((b) => b.addEventListener("click", () => {
    const next = b.dataset.ctab as "run" | "code";
    // Edits in the code view run when you go back to the page.
    if (tab === "code" && next === "run" && ($("#canvas-code") as HTMLTextAreaElement).value !== code) {
      code = ($("#canvas-code") as HTMLTextAreaElement).value;
      showTab("run");
      run();
      return;
    }
    showTab(next);
  }));
  // Errors and "loaded" from the page in the frame (and only from it).
  window.addEventListener("message", (e) => {
    if (!frame || e.source !== frame.contentWindow || !e.data?.__canvas) return;
    let { type, msg } = e.data as { type: string; msg: string };
    // What the browser reports for an error inside a library from a CDN; say what usually causes it.
    if (/^Script error\.?$/.test(msg)) msg = "A script loaded from a CDN failed (no details): often an ES module loaded with a plain <script src>, or the wrong URL.";
    if (type === "ready") {
      setStatus(errors.length ? "" : "Running");
      return;
    }
    if (errors.length >= 20 || errors.includes(msg)) return;
    errors.push(type === "console" ? `console.error: ${msg}` : msg);
    renderErrors();
  });
  // Drag the left edge to resize.
  const grip = $("#canvas-grip");
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    panel.classList.add("resizing");
    const move = (ev: PointerEvent) => setWidth(window.innerWidth - ev.clientX - 8);
    const up = () => {
      grip.removeEventListener("pointermove", move);
      panel.classList.remove("resizing");
      write(WIDTH_KEY, String(Math.round(panel.getBoundingClientRect().width)));
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up, { once: true });
  });
}

function setWidth(px: number) {
  const w = Math.max(340, Math.min(px, window.innerWidth - 380));
  document.documentElement.style.setProperty("--canvas-w", `${w}px`);
}

function read(k: string) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function write(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* not kept */ }
}

const currentCode = () => (tab === "code" ? ($("#canvas-code") as HTMLTextAreaElement).value : code);

function setVisible() {
  const on = shown && onChat;
  panel.hidden = !on;
  document.body.classList.toggle("canvas-open", on);
}

/** The chat screen is (or isn't) showing; the canvas stays open behind the other screens. */
export function canvasOnChat(on: boolean) {
  onChat = on;
  setVisible();
}

export function closeCanvas() {
  if (streaming) muted = true;
  shown = false;
  streaming = false;
  frame?.remove();
  frame = null;
  stopModel();
  setVisible();
}

// ---------- a 3D model (Picture to 3D) ----------
// Not a page: the .glb is drawn by Prestige's own three.js viewer (model3d.ts) in the panel, not in the sandboxed frame,
// so it loads from disk without a CDN or copying the file into the page.
let modelView: { dispose: () => void } | null = null;

function stopModel() {
  modelView?.dispose();
  modelView = null;
  $(".model-view", panel)?.remove();
  panel?.classList.remove("model");
}

/** Shows a 3D model file in the Canvas. `path` is the .glb on disk. */
export async function openModel(path: string, name: string) {
  closeCanvas();
  muted = false;
  shown = true;
  title = name;
  errors = [];
  renderErrors();
  setVisible();
  showTab("run");
  panel.classList.add("model");
  $("#canvas-title").textContent = name;
  setStatus("Loading the model…");
  const view = document.createElement("div");
  view.className = "model-view";
  $("#canvas-stage").appendChild(view);
  try {
    const { mountViewer } = await import("./model3d");
    const v = await mountViewer(view, convertFileSrc(path));
    if (!view.isConnected) return v.dispose(); // closed (or replaced) while it was loading
    modelView = v;
    const s = v.stats;
    setStatus(`${s.triangles.toLocaleString()} triangles · ${s.textures} textures · drag to turn, scroll to zoom`);
  } catch (e) {
    view.remove();
    setStatus(`Couldn't show it: ${e instanceof Error ? e.message : e}`);
  }
}

/** A new reply is starting: it may open the canvas. */
export function canvasReplyStart() {
  muted = false;
}

/** Opens a page in the canvas and runs it. `auto`: opened by a reply finishing, not by the user. */
export function openCanvas(c: { html: string; title: string }, auto = false) {
  if (auto && muted) return;
  streaming = false;
  code = c.html;
  title = c.title;
  shown = true;
  setVisible();
  showTab("run");
  run();
}

/** While a reply is writing a page: the code view follows along, and the page runs once it's complete. */
export function streamCanvas(c: CanvasCode) {
  if (muted) return;
  if (c.done) return openCanvas(c);
  if (!streaming) {
    stopModel();
    streaming = true;
    shown = true;
    errors = [];
    renderErrors();
    frame?.remove();
    frame = null;
    setVisible();
    showTab("code");
  }
  title = c.title;
  $("#canvas-title").textContent = title;
  const ta = $("#canvas-code") as HTMLTextAreaElement;
  ta.value = c.html;
  ta.scrollTop = ta.scrollHeight;
  setStatus(`Writing… ${c.html.split("\n").length} lines`);
}

/** The reply ended without finishing the page (stopped, or the model ran out of room). */
export function streamEnded() {
  if (!streaming) return;
  streaming = false;
  setStatus("Unfinished: ask it to continue, or start a new chat");
}

async function run() {
  stopModel();
  errors = [];
  renderErrors();
  if (/<title[^>]*>[^<]/i.test(code)) title = titleOf(code); // an edit in the Code view may rename it
  $("#canvas-title").textContent = title;
  setStatus("Starting…");
  frame?.remove();
  const f = (frame = document.createElement("iframe"));
  f.className = "canvas-frame";
  f.title = title;
  // Scripts, forms and dialogs, but no same-origin access, top navigation or popups.
  f.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-pointer-lock");
  f.setAttribute("allow", "fullscreen; autoplay; gamepad");
  f.referrerPolicy = "no-referrer";
  const page = withBoot(code);
  if (inTauri) {
    try {
      const id = await invoke<string>("canvas_put", { html: page });
      f.src = convertFileSrc(id, "canvas");
    } catch (e) {
      setStatus(`Couldn't start it: ${e}`);
      return;
    }
  } else f.srcdoc = page; // browser preview of the UI
  if (frame !== f) return; // run again (or closed) while this one was starting
  f.addEventListener("load", () => f.focus());
  $("#canvas-stage").appendChild(f);
  // Games want the keyboard straight away.
  setTimeout(() => frame?.focus(), 60);
}

function showTab(t: "run" | "code") {
  tab = t;
  panel.querySelectorAll<HTMLElement>("[data-ctab]").forEach((b) => b.classList.toggle("on", b.dataset.ctab === t));
  $("#canvas-stage").hidden = t !== "run";
  const ta = $("#canvas-code") as HTMLTextAreaElement;
  ta.hidden = t !== "code";
  if (t === "code" && !streaming) ta.value = code;
  ta.readOnly = streaming;
}

function setStatus(s: string) {
  $("#canvas-status").textContent = s;
}

function renderErrors() {
  const box = $("#canvas-errors");
  box.hidden = !errors.length;
  $("#canvas-fix").classList.toggle("primary", errors.length > 0);
  if (!errors.length) return;
  $("b", box).textContent = `${errors.length} ${errors.length === 1 ? "error" : "errors"}`;
  $("pre", box).textContent = errors.join("\n\n");
  setStatus("");
}

function fixIt() {
  if (!errors.length) {
    deps.draft("Fix the canvas: ");
    return;
  }
  const report = errors.slice(0, 8).join("\n\n");
  const ok = deps.send(
    `The canvas page you wrote shows these errors when it runs:\n\n\`\`\`\n${report}\n\`\`\`\n\n` +
      "Fix them, and anything else that would stop it working, and reply with the complete corrected HTML file in one ```html block.",
  );
  if (!ok) deps.toast("Wait for the reply to finish first.");
}

/** What the chat models are told about the canvas, for requests that want something built. */
export const CANVAS_HINT =
  "Canvas: Prestige runs HTML you write in a Canvas panel beside the chat, where the user can see and play with it. " +
  "When the user asks for something visual or interactive (a game, chart, animation, 3D scene, simulation, or a small app or tool), " +
  "build it as ONE complete, self-contained HTML file in a single ```html code block. Inline all CSS and JavaScript. " +
  "Libraries may load from a CDN over https (for example Chart.js from https://cdn.jsdelivr.net/npm/chart.js, or three.js through an " +
  "import map to https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js); nothing else can be loaded, and there is no server, " +
  "local file or local network. For logic that is easy to get wrong, use a proven library instead of writing it yourself: " +
  "for chess, chess.js 0.10 (<script src=\"https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js\"></script>, a global " +
  "Chess with moves({ verbose: true }), move({ from, to, promotion: \"q\" }), undo(), board(), turn(), in_check(), in_checkmate(), game_over()) " +
  "for the rules, with the computer choosing among those moves. Draw graphics in code (canvas, SVG, CSS, Unicode symbols) instead of using image files. " +
  "The page opens in a panel roughly 600 by 700 pixels: make it fill the window and resize with it, on a dark background. " +
  "Make it work completely: correct rules and logic, keyboard and mouse controls that respond, on-screen score or instructions, and a restart. " +
  "Before the code write at most one short sentence; after it, only how to use it. " +
  "When asked to change or fix it, reply with the whole updated file again, not a fragment. " +
  "The page is not a file on disk, so never use file, edit or command tools for it: the ```html block in your reply is what runs.";

// "Make a snake game", "build me a chart of…", "let's play chess", "/canvas …".
const BUILD =
  /\b(build|make|create|code|write|program|design|generate|render|show|draw|give)\b[\s\S]{0,80}?\b(games?|snake|chess|checkers|tetris|pong|breakout|minesweeper|sudoku|tic[- ]?tac[- ]?toe|2048|flappy|asteroids|app|chart|graph|plot|visuali[sz]ation|dashboard|animation|simulation|sim|3d|three\.?js|scene|canvas|calculator|clock|timer|interactive|demo|website|web ?page|html|ui|widget|diagram|fractal|particles?|visualizer|editor|drawing app|piano|synth|maze|map)\b/i;
const PLAY = /\b(let'?s\s+play|play\s+(a\s+game\s+of\s+)?)(snake|chess|checkers|tetris|pong|tic[- ]?tac[- ]?toe|minesweeper|sudoku|2048)\b/i;
export const CANVAS_CMD = /^\/canvas\b\s*/i;

export function wantsCanvas(text: string) {
  return CANVAS_CMD.test(text) || BUILD.test(text) || PLAY.test(text);
}
