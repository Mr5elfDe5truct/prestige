// Missions: jobs Prestige runs on a schedule while it's open, like a morning briefing. Each one is a prompt for a chat
// model (with read-only tools: web search, the Reddit / Hugging Face / GitHub scout, past chats, your files) or a Deep
// Research question, run daily at a time (on chosen days) or every few hours. Nobody is there to say "Allow?", so tools
// that would ask are declined, and the model is told to say what it would have done. Each result is saved as a chat
// ("Mission · name · date") and announced with a notification. A mission that came due while Prestige was closed
// runs once when it opens if "catch up" is on, and is skipped otherwise.
import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { ctxOf, errMsg, streamChat, type ChatMessage, type ModelInfo } from "./backends";
import { supportsTools } from "./caps";
import { deepResearch } from "./research";
import { GROUPS, LAST_ROUND, TOOL_ROUNDS, fitToolResults, loadTools, withoutToolCalls, runTool, toolSpecs, type ToolStep } from "./tools";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

export interface When {
  kind: "daily" | "every";
  time: string; // "08:00" (daily)
  days: number[]; // 0 = Sunday … 6 = Saturday (daily); all seven = every day
  hours: number; // every N hours (every)
}

export interface Mission {
  id: string;
  name: string;
  prompt: string;
  how: "chat" | "research";
  groups: string[]; // tool groups a chat mission may use (read-only tools only; the rest are declined)
  model?: string; // a model's key; unset = the model picked in Chat
  when: When;
  catchUp: boolean;
  enabled: boolean;
  next?: number; // when it runs next (ms)
  last?: { at: number; ok: boolean; skipped?: boolean; chatId?: string; note: string; secs?: number };
}

/** A chat as main.ts stores it (only what missions write). */
export interface SavedChat {
  id: string;
  title: string;
  created: number;
  updated: number;
  model?: string;
  messages: { role: "user" | "assistant"; content: string; model?: string; note?: string; tools?: ToolStep[]; error?: boolean; thinking?: string }[];
}

interface Deps {
  toast: (msg: string, kind?: string) => void;
  models: () => ModelInfo[];
  current: () => ModelInfo | null;
  /** The system prompt every chat gets (the user's name and note), and the tool-use hint. */
  system: () => string;
  toolsHint: string;
  /** A reply or computer use is running: missions wait so they don't swap the model out from under it. */
  busy: () => boolean;
  saved: (chatId: string) => void; // a mission's chat was saved (refresh Past chats)
  openChat: (chatId: string) => void;
}

const DAY = 86_400_000;
const LATE_MS = 5 * 60_000; // more than this past its time when noticed: it was missed (Prestige closed or asleep)
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const UNATTENDED =
  "This is a scheduled mission: it runs in the background and nobody is watching, so write the result as a finished " +
  "report for the user to read later. Tools that change things or need approval are declined automatically; don't " +
  "retry them, and say in the report what you would have done instead. Today is ";

/** Ready-made missions. */
export const TEMPLATES: { name: string; about: string; m: Omit<Mission, "id" | "enabled"> }[] = [
  {
    name: "Daily r/LocalLLaMA + Hugging Face briefing",
    about: "Every morning: the day's top r/LocalLLaMA posts and the trending GGUF models on Hugging Face, as a short briefing.",
    m: {
      name: "LocalLLaMA + Hugging Face briefing",
      how: "chat",
      groups: ["workstation", "web"],
      when: { kind: "daily", time: "08:00", days: [0, 1, 2, 3, 4, 5, 6], hours: 24 },
      catchUp: true,
      prompt:
        "Make my morning local-AI briefing.\n" +
        "1. Call reddit_top with subreddit LocalLLaMA and period day, and pick the 5-8 posts that matter most: new models, releases, benchmarks, tools, news.\n" +
        "2. Call hf_models (sort trendingScore, GGUF only) and pick the 5 most interesting trending models, with their sizes where they're given.\n" +
        "3. Write the briefing in Markdown: a one-line summary of the day, then **Reddit** and **Hugging Face** sections, each item with one line on why it matters and its link. End with what looks worth trying on a 12 GB GPU.",
    },
  },
  {
    name: "Morning news on a topic",
    about: "Deep Research every weekday morning on what's new in a topic you choose (edit the question).",
    m: {
      name: "Morning news",
      how: "research",
      groups: [],
      when: { kind: "daily", time: "07:30", days: [1, 2, 3, 4, 5], hours: 24 },
      catchUp: false,
      prompt: "What are the most important new developments in open-weight AI models in the last 24 hours?",
    },
  },
  {
    name: "Weekly GitHub projects to watch",
    about: "Monday mornings: new and rising local-AI projects on GitHub from the past week.",
    m: {
      name: "GitHub projects to watch",
      how: "chat",
      groups: ["workstation"],
      when: { kind: "daily", time: "09:00", days: [1], hours: 24 },
      catchUp: true,
      prompt:
        "Find new and rising local-AI projects on GitHub from the past 7 days: call github_search a few times (for example \"llm\", \"local ai\", \"gguf\", \"comfyui\", \"agent\"), with days 7. " +
        "List the 8 most interesting with stars, what each does in one line, and its link, then say which one or two are worth trying here.",
    },
  },
];

