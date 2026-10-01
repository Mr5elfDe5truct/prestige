// Shared long-term memory, stored in Open WebUI so Prestige and Open WebUI stay in sync.
// Mirrors Open WebUI's own injection: every "user" fact, plus the stored context most relevant
// to the recent conversation (vector search, top 8).
import { errMsg, http } from "./backends";

export interface MemoryConfig {
  url: string;
  key: string;
}

export const DEFAULT_OWUI = "http://127.0.0.1:8080";

interface MemoryRow {
  id: string;
  content: string;
  type?: string;
  path?: string | null;
}

function headers(cfg: MemoryConfig) {
  return { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" };
}

function label(m: { content: string; path?: string | null }) {
  return m.path ? `${m.path}: ${m.content}` : m.content;
}

export async function listMemories(cfg: MemoryConfig): Promise<MemoryRow[]> {
  let r: Response;
  try {
    r = await http(`${cfg.url}/api/v1/memories/`, { headers: headers(cfg) });
  } catch (e) {
    const m = errMsg(e);
    throw new Error(m === "not reachable" ? `Open WebUI isn't running at ${cfg.url}` : `Open WebUI: ${m}`);
  }
  if (r.status === 401 || r.status === 403) throw new Error("Open WebUI rejected the API key (check that API keys are enabled)");
  if (!r.ok) throw new Error(`Open WebUI answered ${r.status}`);
  return r.json();
}

/** The memory block for the system prompt, and how many facts it holds. */
export async function memoryContext(cfg: MemoryConfig, recentUserText: string): Promise<{ text: string; count: number; total: number }> {
  const all = await listMemories(cfg);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const m of all.filter((m) => m.type === "user")) {
    seen.add(m.id);
    lines.push(label(m));
  }
  if (recentUserText.trim() && all.length) {
    try {
      const r = await http(`${cfg.url}/api/v1/memories/query`, {
        method: "POST",
        headers: headers(cfg),
        body: JSON.stringify({ content: recentUserText.slice(-4000), k: 8 }),
      });
      if (r.ok) {
        const res = await r.json();
        const docs: string[] = res.documents?.[0] ?? [];
        const ids: string[] = res.ids?.[0] ?? [];
        const metas: any[] = res.metadatas?.[0] ?? [];
        docs.forEach((doc, i) => {
          if (!doc || (ids[i] && seen.has(ids[i]))) return;
          if (ids[i]) seen.add(ids[i]);
          const path = metas[i]?.path;
          let content = String(doc);
          if (path && content.startsWith(`${path}\n`)) content = content.slice(path.length + 1);
          lines.push(label({ content, path }));
        });
      }
    } catch {
      // Relevance search is a bonus; the user facts above still go in.
    }
  }
  const text = lines.length
    ? "Long-term memory shared across all of the user's models (facts they asked you to remember):\n" +
      lines.map((l) => `- ${l}`).join("\n")
    : "";
  return { text, count: lines.length, total: all.length };
}

export async function addMemory(cfg: MemoryConfig, content: string): Promise<void> {
  const r = await http(`${cfg.url}/api/v1/memories/add`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({ content, type: "user" }),
  });
  if (!r.ok) throw new Error(`Open WebUI answered ${r.status}`);
}
/** "remember that I like X" → "I like X". Returns null when the message isn't a remember request. */
export function rememberRequest(text: string): string | null {
  const m = text.trim().match(/^(?:please\s+|hey,?\s+)?remember(?:\s+that)?[:,]?\s+(.+)$/is);
  if (!m) return null;
  const fact = m[1].trim().replace(/[.!]+$/, "");
  return fact.length >= 3 ? fact : null;
}
