// The working readout: while Prestige is busy (a chat reply thinking, writing or running tools, Deep Research, Do it for
// me, a mission, the render queue) the HUD shows the top hat with its eye glowing and a gold ring turning round it, and
// what's happening right now ("Searching the web for …", "Rendering · 3 of 8", 42%), with who's doing it (the model or
// agent) and the tool it's calling. Clicking it lists every job that's running. Each job is kept under a key ("reply",
// "mission", "render"), so one ending doesn't clear the others.

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

interface Work {
  what: string; // "Chat · Qwen3.8-27B", "Mission · Morning briefing", "Render queue"
  who?: string; // the model or agent doing it: "Qwen3.8-27B", "UI-TARS"
  step: string; // "Thinking…"
  tool?: string; // the tool it's calling now: "web_search"
  pct?: number; // 0–100 when it's known
  t0: number;
}

/** Shown first: what you started beats a mission, which beats the render queue. */
const ORDER = ["reply", "mission", "render"];
const jobs = new Map<string, Work>();
let ticker = 0;
let el: HTMLElement | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Starts a job, or relabels one that's running (keeping its step and clock). */
export function beginWork(key: string, what: string, who?: string) {
  const j = jobs.get(key);
  if (j) Object.assign(j, { what, who: who ?? j.who });
  else jobs.set(key, { what, who, step: "Starting…", t0: Date.now() });
  paint(!j);
}

/** Who's doing a job now (a reply that picks its model after it starts, Do it for me's vision model). */
export function workBy(key: string, who: string) {
  const j = jobs.get(key);
  if (j && j.who !== who) {
    j.who = who;
    paint(false);
  }
}

/** What a job is doing now. `tool` is the tool it's calling (null: none now; left out: the same as before, so a
 *  render's progress doesn't hide the make_image that started it). Ignored when the job isn't running (a late progress
 *  callback after it finished). */
export function stepWork(key: string, step: string, pct?: number, tool?: string | null) {
  const j = jobs.get(key);
  if (!j) return;
  const text = step.trim();
  const t = tool === undefined ? j.tool : (tool ?? undefined);
  if (!text || (text === j.step && pct === j.pct && t === j.tool)) return;
  Object.assign(j, { step: text, pct, tool: t });
  paint(true);
}

export function endWork(key: string) {
  if (jobs.delete(key)) paint(false);
}

export const isWorking = (key?: string) => (key ? jobs.has(key) : jobs.size > 0);

/** "Rendering… (42%)" → 42, so a progress label also fills the bar. */
export const pctOf = (text: string) => {
  const m = text.match(/\((\d{1,3})%\)\s*$/);
  return m ? Math.min(100, Number(m[1])) : undefined;
};

/** What a tool call is doing, in words: web_search {query: "x"} → Searching the web for "x". */
export function toolDoing(name: string, args: any): string {
  const a = args && typeof args === "object" ? args : {};
  const first = Object.values(a).find((v) => typeof v === "string" && v) as string | undefined;
  const q = (s?: string) => (s ? ` for "${s.length > 48 ? s.slice(0, 45) + "…" : s}"` : "");
  const host = (u?: string) => {
    try {
      return u ? new URL(u).hostname.replace(/^www\./, "") : "";
    } catch {
      return "";
    }
  };
  if (name === "plan") return "Planning the searches…";
  if (name === "web_search" || name === "search") return `Searching the web${q(a.query ?? first)}…`;
  if (name === "search_past_chats") return `Looking through past chats${q(a.query ?? first)}…`;
  if (name === "search_my_files") return `Searching your files${q(a.query ?? first)}…`;
  if (/^(read|fetch|fetch_url|read_url|read_page)$/.test(name)) return `Reading ${host(a.url ?? first) || "a page"}…`;
  if (name === "make_image") return "Making a picture…";
  if (name === "make_video") return "Making a video…";
  if (name === "edit_image") return "Editing the picture…";
  return `Running ${name.replace(/_/g, " ")}…`;
}

function lead(): [string, Work] | undefined {
  const keys = [...jobs.keys()].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  return keys.length ? [keys[0], jobs.get(keys[0])!] : undefined;
}

/** `changed`: the step itself changed (it rises into place), not just the clock. */
function paint(changed: boolean) {
  if (!el) return;
  const on = jobs.size > 0;
  document.body.classList.toggle("working", on);
  el.hidden = !on;
  if (!on) {
    clearInterval(ticker);
    ticker = 0;
    $(".wk-pop", el.parentElement!)?.setAttribute("hidden", "");
    return;
  }
  if (!ticker) ticker = window.setInterval(() => paint(false), 1000);
  const [, j] = lead()!;
  const who = $(".wk-who", el);
  who.hidden = !j.who;
  who.textContent = j.who ?? "";
  const tool = $(".wk-tool", el);
  tool.hidden = !j.tool;
  tool.textContent = j.tool ?? "";
  el.classList.toggle("calling", !!j.tool);
  const step = $(".wk-step", el);
  if (step.textContent !== j.step) {
    step.textContent = j.step;
    if (changed) {
      step.classList.remove("rise");
      void step.offsetWidth; // restarts the animation
      step.classList.add("rise");
    }
  }
  $(".wk-time", el).textContent = clock(Date.now() - j.t0);
  const more = $(".wk-more", el);
  more.hidden = jobs.size < 2;
  more.textContent = `+${jobs.size - 1}`;
  el.style.setProperty("--v", String(j.pct ?? 0));
  el.classList.toggle("has-pct", j.pct != null);
  el.title = [...jobs.values()].map((w) => `${w.what}${w.who ? ` (${w.who})` : ""}: ${w.tool ? `${w.tool} · ` : ""}${w.step}`).join("\n");
  const pop = $(".wk-pop", el.parentElement!);
  if (pop && !pop.hidden) paintPop(pop);
}

function paintPop(pop: HTMLElement) {
  const now = Date.now();
  pop.innerHTML = [...jobs.entries()]
    .sort(([a], [b]) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99))
    .map(
      ([, w]) => `<div class="wk-job">
        <div class="wk-job-head"><b>${esc(w.what)}</b><span>${clock(now - w.t0)}</span></div>
        ${w.who ? `<div class="wk-job-who">by ${esc(w.who)}</div>` : ""}
        <div class="wk-job-step">${w.tool ? `<span class="wk-tool">${esc(w.tool)}</span>` : ""}${esc(w.step)}${w.pct != null ? ` · ${Math.round(w.pct)}%` : ""}</div>
        ${w.pct != null ? `<div class="progress" style="--v:${w.pct}"><i></i></div>` : `<div class="wk-scan"></div>`}
      </div>`,
    )
    .join("");
}

/** Builds the readout into the HUD, before `before`. */
export function initWorking(before: Element) {
  const wrap = document.createElement("div");
  wrap.className = "wk-wrap";
  wrap.innerHTML = `
    <button type="button" class="wk-readout" id="working" hidden aria-live="polite">
      <span class="wk-orb" aria-hidden="true"><span class="wk-ring"></span><svg class="mark" viewBox="0 0 600 600"><use href="#rg-mark" /></svg></span>
      <span class="wk-who" hidden></span>
      <span class="wk-tool" hidden></span>
      <span class="wk-step"></span>
      <span class="wk-time"></span>
      <span class="wk-more" hidden></span>
    </button>
    <div class="wk-pop" hidden></div>`;
  before.parentElement!.insertBefore(wrap, before);
  el = $(".wk-readout", wrap);
  const pop = $(".wk-pop", wrap);
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    if (!pop.hidden) paintPop(pop);
  });
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target as Node)) pop.hidden = true;
  });
}
