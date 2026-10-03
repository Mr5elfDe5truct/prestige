// Talking to the local model servers: model lists and streaming chat for Ollama and llama.cpp.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export const OLLAMA = "http://127.0.0.1:11434";
export const LLAMA = "http://127.0.0.1:8081/v1";
// Same context start-all.ps1 gives Ollama (OLLAMA_CONTEXT_LENGTH).
export const NUM_CTX = 32768;

const inTauri = "__TAURI_INTERNALS__" in window;
// Inside the app, requests go through Rust so CORS doesn't apply. The installed app's origin is
// http://tauri.localhost, which Ollama rejects (403), so present the local origin Ollama allows.
const tauriHttp: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("Origin", "http://127.0.0.1");
  return (tauriFetch as typeof fetch)(input, { ...init, headers });
};
export const http: typeof fetch = inTauri ? tauriHttp : window.fetch.bind(window);

/** A readable message for any thrown value. The HTTP plugin throws plain strings, not Error objects. */
export function errMsg(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  if (/refused|actively refused|error sending request|connect|10061|Failed to fetch|NetworkError/i.test(raw ?? "")) return "not reachable";
  return raw || "unknown error";
}

export type Backend = "ollama" | "llama";

export interface ModelInfo {
  key: string; // backend:id
  id: string;
  backend: Backend;
  name: string;
  role?: string;
  detail: string;
  order: number;
  sizeBytes?: number; // Ollama: download size
  args?: string[]; // llama.cpp: the router's command line for this model
  inputModalities?: string[];
}

/** The models from the last listModels() call, for screens that need their details. */
export let lastModels: ModelInfo[] = [];

export interface ToolCall {
  id: string;
  name: string;
  arguments: any;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[]; // base64 JPEGs, no data: prefix
  tool_calls?: ToolCall[]; // assistant asked for these
  tool_call_id?: string; // tool result for this call
  tool_name?: string;
}

/** llama.cpp's OpenAI API takes images as content parts and tool calls with JSON-string arguments. */
function toOpenAI(m: ChatMessage) {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
  if (m.tool_calls?.length) {
    return {
      role: m.role,
      content: m.content || null,
      tool_calls: m.tool_calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
      })),
    };
  }
  if (!m.images?.length) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [
      { type: "text", text: m.content },
      ...m.images.map((b64) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } })),
    ],
  };
}

/** Ollama takes images[] and tool calls with object arguments; tool results name their tool. */
function toOllama(m: ChatMessage) {
  if (m.role === "tool") return { role: "tool", content: m.content, tool_name: m.tool_name };
  const out: any = { role: m.role, content: m.content };
  if (m.images?.length) out.images = m.images;
  if (m.tool_calls?.length) out.tool_calls = m.tool_calls.map((c) => ({ function: { name: c.name, arguments: c.arguments ?? {} } }));
  return out;
}

function parseArgs(a: any) {
  if (typeof a !== "string") return a ?? {};
  try {
    return JSON.parse(a || "{}");
  } catch {
    return { _raw: a };
  }
}

export interface StreamStats {
  tokens: number;
  tps: number;
  seconds: number;
  promptTokens?: number;
}

interface Known {
  match: RegExp;
  name: string;
  role?: string;
  order: number;
  hide?: boolean;
}

// Friendly names and roles for the models on this PC. Unknown models still show, by their raw id.
const KNOWN: Known[] = [
  { match: /qwen3\.6-35b/i, name: "Qwen3.6 35B Uncensored", role: "Main", order: 0 },
  { match: /qwen3\.8-27b/i, name: "Qwen3.8 27B Uncensored", role: "Deep thinker", order: 0.5 },
  { match: /qwen3\.5-9b/i, name: "Qwen3.5 9B Uncensored", role: "Fast", order: 1 },
  { match: /^gemma4:12b/i, name: "Gemma 4 12B", role: "Vision", order: 2 },
  { match: /^gemma4:e4b/i, name: "Gemma 4 E4B", role: "Vision · small", order: 3 },
  { match: /^llama3\.1/i, name: "Llama 3.1 8B", role: "General", order: 4 },
  { match: /^qwen2\.5-coder:7b/i, name: "Qwen2.5 Coder 7B", role: "Code", order: 5 },
  { match: /^qwen2\.5-coder:1\.5b/i, name: "Qwen2.5 Coder 1.5B", role: "Code · small", order: 6 },
  // UI-TARS drives the mouse and keyboard; it isn't a chat model.
  { match: /ui-tars/i, name: "UI-TARS", order: 99, hide: true },
];

