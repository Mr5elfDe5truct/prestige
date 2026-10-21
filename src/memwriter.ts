// Learning from chats: once a chat has been quiet for a while, a memory writer reads the new exchanges and decides
// what Prestige's shared memory (memory.ts) should add, change or forget. Two steps, the way Mem0 (Apache-2.0) does its
// write path, which Tencent's Hy-Memory-30B-A3B was trained inside: first the facts about the user are pulled out of
// the exchanges, then they're compared with the stored facts most like them, and each gets ADD, UPDATE, DELETE or NONE.
// The writer is the chat model in use, or Hy-Memory (the hy-memory pack) in llama.cpp's router. It never runs during a
// reply: a new message stops it, and the exchanges wait for the next quiet spell.
import { invoke } from "@tauri-apps/api/core";
import { errMsg, streamChat, type ChatMessage, type ModelInfo } from "./backends";
import { addFact, editFact, relatedFacts, removeFact, type MemoryConfig } from "./memory";

/** Who writes memory: nobody (only "remember that …"), the chat model in use, or Hy-Memory. */
export type MemoryWriter = "off" | "chat" | "hymemory";
const KEY = "memory.writer";
/** How long a chat has to be quiet before the writer runs. */
const QUIET_MS = 45_000;
/** The most exchanges read at once (the newest). */
const MAX_TURNS = 6;

interface Turn {
  user: string;
  assistant: string;
  model: ModelInfo;
}
interface Deps {
  root: () => string | null;
  owui: () => MemoryConfig | null;
  toast: (msg: string, kind?: string) => void;
  onChange: () => void;
}
let deps: Deps;
let pending: Turn[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let running: AbortController | null = null;
let hyInstalled: boolean | null = null;

export function initMemoryWriter(d: Deps) {
  deps = d;
  invoke<boolean>("hymemory_status", { root: deps.root() })
    .then((v) => (hyInstalled = v))
    .catch(() => (hyInstalled = false));
}

/** The writer picked in the Memory sheet; until one is picked, Hy-Memory when its pack is in, else off. */
export function memoryWriter(): MemoryWriter {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "off" || v === "chat" || v === "hymemory") return v;
  } catch {}
  return hyInstalled ? "hymemory" : "off";
}

export function setMemoryWriter(w: MemoryWriter) {
  try {
    localStorage.setItem(KEY, w);
  } catch {}
}

export const hyMemoryInstalled = () => hyInstalled === true;

/** A reply finished: its exchange waits for the writer, which runs once the chat has been quiet for QUIET_MS. */
export function queueMemoryWrite(user: string, assistant: string, model: ModelInfo) {
  if (memoryWriter() === "off" || !user.trim() || !assistant.trim()) return;
  pending.push({ user: user.slice(0, 4000), assistant: assistant.slice(0, 4000), model });
  pending = pending.slice(-MAX_TURNS);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void write(), QUIET_MS);
}

/** A new message is on its way: the writer stops (its exchanges stay queued) so the reply gets the GPU. */
export function pauseMemoryWrite() {
  if (timer) clearTimeout(timer);
  timer = null;
  running?.abort();
}

// The two requests, after Mem0's fact extraction and memory update prompts.
const today = () => new Date().toISOString().slice(0, 10);
const extractPrompt = () => `You organise personal information. From the conversation below, write down the facts about the user that are worth remembering in later conversations: preferences (likes, dislikes, food, products, activities), personal details (names, relationships, dates), plans and goals, health and diet, work, and favourite books, films, brands and the like.

Only use what the user says. Never take facts from the assistant's or system messages. Write each fact as a short self-contained statement, in the language the user writes in. Small talk and general remarks are not facts.

Examples:
User: Hi.
Assistant: Hello! How can I help today?
Output: {"facts": []}

User: Hi, my name is John. I'm a software engineer.
Assistant: Nice to meet you, John! My name is Alex.
Output: {"facts": ["Name is John", "Is a software engineer"]}

User: My favourite films are Inception and Interstellar. What are yours?
Assistant: Great choices! Mine are The Dark Knight and Spirited Away.
Output: {"facts": ["Favourite films are Inception and Interstellar"]}

Today is ${today()}. Answer with JSON only: {"facts": [ ... ]}, an empty list when there is nothing to remember.`;