// ---------- the schedule ----------
/** The next time a mission should run after `from` (its last run for "every"). */
export function nextTime(w: When, from: number): number {
  if (w.kind === "every") return from + Math.max(1, w.hours) * 3_600_000;
  const [h, min] = w.time.split(":").map(Number);
  const days = w.days.length ? w.days : [0, 1, 2, 3, 4, 5, 6];
  const d = new Date(from);
  d.setHours(h || 0, min || 0, 0, 0);
  for (let i = 0; i < 8; i++) {
    const t = new Date(d.getTime() + i * DAY);
    t.setHours(h || 0, min || 0, 0, 0); // across a clock change, keep the wall-clock time
    if (t.getTime() > from && days.includes(t.getDay())) return t.getTime();
  }
  return from + DAY;
}

/** "Daily at 08:00", "Mon, Wed at 07:30", "Every 6 hours". */
export function whenText(w: When): string {
  if (w.kind === "every") return w.hours === 1 ? "Every hour" : `Every ${w.hours} hours`;
  const d = [...w.days].sort();
  const days = d.length === 7 || !d.length ? "Daily" : d.join() === "1,2,3,4,5" ? "Weekdays" : d.join() === "0,6" ? "Weekends" : d.map((x) => DAYS[x]).join(", ");
  return `${days} at ${w.time}`;
}

