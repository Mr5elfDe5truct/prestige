// Tools for chat: the Workstation's tool server (mcpo on :8200) exposes each MCP server as an OpenAPI
// app. Prestige turns their operations into function tools for the model, runs the calls the model
// makes, and asks first before anything that changes files, runs commands, drives the browser,
// uses the camera or starts a render.
import { invoke } from "@tauri-apps/api/core";
import { errMsg, http } from "./backends";
import { libraryNote, readyDocs, searchFilesTool } from "./knowledge";

export const MCPO = "http://127.0.0.1:8200";

export interface ToolGroup {
  id: string; // mcpo server name, or "web" for the built-in search
  label: string;
  hint: string;
  defaultOn: boolean;
}

export const GROUPS: ToolGroup[] = [
  { id: "web", label: "Web search", hint: "search the web (DuckDuckGo) and read pages", defaultOn: true },
  { id: "history", label: "Past chats", hint: "look up what you talked about in earlier chats (stays on this PC)", defaultOn: true },
  { id: "knowledge", label: "Your files", hint: "search the files in Knowledge and cite their pages (stays on this PC)", defaultOn: true },
  { id: "workstation", label: "Workstation", hint: "Reddit / Hugging Face / GitHub scout, webcam snapshot, video jobs", defaultOn: true },
  { id: "filesystem", label: "Files", hint: "read and write files in your folders", defaultOn: false },
  { id: "desktop", label: "PowerShell", hint: "run commands and manage processes on this PC", defaultOn: false },
  { id: "browser", label: "Browser control", hint: "drive a Chrome window (Playwright)", defaultOn: false },
];

export interface ToolDef {
  name: string; // what the model calls
  group: string;
  server: string; // mcpo path segment ("" for built-ins)
  op: string;
  description: string;
  parameters: any;
  confirm: boolean; // ask before running
}

export interface ToolStep {
  name: string;
  args: any;
  result?: string;
  ok?: boolean;
  denied?: boolean;
  ms?: number;
}

// Read-only operations run without asking. Everything else asks first.
const SAFE =
  /^(read_|list_|get_|search_|directory_tree|reddit_|hf_models|github_search|scout_report|video_status|fetch$|web_search$|start_search$|get_more_search_results$|stop_search$|list_searches$|browser_(snapshot|take_screenshot|tabs|console_messages|network_requests|network_request|find)$)/;
// Camera and settings changes always ask, even though their names look harmless.
const ALWAYS_ASK = /^(webcam_snapshot|set_config_value|get_config)$/;

/** Inlines $ref schemas and drops OpenAPI-only noise so small models get clean JSON schema. */
function clean(schema: any, components: any, depth = 0): any {
  if (!schema || typeof schema !== "object" || depth > 8) return schema;
  if (Array.isArray(schema)) return schema.map((s) => clean(s, components, depth + 1));
  if (schema.$ref) {
    const key = String(schema.$ref).split("/").pop()!;
    return clean(components?.[key] ?? {}, components, depth + 1);
  }
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "title") continue;
    out[k] = clean(v, components, depth + 1);
  }
  return out;
}

let cache: { at: number; tools: ToolDef[]; errors: string[] } | null = null;

