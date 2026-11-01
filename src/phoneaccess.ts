import { phoneOn, phonePush } from "./phone";
import { invoke } from "@tauri-apps/api/core";
import { activeCharacter, characterById, characters, setCharacterVoice } from "./characters";
import { faceThumb, phoneQueue } from "./studiophone";
import { beginWork, endWork, isWorking, pctOf, stepWork } from "./working";
import { addFact, listFacts } from "./memory";
import { GROUPS, loadTools } from "./tools";
import { freeLlamaVram, type ModelInfo } from "./backends";
import { isVox } from "./speech";
import { $, $$, setAttachments, beginLiveChat, busy, chat, setChat, type Chat, choosePersona, current, go, inTauri, liveModels, memCfg, models, newChat, refreshMemoryStatus, renderAttachments, saveSettings, selectModel, send, settings, syncPhone } from "./main";
import { renderChat } from "./chatrender";
import { renderHistory } from "./chathistory";
import { enabledGroups, updateToolsButton } from "./chattools";

// ---------- phone access ----------
/** A reply is starting in this chat: it's saved first (with the user's message), so a phone can open it straight away,
 *  then phones are told, with the message, so they can show it before they've fetched anything. Every reply does this,
 *  typed here or on a phone. */
export function phoneReplyStart(who: string, text: string) {
  if (!phoneOn() || !inTauri) return;
  const id = chat.id;
  chat.updated = Date.now();
  invoke("save_chat", { id, chat })
    .catch(() => {})
    .finally(() => {
      phonePush({ type: "started", chatId: id, who, text, title: chat.title });
      syncPhone();
    });
}
export const phoneDelta = (id: string, text: string) => phonePush({ type: "delta", chatId: id, text });
export const phoneReplyEnd = (id: string) => {
  phonePush({ type: "done", chatId: id });
  syncPhone();
};

/** A message from a paired phone (phone.rs): it runs in the app's own chat, so everything works from the phone, and the
 *  reply streams back to it. A phone message for another chat opens that chat here first; no chat id starts a new one. */
export async function fromPhone(p: PhoneSend) {
  if (busy && (p.interrupt || (p.live && phoneLive))) {
    // Talking over a reply in a call cuts it off, as on the PC; the next turn starts once it has wrapped up.
    busy.abort();
    for (let i = 0; busy && i < 60; i++) await new Promise((r) => setTimeout(r, 50));
  }
  if (busy) {
    phonePush({ type: "error", text: "Prestige is busy with another reply. Try again when it's done.", busy: true });
    return;
  }
  try {
    if (p.chatId && p.chatId !== chat.id) {
      setChat(await invoke<Chat>("load_chat", { id: p.chatId }));
      if ((chat.character ?? undefined) !== settings.character && (!chat.character || characterById(chat.character))) choosePersona(chat.character, true);
    } else if (!p.chatId && chat.messages.length) setChat(newChat());
  } catch {
    setChat(newChat());
  }
  go("chat");
  renderChat();
  renderHistory();
  // The reply streams to phones like every reply (phoneReplyStart / phoneDelta / phoneReplyEnd); this only refreshes
  // the phone's header afterwards. The hooks also keep the reply from being read aloud on the PC.
  const hooks = { onDone: () => syncPhone() };
  // A turn of a Live call on the phone: what was said, with the camera's frame, answered by the Live model.
  if (p.live && phoneLive) return send(p.text, { images: p.images?.length ? p.images : undefined, live: phoneLive, hooks });
  const m = p.model ? models.find((x) => x.key === p.model) : null;
  if (m && m.key !== current?.key) selectModel(m);
  // Photos from the phone are attachments, like pictures added here: a vision model looks at them, /image uses the
  // first as its reference and /edit changes it.
  if (p.images?.length) {
    setAttachments(p.images.slice(0, 4));
    renderAttachments();
  }
  send(p.text, { hooks });
}

/** Phones see the render queue as it changes: at most once a second while a render's progress moves, straight away
 *  when one is added or finishes (and then the gallery is new too). */
export let queueSent = 0;
export let queueTimer: number | undefined;
export let queueShape = "";
/** The render queue in the working readout: what's rendering now and how many wait. */
export function queueWork() {
  const q = phoneQueue();
  const run = q.find((j) => j.state === "running");
  const waiting = q.filter((j) => j.state === "waiting").length;
  if (!run && !waiting) return endWork("render");
  const what = `Render queue${waiting ? ` · ${waiting} waiting` : ""}`;
  beginWork("render", what);
  stepWork("render", run ? `${run.label}: ${run.status || "rendering"}` : "Waiting to start…", run?.pct);
}

/** The working readout follows what the newest reply says it's doing: every feature writes its steps into a
 *  .status-line in the bubble ("Searching your files…", "Rendering (42%)"), and once the words come it's writing. */
