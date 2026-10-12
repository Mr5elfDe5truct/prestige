// Translate: Index-Translate (translate.rs, the Translate pack) puts text, or the text in a picture, into another of
// its 150 languages. The globe under the chat box opens it with what's typed there; Studio's right-click menu opens it
// on a picture. The result can be copied or put in the chat box.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { errMsg } from "./backends";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

interface Deps {
  toast: (msg: string, kind?: string) => void;
  root: () => string | null;
}

let deps: Deps;
let installed = false;
let picture: string | null = null; // a picture's path, when it's the picture's text being translated
let running = 0;

/** The menu's languages (Index-Translate takes 150; any other can be typed). */
const LANGUAGES = [
  "English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch", "Polish", "Romanian", "Swedish", "Danish",
  "Norwegian", "Finnish", "Greek", "Czech", "Slovak", "Hungarian", "Bulgarian", "Ukrainian", "Russian", "Turkish", "Arabic",
  "Persian", "Hindi", "Chinese", "Japanese", "Korean", "Vietnamese", "Thai", "Indonesian", "Malay", "Filipino",
];
const LAST = "prestige.translate.to";

export const translateReady = () => installed;

export async function checkTranslate() {
  try {
    installed = await invoke<boolean>("translate_status", { root: deps.root() });
  } catch {
    installed = false;
  }
  document.body.classList.toggle("translator", installed);
}

function target(): string {
  const sel = $("#tr-to") as HTMLSelectElement;
  return sel.value === "other" ? ($("#tr-other") as HTMLInputElement).value.trim() : sel.value;
}

function showSource() {
  const pic = $("#tr-pic") as HTMLImageElement;
  pic.hidden = !picture;
  if (picture) pic.src = convertFileSrc(picture);
  ($("#tr-text") as HTMLTextAreaElement).hidden = !!picture;
  $("#tr-pic-clear").hidden = !picture;
}

/** Opens Translate with `text` to translate, or the text in the picture at `path`. */
export function openTranslate(text = "", path: string | null = null) {
  const dlg = $("#translate") as HTMLDialogElement;
  picture = path;
  ($("#tr-text") as HTMLTextAreaElement).value = text;
  $("#tr-out").textContent = "";
  $("#tr-note").textContent = "";
  ($("#tr-copy") as HTMLButtonElement).disabled = true;
  ($("#tr-use") as HTMLButtonElement).disabled = true;
  showSource();
  if (!dlg.open) dlg.showModal();
  (picture ? $("#tr-go") : $("#tr-text")).focus();
}

async function run() {
  const to = target();
  if (!to) return deps.toast("Pick a language to translate into.");
  const text = ($("#tr-text") as HTMLTextAreaElement).value;
  if (!picture && !text.trim()) return deps.toast("Type or paste something to translate.");
  try {
    localStorage.setItem(LAST, to);
  } catch {}
  const mine = ++running;
  const go = $("#tr-go") as HTMLButtonElement;
  go.disabled = true;
  $("#tr-out").textContent = "";
  $("#tr-note").textContent = "Translating… The first time takes a minute or two while llama.cpp loads Index-Translate.";
  const t0 = Date.now();
  try {
    const out = picture
      ? await invoke<string>("translate_image", { root: deps.root(), path: picture, target: to })
      : await invoke<string>("translate_text", { root: deps.root(), text, target: to });
    if (mine !== running) return;
    $("#tr-out").textContent = out;
    $("#tr-note").textContent = `Translated into ${to} in ${Math.round((Date.now() - t0) / 1000)} s by Index-Translate on this PC.`;
    ($("#tr-copy") as HTMLButtonElement).disabled = false;
    ($("#tr-use") as HTMLButtonElement).disabled = false;
  } catch (e) {
    if (mine === running) $("#tr-note").textContent = `Couldn't translate it: ${errMsg(e)}.`;
  } finally {
    go.disabled = false;
  }
}

export function initTranslate(d: Deps) {
  deps = d;
  const sel = $("#tr-to") as HTMLSelectElement;
  sel.innerHTML = LANGUAGES.map((l) => `<option>${l}</option>`).join("") + `<option value="other">Another language…</option>`;
  let last = "English";
  try {
    last = localStorage.getItem(LAST) || last;
  } catch {}
  if (LANGUAGES.includes(last)) sel.value = last;
  else {
    sel.value = "other";
    ($("#tr-other") as HTMLInputElement).value = last;
  }
  const other = () => ($("#tr-other") as HTMLInputElement).hidden = sel.value !== "other";
  sel.addEventListener("change", other);
  other();
  $("#tr-go").addEventListener("click", run);
  $("#tr-close").addEventListener("click", () => ($("#translate") as HTMLDialogElement).close());
  $("#tr-pic-clear").addEventListener("click", () => {
    picture = null;
    showSource();
  });
  $("#tr-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#tr-out").textContent ?? "");
    deps.toast("Copied the translation.");
  });
  $("#tr-use").addEventListener("click", () => {
    const ta = $("#prompt") as HTMLTextAreaElement;
    ta.value = $("#tr-out").textContent ?? "";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ($("#translate") as HTMLDialogElement).close();
    ta.focus();
  });
  $("#composer-translate").addEventListener("click", () => openTranslate(($("#prompt") as HTMLTextAreaElement).value));
  checkTranslate();
}
