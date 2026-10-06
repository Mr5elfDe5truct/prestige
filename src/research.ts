// Deep Research: a multi-step mode that plans searches, reads the pages it finds and writes a cited report, all through
// the workstation's own web tools (DuckDuckGo search and page fetching on the tool server, :8200) and the chat model
// that's picked. Steps: plan the searches → search → read the best pages and take notes on each → look for gaps and
// search once more → write the report, citing the pages as [1], [2]… with the list of sources at the end.
import { streamChat, type ChatMessage, type ModelInfo } from "./backends";
import { loadTools, runTool, type ToolDef } from "./tools";

/** "/research how do heat pumps work in the cold" (or /deep). */
export const RESEARCH_CMD = /^\/(?:research|deep)\b\s*/i;

export interface ResearchSource {
  n: number;
  title: string;
  url: string;
}

/** What the chat shows while it works. `step` returns a handle to finish the step with its result. */
export interface ResearchUi {
  step: (name: string, arg: string) => { done: (ok: boolean, result?: string) => void };
  status: (text: string) => void;
  thinking: (t: string) => void;
  token: (t: string) => void;
}

const FIRST_PAGES = 6; // pages read in the first round
const MORE_PAGES = 4; // and in the follow-up round
const PAGE_CHARS = 12000; // of each page, for the notes
const SKIP = /(youtube\.com|youtu\.be|facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|pinterest\.|linkedin\.com|\.pdf$)/i;

interface Hit {
  title: string;
  url: string;
  snippet: string;
}

interface Page extends Hit {
  notes: string;
}

