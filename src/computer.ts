// Computer use ("Do it for me"): a vision model works through a task on this PC one action at a time. Each step takes
// a screenshot of the primary screen (computer.rs), asks the model for the next action as JSON on a 0-1000 grid, shows
// it on the screenshot, waits for "Do it" (when Ask before each step is on, the default), then clicks, types, presses
// keys or scrolls through Windows' SendInput. While it runs Prestige is a small panel in a corner, always on top and
// left out of the screenshots; Stop ends it at any time. The run is posted in the chat afterwards: every step, and the
// model's summary.
import { invoke } from "@tauri-apps/api/core";
import { errMsg, streamChat, type ChatMessage, type ModelInfo } from "./backends";

/** "/do open Notepad and write a haiku" (or /computer). */
export const DO_CMD = /^\/(?:do|computer)\b\s*/i;

const MAX_STEPS = 40;
const SETTLE_MS = 900; // after an action, before the next screenshot (menus open, pages start loading)

export interface CuAction {
  action: string;
  x?: number;
  y?: number;
  to_x?: number;
  to_y?: number;
  text?: string;
  keys?: string;
  direction?: string;
  amount?: number;
  seconds?: number;
  summary?: string;
}

export interface CuStep {
  n: number;
  act: CuAction;
  thought: string;
  state: "done" | "skipped" | "failed";
  note?: string;
  ms: number; // the model's time for this step
}

export interface CuResult {
  status: "done" | "failed" | "stopped" | "limit";
  summary: string;
  steps: CuStep[];
  model: string;
  seconds: number;
}

interface Shot {
  image: string;
  width: number;
  height: number;
  w: number;
  h: number;
}

const SYSTEM = `You operate a Windows PC for the user. Each turn you get a screenshot of the screen and choose ONE action.
Positions are on a 0-1000 grid over the screenshot: x from the left edge (0) to the right edge (1000), y from the top (0) to the bottom (1000). Aim at the middle of the thing to click.

Reply with one JSON object and nothing else:
{"thought": "<one or two short sentences: what you see, and why this action>", "action": "<name>", ...}

Actions:
{"action": "click", "x": 500, "y": 300}            also "double_click" and "right_click"
{"action": "type", "text": "hello"}                types into the field that has the keyboard (click it first)
{"action": "key", "keys": "ctrl+s"}                one key or a combination: enter, tab, esc, backspace, delete, up, down, left, right, home, end, pageup, pagedown, space, win, f1-f12, letters, digits, joined with +
{"action": "scroll", "x": 500, "y": 500, "direction": "down", "amount": 5}   direction up, down, left or right; amount in wheel notches
{"action": "drag", "x": 100, "y": 200, "to_x": 600, "to_y": 200}
{"action": "wait", "seconds": 2}                   when something is still loading
{"action": "done", "summary": "..."}               the task is finished: say what you did and anything the user should know
{"action": "fail", "summary": "..."}               it can't be done, or only the user can go on: say why

Rules:
- Check the new screenshot to see whether your last action worked before going on; if it didn't, try another way.
- To open an app, press win, type its name, wait a moment, then press enter.
- Use the keyboard when it's simpler: type numbers and text, and use shortcuts, rather than clicking small keys or buttons.
- Never type passwords, card numbers or other secrets, never buy, pay or send money, never send messages or emails the task didn't ask for, and don't delete anything the task doesn't name. Stop with "fail" and say what the user needs to do instead.
- A login screen, a captcha or a security prompt is for the user: stop with "fail".`;

/** The first JSON object in a reply (models wrap it in prose or code fences), with small slips mended: a stray quote
 *  after a number ("y":380"}, seen from Nex-N2.5) and trailing commas. */
