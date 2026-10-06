// The tool store: a catalog of MCP servers to add to the workstation's tool server in one click (Home Assistant,
// GitHub, Spotify, Gmail and more). Each needs at most a key or two (asked for here) and sometimes a one-time sign-in.
// Added servers are saved in the workstation's data\mcpo-extra.json (toolstore.rs) and the tool server reloads them
// while it runs; each becomes a group in the chat's Tools menu. Every package here was checked to exist.
import { invoke } from "@tauri-apps/api/core";
import { errMsg } from "./backends";
import { loadTools, setExtraServers, type ToolGroup } from "./tools";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const inTauri = "__TAURI_INTERNALS__" in window;

interface Field {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  value?: string; // the default
  help?: string;
}

/** An MCP server's entry in the tool server's config. */
type ServerConfig =
  | { command: string; args: string[]; env?: Record<string, string> }
  | { type: "streamable-http"; url: string; headers?: Record<string, string> };

interface Entry {
  id: string; // the server's name on the tool server (and its group)
  name: string;
  icon: string;
  about: string;
  hint: string; // what the Tools menu says about it
  fields: Field[];
  build: (v: Record<string, string>) => ServerConfig;
  /** A one-time sign-in in a PowerShell window (the values are passed as environment variables). */
  signIn?: { label: string; script: string; env: (v: Record<string, string>) => Record<string, string> };
  needs?: string; // shown on the card: what you need first
  online?: boolean; // a service on the internet (or your network), not a program on this PC
  link?: string;
}

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const trim = (u: string) => u.trim().replace(/\/+$/, "");