const updatePrompt = (old: { id: string; text: string }[], facts: string[]) => `You manage a memory. Compare the new facts with the current memory and, for each, decide:
- ADD: new information that isn't in the memory. Give it a new id.
- UPDATE: the memory has it but the new fact says more or says something different. Keep the id, write the new text, and give the old text as "old_memory". If both say the same thing ("Likes cheese pizza", "Loves cheese pizza"), it's NONE.
- DELETE: the new fact contradicts a memory ("Loves cheese pizza" and now "Dislikes cheese pizza"), or the user asked to forget it.
- NONE: already there, or not worth keeping.
Only use ids from the current memory for UPDATE, DELETE and NONE.

Current memory:
${old.length ? JSON.stringify(old, null, 1) : "(empty)"}

New facts:
${JSON.stringify(facts)}

Answer with JSON only: {"memory": [{"id": "...", "text": "...", "event": "ADD" | "UPDATE" | "DELETE" | "NONE", "old_memory": "..."}]}`;

/** The model's JSON (it may be wrapped in a code fence or follow a stray thought). */
function parseJson(text: string): any {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("the writer didn't answer in JSON");
  return JSON.parse(t.slice(a, b + 1));
}

/** One request to the writer, without thinking, as plain text. */
async function ask(model: ModelInfo, messages: ChatMessage[], signal: AbortSignal): Promise<string> {
  let out = "";
  await streamChat(model, messages, { onToken: (t) => (out += t), onThinking: () => {}, onStats: () => {} }, signal, undefined, { think: false });
  return out;
}

async function writerModel(turnModel: ModelInfo): Promise<ModelInfo> {
  if (memoryWriter() !== "hymemory") return turnModel;
  const id = await invoke<string>("hymemory_ready", { root: deps.root() });
  return { key: `llama:${id}`, id, backend: "llama", name: "Hy-Memory", detail: "memory writer", order: 0 };
}

async function write() {
  timer = null;
  if (running || !pending.length || memoryWriter() === "off") return;
  const turns = pending;
  pending = [];
  const ctl = new AbortController();
  running = ctl;
  try {
    const model = await writerModel(turns[turns.length - 1].model);
    const convo = turns.map((t) => `User: ${t.user}\nAssistant: ${t.assistant}`).join("\n\n");
    const got = parseJson(
      await ask(model, [{ role: "system", content: extractPrompt() }, { role: "user", content: `Conversation:\n${convo}` }], ctl.signal),
    );
    const facts: string[] = (Array.isArray(got?.facts) ? got.facts : []).map((f: unknown) => String(f).trim()).filter(Boolean);
    if (!facts.length) return;
    // The stored facts most like the new ones, by short ids the model can't mistype.
    const near = await relatedFacts(facts, 20);
    const ids = new Map(near.map((f, i) => [String(i), f.id]));
    const plan = parseJson(await ask(model, [{ role: "user", content: updatePrompt(near.map((f, i) => ({ id: String(i), text: f.content })), facts) }], ctl.signal));
    let added = 0, changed = 0, removed = 0;
    for (const op of Array.isArray(plan?.memory) ? plan.memory : []) {
      const event = String(op?.event ?? "").toUpperCase();
      const text = String(op?.text ?? "").trim();
      const real = ids.get(String(op?.id ?? ""));
      if (event === "ADD" && text) {
        await addFact(text, deps.owui(), "learned");
        added++;
      } else if (event === "UPDATE" && real && text) {
        await editFact(real, text, deps.owui());
        changed++;
      } else if (event === "DELETE" && real) {
        await removeFact(real, deps.owui());
        removed++;
      }
    }
    if (added + changed + removed) {
      deps.onChange();
      const parts = [added && `learned ${added}`, changed && `updated ${changed}`, removed && `forgot ${removed}`].filter(Boolean);
      deps.toast(`Memory: ${parts.join(", ")} (${model.name}).`);
    }
  } catch (e) {
    if (ctl.signal.aborted) pending = [...turns, ...pending].slice(-MAX_TURNS);
    else console.warn("memory writer:", errMsg(e));
  } finally {
    if (running === ctl) running = null;
  }
}