const at = (t: number) => new Date(t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// ---------- state ----------
let deps: Deps;
let missions: Mission[] = [];
let running: string | null = null; // the mission running now
let runCtrl: AbortController | null = null;
const queue: string[] = [];

async function save() {
  await invoke("store_set", { name: "missions", value: missions }).catch((e) => deps.toast(`Couldn't save missions: ${errMsg(e)}`, "warn"));
}

/** Loads the missions and starts the clock (every 30 s). Missed runs are caught up or skipped now. */
export async function initMissions(d: Deps) {
  deps = d;
  try {
    const v = await invoke<any>("store_get", { name: "missions" });
    missions = Array.isArray(v) ? v : [];
  } catch {
    missions = [];
  }
  wireSheet();
  tick();
  setInterval(tick, 30_000);
}

/** Queues what's due; a run waits while a reply or computer use is going. */
function tick() {
  const now = Date.now();
  let changed = false;
  for (const m of missions) {
    if (!m.enabled) continue;
    if (!m.next) {
      m.next = nextTime(m.when, m.last?.at && m.when.kind === "every" ? m.last.at : now);
      changed = true;
      continue;
    }
    if (now < m.next || queue.includes(m.id) || running === m.id) continue;
    const missed = now - m.next > LATE_MS;
    if (missed && !m.catchUp) {
      m.last = { at: now, ok: false, skipped: true, note: `the run due ${at(m.next)} (Prestige wasn't open)` };
      m.next = nextTime(m.when, now);
      changed = true;
      continue;
    }
    queue.push(m.id);
  }
  if (changed) {
    save();
    renderList();
  }
  pump();
}

/** What a queued mission is waiting for, or "" when it can start. */
function waiting(): string {
  if (running) return `"${missions.find((x) => x.id === running)?.name ?? "another mission"}" finishes`;
  if (deps.busy()) return "the current reply finishes";
  // At startup the services may still be starting.
  if (!deps.models().length) return "the chat models are up";
  return "";
}

async function pump() {
  // Otherwise the next tick (every 30 s) tries again.
  if (!queue.length || waiting()) return;
  const id = queue.shift();
  const m = missions.find((x) => x.id === id);
  if (!m) return pump();
  await runMission(m);
  pump();
}

/** The model a mission uses: its own pick if that's still installed, else the one picked in Chat. */
function modelFor(m: Mission): ModelInfo | null {
  return deps.models().find((x) => x.key === m.model) ?? deps.current();
}

/** Runs a mission now and saves the result as a chat. */
export async function runMission(m: Mission) {
  const model = modelFor(m);
  const t0 = Date.now();
  running = m.id;
  runCtrl = new AbortController();
  renderList();
  const stamp = new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const chat: SavedChat = { id, title: `Mission · ${m.name} · ${stamp}`, created: t0, updated: t0, model: model?.name, messages: [{ role: "user", content: m.prompt }] };
  const reply: SavedChat["messages"][number] = { role: "assistant", content: "", model: model?.name ?? "no model", tools: [] };
  try {
    if (!model) throw new Error("no chat model is available (start the services)");
    if (m.how === "research") {
      const step = (name: string, arg: string) => {
        const s: ToolStep = { name, args: name === "read" ? { url: arg } : name === "plan" ? { goal: arg } : { query: arg } };
        reply.tools!.push(s);
        const t = performance.now();
        return { done: (ok: boolean, result?: string) => Object.assign(s, { ok, ms: Math.round(performance.now() - t), result: result && result.length > 2000 ? result.slice(0, 2000) + "…" : result }) };
      };
      const res = await deepResearch(m.prompt, model, { step, status: () => {}, thinking: () => {}, token: () => {} }, runCtrl.signal, "");
      reply.content = res.report;
      reply.note = `mission · deep research · ${res.sources.length} sources · ${Math.max(1, Math.round((Date.now() - t0) / 60000))} min`;
    } else {
      await chatRun(m, model, reply, runCtrl.signal);
      const used = reply.tools!.length;
      const declined = reply.tools!.filter((s) => s.denied).length;
      reply.note = `mission · ${used} tool call${used === 1 ? "" : "s"}${declined ? ` (${declined} declined)` : ""} · ${Math.round((Date.now() - t0) / 1000)} s`;
    }
    if (!reply.content.trim()) throw new Error(`${model.name} didn't write anything`);
    m.last = { at: Date.now(), ok: true, chatId: id, note: reply.note!, secs: Math.round((Date.now() - t0) / 1000) };
  } catch (e) {
    const stopped = runCtrl.signal.aborted;
    reply.error = !stopped;
    reply.content = stopped ? "*(stopped)*" : `The mission didn't finish: ${errMsg(e)}`;
    m.last = { at: Date.now(), ok: false, chatId: id, note: stopped ? "stopped" : errMsg(e), secs: Math.round((Date.now() - t0) / 1000) };
  } finally {
    chat.messages.push(reply);
    chat.updated = Date.now();
    try {
      await invoke("save_chat", { id, chat });
      deps.saved(id);
    } catch (e) {
      deps.toast(`Couldn't save the mission's chat: ${errMsg(e)}`, "warn");
    }
    m.next = nextTime(m.when, Date.now());
    running = null;
    runCtrl = null;
    await save();
    renderList();
    announce(m);
  }
}

/** A chat mission: the model with the mission's read-only tools, up to TOOL_ROUNDS rounds of tool calls. */
async function chatRun(m: Mission, model: ModelInfo, reply: SavedChat["messages"][number], signal: AbortSignal) {
  const today = new Date().toLocaleString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  const messages: ChatMessage[] = [
    { role: "system", content: `${deps.system()}\n\n${UNATTENDED}${today}.` },
    { role: "user", content: m.prompt },
  ];
  const groups = new Set(m.groups);
  let specs: any[] | undefined;
  let defs: Awaited<ReturnType<typeof loadTools>>["tools"] = [];
  if (groups.size && (await supportsTools(model))) {
    const t = await loadTools();
    defs = t.tools.filter((x) => groups.has(x.group));
    specs = defs.length ? toolSpecs(t.tools, groups) : undefined;
    if (specs) messages[0].content += `\n\n${deps.toolsHint}`;
  }
  let thinking = "";
  for (let round = 0; round <= TOOL_ROUNDS; round++) {
    const before = reply.content.length;
    const last = round === TOOL_ROUNDS || (round > 0 && !fitToolResults(messages, ctxOf(model), Math.round(ctxOf(model) / 4)));
    if (last) messages.push(LAST_ROUND);
    const res = await streamChat(model, messages, { onToken: (t) => (reply.content += t), onThinking: (t) => (thinking += t), onStats: () => {} }, signal, last ? undefined : specs);
    if (last || !res.toolCalls.length || signal.aborted) break;
    messages.push({ role: "assistant", content: reply.content.slice(before), tool_calls: res.toolCalls });
    for (const call of res.toolCalls) {
      const def = defs.find((d) => d.name === call.name);
      const step: ToolStep = { name: call.name, args: call.arguments };
      reply.tools!.push(step);
      let result: string;
      if (!def) {
        result = `There is no tool called ${call.name}.`;
        step.ok = false;
      } else if (def.confirm) {
        // Nobody is there to allow it.
        step.denied = true;
        result = "This mission runs unattended, so actions that need the user's approval are declined. Don't retry it; say in your report what you would have done.";
      } else {
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
      messages.push({ role: "tool", content: result, tool_call_id: call.id, tool_name: call.name });
    }
  }
  reply.content = withoutToolCalls(reply.content.replace(/<think>[\s\S]*?<\/think>/g, ""));
  reply.thinking = thinking || undefined;
}

/** A Windows notification (and a toast with a link while Prestige is in front). */
async function announce(m: Mission) {
  const l = m.last;
  if (!l) return;
  const title = l.ok ? `Mission done: ${m.name}` : `Mission didn't finish: ${m.name}`;
  const body = l.ok ? "Open Prestige's Past chats to read it." : l.note.slice(0, 160);
  if (!document.hasFocus() || document.hidden) {
    try {
      let ok = await isPermissionGranted();
      if (!ok) ok = (await requestPermission()) === "granted";
      if (ok) sendNotification({ title, body });
    } catch {
      /* not in the app */
    }
  }
  deps.toast(`${title}${l.ok ? ". It's in Past chats (Missions shows it too)." : `: ${l.note.slice(0, 100)}`}`, l.ok ? "" : "warn");
}

// ---------- the Missions sheet ----------
let editing: Mission | null = null;

function wireSheet() {
  $("#missions-btn").addEventListener("click", () => openMissions());
  $("#missions-close").addEventListener("click", () => ($("#missions") as HTMLDialogElement).close());
  $("#missions-new").addEventListener("click", () => edit(blank()));
  $("#ms-cancel").addEventListener("click", () => {
    editing = null;
    renderList();
  });
  $("#ms-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveForm();
  });
  $("#ms-how").addEventListener("change", () => syncForm());
  $("#ms-kind").addEventListener("change", () => syncForm());
}

export function openMissions() {
  editing = null;
  renderList();
  const dlg = $("#missions") as HTMLDialogElement;
  if (!dlg.open) dlg.showModal();
}

const blank = (): Mission => ({
  id: "",
  name: "",
  prompt: "",
  how: "chat",
  groups: ["web", "workstation"],
  when: { kind: "daily", time: "08:00", days: [0, 1, 2, 3, 4, 5, 6], hours: 6 },
  catchUp: false,
  enabled: true,
});

function renderList() {
  const box = document.getElementById("missions-list");
  if (!box) return;
  const form = $("#ms-form") as HTMLFormElement;
  form.hidden = !editing;
  box.hidden = !!editing;
  $("#missions-templates").hidden = !!editing;
  $("#missions-new").hidden = !!editing;
  const badge = document.getElementById("missions-count");
  if (badge) badge.textContent = missions.filter((m) => m.enabled).length ? String(missions.filter((m) => m.enabled).length) : "";
  if (editing) return;
  box.innerHTML = missions.length ? "" : `<p class="muted kb-empty">No missions yet. Start from a template below, or make your own.</p>`;
  for (const m of missions) {
    const row = document.createElement("div");
    row.className = "ms-row" + (m.enabled ? "" : " off") + (running === m.id ? " running" : "");
    row.innerHTML = `<label class="ms-on" title="On or off"><input type="checkbox" /></label>
      <div class="ms-t"><b></b><small class="ms-when"></small><small class="ms-last"></small></div>
      <div class="ms-acts"></div>`;
    ($("input", row) as HTMLInputElement).checked = m.enabled;
    $("input", row).addEventListener("change", (e) => {
      m.enabled = (e.target as HTMLInputElement).checked;
      m.next = m.enabled ? nextTime(m.when, Date.now()) : undefined;
      save();
      renderList();
    });
    $("b", row).textContent = m.name;
    const model = modelFor(m);
    $(".ms-when", row).textContent = [
      whenText(m.when),
      m.how === "research" ? "Deep Research" : "chat with tools",
      model?.name ?? "no model",
      m.enabled && m.next ? `next ${at(m.next)}` : m.enabled ? "" : "off",
      m.catchUp ? "catches up" : "",
    ].filter(Boolean).join(" · ");
    const l = m.last;
    $(".ms-last", row).textContent = running === m.id ? "Running now…" : l ? `Last: ${at(l.at)} · ${l.ok ? "done" : l.skipped ? "skipped" : "didn't finish"} · ${l.note}` : "Hasn't run yet";
    const act = (label: string, fn: () => void, cls = "linkish") => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = label;
      b.addEventListener("click", fn);
      $(".ms-acts", row).appendChild(b);
    };
    if (l?.chatId && running !== m.id) act("open result", () => {
      ($("#missions") as HTMLDialogElement).close();
      deps.openChat(l.chatId!);
    });
    if (running === m.id) act("stop", () => runCtrl?.abort());
    else act("run now", () => {
      if (!queue.includes(m.id)) queue.unshift(m.id);
      const wait = waiting();
      if (wait) deps.toast(`It starts when ${wait}.`);
      pump();
    });
    act("edit", () => edit(m));
    act("delete", () => {
      if (!confirm(`Delete the mission "${m.name}"? Its past results stay in Past chats.`)) return;
      missions = missions.filter((x) => x !== m);
      save();
      renderList();
    }, "linkish danger");
    box.appendChild(row);
  }
  const tpl = $("#missions-templates");
  tpl.innerHTML = `<span class="eyebrow">Templates</span>`;
  for (const t of TEMPLATES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ms-tpl";
    b.innerHTML = `<b></b><small></small>`;
    $("b", b).textContent = t.name;
    $("small", b).textContent = t.about;
    b.addEventListener("click", () => edit({ ...structuredClone(t.m), id: "", enabled: true }));
    tpl.appendChild(b);
  }
}