// Display names for models that came from the catalog (filled in by catalog.ts).
const friendly = new Map<string, string>();
export function setFriendlyNames(names: [string, string][]) {
  for (const [id, name] of names) friendly.set(id.includes(":") || !/^[a-z0-9._-]+$/i.test(id) ? id : `${id}:latest`, name);
}
const friendlyName = (id: string) => friendly.get(id) ?? friendly.get(id.includes(":") ? id : `${id}:latest`);

/** Friendly name and role for a model id; `hide` marks models that aren't for chat. */
export function nameFor(id: string): { name: string; role?: string; hide?: boolean; order: number } {
  const k = KNOWN.find((m) => m.match.test(id));
  return { name: k?.name ?? friendlyName(id) ?? id, role: k?.role, hide: k?.hide, order: k?.order ?? 50 };
}

function describe(id: string, backend: Backend, detail: string): ModelInfo | null {
  const k = KNOWN.find((m) => m.match.test(id));
  if (k?.hide) return null;
  return {
    key: `${backend}:${id}`,
    id,
    backend,
    name: k?.name ?? friendlyName(id) ?? id,
    role: k?.role,
    detail,
    order: k?.order ?? 50,
  };
}

async function getJson(url: string, timeoutMs = 2500): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await http(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export async function ping(url: string): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    const r = await http(url, { signal: ctl.signal });
    clearTimeout(t);
    return r.status < 500;
  } catch {
    return false;
  }
}

export async function listModels(): Promise<{ models: ModelInfo[]; ollama: boolean; llama: boolean }> {
  const models: ModelInfo[] = [];
  let ollama = false;
  let llama = false;
  const [o, l] = await Promise.allSettled([getJson(`${OLLAMA}/api/tags`), getJson(`${LLAMA}/models`)]);
  if (o.status === "fulfilled") {
    ollama = true;
    for (const m of o.value.models ?? []) {
      const gb = m.size ? `${(m.size / 1e9).toFixed(1)} GB` : "";
      const d = describe(m.name, "ollama", ["Ollama", gb, m.details?.quantization_level].filter(Boolean).join(" · "));
      if (d) models.push({ ...d, sizeBytes: m.size });
    }
  }
  if (l.status === "fulfilled") {
    llama = true;
    for (const m of l.value.data ?? []) {
      const state = m.status?.value === "loaded" ? "loaded" : "loads on first message";
      const a: string[] = m.status?.args ?? [];
      const ctx = Number(a[a.indexOf("--ctx-size") + 1]) || 32768;
      const d = describe(m.id, "llama", `llama.cpp · ${Math.round(ctx / 1024)}k ctx · ${state}`);
      if (d) models.push({ ...d, args: m.status?.args ?? [], inputModalities: m.architecture?.input_modalities ?? [] });
    }
  }
  models.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  lastModels = models;
  return { models, ollama, llama };
}

