import { invoke } from "@tauri-apps/api/core";
import { phonePush } from "./phone";
import { characterById } from "./characters";
import { $, busy, chat, setChat, type Chat, choosePersona, escapeHtml, inTauri, newChat, settings, toast } from "./main";
import { renderChat } from "./chatrender";

// ---------- history ----------
export interface ChatHit {
  id: string;
  title: string;
  updated: number;
  model?: string;
  hits?: number;
  index?: number | null;
  snippet?: string;
}

/** Escapes `text` and wraps each search word in <mark>. */
export function highlight(text: string, terms: string[]) {
  if (!terms.length) return escapeHtml(text);
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  // split() with a capture group alternates plain text and matches.
  return text.split(re).map((part, i) => (i % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part))).join("");
}

export async function persist() {
  chat.updated = Date.now();
  if (inTauri) await invoke("save_chat", { id: chat.id, chat });
  phonePush({ type: "saved", chatId: chat.id });
  await renderHistory();
}

/** Opens a saved chat (from Past chats, or a mission's result); false when a reply is still running. */
export async function openSavedChat(id: string): Promise<boolean> {
  if (busy) {
    toast("Wait for the reply to finish first.");
    return false;
  }
  setChat(await invoke<Chat>("load_chat", { id }));
  // Carry on with whoever the chat was with.
  if ((chat.character ?? undefined) !== settings.character && (!chat.character || characterById(chat.character))) choosePersona(chat.character, true);
  renderChat();
  renderHistory();
  return true;
}

export async function renderHistory() {
  const list = $("#history-list");
  if (!inTauri) {
    list.innerHTML = `<p class="muted" style="padding:10px">History is saved in the desktop app.</p>`;
    return;
  }
  // With words in the search box, the list is the chats that contain all of them, each with the matching passage.
  const query = ($("#history-search") as HTMLInputElement).value.trim();
  const items = query
    ? await invoke<ChatHit[]>("search_chats", { query, exclude: null, width: 140 })
    : await invoke<ChatHit[]>("list_chats");
  if (query !== ($("#history-search") as HTMLInputElement).value.trim()) return; // a newer search is on its way
  list.innerHTML = items.length
    ? ""
    : `<p class="muted" style="padding:10px;font-size:12.5px">${query ? "No chats mention that." : "No saved chats yet."}</p>`;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "history-item" + (it.id === chat.id ? " sel" : "");
    row.innerHTML = `<button class="open"><span class="t"></span><span class="m"></span></button><button class="del" aria-label="Delete chat" title="Delete">✕</button>`;
    $(".t", row).textContent = it.title || "Untitled";
    $(".m", row).textContent = [
      new Date(it.updated).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      it.model,
      query && it.hits ? `${it.hits} ${it.hits === 1 ? "match" : "matches"}` : "",
    ].filter(Boolean).join(" · ");
    if (it.snippet) {
      const s = document.createElement("span");
      s.className = "s";
      s.innerHTML = highlight(it.snippet, terms);
      $(".open", row).appendChild(s);
    }
    $(".open", row).addEventListener("click", async () => {
      if (!(await openSavedChat(it.id))) return;
      $("#history").hidden = true;
      // Jump to the message that matched.
      if (it.index != null) {
        const hit = $(`#thread [data-i="${it.index}"]`);
        hit?.scrollIntoView({ block: "center" });
        hit?.classList.add("found");
        setTimeout(() => hit?.classList.remove("found"), 2400);
      }
    });
    $(".del", row).addEventListener("click", async () => {
      if (!confirm(`Delete "${it.title}"?`)) return;
      await invoke("delete_chat", { id: it.id });
      if (it.id === chat.id) {
        setChat(newChat());
        renderChat();
      }
      renderHistory();
    });
    list.appendChild(row);
  }
}