/** Opens the form for a mission (a new one has no id yet). */
function edit(m: Mission) {
  editing = m;
  renderList();
  const f = $("#ms-form");
  ($("#ms-name", f) as HTMLInputElement).value = m.name;
  ($("#ms-prompt", f) as HTMLTextAreaElement).value = m.prompt;
  ($("#ms-how", f) as HTMLSelectElement).value = m.how;
  ($("#ms-kind", f) as HTMLSelectElement).value = m.when.kind;
  ($("#ms-time", f) as HTMLInputElement).value = m.when.time;
  ($("#ms-hours", f) as HTMLInputElement).value = String(m.when.hours || 6);
  ($("#ms-catchup", f) as HTMLInputElement).checked = m.catchUp;
  $("#ms-days", f).innerHTML = DAYS.map((d, i) => `<label class="ms-day"><input type="checkbox" value="${i}"${m.when.days.includes(i) ? " checked" : ""} />${d}</label>`).join("");
  $("#ms-groups", f).innerHTML = GROUPS.map(
    (g) => `<label class="check"><input type="checkbox" value="${g.id}"${m.groups.includes(g.id) ? " checked" : ""} /> ${g.label} <small class="muted">${g.hint}</small></label>`,
  ).join("");
  const sel = $("#ms-model", f) as HTMLSelectElement;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  sel.innerHTML =
    `<option value="">The model picked in Chat${deps.current() ? ` (now ${esc(deps.current()!.name)})` : ""}</option>` +
    deps.models().map((x) => `<option value="${esc(x.key)}"${x.key === m.model ? " selected" : ""}>${esc(x.name)}</option>`).join("");
  syncForm();
  ($("#ms-name", f) as HTMLInputElement).focus();
}

