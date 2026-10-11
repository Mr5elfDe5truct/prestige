// Shared long-term memory: what every model knows about the user, kept by Prestige on this PC (the "memory" store in
// its app data folder). Every "user" fact goes into each reply, plus the other stored facts most relevant to the
// recent conversation (by meaning, with the small embedding model Knowledge uses; top 8).
// Open WebUI kept this memory before. When it's connected (an API key in Settings), its facts are copied in, the ones
// it learns later keep coming, and facts saved or changed here are passed to it, so both apps know the same things.
import { invoke } from "@tauri-apps/api/core";
import { errMsg, http } from "./backends";

export interface MemoryConfig {
  url: string;
  key: string;
}

export const DEFAULT_OWUI = "http://127.0.0.1:8080";
const OLLAMA = "http://127.0.0.1:11434";

export interface Fact {
  id: string;
  content: string;
  type: string; // "user": always given to the model; anything else only when relevant
  path?: string | null;
  created: number;
  owui?: string; // its id in Open WebUI
  vec?: number[];
  vecModel?: string;
}
interface Store {
  version: 1;
  facts: Fact[];
  gone: string[]; // Open WebUI ids deleted here, so a sync doesn't bring them back
}

let store: Store | null = null;
const inTauri = "__TAURI_INTERNALS__" in window;

async function load(): Promise<Store> {
  if (store) return store;
  const v = inTauri ? await invoke<Store | null>("store_get", { name: "memory" }).catch(() => null) : null;
  store = v && Array.isArray(v.facts) ? { version: 1, facts: v.facts, gone: v.gone ?? [] } : { version: 1, facts: [], gone: [] };
  return store;
}

async function save() {
  if (store && inTauri) await invoke("store_set", { name: "memory", value: store });
}

const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const label = (m: { content: string; path?: string | null }) => (m.path ? `${m.path}: ${m.content}` : m.content);

/** Every fact, newest first (without the vectors). */
export async function listFacts(): Promise<Omit<Fact, "vec">[]> {
  const s = await load();
  return s.facts.map(({ vec, ...f }) => f).sort((a, b) => b.created - a.created);
}

export async function factCount(): Promise<number> {
  return (await load()).facts.length;
}

// ---------- meaning (embeddings) ----------
let embedModel: string | null | undefined;
async function model(): Promise<string | null> {
  if (embedModel !== undefined) return embedModel;
  try {
    const tags = await (await http(`${OLLAMA}/api/tags`)).json();
    const names: string[] = (tags.models ?? []).map((m: any) => String(m.name));
    embedModel = names.find((n) => n.startsWith("qwen3-embedding")) ?? names.find((n) => /embed/i.test(n)) ?? null;
  } catch {
    return null; // Ollama isn't up yet: ask again next time
  }
  return embedModel;
}

