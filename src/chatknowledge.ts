import { citeLabel, docById, type KbDoc, openSource, readyDocs, type Source } from "./knowledge";
import { persist } from "./chathistory";
import { $, chat, toast } from "./main";

// ---------- Knowledge in chat ----------
/** Under a reply: the passages it was given, as file · page chips (the ones it cited first), and its [file, p. N]
 *  citations turned into buttons that open the file. */
export function renderSources(bubble: HTMLElement, sources: Source[], text: string) {
  bubble.querySelector(".sources")?.remove();
  const body = $(".msg-body", bubble);
  const labels = new Map(sources.map((s) => [citeLabel(s).toLowerCase(), s]));
  // In-text citations: text nodes only, so code blocks and links stay as they are.
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const n of nodes) {
    if (n.parentElement?.closest("pre, code, a, button") || !/\[[^\[\]]+\]/.test(n.data)) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of n.data.matchAll(/\[([^\[\]]{2,200})\]/g)) {
      // A citation can name several sources: [a.pdf, p. 2; b.pdf, p. 7].
      const parts = m[1].split(/\s*;\s*/).map((p) => labels.get(p.trim().toLowerCase()));
      if (!parts.every(Boolean)) continue;
      frag.append(n.data.slice(last, m.index));
      parts.forEach((s) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "cite";
        b.textContent = citeLabel(s!);
        b.title = `${s!.text.slice(0, 400)}${s!.text.length > 400 ? "…" : ""}\n\nClick to open the file.`;
        b.addEventListener("click", () => openSource(s!));
        frag.append(b);
      });
      last = m.index! + m[0].length;
    }
    if (!last) continue;
    frag.append(n.data.slice(last));
    n.replaceWith(frag);
  }
  // The chips: one per file and page, cited ones first.
  const seen = new Map<string, { s: Source; cited: boolean }>();
  const said = text.toLowerCase();
  for (const s of sources) {
    const key = citeLabel(s).toLowerCase();
    if (!seen.has(key)) seen.set(key, { s, cited: said.includes(key) });
  }
  const row = document.createElement("div");
  row.className = "sources";
  row.innerHTML = `<span class="eyebrow">Sources</span>`;
  for (const { s, cited } of [...seen.values()].sort((a, b) => Number(b.cited) - Number(a.cited))) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cited ? "cited" : "";
    b.textContent = citeLabel(s);
    b.title = `${cited ? "" : "Given to the model but not cited. "}${s.text.slice(0, 400)}${s.text.length > 400 ? "…" : ""}\n\nClick to open the file.`;
    b.addEventListener("click", () => openSource(s));
    row.appendChild(b);
  }
  body.after(row);
}

/** Above the message box: the files attached to this chat (their passages go with every message). */
export function renderChatFiles() {
  const box = $("#chat-files");
  const ids = chat.files ?? [];
  box.hidden = !ids.length;
  box.innerHTML = "";
  for (const id of ids) {
    const d = docById(id);
    const chip = document.createElement("span");
    chip.className = "cf";
    chip.innerHTML = `<span></span><small></small><button type="button" aria-label="Detach from this chat" title="Stop using it in this chat (it stays in Knowledge)">✕</button>`;
    $("span", chip).textContent = d?.name ?? "a removed file";
    $("small", chip).textContent = !d ? "gone" : d.state === "ready" ? (d.pages ? `${d.pages} p.` : "ready") : d.state === "error" ? "error" : "reading…";
    chip.title = d?.error ?? d?.path ?? "";
    $("button", chip).addEventListener("click", () => {
      chat.files = (chat.files ?? []).filter((x) => x !== id);
      if (!chat.files.length) chat.files = undefined;
      renderChatFiles();
      if (chat.messages.length) persist().catch(() => {});
    });
    box.appendChild(chip);
  }
  if (ids.length) {
    const note = document.createElement("span");
    note.className = "cf-note";
    note.textContent = "Ask about them: answers cite the file and page.";
    box.appendChild(note);
  }
  const badge = document.getElementById("kb-count-badge");
  if (badge) badge.textContent = readyDocs().length ? String(readyDocs().length) : "";
}

/** Adds documents to Knowledge and attaches them to this chat. */
export function attachDocs(added: KbDoc[]) {
  if (!added.length) return;
  chat.files = [...new Set([...(chat.files ?? []), ...added.map((d) => d.id)])];
  renderChatFiles();
  if (chat.messages.length) persist().catch(() => {});
  toast(`Reading ${added.length === 1 ? added[0].name : `${added.length} files`}. Ask about ${added.length === 1 ? "it" : "them"} any time.`);
}