function syncForm() {
  const f = $("#ms-form");
  const research = ($("#ms-how", f) as HTMLSelectElement).value === "research";
  const daily = ($("#ms-kind", f) as HTMLSelectElement).value === "daily";
  $("#ms-groups-wrap", f).hidden = research;
  $("#ms-daily", f).hidden = !daily;
  $("#ms-every", f).hidden = daily;
  ($("#ms-prompt", f) as HTMLTextAreaElement).placeholder = research
    ? "The question to research, e.g. What's new in open-weight AI models in the last 24 hours?"
    : "What to do, e.g. Check r/LocalLLaMA's top posts today and summarise the most important ones with links.";
}

function saveForm() {
  const f = $("#ms-form");
  const m = editing!;
  const name = ($("#ms-name", f) as HTMLInputElement).value.trim();
  const prompt = ($("#ms-prompt", f) as HTMLTextAreaElement).value.trim();
  if (!name || !prompt) return deps.toast("Give the mission a name and say what it should do.");
  const kind = ($("#ms-kind", f) as HTMLSelectElement).value as When["kind"];
  const days = Array.from(f.querySelectorAll<HTMLInputElement>("#ms-days input:checked")).map((x) => Number(x.value));
  if (kind === "daily" && !days.length) return deps.toast("Pick at least one day.");
  const time = ($("#ms-time", f) as HTMLInputElement).value || "08:00";
  const hours = Math.max(1, Math.min(168, Math.round(Number(($("#ms-hours", f) as HTMLInputElement).value) || 6)));
  Object.assign(m, {
    name,
    prompt,
    how: ($("#ms-how", f) as HTMLSelectElement).value as Mission["how"],
    groups: Array.from(f.querySelectorAll<HTMLInputElement>("#ms-groups input:checked")).map((x) => x.value),
    model: ($("#ms-model", f) as HTMLSelectElement).value || undefined,
    when: { kind, time, days, hours },
    catchUp: ($("#ms-catchup", f) as HTMLInputElement).checked,
  });
  if (!m.id) {
    m.id = `m-${Date.now().toString(36)}`;
    missions.push(m);
  }
  m.next = m.enabled ? nextTime(m.when, Date.now()) : undefined;
  editing = null;
  save();
  renderList();
  deps.toast(`Saved. ${m.enabled && m.next ? `It runs next ${at(m.next)}.` : ""}`);
}

