// Characters: saved personas to talk to. Each has a name, a personality (how it talks and who it is), a voice (any Kokoro
// voice, or a VoxCPM2 voice cloned from a recording), a face (a reference picture, so images and videos of it keep its
// look) and its own memory ("remember that…" while talking to it goes there, and it can be edited). Pick one in the top
// bar: chat, the Voice screen and Live calls then talk as it, and /image or /video prompts that name it (or say "you")
// put its face in the picture. Stored in the app data folder (store\characters.json).
import { invoke } from "@tauri-apps/api/core";
import { errMsg } from "./backends";
import { cloneVoice, isVox, listVoices, DEFAULT_VOICE } from "./speech";
import { CONSENT, imageIn, imageToBase64 } from "./reference";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const inTauri = "__TAURI_INTERNALS__" in window;

export interface Character {
  id: string;
  name: string;
  personality: string;
  voice?: string; // a Kokoro voice, or "vox:<name>" for VoxCPM2
  face?: string; // base64 JPEG, at most 2048 px
  memory: string[];
  sharedMemory?: boolean; // also give it the shared memory (what every model knows about the user); undefined = yes
  created: number;
}

interface Deps {
  toast: (msg: string, kind?: string) => void;
  /** The character being talked to (undefined: Prestige itself). */
  active: () => string | undefined;
  choose: (id: string | undefined) => void;
  /** The voice Prestige itself uses, for a character without one. */
  defaultVoice: () => string;
  /** "Make a talking video": their face says a line in their voice (InfiniteTalk). */
  makeTalk: (c: Character) => void;
}

let deps: Deps;
let list: Character[] = [];
let editing: Character | null = null;
const changed = new Set<() => void>();

export const characters = () => list;
export const characterById = (id?: string) => (id ? list.find((c) => c.id === id) : undefined);
export const activeCharacter = () => characterById(deps?.active());
/** Runs when characters are added, edited or removed (Studio's picker, the top bar). */
export const onCharactersChange = (f: () => void) => changed.add(f);

async function load() {
  try {
    const v = inTauri ? await invoke<Character[] | null>("store_get", { name: "characters" }) : JSON.parse(localStorage.getItem("prestige-characters") || "[]");
    list = Array.isArray(v) ? v : [];
  } catch {
    list = [];
  }
}

async function save() {
  try {
    if (inTauri) await invoke("store_set", { name: "characters", value: list });
    else localStorage.setItem("prestige-characters", JSON.stringify(list));
  } catch (e) {
    deps.toast(`Couldn't save the characters: ${errMsg(e)}`, "warn");
  }
  changed.forEach((f) => f());
}

// ---------- what the model and the speech get ----------