export function watchReplySteps() {
  const thread = $("#thread");
  let queued = false;
  let seen = "";
  const read = () => {
    queued = false;
    if (!isWorking("reply")) return void (seen = "");
    const bubble = $$(".msg.ai", thread).pop();
    if (!bubble) return;
    const line = $$(".status-line", bubble).pop()?.textContent?.trim();
    const bar = ($(".progress", bubble) as HTMLElement | null)?.style.getPropertyValue("--v");
    const text = line || ($(".msg-body", bubble)?.textContent?.trim() ? "Writing the reply…" : "");
    // Only what changed in the bubble: Do it for me and tool calls also say what they're doing straight to the readout.
    const key = `${text}|${bar ?? ""}`;
    if (!text || key === seen) return;
    seen = key;
    stepWork("reply", text, (line ? pctOf(line) : undefined) ?? (bar ? Number(bar) : undefined));
  };
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(read);
  }).observe(thread, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style"] });
}

export function phoneQueueChanged() {
  if (!phoneOn()) return;
  const q = phoneQueue();
  const shape = q.map((j) => `${j.id}:${j.state}`).join(",");
  const send = () => {
    queueSent = Date.now();
    phonePush({ type: "queue", queue: phoneQueue() });
  };
  clearTimeout(queueTimer);
  if (shape !== queueShape) {
    const before = new Set(queueShape.split(","));
    const finished = q.some((j) => j.state === "done" && !before.has(`${j.id}:done`));
    queueShape = shape;
    send();
    if (finished) phonePush({ type: "gallery" });
  } else if (Date.now() - queueSent >= 1000) send();
  else queueTimer = window.setTimeout(send, 1000 - (Date.now() - queueSent));
}

/** Characters on the phone: who there is to talk to (with a small face), and picking one (or Prestige, with no id). */
export async function phoneCharacters(action: string, a: any) {
  if (action === "choose") {
    if (a.id && !characterById(String(a.id))) throw new Error("That character isn't there any more.");
    choosePersona(a.id ? String(a.id) : undefined, true);
    return { ok: true };
  }
  if (action !== "list") throw new Error(`unknown Characters action ${action}`);
  return {
    active: activeCharacter()?.id ?? null,
    list: await Promise.all(
      characters().map(async (c) => ({
        id: c.id,
        name: c.name,
        about: c.personality.slice(0, 160),
        voice: c.voice ?? "",
        memories: c.memory.length,
        thumb: c.face ? await faceThumb(c).catch(() => "") : "",
      })),
    ),
  };
}

/** Settings on the phone: the tool groups models may use in chat, "use my files in every chat", and shared memory. */
export async function phoneSettings(action: string, a: any) {
  if (action === "tool") {
    const next = enabledGroups();
    a.on ? next.add(String(a.id)) : next.delete(String(a.id));
    settings.toolGroups = [...next];
    saveSettings();
    updateToolsButton();
  } else if (action === "kbAll") {
    settings.kbAll = a.on ? undefined : false;
    saveSettings();
  } else if (action === "remember") {
    const fact = String(a.fact ?? "").trim();
    if (!fact) throw new Error("Say what to remember.");
    await addFact(fact, memCfg());
    refreshMemoryStatus();
  } else if (action === "memories") {
    return { memories: (await listFacts()).map((m) => m.content) };
  } else if (action !== "list") throw new Error(`unknown Settings action ${action}`);
  const on = enabledGroups();
  const { tools } = await loadTools();
  return {
    tools: GROUPS.map((g) => ({ id: g.id, label: g.label, hint: g.hint, on: on.has(g.id), count: tools.filter((t) => t.group === g.id).length })),
    kbAll: settings.kbAll !== false,
    memory: true,
  };
}

export interface PhoneSend {
  chatId?: string | null;
  text: string;
  model?: string | null;
  images?: string[];
  live?: boolean;
  interrupt?: boolean; // a turn of a voice call: it cuts off a reply that's still running
}

/** The Live model a call on the phone uses (null when no call is on). */
export let phoneLive: ModelInfo | null = null;

/** A Live call starting on the phone: makes room on the GPU, picks the Live model and opens the call's chat. The phone
 *  does the listening and speaking; each turn arrives as a phone message with live set. */
export async function phoneLiveCall(on: boolean) {
  if (!on) {
    phoneLive = null;
    syncPhone();
    return;
  }
  const have = liveModels();
  if (!have.length) {
    phonePush({ type: "error", text: "Live needs Qwen3.5 2B or 4B. Add one from the model catalog on the PC." });
    return;
  }
  busy?.abort();
  // A VoxCPM2 voice takes ~6 GB, so it gets the smaller Live model (as on the PC).
  phoneLive = isVox(activeCharacter()?.voice || settings.voice) ? have[have.length - 1] : have[0];
  await freeLlamaVram(["ollama", "voice"]).catch(() => {});
  beginLiveChat();
  go("chat");
  syncPhone();
  phonePush({ type: "live", on: true, model: phoneLive.name, chatId: chat.id });
}

/** A voice picked on the Voice screen or in a call: the character's new voice while talking to one, else Prestige's. */
export function setVoicePref(v: string) {
  const c = activeCharacter();
  if (c) setCharacterVoice(c, v);
  else {
    settings.voice = v;
    saveSettings();
  }
}

/** Live calls show the character's face in place of the top hat. */
export function livePersona() {
  const c = activeCharacter();
  const img = $("#live-face") as HTMLImageElement;
  img.hidden = !c?.face;
  if (c?.face) img.src = `data:image/jpeg;base64,${c.face}`;
  $("#live").classList.toggle("has-face", !!c?.face);
}