// ---------- the phone (Missions on a paired phone; main.ts passes its requests here) ----------
/** Missions as the phone shows them. */
function phoneList() {
  return {
    missions: missions.map((m) => ({
      id: m.id,
      name: m.name,
      enabled: m.enabled,
      running: running === m.id,
      when: [whenText(m.when), m.how === "research" ? "Deep Research" : "chat with tools", modelFor(m)?.name ?? "no model"].join(" · "),
      next: m.enabled && m.next ? at(m.next) : "",
      last: m.last ? `${at(m.last.at)} · ${m.last.ok ? "done" : m.last.skipped ? "skipped" : "didn't finish"} · ${m.last.note}` : "",
      chatId: m.last?.chatId ?? null,
    })),
    templates: TEMPLATES.map((t, i) => ({ i, name: t.name, about: t.about })),
  };
}

/** "list", switch one "on" or off, "run" it now, "stop" it, "delete" it, or "add" a template or a mission of your own. */
export async function phoneMissions(action: string, a: any): Promise<unknown> {
  const m = missions.find((x) => x.id === a.id);
  if (["on", "run", "stop", "delete"].includes(action) && !m) throw new Error("That mission isn't there any more.");
  switch (action) {
    case "list":
      break;
    case "on":
      m!.enabled = !!a.on;
      m!.next = m!.enabled ? nextTime(m!.when, Date.now()) : undefined;
      await save();
      break;
    case "run": {
      if (!queue.includes(m!.id) && running !== m!.id) queue.unshift(m!.id);
      const wait = waiting();
      pump();
      renderList();
      return { ...phoneList(), message: wait ? `It starts when ${wait}.` : `Running "${m!.name}" on the PC.` };
    }
    case "stop":
      if (running === m!.id) runCtrl?.abort();
      break;
    case "delete":
      missions = missions.filter((x) => x !== m);
      await save();
      break;
    case "add": {
      // A template as it is, or a daily mission from a name, what to do and a time.
      const t = a.template != null ? TEMPLATES[Number(a.template)] : null;
      let n: Mission;
      if (t) n = { ...structuredClone(t.m), id: "", enabled: true };
      else {
        const name = String(a.name ?? "").trim();
        const prompt = String(a.prompt ?? "").trim();
        if (!name || !prompt) throw new Error("Give the mission a name and say what it should do.");
        const time = /^\d{2}:\d{2}$/.test(String(a.time)) ? String(a.time) : "08:00";
        n = {
          id: "",
          name,
          prompt,
          how: a.how === "research" ? "research" : "chat",
          groups: ["web", "workstation"],
          when: { kind: "daily", time, days: [0, 1, 2, 3, 4, 5, 6], hours: 6 },
          catchUp: false,
          enabled: true,
        };
      }
      n.id = `m-${Date.now().toString(36)}`;
      n.next = nextTime(n.when, Date.now());
      missions.push(n);
      await save();
      renderList();
      return { ...phoneList(), message: `Added "${n.name}". It runs next ${at(n.next)}.` };
    }
    default:
      throw new Error(`unknown Missions action ${action}`);
  }
  renderList();
  return phoneList();
}
