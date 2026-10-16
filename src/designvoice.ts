// Design a voice: describe it in words ("a gravelly old pirate") and VoxCPM2 makes it up, a few takes at a time since
// each comes out different. The take that's kept is saved on the voice server like a cloned voice (the take is the clip,
// the line its transcript), so every sentence after sounds like it. Opened from a Character's voice and the Voice screen.
import { errMsg } from "./backends";
import { cloneVoice, designVoice } from "./speech";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const LINE = "Hello there. It's good to hear from you, and I'm ready whenever you are. What should we make today?";

let ready = false;
let busy = false;
let made: { text: string; description: string; takes: Blob[] } | null = null;
let urls: string[] = [];
let done: ((voice: string) => void) | null = null;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

function clearTakes() {
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
  made = null;
  $("#dv-takes").innerHTML = "";
}

function renderTakes() {
  const box = $("#dv-takes");
  box.innerHTML = "";
  made?.takes.forEach((b, i) => {
    const url = URL.createObjectURL(b);
    urls.push(url);
    const row = document.createElement("div");
    row.className = "dv-take";
    row.innerHTML = `<b>Take ${i + 1}</b><audio controls preload="auto"></audio><button type="button" class="btn primary">Keep this one</button>`;
    $("audio", row).setAttribute("src", url);
    $("button", row).addEventListener("click", () => keep(i));
    box.appendChild(row);
  });
}

async function make(toast: (m: string, k?: string) => void) {
  const description = ($("#dv-desc") as HTMLTextAreaElement).value.trim();
  if (!description) {
    ($("#dv-desc") as HTMLTextAreaElement).focus();
    return;
  }
  if (busy) return;
  busy = true;
  clearTakes();
  const n = Number(($("#dv-count") as HTMLSelectElement).value) || 3;
  const btn = $("#dv-make") as HTMLButtonElement;
  btn.disabled = true;
  const t0 = performance.now();
  $("#dv-status").textContent = `Making ${n} takes with VoxCPM2… (about ${n * 10}–${n * 20} s; the chat model steps aside while it works)`;
  try {
    const r = await designVoice(description, ($("#dv-text") as HTMLInputElement).value.trim() || LINE, n);
    made = { ...r, description };
    $("#dv-status").textContent = `${r.takes.length} takes in ${Math.round((performance.now() - t0) / 1000)} s. Play them and keep one, or change the words and make more.`;
    renderTakes();
  } catch (e) {
    $("#dv-status").textContent = "";
    toast(`Couldn't design that voice: ${errMsg(e)}`, "warn");
  } finally {
    busy = false;
    btn.disabled = false;
  }
}

async function keep(i: number) {
  if (!made) return;
  const name = slug(($("#dv-name") as HTMLInputElement).value) || slug(made.description) || "designed";
  try {
    const id = await cloneVoice(name, made.takes[i], made.text, made.description);
    const cb = done;
    ($("#design-voice") as HTMLDialogElement).close();
    cb?.(`vox:${id}`);
  } catch (e) {
    $("#dv-status").textContent = `Couldn't save it: ${errMsg(e)}`;
  }
}

/** Opens the window; `onSaved` gets the kept voice ("vox:<name>"). `name` is the suggested name (e.g. the character's). */
export function openDesignVoice(name: string, toast: (m: string, k?: string) => void, onSaved: (voice: string) => void) {
  const dlg = $("#design-voice") as HTMLDialogElement;
  if (!ready) {
    ready = true;
    $("#dv-make").addEventListener("click", () => make(toast));
    // Enter in a field makes takes instead of closing the window.
    dlg.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.target as HTMLElement).matches("input")) {
        e.preventDefault();
        make(toast);
      }
    });
    dlg.addEventListener("close", () => {
      clearTakes();
      done = null;
    });
  }
  done = onSaved;
  clearTakes();
  $("#dv-status").textContent = "";
  const text = $("#dv-text") as HTMLInputElement;
  if (!text.value) text.value = LINE;
  ($("#dv-name") as HTMLInputElement).value = slug(name);
  dlg.showModal();
  ($("#dv-desc") as HTMLTextAreaElement).focus();
}
