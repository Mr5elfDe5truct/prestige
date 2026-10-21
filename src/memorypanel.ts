// The Memory sheet: every fact Prestige's models know about the user (memory.ts), to add, change or delete, and the
// Open WebUI copy (when it's connected) brought up to date on request.
import { errMsg } from "./backends";
import { addFact, editFact, listFacts, removeFact, syncFromOwui, type MemoryConfig } from "./memory";
import { hyMemoryInstalled, memoryWriter, setMemoryWriter, type MemoryWriter } from "./memwriter";

interface Deps {
  owui: () => MemoryConfig | null;
  toast: (msg: string, kind?: string) => void;
  onChange: () => void;
}
let deps: Deps;
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;

async function render() {
  const list = $("#mem-list");
  const facts = await listFacts();
  const q = ($("#mem-filter") as HTMLInputElement).value.trim().toLowerCase();
  const shown = q ? facts.filter((f) => f.content.toLowerCase().includes(q) || f.path?.toLowerCase().includes(q)) : facts;
  $("#mem-count").textContent = `${facts.length} ${facts.length === 1 ? "fact" : "facts"}${q ? `, ${shown.length} shown` : ""}`;
  list.innerHTML = "";
  if (!shown.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = facts.length ? "Nothing matches." : 'Nothing yet. Add a fact above, or say "remember that …" in any chat.';
    list.append(p);
  }
  for (const f of shown) {
    const row = document.createElement("div");
    row.className = "mem-row";
    const text = document.createElement("div");
    text.className = "mem-text";
    text.textContent = f.path ? `${f.path}: ${f.content}` : f.content;
    text.title = f.type === "user" ? "Given to every reply" : "Given when it's relevant to the conversation";
    const tag = document.createElement("small");
    tag.className = "muted";
    tag.textContent = [f.type === "user" ? "always" : "when relevant", f.type === "learned" ? "learned from a chat" : "", f.owui ? "also in Open WebUI" : ""].filter(Boolean).join(" · ");
    const acts = document.createElement("span");
    acts.className = "mem-acts";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "linkish";
    edit.textContent = "edit";
    edit.addEventListener("click", () => {
      const box = document.createElement("textarea");
      box.value = f.content;
      box.rows = Math.min(6, Math.ceil(f.content.length / 70) + 1);
      text.replaceWith(box);
      box.focus();
      const done = async (keep: boolean) => {
        if (keep && box.value.trim() && box.value.trim() !== f.content) await editFact(f.id, box.value, deps.owui());
        render();
      };
      box.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), done(true));
        if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), done(false));
      });
      box.addEventListener("blur", () => done(true));
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "linkish";
    del.textContent = "delete";
    del.addEventListener("click", async () => {
      await removeFact(f.id, deps.owui());
      deps.onChange();
      render();
    });
    acts.append(edit, del);
    row.append(text, acts, tag);
    list.append(row);
  }
  const cfg = deps.owui();
  $("#mem-owui").hidden = !cfg;
}

/** The writer picker: Hy-Memory only once its pack is in. */
function renderWriter() {
  const sel = $("#mem-writer") as HTMLSelectElement;
  const hy = sel.querySelector("option[value=hymemory]") as HTMLOptionElement;
  hy.disabled = !hyMemoryInstalled();
  hy.textContent = hyMemoryInstalled() ? "With Hy-Memory, after a chat goes quiet" : "With Hy-Memory (add the Hy-Memory pack in Packs)";
  sel.value = memoryWriter();
  $("#mem-writer-note").textContent =
    sel.value === "off"
      ? ""
      : `${sel.value === "hymemory" ? "Hy-Memory (Tencent, made for writing memory) loads in place of a llama.cpp chat model for a minute or so." : "The model you're chatting with does it."} It reads what you said, then adds, updates or removes facts here; a new message stops it.`;
}

export function openMemoryPanel() {
  const dlg = $<HTMLDialogElement>("#memory");
  renderWriter();
  ($("#mem-filter") as HTMLInputElement).value = "";
  render();
  if (!dlg.open) dlg.showModal();
  const cfg = deps.owui();
  if (cfg) syncFromOwui(cfg).then((n) => n && (render(), deps.onChange())).catch(() => {});
}

export function initMemoryPanel(d: Deps) {
  deps = d;
  const add = $("#mem-add-text") as HTMLInputElement;
  const save = async () => {
    const t = add.value.trim();
    if (!t) return;
    await addFact(t, deps.owui());
    add.value = "";
    deps.onChange();
    render();
  };
  $("#mem-add").addEventListener("click", save);
  add.addEventListener("keydown", (e) => {
    if (e.key === "Enter") (e.preventDefault(), save());
  });
  $("#mem-filter").addEventListener("input", () => render());
  $("#mem-writer").addEventListener("change", (e) => {
    setMemoryWriter((e.target as HTMLSelectElement).value as MemoryWriter);
    renderWriter();
  });
  $("#mem-owui").addEventListener("click", async () => {
    const cfg = deps.owui();
    if (!cfg) return;
    try {
      const n = await syncFromOwui(cfg, true);
      deps.toast(n ? `Copied ${n} new ${n === 1 ? "fact" : "facts"} from Open WebUI.` : "Nothing new in Open WebUI.");
      deps.onChange();
      render();
    } catch (e) {
      deps.toast(`Couldn't read Open WebUI's memory: ${errMsg(e)}`, "warn");
    }
  });
}