/** One answer from the model, without showing it (thinking is switched off where the model allows). */
async function ask(model: ModelInfo, messages: ChatMessage[], signal: AbortSignal, onThinking?: (t: string) => void) {
  let out = "";
  await streamChat(model, messages, { onToken: (t) => (out += t), onThinking: (t) => onThinking?.(t), onStats: () => {} }, signal, undefined, { think: false });
  return out.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** The first JSON object in a reply (models wrap it in prose or code fences). */
function json(text: string): any {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

const unhtml = (s: string) =>
  s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

/** DuckDuckGo's results page as raw HTML: the real addresses (the text version shortens long ones). */
export function parseResultsHtml(html: string): Hit[] {
  const hits: Hit[] = [];
  const blocks = html.split(/class="result__a"/).slice(1);
  for (const b of blocks) {
    const href = b.match(/href="([^"]+)"/)?.[1] ?? "";
    const enc = href.match(/[?&]uddg=([^&]+)/);
    const url = enc ? decodeURIComponent(enc[1]) : href.startsWith("http") ? href : "";
    if (!url || /duckduckgo\.com\/y\.js|ad_provider/.test(href + url)) continue; // ads
    const title = unhtml(b.slice(b.indexOf(">") + 1, b.indexOf("</a>")));
    const snip = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "";
    if (!hits.some((h) => h.url === url)) hits.push({ title, url, snippet: unhtml(snip) });
  }
  return hits;
}

/** DuckDuckGo's results page, as the fetch tool returns it: "## Title", then the address, then the snippet. */
export function parseResults(text: string): Hit[] {
  const hits: Hit[] = [];
  const blocks = text.split(/^## /m).slice(1);
  for (const b of blocks) {
    const lines = b.split("\n").map((l) => l.trim()).filter(Boolean);
    const title = lines[0] ?? "";
    const addr = lines.slice(1).find((l) => /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(l));
    if (!addr || /duckduckgo\.com/i.test(addr)) continue;
    const url = /^https?:\/\//i.test(addr) ? addr : `https://${addr}`;
    const snippet = lines.slice(lines.indexOf(addr) + 1).join(" ");
    hits.push({ title: title.replace(/\s+/g, " "), url, snippet });
  }
  // When the page comes back with its links kept ([title](//duckduckgo.com/l/?uddg=…)), read those instead.
  if (!hits.length) {
    for (const m of text.matchAll(/\[([^\]]{3,200})\]\(([^)\s]+)\)/g)) {
      const u = m[2].match(/uddg=([^&]+)/);
      const url = u ? decodeURIComponent(u[1]) : m[2];
      if (/^https?:\/\//i.test(url) && !/duckduckgo\.com/i.test(url) && !hits.some((h) => h.url === url)) hits.push({ title: m[1], url, snippet: "" });
    }
  }
  return hits;
}

/** Picks pages to read: round-robin across the searches, no repeats, at most two from one site. */
export function pickPages(lists: Hit[][], n: number, seen: Set<string>): Hit[] {
  const out: Hit[] = [];
  const perSite = new Map<string, number>();
  for (const u of seen) {
    const h = host(u);
    perSite.set(h, (perSite.get(h) ?? 0) + 1);
  }
  for (let i = 0; out.length < n && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const h = l[i];
      if (!h || out.length >= n) continue;
      const key = h.url.replace(/[#?].*$/, "").replace(/\/$/, "");
      const site = host(h.url);
      if (seen.has(key) || SKIP.test(h.url) || (perSite.get(site) ?? 0) >= 2) continue;
      seen.add(key);
      perSite.set(site, (perSite.get(site) ?? 0) + 1);
      out.push(h);
    }
  }
  return out;
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res) => {
    if (ms <= 0 || signal.aborted) return res();
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
  });

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

async function webTools(): Promise<{ search: ToolDef; fetch: ToolDef }> {
  const { tools, errors } = await loadTools();
  const search = tools.find((t) => t.op === "web_search");
  const fetch = tools.find((t) => t.server === "fetch" && t.op === "fetch");
  if (!search || !fetch) throw new Error(`the web tools aren't available (${errors.join("; ") || "is the tool server running?"})`);
  return { search, fetch };
}

/** Researches `question` on the web and streams a cited report through `ui.token`. Returns the report and its sources. */
export async function deepResearch(
  question: string,
  model: ModelInfo,
  ui: ResearchUi,
  signal: AbortSignal,
  context = "",
): Promise<{ report: string; sources: ResearchSource[]; pages: number }> {
  const { search, fetch } = await webTools();
  const today = new Date().toLocaleDateString(undefined, { dateStyle: "long" });
  const pages: Page[] = [];
  const seen = new Set<string>();

  // DuckDuckGo shows a bot check to quick bursts of searches, so they're spaced out and an empty page is tried again.
  let lastSearch = 0;
  const searchOnce = async (q: string): Promise<Hit[]> => {
    await pause(Math.max(0, lastSearch + 2500 - Date.now()), signal);
    lastSearch = Date.now();
    try {
      const raw = await runTool(fetch, { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, raw: true, max_length: 120000 }, 130000);
      const hits = parseResultsHtml(raw);
      if (hits.length) return hits;
    } catch {
      /* the text version below */
    }
    return parseResults(await runTool(search, { query: q }));
  };
  const runSearches = async (queries: string[]) => {
    const lists: Hit[][] = [];
    for (const q of queries) {
      if (signal.aborted) break;
      const s = ui.step("web_search", q);
      try {
        let hits = await searchOnce(q);
        if (!hits.length && !signal.aborted) {
          await pause(6000, signal);
          hits = await searchOnce(q);
        }
        lists.push(hits);
        s.done(hits.length > 0, hits.map((h) => `${h.title}\n${h.url}`).join("\n\n") || "No results");
      } catch (e) {
        s.done(false, String(e));
      }
    }
    return lists;
  };

  const read = async (hits: Hit[]) => {
    for (const h of hits) {
      if (signal.aborted) break;
      const s = ui.step("read", h.url);
      try {
        let text = await runTool(fetch, { url: h.url, max_length: PAGE_CHARS }, PAGE_CHARS + 500);
        text = text.replace(/^Contents of \S+:\s*/, "");
        if (text.length < 200) throw new Error("the page had almost no text");
        ui.status(`Taking notes on ${host(h.url)}…`);
        const notes = await ask(
          model,
          [
            {
              role: "system",
              content:
                "You take research notes. From the page below, write only the facts that help answer the question: short bullet " +
                "points with the specific numbers, names, dates and claims, in your own words. If nothing on the page helps, " +
                "reply with exactly NONE.",
            },
            { role: "user", content: `Question: ${question}\n\nPage: ${h.title} (${h.url})\n\n${text.slice(0, PAGE_CHARS)}` },
          ],
          signal,
        );
        const useful = !!notes && !/^\W*none\W*$/i.test(notes);
        if (useful) pages.push({ ...h, notes });
        s.done(useful, useful ? notes : "Nothing on this page answers the question.");
      } catch (e) {
        s.done(false, String(e instanceof Error ? e.message : e));
      }
    }
  };

  // 1. Plan.
  ui.status("Planning the searches…");
  const plan = ui.step("plan", question);
  const planned = json(
    await ask(
      model,
      [
        {
          role: "system",
          content:
            `You plan web research. Today is ${today}. Write 3 to 5 web search queries that together cover the question from ` +
            'different angles (facts, recent news, opinions, numbers). Reply with JSON only: {"queries": ["...", "..."]}',
        },
        { role: "user", content: context ? `${context}\n\nQuestion: ${question}` : question },
      ],
      signal,
      ui.thinking,
    ),
  );
  const queries: string[] = (Array.isArray(planned?.queries) ? planned.queries : [question]).map(String).filter(Boolean).slice(0, 5);
  plan.done(true, queries.map((q) => `• ${q}`).join("\n"));

  // 2-3. Search and read.
  ui.status("Searching…");
  await read(pickPages(await runSearches(queries), FIRST_PAGES, seen));

  // 4. One more round for what's missing.
  if (!signal.aborted && pages.length) {
    ui.status("Looking for gaps…");
    const gap = ui.step("plan", "what's still missing");
    const more = json(
      await ask(
        model,
        [
          {
            role: "system",
            content:
              `Today is ${today}. Here are research notes for a question. If they already answer it well, reply {"done": true}. ` +
              'Otherwise reply with up to 3 new web search queries for what is missing: {"queries": ["..."]}. JSON only.',
          },
          { role: "user", content: `Question: ${question}\n\nNotes:\n${pages.map((p) => `From ${p.title}:\n${p.notes}`).join("\n\n").slice(0, 16000)}` },
        ],
        signal,
      ),
    );
    const next: string[] = Array.isArray(more?.queries) ? more.queries.map(String).filter(Boolean).slice(0, 3) : [];
    gap.done(true, next.length ? next.map((q) => `• ${q}`).join("\n") : "The notes cover it.");
    if (next.length) await read(pickPages(await runSearches(next), MORE_PAGES, seen));
  } else if (!signal.aborted) {
    // Nothing useful yet: try the question itself as the search.
    await read(pickPages(await runSearches([question]), MORE_PAGES, seen));
  }
  if (signal.aborted) throw new DOMException("stopped", "AbortError");
  if (!pages.length) throw new Error("none of the pages it found could be read or answered the question. Try rewording it.");

  // 5. Write.
  ui.status("Writing the report…");
  const sources: ResearchSource[] = pages.map((p, i) => ({ n: i + 1, title: p.title, url: p.url }));
  let report = "";
  await streamChat(
    model,
    [
      {
        role: "system",
        content:
          `You write research reports for the user (today is ${today}). Use only the numbered notes below. Start with a short, ` +
          "direct answer, then the details under clear headings, then what is uncertain or disputed. Cite every fact with the " +
          "number of its source in square brackets right after it, like [2] or [1][3]. Use Markdown. Don't add a list of " +
          "sources at the end; it's added for you.",
      },
      {
        role: "user",
        content:
          (context ? `${context}\n\n` : "") +
          `Question: ${question}\n\n` +
          pages.map((p, i) => `[${i + 1}] ${p.title} (${p.url})\n${p.notes}`).join("\n\n"),
      },
    ],
    {
      onToken: (t) => {
        report += t;
        ui.token(t);
      },
      onThinking: ui.thinking,
      onStats: () => {},
    },
    signal,
  );
  const list = `\n\n## Sources\n${sources.map((s) => `${s.n}. [${s.title.replace(/[[\]]/g, "")}](${s.url})`).join("\n")}`;
  ui.token(list);
  return { report: report.trim() + list, sources, pages: seen.size };
}
