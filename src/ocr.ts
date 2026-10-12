// Read the text: Unlimited-OCR (ocr.rs, the Read documents pack) turns a picture of a page (a photo of a letter, a
// scan, a screenshot, a receipt) into Markdown with its headings and tables. Studio's right-click menu opens it on a
// picture; the result can be copied, or the picture added to Knowledge so chats can answer from it.
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { errMsg } from "./backends";
import { EMBED_MODEL } from "./knowledge";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

interface Deps {
  toast: (msg: string, kind?: string) => void;
  root: () => string | null;
}

let deps: Deps;
let installed = false;
let reading = 0;

/** Whether the Read documents pack is there (checked at start and when Studio opens). */
export const ocrReady = () => installed;

export async function checkOcr() {
  try {
    installed = (await invoke<{ installed: boolean }>("ocr_status", { root: deps.root() })).installed;
  } catch {
    installed = false;
  }
}

/** Reads the text of the picture at `path` and shows it. */
export async function readText(path: string, name: string) {
  const dlg = $("#ocr") as HTMLDialogElement;
  const body = $("#ocr-body");
  const mine = ++reading;
  let markdown = "";
  $("#ocr-name").textContent = name;
  $("#ocr-note").textContent = "Reading the page… The first time takes a little longer while llama.cpp loads Unlimited-OCR.";
  body.innerHTML = `<div class="spinner"></div>`;
  ($("#ocr-copy") as HTMLButtonElement).disabled = true;
  ($("#ocr-kb") as HTMLButtonElement).disabled = true;
  $("#ocr-copy").onclick = async () => {
    await navigator.clipboard.writeText(markdown);
    deps.toast("Copied the text as Markdown.");
  };
  $("#ocr-kb").onclick = async () => {
    try {
      await invoke("kb_add_paths", { paths: [path], model: EMBED_MODEL });
      deps.toast(`Added ${name} to Knowledge: chats can answer from it once it's read.`);
    } catch (e) {
      deps.toast(`Couldn't add it to Knowledge: ${errMsg(e)}`, "warn");
    }
  };
  if (!dlg.open) dlg.showModal();
  try {
    const r = await invoke<{ markdown: string; secs: number }>("ocr_read", { root: deps.root(), path });
    if (mine !== reading) return;
    markdown = r.markdown;
    body.innerHTML = markdown.trim() ? DOMPurify.sanitize(marked.parse(markdown, { async: false, gfm: true }) as string) : `<p class="muted">No text was found in this picture.</p>`;
    $("#ocr-note").textContent = `Read in ${r.secs < 10 ? r.secs.toFixed(1) : Math.round(r.secs)} s by Unlimited-OCR on this PC. Check names and numbers before you rely on them.`;
    ($("#ocr-copy") as HTMLButtonElement).disabled = !markdown.trim();
    ($("#ocr-kb") as HTMLButtonElement).disabled = !markdown.trim();
  } catch (e) {
    if (mine !== reading) return;
    body.innerHTML = "";
    $("#ocr-note").textContent = `Couldn't read it: ${errMsg(e)}.`;
  }
}

export function initOcr(d: Deps) {
  deps = d;
  $("#ocr-close").addEventListener("click", () => ($("#ocr") as HTMLDialogElement).close());
  checkOcr();
}