export const STORE: Entry[] = [
  {
    id: "homeassistant", name: "Home Assistant", icon: "🏠", online: true,
    about: "Turn lights and devices on and off, check sensors and run scenes in your smart home.",
    hint: "control your smart home (asks before changing anything)",
    needs: "In Home Assistant: add the Model Context Protocol Server integration, and make a long-lived access token (your profile → Security).",
    link: "https://www.home-assistant.io/integrations/mcp_server/",
    fields: [
      { key: "url", label: "Home Assistant address", value: "http://homeassistant.local:8123" },
      { key: "token", label: "Long-lived access token", secret: true },
    ],
    build: (v) => ({ type: "streamable-http", url: `${trim(v.url)}/api/mcp`, headers: { Authorization: `Bearer ${v.token.trim()}` } }),
  },
  {
    id: "github", name: "GitHub", icon: "🐙", online: true,
    about: "Your repositories, issues, pull requests and code search, through GitHub's own MCP server.",
    hint: "issues, pull requests and code on GitHub",
    needs: "A personal access token (GitHub → Settings → Developer settings → Fine-grained tokens) with the repositories it may see.",
    link: "https://github.com/settings/personal-access-tokens",
    fields: [{ key: "token", label: "Personal access token", secret: true, placeholder: "github_pat_…" }],
    build: (v) => ({ type: "streamable-http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: `Bearer ${v.token.trim()}` } }),
  },
  {
    id: "spotify", name: "Spotify", icon: "🎵",
    about: "Play, pause and skip, search for music and manage your queue and playlists.",
    hint: "play and search music on Spotify",
    needs: "Spotify Premium, and an app at developer.spotify.com with the redirect address below.",
    link: "https://developer.spotify.com/dashboard",
    fields: [
      { key: "id", label: "Client ID" },
      { key: "secret", label: "Client secret", secret: true },
      { key: "redirect", label: "Redirect address (add it to the Spotify app)", value: "http://127.0.0.1:8888/callback" },
    ],
    build: (v) => ({
      command: "uvx", args: ["spotify-mcp"],
      env: { SPOTIFY_CLIENT_ID: v.id.trim(), SPOTIFY_CLIENT_SECRET: v.secret.trim(), SPOTIFY_REDIRECT_URI: v.redirect.trim() },
    }),
  },
  {
    id: "gmail", name: "Gmail", icon: "✉️",
    about: "Search and read your email, draft and send messages, and manage labels.",
    hint: "search, read and send Gmail (asks before sending)",
    needs: "A Google Cloud OAuth client (Desktop app) with the Gmail API on, downloaded as a JSON file. Then sign in once.",
    link: "https://console.cloud.google.com/apis/credentials",
    fields: [{ key: "keys", label: "The OAuth client JSON file (its full path)", placeholder: "C:\\Users\\you\\Downloads\\client_secret_….json" }],
    build: () => ({ command: "npx", args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"] }),
    signIn: {
      label: "Sign in to Google",
      script:
        "$d = Join-Path $env:USERPROFILE '.gmail-mcp'; New-Item -ItemType Directory -Force $d | Out-Null; " +
        "Copy-Item -LiteralPath $env:PRESTIGE_KEYS (Join-Path $d 'gcp-oauth.keys.json') -Force; " +
        "Write-Host 'Signing in to Google: finish in the browser, then close this window.'; npx -y @gongrzhe/server-gmail-autoauth-mcp auth",
      env: (v) => ({ PRESTIGE_KEYS: v.keys.trim().replace(/^"|"$/g, "") }),
    },
  },
  {
    id: "calendar", name: "Google Calendar", icon: "📅",
    about: "See what's coming up, find free time, and add or move events.",
    hint: "your Google Calendar (asks before changing it)",
    needs: "A Google Cloud OAuth client (Desktop app) with the Calendar API on, downloaded as a JSON file. Then sign in once.",
    link: "https://console.cloud.google.com/apis/credentials",
    fields: [{ key: "keys", label: "The OAuth client JSON file (its full path)", placeholder: "C:\\Users\\you\\Downloads\\client_secret_….json" }],
    build: (v) => ({ command: "npx", args: ["-y", "@cocal/google-calendar-mcp"], env: { GOOGLE_OAUTH_CREDENTIALS: v.keys.trim().replace(/^"|"$/g, "") } }),
    signIn: {
      label: "Sign in to Google",
      script: "Write-Host 'Signing in to Google: finish in the browser, then close this window.'; npx -y @cocal/google-calendar-mcp auth",
      env: (v) => ({ GOOGLE_OAUTH_CREDENTIALS: v.keys.trim().replace(/^"|"$/g, "") }),
    },
  },
  {
    id: "notion", name: "Notion", icon: "📓",
    about: "Search your Notion pages and databases, read them, and add or update pages.",
    hint: "search and edit your Notion pages",
    needs: "An internal integration token (notion.so/profile/integrations), shared with the pages it may use.",
    link: "https://www.notion.so/profile/integrations",
    fields: [{ key: "token", label: "Integration token", secret: true, placeholder: "ntn_…" }],
    build: (v) => ({ command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], env: { NOTION_TOKEN: v.token.trim() } }),
  },
  {
    id: "todoist", name: "Todoist", icon: "✅",
    about: "Add, find, complete and reschedule your tasks.",
    hint: "your Todoist tasks",
    needs: "Your API token (Todoist → Settings → Integrations → Developer).",
    link: "https://app.todoist.com/app/settings/integrations/developer",
    fields: [{ key: "token", label: "API token", secret: true }],
    build: (v) => ({ command: "npx", args: ["-y", "@abhiz123/todoist-mcp-server"], env: { TODOIST_API_TOKEN: v.token.trim() } }),
  },
  {
    id: "brave", name: "Brave Search", icon: "🦁",
    about: "Web, news, image and local search from Brave's own index (an alternative to DuckDuckGo).",
    hint: "search the web with Brave",
    needs: "A Brave Search API key (the free plan is enough).",
    link: "https://api-dashboard.search.brave.com/",
    fields: [{ key: "key", label: "API key", secret: true }],
    build: (v) => ({ command: "npx", args: ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"], env: { BRAVE_API_KEY: v.key.trim() } }),
  },
  {
    id: "obsidian", name: "Obsidian", icon: "🗂️",
    about: "Read and search the notes in your Obsidian vault (or any folder of Markdown).",
    hint: "read and search your Obsidian notes",
    fields: [{ key: "vault", label: "Vault folder", placeholder: "C:\\Users\\you\\Documents\\Obsidian Vault" }],
    build: (v) => ({ command: "npx", args: ["-y", "mcp-obsidian", v.vault.trim().replace(/^"|"$/g, "")] }),
  },
  {
    id: "youtube", name: "YouTube transcripts", icon: "▶️",
    about: "Fetch the transcript of a YouTube video, so a model can summarise or quote it.",
    hint: "read YouTube video transcripts",
    fields: [],
    build: () => ({ command: "npx", args: ["-y", "@kimtaeyoon83/mcp-server-youtube-transcript"] }),
  },
  {
    id: "wikipedia", name: "Wikipedia", icon: "📚",
    about: "Search Wikipedia and read articles, summaries and sections, in any language.",
    hint: "search and read Wikipedia",
    fields: [],
    build: () => ({ command: "uvx", args: ["wikipedia-mcp", "--transport", "stdio"] }),
  },
  {
    id: "time", name: "Time zones", icon: "🕒",
    about: "The current time anywhere, and conversions between time zones.",
    hint: "current time and time zone conversions",
    fields: [{ key: "tz", label: "Your time zone", value: tz }],
    build: (v) => ({ command: "uvx", args: ["mcp-server-time", `--local-timezone=${v.tz.trim() || tz}`] }),
  },
];

interface Deps {
  toast: (msg: string, kind?: string) => void;
  root: () => string | null;
  /** Switches a newly added tool's group on in the Tools menu. */
  enableGroup: (id: string) => void;
}
let deps: Deps;
let added: Record<string, any> = {}; // the saved mcpServers
let open: string | null = null; // the card showing its form
let saving = false;

const groupsFor = (servers: Record<string, any>): ToolGroup[] =>
  Object.keys(servers).map((id) => {
    const e = STORE.find((x) => x.id === id);
    return { id, label: e?.name ?? id, hint: e?.hint ?? "added by hand in data\\mcpo-extra.json", defaultOn: true };
  });

async function load() {
  if (!inTauri) return;
  try {
    added = (await invoke<{ mcpServers: Record<string, any> }>("tools_extra_get", { root: deps.root() })).mcpServers ?? {};
  } catch {
    added = {};
  }
  setExtraServers(groupsFor(added));
}

async function save(next: Record<string, any>, done: string) {
  saving = true;
  render();
  try {
    await invoke("tools_extra_set", { root: deps.root(), value: { mcpServers: next } });
    added = next;
    setExtraServers(groupsFor(added));
    deps.toast(done);
    // The tool server starts the new one in the background (a first run downloads it); look again in a bit.
    setTimeout(() => loadTools(true).catch(() => {}), 15000);
  } catch (e) {
    deps.toast(`Couldn't change the tools: ${errMsg(e)}`, "warn");
  } finally {
    saving = false;
    render();
  }
}

function card(e: Entry) {
  const isAdded = e.id in added;
  const div = document.createElement("div");
  div.className = `cat-card ts-card${isAdded ? " installed" : ""}`;
  div.innerHTML = `<div class="cat-top"><b></b><span class="be"></span></div><p class="ab"></p><p class="credit ts-needs"></p><div class="ts-form" hidden></div><div class="cat-foot"><span class="meta"></span><span class="ts-acts"></span></div>`;
  $("b", div).textContent = `${e.icon}  ${e.name}`;
  $(".be", div).textContent = isAdded ? "added" : e.fields.length ? "needs a key" : "no setup";
  $(".ab", div).textContent = e.about;
  const needs = $(".ts-needs", div);
  needs.hidden = !e.needs;
  if (e.needs) {
    needs.textContent = e.needs + " ";
    if (e.link) {
      const a = document.createElement("a");
      a.href = e.link;
      a.textContent = "Open";
      // The app window won't follow the link itself, so the default browser opens it.
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (!inTauri) return void window.open(e.link, "_blank", "noopener");
        invoke("tools_open_link", { url: e.link }).catch((err) => deps.toast(`Couldn't open the link: ${errMsg(err)}`, "warn"));
      });
      needs.appendChild(a);
    }
  }
  $(".meta", div).textContent = e.online ? "connects to the service" : "runs on this PC";
  const acts = $(".ts-acts", div);
  const btn = (label: string, primary: boolean, fn: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn${primary ? " primary" : ""}`;
    b.textContent = label;
    b.disabled = saving;
    b.addEventListener("click", fn);
    acts.appendChild(b);
  };
  if (isAdded) {
    if (e.signIn) btn(e.signIn.label, false, () => signIn(e, added[e.id]?._values ?? {}));
    btn("Remove", false, () => {
      const next = { ...added };
      delete next[e.id];
      save(next, `Removed ${e.name}.`);
    });
  } else if (open === e.id || !e.fields.length) {
    if (e.fields.length) form(e, $(".ts-form", div));
    btn(saving ? "Adding…" : "Add", true, () => add(e, div));
    if (open === e.id) btn("Cancel", false, () => ((open = null), render()));
  } else btn("Add…", true, () => ((open = e.id), render()));
  return div;
}

function form(e: Entry, box: HTMLElement) {
  box.hidden = false;
  for (const f of e.fields) {
    const l = document.createElement("label");
    l.className = "ts-field";
    l.innerHTML = `<span></span><input autocomplete="off" spellcheck="false" />`;
    $("span", l).textContent = f.label;
    const i = $("input", l) as HTMLInputElement;
    i.type = f.secret ? "password" : "text";
    i.dataset.key = f.key;
    i.placeholder = f.placeholder ?? "";
    i.value = f.value ?? "";
    box.appendChild(l);
  }
}

function values(div: HTMLElement): Record<string, string> {
  const v: Record<string, string> = {};
  div.querySelectorAll<HTMLInputElement>(".ts-form input").forEach((i) => (v[i.dataset.key!] = i.value));
  return v;
}

async function add(e: Entry, div: HTMLElement) {
  const v = values(div);
  const missing = e.fields.filter((f) => !v[f.key]?.trim());
  if (missing.length) return deps.toast(`Fill in: ${missing.map((f) => f.label).join(", ")}`, "warn");
  // The values are kept with it (non-secret ones only), so a sign-in can run again later.
  const keep = Object.fromEntries(e.fields.filter((f) => !f.secret).map((f) => [f.key, v[f.key]]));
  const config = { ...e.build(v), ...(Object.keys(keep).length ? { _values: keep } : {}) };
  open = null;
  await save({ ...added, [e.id]: config }, `Added ${e.name}. It's in the Tools menu once the tool server has started it (a first run downloads it).`);
  deps.enableGroup(e.id);
  if (e.signIn) signIn(e, v);
}

function signIn(e: Entry, v: Record<string, string>) {
  if (!e.signIn) return;
  invoke("tools_setup", { script: e.signIn.script, env: e.signIn.env(v) })
    .then(() => deps.toast(`Finish signing in to ${e.name} in the window that opened.`))
    .catch((err) => deps.toast(errMsg(err), "warn"));
}

function render() {
  const grid = $("#ts-grid");
  if (!grid) return;
  grid.innerHTML = "";
  STORE.forEach((e) => grid.appendChild(card(e)));
  // Servers added by hand in data\mcpo-extra.json are listed too, so they can be removed here.
  for (const id of Object.keys(added).filter((id) => !STORE.some((e) => e.id === id))) {
    const div = document.createElement("div");
    div.className = "cat-card ts-card installed";
    div.innerHTML = `<div class="cat-top"><b></b><span class="be">added by hand</span></div><p class="ab">From data\\mcpo-extra.json.</p><div class="cat-foot"><span class="meta"></span><button type="button" class="btn">Remove</button></div>`;
    $("b", div).textContent = `🧩  ${id}`;
    $("button", div).addEventListener("click", () => {
      const next = { ...added };
      delete next[id];
      save(next, `Removed ${id}.`);
    });
    grid.appendChild(div);
  }
}

export async function openToolStore() {
  await load();
  render();
  ($("#toolstore") as HTMLDialogElement).showModal();
}

export async function initToolStore(d: Deps) {
  deps = d;
  $("#ts-close").addEventListener("click", () => ($("#toolstore") as HTMLDialogElement).close());
  await load();
}