/** The 12 GB card can't hold an Ollama model and Qwen3.6 35B together, so unload Ollama's first. */
async function freeOllamaVram() {
  try {
    const ps = await getJson(`${OLLAMA}/api/ps`);
    await Promise.all(
      (ps.models ?? []).map((m: any) =>
        http(`${OLLAMA}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: m.name, keep_alive: 0 }),
        }),
      ),
    );
  } catch {
    // Ollama may be down; llama.cpp can still try.
  }
}

/** And the other way round: Qwen3.6 35B fills the card, so unload it before an Ollama model runs. */
export async function freeLlamaVram() {
  try {
    const list = (await getJson(`${LLAMA}/models`)).data ?? [];
    await Promise.all(
      list
        .filter((m: any) => m.status?.value === "loaded" || m.status?.value === "loading")
        .map((m: any) =>
          http(`${LLAMA.replace(/\/v1$/, "")}/models/unload`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: m.id }),
          }),
        ),
    );
  } catch {
    // llama.cpp may be down; Ollama can still try.
  }
}

export interface StreamHandlers {
  onToken: (text: string) => void;
  onThinking: (text: string) => void;
  onStats: (s: StreamStats) => void;
}

/** Splits a streamed body into lines and hands each one over as it arrives. */
async function readLines(body: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  }
  if (buf.trim()) onLine(buf.trim());
}

export async function streamChat(
  model: ModelInfo,
  messages: ChatMessage[],
  h: StreamHandlers,
  signal: AbortSignal,
  tools?: any[],
): Promise<StreamStats & { toolCalls: ToolCall[] }> {
  const toolCalls: ToolCall[] = [];
  const withTools = tools?.length ? { tools } : {};
  const start = performance.now();
  let first = 0;
  let chunks = 0;
  let final: StreamStats | null = null;
  const live = () => {
    chunks++;
    if (!first) first = performance.now();
    const secs = (performance.now() - first) / 1000;
    h.onStats({ tokens: chunks, tps: secs > 0.25 ? chunks / secs : 0, seconds: (performance.now() - start) / 1000 });
  };

  if (model.backend === "ollama") {
    await freeLlamaVram();
    const r = await http(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model.id, messages: messages.map(toOllama), stream: true, options: { num_ctx: NUM_CTX }, ...withTools }),
      signal,
    });
    if (!r.ok || !r.body) throw new Error(`Ollama answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
    await readLines(r.body, (line) => {
      const j = JSON.parse(line);
      if (j.error) throw new Error(j.error);
      if (j.message?.thinking) {
        h.onThinking(j.message.thinking);
        live();
      }
      if (j.message?.content) {
        h.onToken(j.message.content);
        live();
      }
      for (const c of j.message?.tool_calls ?? []) {
        toolCalls.push({ id: `call_${toolCalls.length}`, name: c.function?.name, arguments: parseArgs(c.function?.arguments) });
      }
      if (j.done && j.eval_count) {
        const secs = (j.eval_duration ?? 0) / 1e9;
        final = {
          tokens: j.eval_count,
          tps: secs ? j.eval_count / secs : 0,
          seconds: (performance.now() - start) / 1000,
          promptTokens: j.prompt_eval_count,
        };
      }
    });
  } else {
    await freeOllamaVram();
    const r = await http(`${LLAMA}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model.id, messages: messages.map(toOpenAI), stream: true, stream_options: { include_usage: true }, ...withTools }),
      signal,
    });
    if (!r.ok || !r.body) throw new Error(`llama.cpp answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const partial: { id: string; name: string; args: string }[] = [];
    await readLines(r.body, (line) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      const j = JSON.parse(data);
      if (j.error) throw new Error(j.error.message ?? String(j.error));
      const d = j.choices?.[0]?.delta;
      if (d?.reasoning_content) {
        h.onThinking(d.reasoning_content);
        live();
      }
      if (d?.content) {
        h.onToken(d.content);
        live();
      }
      // Tool calls stream in pieces: the name first, then the JSON arguments in fragments.
      for (const tc of d?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        partial[i] ??= { id: tc.id ?? `call_${i}`, name: "", args: "" };
        if (tc.id) partial[i].id = tc.id;
        if (tc.function?.name) partial[i].name += tc.function.name;
        if (tc.function?.arguments) partial[i].args += tc.function.arguments;
      }
      const t = j.timings;
      if (t?.predicted_n) {
        final = {
          tokens: t.predicted_n,
          tps: t.predicted_per_second ?? 0,
          seconds: (performance.now() - start) / 1000,
          promptTokens: t.prompt_n,
        };
      } else if (j.usage?.completion_tokens && !final) {
        const secs = first ? (performance.now() - first) / 1000 : 0;
        final = {
          tokens: j.usage.completion_tokens,
          tps: secs ? j.usage.completion_tokens / secs : 0,
          seconds: (performance.now() - start) / 1000,
          promptTokens: j.usage.prompt_tokens,
        };
      }
    });
    for (const p of partial) if (p?.name) toolCalls.push({ id: p.id, name: p.name, arguments: parseArgs(p.args) });
  }
  const secs = first ? (performance.now() - first) / 1000 : 0;
  const stats = final ?? { tokens: chunks, tps: secs ? chunks / secs : 0, seconds: (performance.now() - start) / 1000 };
  return { ...stats, toolCalls };
}