/** Every tool the tool server offers (cached for a minute). */
export async function loadTools(force = false): Promise<{ tools: ToolDef[]; errors: string[] }> {
  if (cache && !force && Date.now() - cache.at < 60_000) return cache;
  const tools: ToolDef[] = [
    {
      name: "web_search",
      group: "web",
      server: "",
      op: "web_search",
      description: "Search the web with DuckDuckGo. Returns titles, links and snippets. Use fetch to read a result page.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What to search for" } },
        required: ["query"],
      },
      confirm: false,
    },
    {
      name: "search_past_chats",
      group: "history",
      server: "",
      op: "search_past_chats",
      description:
        "Search the user's earlier Prestige conversations saved on this PC. Use it when they refer to something discussed before " +
        "(\"what did we say about…\", \"last time\"). Returns matching chats with dates and the relevant passage.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "A few distinctive words to look for (every word must appear)" } },
        required: ["query"],
      },
      confirm: false,
    },
  ];
  // Only offered once there are files to search.
  if (readyDocs().length) tools.push(
    {
      name: "search_my_files",
      group: "knowledge",
      server: "",
      op: "search_my_files",
      description:
        "Search the user's own documents in Knowledge (PDFs, Word files, notes, code) on this PC. Returns the best-matching " +
        "passages labelled with file and page; cite them like [file.pdf, p. 3]. Use it for questions about their files, or to " +
        "look further when the passages already given don't answer the question." + libraryNote(),
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What to look for, as a question or a few words" } },
        required: ["query"],
      },
      confirm: false,
    },
  );
  const errors: string[] = [];
  const seen = new Map<string, number>();
  const servers = ["fetch", "workstation", "filesystem", "desktop", "browser"];
  await Promise.all(
    servers.map(async (server) => {
      try {
        const r = await http(`${MCPO}/${server}/openapi.json`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const spec = await r.json();
        const comps = spec.components?.schemas ?? {};
        for (const [path, methods] of Object.entries<any>(spec.paths ?? {})) {
          const op = methods.post;
          if (!op) continue;
          const opName = path.replace(/^\//, "");
          const schema = op.requestBody?.content?.["application/json"]?.schema;
          tools.push({
            name: opName,
            group: server === "fetch" ? "web" : server,
            server,
            op: opName,
            description: String(op.description || op.summary || opName).replace(/\s+/g, " ").slice(0, 700),
            parameters: schema ? clean(schema, comps) : { type: "object", properties: {} },
            confirm: ALWAYS_ASK.test(opName) || !SAFE.test(opName),
          });
          seen.set(opName, (seen.get(opName) ?? 0) + 1);
        }
      } catch (e) {
        errors.push(`${server}: ${errMsg(e) === "not reachable" ? "tool server isn't running" : errMsg(e)}`);
      }
    }),
  );
  // Two servers both have read_file etc.; give duplicates a server prefix so names stay unique.
  for (const t of tools) if ((seen.get(t.op) ?? 0) > 1) t.name = `${t.server}_${t.op}`;
  cache = { at: Date.now(), tools, errors };
  return cache;
}

/** Tools in the groups that are switched on, in the shape both Ollama and llama.cpp accept. */
export function toolSpecs(tools: ToolDef[], enabled: Set<string>) {
  return tools
    .filter((t) => enabled.has(t.group))
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

const MAX_RESULT = 8000;

/** The chat being answered, so search_past_chats leaves it out. */
export const toolContext = { chatId: "" };

interface ChatHit {
  title: string;
  updated: number;
  hits: number;
  snippet: string;
  role?: string;
}

async function searchPastChats(query: string): Promise<string> {
  if (!("__TAURI_INTERNALS__" in window)) throw new Error("past chats are only saved in the desktop app");
  const found = await invoke<ChatHit[]>("search_chats", { query, exclude: toolContext.chatId || null, width: 500 });
  if (!found.length) return `No earlier chats mention "${query}". Try fewer or different words.`;
  return found
    .slice(0, 8)
    .map((c) => {
      const when = new Date(c.updated).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      const who = c.role === "user" ? "the user said" : "you said";
      return `• "${c.title}" (${when}, ${c.hits} matching message${c.hits === 1 ? "" : "s"})` + (c.snippet ? `\n  ${who}: ${c.snippet}` : "");
    })
    .join("\n");
}

/** Runs one tool call and returns its result as text for the model (cut to `max` characters). */
export async function runTool(t: ToolDef, args: any, max = MAX_RESULT): Promise<string> {
  if (t.op === "search_past_chats") {
    const q = String(args?.query ?? "").trim();
    if (!q) throw new Error("empty query");
    return searchPastChats(q);
  }
  if (t.op === "search_my_files") {
    const q = String(args?.query ?? "").trim();
    if (!q) throw new Error("empty query");
    return searchFilesTool(q);
  }
  if (t.op === "web_search") {
    const q = String(args?.query ?? "").trim();
    if (!q) throw new Error("empty query");
    return runTool(
      { ...t, server: "fetch", op: "fetch" },
      { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, max_length: 4000 },
    );
  }
  const r = await http(`${MCPO}/${t.server}/${t.op}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${t.name} failed (HTTP ${r.status}): ${text.slice(0, 300)}`);
  let out = text;
  try {
    const v = JSON.parse(text);
    out = typeof v === "string" ? v : JSON.stringify(v, null, 1);
  } catch {
    /* plain text */
  }
  return out.length > max ? `${out.slice(0, max)}\n…(truncated, ${out.length} characters in total)` : out;
}

/** A one-line description of a call, e.g. `web_search · "llama.cpp release"`. */
export function describeCall(name: string, args: any) {
  const first = args && typeof args === "object" ? Object.values(args).find((v) => typeof v === "string" && v) : "";
  const s = typeof first === "string" ? first.replace(/\s+/g, " ") : "";
  return s ? `${name} · ${s.length > 60 ? s.slice(0, 57) + "…" : s}` : name;
}
