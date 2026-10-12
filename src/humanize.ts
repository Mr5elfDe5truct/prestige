// Make it sound human: humanize.rs rewrites text with the humanizer model so it reads like a person wrote it, every
// fact, number and name kept. A reply gets a button beside its speaker (the rewrite shows under it, to copy), and the
// composer gets one that rewrites what's typed in the box (Ctrl+Z puts it back). Both show once the pack is installed.
import { invoke } from "@tauri-apps/api/core";
import { errMsg } from "./backends";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

interface Deps {
  toast: (msg: string, kind?: string) => void;
  root: () => string | null;
  md: (text: string) => string;
}

let deps: Deps;

export const HUMANIZE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20c2-1 3.5-3 4.5-5.5L15 6l3 3-8.5 6.5C7 16.5 5 18 4 20z" /><path d="M14 7l3 3M4 20h16" /></svg>`;

/** Checks for the pack; the buttons show (body.humanizer) when it's there. */
export async function checkHumanizer() {
  let on = false;
  try {
    on = await invoke<boolean>("humanize_status", { root: deps.root() });
  } catch {}
  document.body.classList.toggle("humanizer", on);
}

const FIRST = "Rewriting… The first time takes a little longer while llama.cpp loads the humanizer model.";

/** The button a reply gets beside its speaker: the rewrite of `text()` shows under the reply. */
export function humanizeButton(bubble: HTMLElement, text: () => string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "msg-humanize humanize-only";
  b.title = "Make it sound human";
  b.setAttribute("aria-label", "Make it sound human");
  b.innerHTML = HUMANIZE_SVG;
  b.addEventListener("click", async () => {
    $(".msg-humanized", bubble)?.remove();
    const box = document.createElement("div");
    box.className = "msg-humanized working";
    box.innerHTML = `<header><span>REWRITTEN TO SOUND HUMAN</span><span class="grow"></span><button type="button" class="linkish" data-copy hidden>copy</button><button type="button" class="linkish" data-close>close</button></header><div class="msg-body"></div>`;
    $(".msg-body", box).textContent = FIRST;
    $("[data-close]", box).addEventListener("click", () => box.remove());
    bubble.appendChild(box);
    b.disabled = true;
    try {
      const out = await invoke<string>("humanize", { root: deps.root(), text: text() });
      box.classList.remove("working");
      $(".msg-body", box).innerHTML = deps.md(out);
      const copy = $("[data-copy]", box) as HTMLButtonElement;
      copy.hidden = false;
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(out);
        deps.toast("Copied the rewrite.");
      });
    } catch (e) {
      box.classList.remove("working");
      $(".msg-body", box).textContent = `Couldn't rewrite it: ${errMsg(e)}.`;
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

/** Rewrites what's typed in the composer, as one edit (so Ctrl+Z puts the original back). */
async function humanizeComposer(ta: HTMLTextAreaElement, btn: HTMLButtonElement) {
  const draft = ta.value;
  if (!draft.trim()) return deps.toast("Type or paste something to rewrite first.");
  btn.disabled = true;
  ta.readOnly = true;
  deps.toast(FIRST);
  try {
    const out = await invoke<string>("humanize", { root: deps.root(), text: draft });
    ta.readOnly = false;
    ta.focus();
    ta.select();
    // insertText keeps the browser's undo history, unlike setting the value.
    if (!document.execCommand("insertText", false, out)) ta.value = out;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    deps.toast("Rewritten. Ctrl+Z puts yours back.");
  } catch (e) {
    deps.toast(`Couldn't rewrite it: ${errMsg(e)}`, "warn");
  } finally {
    ta.readOnly = false;
    btn.disabled = false;
  }
}

export function initHumanize(d: Deps) {
  deps = d;
  const btn = $("#composer-humanize") as HTMLButtonElement;
  btn.addEventListener("click", () => humanizeComposer($("#prompt") as HTMLTextAreaElement, btn));
  checkHumanizer();
}