/** The instructions a model gets to be this character, in place of Prestige's own. */
export function characterPrompt(c: Character, userName: string | undefined, about: string | undefined, live: boolean) {
  return [
    `You are ${c.name}. Stay in character as ${c.name} for the whole conversation: speak as them, with their personality, ` +
      "opinions and way of talking, and never say you are an AI model or Prestige unless asked directly.",
    c.personality.trim() ? `Who ${c.name} is and how they talk:\n${c.personality.trim()}` : "",
    `You're talking with ${userName?.trim() || "the user"} through Prestige, an app running entirely on their own PC; nothing leaves it.`,
    about?.trim() ? `What the user wants you to know about them: ${about.trim()}` : "",
    live ? "" : "Use Markdown only when it helps.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The character's own memory, for its system prompt. */
export function characterMemory(c: Character) {
  return c.memory.length ? `What ${c.name} remembers from earlier conversations with the user:\n${c.memory.map((m) => `- ${m}`).join("\n")}` : "";
}

export async function remember(c: Character, fact: string) {
  if (!c.memory.includes(fact)) c.memory.push(fact);
  await save();
}

/** A voice picked on the Voice screen or in a call while talking to the character becomes its voice. */
export async function setCharacterVoice(c: Character, v: string) {
  c.voice = v || undefined;
  await save();
}

/** The voice to speak with: the character's, or Prestige's own. */
export const voiceOf = (c: Character | undefined) => c?.voice || deps.defaultVoice();

/** A /image or /video prompt that's about the character: names it, or says "you" / "yourself". */
export function wantsFace(c: Character | undefined, prompt: string) {
  if (!c?.face) return false;
  const name = c.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(${name}|you|yourself|your)\\b`, "i").test(prompt);
}

/** The scene for Qwen-Image, with the character's name (or "you") as "the character", the one in the reference. */
export function faceScene(c: Character, prompt: string) {
  const name = c.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return prompt.replace(new RegExp(`\\b(${name}|yourself|you)\\b`, "gi"), "the character").replace(/\byour\b/gi, "the character's");
}

export function faceBlob(c: Character): Blob {
  const bin = atob(c.face!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "image/jpeg" });
}

const faceUrl = (c: Character) => (c.face ? `data:image/jpeg;base64,${c.face}` : "");
const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** A round face (or initials) for menus and the top bar. */
export function avatarHtml(c: Character | undefined, cls = "pf") {
  if (!c) return `<span class="${cls} pf-mark"><svg viewBox="0 0 600 600" aria-hidden="true"><use href="#rg-mark" /></svg></span>`;
  return c.face ? `<img class="${cls}" src="${faceUrl(c)}" alt="" />` : `<span class="${cls} pf-ini">${esc(initials(c.name))}</span>`;
}

// ---------- the top-bar picker ----------

export function renderPicker() {
  const c = activeCharacter();
  const btn = $("#persona-btn");
  $(".pf-slot", btn).innerHTML = avatarHtml(c);
  $("#persona-name").textContent = c?.name ?? "Prestige";
  btn.title = c ? `Talking to ${c.name}. Click to switch or manage characters.` : "Talking to Prestige. Click to talk to one of your characters.";
  const menu = $("#persona-menu");
  menu.innerHTML = "";
  const row = (who: Character | undefined) => {
    const b = document.createElement("button");
    b.setAttribute("role", "menuitem");
    b.className = (who?.id ?? "") === (c?.id ?? "") ? "sel" : "";
    b.innerHTML = `${avatarHtml(who)}<span class="n"></span><span class="d"></span>`;
    $(".n", b).textContent = who?.name ?? "Prestige";
    $(".d", b).textContent = who ? who.personality.split("\n")[0].slice(0, 90) || "No personality yet" : "The assistant itself";
    b.addEventListener("click", () => {
      menu.hidden = true;
      deps.choose(who?.id);
    });
    menu.appendChild(b);
  };
  row(undefined);
  list.forEach(row);
  const more = document.createElement("button");
  more.className = "more";
  more.innerHTML = `<span class="n">${list.length ? "Manage characters…" : "＋ Create a character"}</span><span class="d">Name, personality, a cloned voice, a face for pictures, and its own memory</span>`;
  more.addEventListener("click", () => {
    menu.hidden = true;
    openCharacters(c?.id);
  });
  menu.appendChild(more);
}

// ---------- the editor ----------

export function openCharacters(id?: string) {
  editing = characterById(id) ?? list[0] ?? null;
  renderEditor();
  const dlg = $("#characters") as HTMLDialogElement;
  if (!dlg.open) dlg.showModal();
}

function renderList() {
  const box = $("#ch-list");
  box.innerHTML = "";
  for (const c of list) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = c.id === editing?.id ? "sel" : "";
    b.innerHTML = `${avatarHtml(c)}<span></span>`;
    $("span:last-child", b).textContent = c.name;
    b.addEventListener("click", () => {
      editing = c;
      renderEditor();
    });
    box.appendChild(b);
  }
}

async function renderVoices(cur: string | undefined) {
  const sel = $("#ch-voice") as HTMLSelectElement;
  const { kokoro, vox } = await listVoices();
  sel.innerHTML = `<option value="">Prestige's voice</option>`;
  const group = (label: string, values: string[], text: (v: string) => string) => {
    if (!values.length) return;
    const g = document.createElement("optgroup");
    g.label = label;
    for (const v of values) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = text(v);
      g.appendChild(o);
    }
    sel.appendChild(g);
  };
  group("VoxCPM2 · designed and cloned", vox.map((v) => `vox:${v}`), (v) => v.slice(4));
  group("Kokoro · quick", kokoro.length ? kokoro : [DEFAULT_VOICE], (v) => v);
  // A voice whose server is off right now is kept, not lost.
  if (cur && ![...sel.options].some((o) => o.value === cur)) {
    const o = document.createElement("option");
    o.value = cur;
    o.textContent = `${isVox(cur) ? cur.slice(4) : cur} (not running now)`;
    sel.appendChild(o);
  }
  sel.value = cur ?? "";
  ($("#ch-clone") as HTMLButtonElement).disabled = !vox.length;
  $("#ch-clone").title = vox.length ? "Make a VoxCPM2 voice from a 5–30 second recording of one person speaking" : "Cloning needs the workstation's voice server (voice pack)";
}

function renderMemory() {
  const box = $("#ch-memory");
  box.innerHTML = "";
  if (!editing) return;
  if (!editing.memory.length) box.innerHTML = `<p class="muted">Nothing yet. Say "remember that…" while talking to ${esc(editing.name || "them")}, or add a fact below.</p>`;
  editing.memory.forEach((m, i) => {
    const row = document.createElement("div");
    row.className = "ch-fact";
    row.innerHTML = `<span></span><button type="button" aria-label="Forget this">✕</button>`;
    $("span", row).textContent = m;
    $("button", row).addEventListener("click", () => {
      editing!.memory.splice(i, 1);
      renderMemory();
    });
    box.appendChild(row);
  });
}

function renderEditor() {
  renderList();
  const form = $("#ch-form");
  $("#ch-empty").hidden = !!editing;
  form.hidden = !editing;
  if (!editing) return;
  ($("#ch-name") as HTMLInputElement).value = editing.name;
  ($("#ch-personality") as HTMLTextAreaElement).value = editing.personality;
  ($("#ch-shared") as HTMLInputElement).checked = editing.sharedMemory !== false;
  $("#ch-face").innerHTML = editing.face ? `<img src="${faceUrl(editing)}" alt="${esc(editing.name)}" />` : `<span>Add a face</span>`;
  $("#ch-face-clear").hidden = !editing.face;
  $("#ch-talk").textContent = deps.active() === editing.id ? "Talking to them" : `Talk to ${editing.name || "them"}`;
  const vid = $("#ch-video") as HTMLButtonElement;
  vid.disabled = !editing.face;
  vid.title = editing.face ? "Their face says a line in their voice, as a lip-synced video (InfiniteTalk)" : "Add a face first";
  renderMemory();
  renderVoices(editing.voice);
}

/** The form's values into the character being edited. */
function readForm() {
  if (!editing) return;
  editing.name = ($("#ch-name") as HTMLInputElement).value.trim() || "Unnamed";
  editing.personality = ($("#ch-personality") as HTMLTextAreaElement).value.trim();
  editing.voice = ($("#ch-voice") as HTMLSelectElement).value || undefined;
  editing.sharedMemory = ($("#ch-shared") as HTMLInputElement).checked ? undefined : false;
}

async function setFace(f: Blob | null) {
  if (!editing) return;
  try {
    editing.face = f ? await imageToBase64(f) : undefined;
  } catch (e) {
    deps.toast(errMsg(e), "warn");
  }
  readForm();
  renderEditor();
}

export async function initCharacters(d: Deps) {
  deps = d;
  await load();
  renderPicker();
  $("#ch-consent").textContent = `The face is used as a reference picture for images and videos of this character. ${CONSENT}`;
  $("#persona-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("#persona-menu");
    renderPicker();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".persona-pick")) $("#persona-menu").hidden = true;
  });
  $("#ch-new").addEventListener("click", () => {
    readForm();
    editing = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: "", personality: "", memory: [], created: Date.now() };
    list.push(editing);
    renderEditor();
    ($("#ch-name") as HTMLInputElement).focus();
  });
  const file = $("#ch-face-file") as HTMLInputElement;
  $("#ch-face").addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    file.value = "";
    if (f) setFace(f);
  });
  $("#ch-face-clear").addEventListener("click", () => setFace(null));
  const faceBox = $("#ch-face");
  faceBox.addEventListener("dragover", (e) => {
    e.preventDefault();
    faceBox.classList.add("drop");
  });
  faceBox.addEventListener("dragleave", () => faceBox.classList.remove("drop"));
  faceBox.addEventListener("drop", (e) => {
    e.preventDefault();
    faceBox.classList.remove("drop");
    const f = imageIn(e.dataTransfer);
    if (f) setFace(f);
  });
  $("#ch-form").addEventListener("paste", (e) => {
    const f = imageIn((e as ClipboardEvent).clipboardData);
    if (!f || (e.target as HTMLElement).closest("textarea, input")) return;
    e.preventDefault();
    setFace(f);
  });
  // A cloned voice is named after the character and picked straight away.
  const clip = $("#ch-clone-file") as HTMLInputElement;
  $("#ch-clone").addEventListener("click", () => clip.click());
  clip.addEventListener("change", async () => {
    const f = clip.files?.[0];
    clip.value = "";
    if (!f || !editing) return;
    readForm();
    const name = (editing.name || "voice").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "voice";
    deps.toast("Cloning the voice…");
    try {
      const id = await cloneVoice(name, f);
      editing.voice = `vox:${id}`;
      deps.toast(`${editing.name || "The character"} now speaks with the cloned voice "${id}".`);
      renderVoices(editing.voice);
    } catch (e) {
      deps.toast(`Couldn't clone that voice: ${errMsg(e)}`, "warn");
    }
  });
  $("#ch-fact-add").addEventListener("click", () => {
    const inp = $("#ch-fact") as HTMLInputElement;
    const v = inp.value.trim();
    if (!v || !editing) return;
    editing.memory.push(v);
    inp.value = "";
    renderMemory();
  });
  ($("#ch-fact") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("#ch-fact-add").click();
    }
  });
  $("#ch-name").addEventListener("input", () => {
    readForm();
    renderList();
  });
  $("#ch-save").addEventListener("click", async () => {
    readForm();
    await save();
    renderEditor();
    renderPicker();
    deps.toast(`Saved ${editing?.name}.`);
  });
  $("#ch-talk").addEventListener("click", async () => {
    if (!editing) return;
    readForm();
    await save();
    deps.choose(editing.id);
    ($("#characters") as HTMLDialogElement).close();
  });
  $("#ch-video").addEventListener("click", async () => {
    if (!editing?.face) return;
    readForm();
    await save();
    ($("#characters") as HTMLDialogElement).close();
    deps.makeTalk(editing);
  });
  $("#ch-delete").addEventListener("click", async () => {
    if (!editing || !confirm(`Delete ${editing.name || "this character"}, with its memory? (Chats with it stay in Past chats.)`)) return;
    const id = editing.id;
    list = list.filter((c) => c.id !== id);
    editing = list[0] ?? null;
    if (deps.active() === id) deps.choose(undefined);
    await save();
    renderEditor();
    renderPicker();
  });
  $("#ch-close").addEventListener("click", async () => {
    // Unsaved new characters with no name are dropped; edits to others are kept as typed.
    readForm();
    list = list.filter((c) => c.name !== "Unnamed" || c.personality || c.face || c.memory.length);
    await save();
    renderPicker();
    ($("#characters") as HTMLDialogElement).close();
  });
}