async function embed(texts: string[]): Promise<{ model: string; vecs: number[][] } | null> {
  const m = await model();
  if (!m || !texts.length) return null;
  try {
    const r = await http(`${OLLAMA}/api/embed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: m, input: texts, keep_alive: "2m" }) });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.embeddings) ? { model: m, vecs: j.embeddings } : null;
  } catch {
    return null;
  }
}

function cosine(a: number[], b: number[]) {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    d += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  return x && y ? d / Math.sqrt(x * y) : 0;
}

/** Gives the facts that need one a vector (new facts, or ones made with another embedding model). */
async function fillVectors(s: Store): Promise<string | null> {
  const m = await model();
  if (!m) return null;
  const todo = s.facts.filter((f) => f.type !== "user" && (!f.vec || f.vecModel !== m));
  for (let i = 0; i < todo.length; i += 32) {
    const part = todo.slice(i, i + 32);
    const e = await embed(part.map(label));
    if (!e) return m;
    part.forEach((f, j) => ((f.vec = e.vecs[j]), (f.vecModel = e.model)));
    await save();
  }
  return m;
}

// ---------- the memory block for a reply ----------
/** The memory block for the system prompt, how many facts it holds and how many there are. */
export async function memoryContext(recentUserText: string): Promise<{ text: string; count: number; total: number }> {
  const s = await load();
  const lines = s.facts.filter((f) => f.type === "user").sort((a, b) => a.created - b.created).map(label);
  const others = s.facts.filter((f) => f.type !== "user");
  if (recentUserText.trim() && others.length) {
    const m = await fillVectors(s);
    const q = m ? await embed([recentUserText.slice(-4000)]) : null;
    if (q) {
      others
        .filter((f) => f.vec && f.vecModel === q.model)
        .map((f) => ({ f, score: cosine(q.vecs[0], f.vec!) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .forEach(({ f }) => lines.push(label(f)));
    }
  }
  const text = lines.length
    ? "Long-term memory shared across all of the user's models (facts they asked you to remember). This is all of it that " +
      "matters here, so answer from it; don't search files, past chats or tools for memories:\n" + lines.map((l) => `- ${l}`).join("\n")
    : "";
  return { text, count: lines.length, total: s.facts.length };
}

// ---------- changes ----------
/** Saves a fact (unless it's already there); also gives it to Open WebUI when connected. */
export async function addFact(content: string, owui: MemoryConfig | null): Promise<Fact> {
  const s = await load();
  const have = s.facts.find((f) => norm(f.content) === norm(content));
  if (have) return have;
  const f: Fact = { id: newId(), content: content.trim(), type: "user", created: Date.now() };
  s.facts.push(f);
  await save();
  // Waits a moment for Open WebUI (it's local and quick) so the Memory sheet shows the fact as shared straight away.
  if (owui) {
    const late = new Promise<null>((ok) => setTimeout(() => ok(null), 5000));
    const push = owuiAdd(owui, f.content).catch(() => null);
    const id = await Promise.race([push, late]);
    if (!id) push.then(async (later) => later && ((f.owui = later), await save()));
    if (id) (f.owui = id), await save();
  }
  return f;
}

export async function editFact(id: string, content: string, owui: MemoryConfig | null) {
  const s = await load();
  const f = s.facts.find((x) => x.id === id);
  if (!f || !content.trim()) return;
  f.content = content.trim();
  delete f.vec;
  await save();
  if (owui && f.owui) owuiCall(owui, `/api/v1/memories/${f.owui}/update`, "POST", { content: f.content }).catch(() => {});
}

export async function removeFact(id: string, owui: MemoryConfig | null) {
  const s = await load();
  const f = s.facts.find((x) => x.id === id);
  if (!f) return;
  s.facts = s.facts.filter((x) => x !== f);
  if (f.owui) s.gone.push(f.owui);
  await save();
  if (owui && f.owui) owuiCall(owui, `/api/v1/memories/${f.owui}`, "DELETE").catch(() => {});
}

// ---------- Open WebUI ----------
function headers(cfg: MemoryConfig) {
  return { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" };
}

async function owuiCall(cfg: MemoryConfig, path: string, method = "GET", body?: unknown): Promise<Response> {
  let r: Response;
  try {
    r = await http(`${cfg.url}${path}`, { method, headers: headers(cfg), body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    const m = errMsg(e);
    throw new Error(m === "not reachable" ? `Open WebUI isn't running at ${cfg.url}` : `Open WebUI: ${m}`);
  }
  if (r.status === 401 || r.status === 403) throw new Error("Open WebUI rejected the API key (check that API keys are enabled)");
  if (!r.ok) throw new Error(`Open WebUI answered ${r.status}`);
  return r;
}

/** Open WebUI's own memory (Settings' Test button and the sync). */
export async function listOwui(cfg: MemoryConfig): Promise<{ id: string; content: string; type?: string; path?: string | null }[]> {
  return (await owuiCall(cfg, "/api/v1/memories/")).json();
}

async function owuiAdd(cfg: MemoryConfig, content: string): Promise<string | null> {
  const j = await (await owuiCall(cfg, "/api/v1/memories/add", "POST", { content, type: "user" })).json().catch(() => null);
  return j?.id ? String(j.id) : null;
}

let lastSync = 0;
/** Copies in the facts Open WebUI has that Prestige doesn't (new ones, or the whole memory the first time). Returns how
 *  many came in; at most once a minute unless `force`. */
export async function syncFromOwui(cfg: MemoryConfig, force = false): Promise<number> {
  if (!force && Date.now() - lastSync < 60_000) return 0;
  lastSync = Date.now();
  const rows = await listOwui(cfg);
  const s = await load();
  const known = new Set(s.facts.map((f) => f.owui).filter(Boolean));
  const gone = new Set(s.gone);
  let added = 0;
  for (const r of rows) {
    const id = String(r.id);
    if (known.has(id) || gone.has(id) || !r.content?.trim()) continue;
    // The same words saved here before it had an Open WebUI id: link them instead of adding a second copy.
    const twin = s.facts.find((f) => !f.owui && norm(f.content) === norm(r.content));
    if (twin) {
      twin.owui = id;
      continue;
    }
    s.facts.push({ id: newId(), content: r.content.trim(), type: r.type || "user", path: r.path ?? null, created: Date.now(), owui: id });
    added++;
  }
  await save();
  return added;
}

/** "remember that I like X" → "I like X". Returns null when the message isn't a remember request. */
export function rememberRequest(text: string): string | null {
  const m = text.trim().match(/^(?:please\s+|hey,?\s+)?remember(?:\s+that)?[:,]?\s+(.+)$/is);
  if (!m) return null;
  const fact = m[1].trim().replace(/[.!]+$/, "");
  return fact.length >= 3 ? fact : null;
}