function firstJson(text: string): any {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const tries = [m[0], m[0].replace(/(:\s*-?\d+(?:\.\d+)?)"(?=\s*[,}\]])/g, "$1").replace(/,(\s*[}\]])/g, "$1")];
  for (const s of tries) {
    try {
      return JSON.parse(s);
    } catch {}
  }
  // A second object or prose after it: cut at the first balanced close.
  const s = tries[1];
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) {
      try {
        return JSON.parse(s.slice(0, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

const ACTIONS = new Set(["click", "double_click", "right_click", "type", "key", "scroll", "drag", "wait", "done", "fail", "move"]);

/** The model's reply as an action, or null when it isn't one. Accepts a few common variants. */
export function parseAction(text: string): { act: CuAction; thought: string } | null {
  const j = firstJson(text);
  if (!j || typeof j !== "object") return null;
  const inner = typeof j.action === "object" && j.action ? j.action : j;
  let name = String(inner.action ?? inner.type ?? inner.name ?? "").toLowerCase().replace(/[\s-]/g, "_");
  if (name === "left_click") name = "click";
  if (name === "doubleclick") name = "double_click";
  if (name === "rightclick") name = "right_click";
  if (name === "hotkey" || name === "press") name = "key";
  if (name === "finish" || name === "finished" || name === "complete") name = "done";
  if (!ACTIONS.has(name)) return null;
  const num = (v: any) => (v == null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
  // [x, y] pairs as "coordinate" / "point" / "start" are accepted too.
  const pair = (v: any) => (Array.isArray(v) && v.length >= 2 ? [num(v[0]), num(v[1])] : [undefined, undefined]);
  // …and a pair in "x" alone ("x": [334, 309]), which Qwen3.8 writes now and then.
  const [px, py] = pair(inner.coordinate ?? inner.coordinates ?? inner.point ?? inner.start ?? (Array.isArray(inner.x) ? inner.x : undefined));
  if (Array.isArray(inner.x)) inner.x = undefined;
  const [tx, ty] = pair(inner.to ?? inner.end);
  const act: CuAction = {
    action: name,
    x: num(inner.x) ?? px,
    y: num(inner.y) ?? py,
    to_x: num(inner.to_x) ?? tx,
    to_y: num(inner.to_y) ?? ty,
    text: inner.text != null ? String(inner.text) : undefined,
    keys: inner.keys != null ? String(Array.isArray(inner.keys) ? inner.keys.join("+") : inner.keys) : inner.key != null ? String(inner.key) : undefined,
    direction: inner.direction ? String(inner.direction).toLowerCase() : undefined,
    amount: num(inner.amount),
    seconds: num(inner.seconds),
    summary: inner.summary != null ? String(inner.summary) : inner.text != null && (name === "done" || name === "fail") ? String(inner.text) : undefined,
  };
  const needsPoint = ["click", "double_click", "right_click", "drag", "move"].includes(name);
  if (needsPoint && (act.x == null || act.y == null)) return null;
  if (name === "drag" && (act.to_x == null || act.to_y == null)) return null;
  if (name === "type" && !act.text) return null;
  if (name === "key" && !act.keys) return null;
  return { act, thought: String(j.thought ?? j.reasoning ?? inner.thought ?? "").trim() };
}

/** "Click at (512, 300)", "Type "hello"", "Press ctrl+s"… for the panel and the chat. */
export function describe(a: CuAction): string {
  const at = a.x != null ? ` at (${Math.round(a.x)}, ${Math.round(a.y!)})` : "";
  const quote = (s = "") => `"${s.length > 50 ? s.slice(0, 47) + "…" : s}"`;
  switch (a.action) {
    case "click":
      return `Click${at}`;
    case "double_click":
      return `Double-click${at}`;
    case "right_click":
      return `Right-click${at}`;
    case "move":
      return `Move the pointer${at}`;
    case "type":
      return `Type ${quote(a.text)}`;
    case "key":
      return `Press ${a.keys}`;
    case "scroll":
      return `Scroll ${a.direction ?? "down"} ${a.amount ?? 3}${at}`;
    case "drag":
      return `Drag from (${Math.round(a.x!)}, ${Math.round(a.y!)}) to (${Math.round(a.to_x!)}, ${Math.round(a.to_y!)})`;
    case "wait":
      return `Wait ${a.seconds ?? 2} s`;
    default:
      return a.action;
  }
}

/** A point on the model's grid in screen pixels. A model that answers in the screenshot's own pixels (over 1000) is
 *  scaled from those instead. */
function toScreen(x: number, y: number, s: Shot): [number, number] {
  const grid = x <= 1000 && y <= 1000;
  const fx = grid ? x / 1000 : x / s.w;
  const fy = grid ? y / 1000 : y / s.h;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.round(v)));
  return [clamp(fx * s.width, s.width), clamp(fy * s.height, s.height)];
}

/** Carries out an action on the screen. */
async function perform(a: CuAction, s: Shot) {
  const pt = (x: number, y: number) => toScreen(x, y, s);
  switch (a.action) {
    case "click":
    case "double_click":
    case "right_click": {
      const [x, y] = pt(a.x!, a.y!);
      await invoke("cu_act", { action: { kind: "click", x, y, button: a.action === "right_click" ? "right" : "left", count: a.action === "double_click" ? 2 : 1 } });
      break;
    }
    case "move": {
      const [x, y] = pt(a.x!, a.y!);
      await invoke("cu_act", { action: { kind: "move", x, y } });
      break;
    }
    case "drag": {
      const [x, y] = pt(a.x!, a.y!);
      const [to_x, to_y] = pt(a.to_x!, a.to_y!);
      await invoke("cu_act", { action: { kind: "drag", x, y, to_x, to_y } });
      break;
    }
    case "scroll": {
      const [x, y] = a.x != null && a.y != null ? pt(a.x, a.y) : [Math.round(s.width / 2), Math.round(s.height / 2)];
      const n = Math.max(1, Math.min(15, Math.round(a.amount ?? 3)));
      const d = a.direction ?? "down";
      await invoke("cu_act", { action: { kind: "scroll", x, y, dx: d === "right" ? n : d === "left" ? -n : 0, dy: d === "down" ? n : d === "up" ? -n : 0 } });
      break;
    }
    case "type":
      await invoke("cu_act", { action: { kind: "type", text: a.text } });
      break;
    case "key":
      await invoke("cu_act", { action: { kind: "key", keys: a.keys } });
      break;
    case "wait":
      await sleep(Math.max(0.5, Math.min(10, a.seconds ?? 2)) * 1000);
      break;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- the panel ----------
const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

type Decision = "go" | "skip" | "stop";

class Panel {
  el: HTMLElement;
  private decide: ((d: Decision) => void) | null = null;
  ask = true;
  stopped = false;
  onStop: () => void = () => {};

  constructor(task: string, model: string) {
    this.el = document.createElement("section");
    this.el.className = "cu";
    this.el.innerHTML = `
      <div class="cu-head"><b>Doing it for you</b><span class="cu-count"></span></div>
      <p class="cu-task"></p>
      <div class="cu-shot"><img alt="The screen as the model sees it" /><i class="cu-dot" hidden></i><i class="cu-dot to" hidden></i></div>
      <p class="cu-status">Starting…</p>
      <div class="cu-next" hidden>
        <p class="cu-what"></p>
        <p class="cu-why"></p>
        <div class="cu-acts"><button type="button" class="btn primary" data-d="go">Do it</button><button type="button" class="btn" data-d="skip">Skip</button></div>
      </div>
      <label class="check cu-ask"><input type="checkbox" checked /> Ask before each step</label>
      <ol class="cu-log"></ol>
      <button type="button" class="btn cu-stop">■ Stop</button>
      <p class="cu-model"></p>`;
    $(".cu-task", this.el).textContent = task;
    $(".cu-model", this.el).textContent = `${model} · Prestige is left out of its screenshots`;
    $(".cu-ask input", this.el).addEventListener("change", (e) => {
      this.ask = (e.target as HTMLInputElement).checked;
      // Turning it off while a step waits lets that step go.
      if (!this.ask) this.resolve("go");
    });
    this.el.querySelectorAll<HTMLButtonElement>("[data-d]").forEach((b) => b.addEventListener("click", () => this.resolve(b.dataset.d as Decision)));
    $(".cu-stop", this.el).addEventListener("click", () => this.stop());
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.stop();
    });
    document.body.appendChild(this.el);
    document.body.classList.add("cu-on");
  }

  private resolve(d: Decision) {
    const f = this.decide;
    this.decide = null;
    $(".cu-next", this.el).hidden = true;
    f?.(d);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.status("Stopping…");
    this.resolve("stop");
    this.onStop();
  }

  status(t: string) {
    $(".cu-status", this.el).textContent = t;
  }

  count(n: number) {
    $(".cu-count", this.el).textContent = `step ${n} of up to ${MAX_STEPS}`;
  }

  shot(s: Shot) {
    ($("img", this.el) as HTMLImageElement).src = `data:image/jpeg;base64,${s.image}`;
    this.mark(null);
  }

  /** The proposed action's spot on the screenshot (and a drag's end). */
  mark(a: CuAction | null) {
    const [dot, to] = Array.from(this.el.querySelectorAll<HTMLElement>(".cu-dot"));
    const put = (d: HTMLElement, x?: number, y?: number) => {
      d.hidden = x == null || y == null || x > 1000 || y > 1000;
      if (!d.hidden) {
        d.style.left = `${x! / 10}%`;
        d.style.top = `${y! / 10}%`;
      }
    };
    put(dot, a?.x, a?.y);
    put(to, a?.to_x, a?.to_y);
  }

  /** Shows the next action; resolves with what the user chose (straight away when asking is off). */
  propose(a: CuAction, thought: string): Promise<Decision> {
    this.mark(a);
    $(".cu-what", this.el).textContent = `Next: ${describe(a)}`;
    $(".cu-why", this.el).textContent = thought;
    if (!this.ask) {
      $(".cu-next", this.el).hidden = true;
      return Promise.resolve("go");
    }
    $(".cu-next", this.el).hidden = false;
    this.status("Waiting for you: Do it, or Skip to have it try something else");
    ($('[data-d="go"]', this.el) as HTMLButtonElement).focus();
    return new Promise((r) => (this.decide = r));
  }

  log(step: CuStep) {
    const li = document.createElement("li");
    li.className = step.state;
    li.textContent = `${describe(step.act)}${step.state === "skipped" ? " (skipped)" : step.state === "failed" ? ` (failed: ${step.note})` : ""}`;
    li.title = step.thought;
    const log = $(".cu-log", this.el);
    log.prepend(li);
  }

  close() {
    this.el.remove();
    document.body.classList.remove("cu-on");
  }
}

/** A nudge when the model keeps doing the same thing (Nex-N2.5 once clicked the same Calculator key and cleared it
 *  for 17 steps): the same action, near the same spot, 3 or more times in the last 6 steps. */
export function repeating(steps: CuStep[]): string {
  const recent = steps.slice(-6);
  const last = recent[recent.length - 1];
  if (!last) return "";
  const same = (a: CuAction, b: CuAction) =>
    a.action === b.action && a.text === b.text && a.keys === b.keys && (a.x == null || (Math.abs(a.x - b.x!) <= 15 && Math.abs(a.y! - b.y!) <= 15));
  const n = recent.filter((s) => same(s.act, last.act)).length;
  // Or going round in circles: six steps that are only two or three different actions (click 1, click C, click 1…).
  const kinds: CuAction[] = [];
  for (const s of recent) if (!kinds.some((k) => same(k, s.act))) kinds.push(s.act);
  const circling = recent.length === 6 && kinds.length <= 3;
  const what = n >= 3 ? `"${describe(last.act)}" ${n} times in the last ${recent.length} steps` : circling ? `the same ${kinds.length} actions over and over` : "";
  return what
    ? `\n\nWarning: you've done ${what} and it isn't getting the task done. Do something different: use the keyboard instead, try another control, or stop with "fail" and say what's in the way.`
    : "";
}

/** Runs a task to the end (done, failed, stopped or the step limit) and returns what happened. */
export async function doItForMe(task: string, model: ModelInfo): Promise<CuResult> {
  const t0 = Date.now();
  const steps: CuStep[] = [];
  const ctrl = new AbortController();
  const panel = new Panel(task, model.name);
  panel.onStop = () => ctrl.abort();
  const result = (status: CuResult["status"], summary: string): CuResult => ({ status, summary, steps, model: model.name, seconds: Math.round((Date.now() - t0) / 1000) });
  await invoke("cu_panel", { on: true });
  // Let the window shrink and the panel paint before the first screenshot.
  await sleep(500);
  try {
    let retry = "";
    let misses = 0; // replies in a row that weren't an action
    for (let n = 1; n <= MAX_STEPS; n++) {
      if (panel.stopped) return result("stopped", "Stopped.");
      panel.count(n);
      panel.status("Looking at the screen…");
      const shot = await invoke<Shot>("cu_screenshot", { max: 1280 });
      panel.shot(shot);
      const history = steps.length
        ? steps
            .slice(-15)
            .map((s) => `${s.n}. ${describe(s.act)}${s.state === "skipped" ? " (the user skipped this; do something else)" : s.state === "failed" ? ` (failed: ${s.note})` : ""}${s.thought ? ` because: ${s.thought}` : ""}`)
            .join("\n")
        : "Nothing yet.";
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Task: ${task}\n\nSteps so far:\n${history}${repeating(steps)}\n\nThis is the screen now (${shot.width}×${shot.height}). What's the next action?${retry}`,
          images: [shot.image],
        },
      ];
      const ts = Date.now();
      let out = "";
      const tick = setInterval(() => panel.status(`${model.name} is deciding… ${Math.round((Date.now() - ts) / 1000)} s`), 1000);
      try {
        await streamChat(model, messages, { onToken: (t) => (out += t), onThinking: () => {}, onStats: () => {} }, ctrl.signal, undefined, { think: false });
      } finally {
        clearInterval(tick);
      }
      const ms = Date.now() - ts;
      const p = parseAction(out);
      if (!p) {
        if (++misses > 2) return result("failed", `${model.name} didn't answer with an action it could take: ${out.slice(0, 200)}`);
        retry = `\n\nYour last reply wasn't a valid action: ${out.slice(0, 300)}\nReply with only the JSON object, exactly as in the examples.`;
        n--;
        continue;
      }
      retry = "";
      misses = 0;
      const { act, thought } = p;
      if (act.action === "done") return result("done", act.summary || thought || "Done.");
      if (act.action === "fail") return result("failed", act.summary || thought || "It couldn't finish.");
      const d = await panel.propose(act, thought);
      if (d === "stop" || panel.stopped) return result("stopped", "Stopped.");
      const step: CuStep = { n, act, thought, state: "done", ms };
      if (d === "skip") step.state = "skipped";
      else {
        panel.status(`${describe(act)}…`);
        try {
          await perform(act, shot);
        } catch (e) {
          step.state = "failed";
          step.note = errMsg(e);
        }
        await sleep(SETTLE_MS);
      }
      steps.push(step);
      panel.log(step);
    }
    return result("limit", `It stopped after ${MAX_STEPS} steps without finishing.`);
  } catch (e) {
    if (ctrl.signal.aborted || panel.stopped) return result("stopped", "Stopped.");
    return result("failed", errMsg(e));
  } finally {
    panel.close();
    await invoke("cu_panel", { on: false }).catch(() => {});
  }
}

/** The models that can drive the PC: ones that see pictures, the best computer-use picks first. Nex-N2.5-mini was
 *  trained for it and took ~10 s a step on an RTX 3060 + 2060 against ~33 s for Qwen3.8 27B (whose 2-card preset runs
 *  its vision projector on the CPU), and finished tasks Qwen3.8 got stuck on, so it leads when it's installed. */
export function brains(models: ModelInfo[], canSee: (m: ModelInfo) => boolean): ModelInfo[] {
  const rank = (m: ModelInfo) => (/nex.?n2\.5/i.test(m.id) ? 0 : /qwen3\.8.*27b/i.test(m.id) ? 1 : /qwen3(\.\d)?-?vl|qwen3\.6/i.test(m.id) ? 2 : 3);
  return models.filter((m) => canSee(m) && !/ui-tars/i.test(m.id)).sort((a, b) => rank(a) - rank(b) || a.order - b.order);
}
