// What chat makes through Studio's render queue: pictures and videos (/image, /video, /edit), worlds, 3D models, talking videos and songs.
import { allowRenders, cancelRender, editLabel, editMedia, type MediaKind, modelLabel, openRender, renderMedia, renderModel, renderSong, renderTalk, renderWorld, songSeconds, talkSecs } from "./renderapi";
import { type Reference, referenceFromBase64, type RefKind } from "./reference";
import { phoneReplyEnd, phoneReplyStart } from "./phoneaccess";
import { phonePush } from "./phone";
import { errMsg, http } from "./backends";
import { nextSegment, splitCamera, WORLD_MAX_SEGMENTS, WORLD_NEXT, type WorldState, writeWorld } from "./world";
import { openModel } from "./canvas";
import { askSpeech, speakLine } from "./talking";
import { writeSong } from "./songwriter";
import { $, busy, setBusy, canSee, chat, current, inTauri, type ReplyHooks, scrollDown, seeingModel, selectModel, setBusyUi, settings, type StoredMessage, toast } from "./main";
import { addAiBubble, md, reactButton, renderBody, renderChat, renderFigure } from "./chatrender";
import { persist } from "./chathistory";

/** Makes images with the Studio's image model (Qwen-Image-2.1 or its turbo), or a video with LTX, and shows them in the chat. */
export async function makeMedia(text: string, kind: MediaKind, prompt: string, hooks?: ReplyHooks, refB64?: string, refKind?: RefKind, edit = false, moreB64: string[] = []) {
  const what = kind === "video" ? "video" : "image";
  if (!inTauri) {
    toast(`${kind === "video" ? "Videos" : "Images"} are made in the desktop app.`);
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = text.replace(/\s+/g, " ").slice(0, 60);
  chat.messages.push({ role: "user", content: text, images: refB64 ? [refB64, ...moreB64] : undefined });
  renderChat();
  const label = edit ? editLabel() : await modelLabel(kind, !!refB64);
  const reply: StoredMessage = { role: "assistant", content: "", model: label };
  const bubble = addAiBubble(label);
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart(label, text);
  let lastStatus = 0;
  body.innerHTML = `<div class="render-progress"><div class="progress"><i></i></div><span class="status-line">Starting…</span></div>`;
  scrollDown(true);
  setBusy(new AbortController());
  busy!.signal.addEventListener("abort", () => cancelRender(), { once: true });
  setBusyUi(true, kind === "video" ? "Video" : "Picture");
  const t0 = Date.now();
  try {
    const ref = refB64 ? await referenceFromBase64(refB64) : undefined;
    const progress = (pct: number, label: string) => {
      ($(".progress", body) as HTMLElement | null)?.style.setProperty("--v", String(pct));
      const l = $(".status-line", body);
      if (l) l.textContent = label;
      // Phones see the render's progress too (at most every 2 s).
      if (Date.now() - lastStatus > 2000) {
        lastStatus = Date.now();
        phonePush({ type: "status", chatId: replyChat, text: `${label} (${Math.round(pct)}%)` });
      }
    };
    // /edit changes the picture itself; otherwise it's a new picture (with the reference's subject in it, if any).
    const extras = edit ? await Promise.all(moreB64.map((b) => referenceFromBase64(b))) : [];
    const got = edit && ref ? await editMedia(prompt, ref, progress, extras) : await renderMedia(kind, prompt, progress, ref, refKind);
    if (ref) URL.revokeObjectURL(ref.url);
    for (const x of extras) URL.revokeObjectURL(x.url);
    const [a, ...more] = got;
    reply.render = { path: a.path, prompt, seconds: Math.round((Date.now() - t0) / 1000), kind, ...(more.length ? { more: more.map((x) => x.path) } : {}) };
    // What chat models see in later turns.
    const names = got.map((x) => x.name).join(", ");
    reply.content = edit
      ? `(I edited the picture with ${label}: "${prompt}". Saved as ${names}.)`
      : `(I made ${got.length > 1 ? `${got.length} images` : `a ${what}`} with ${label}${refB64 ? " from the attached reference picture" : ""} for: "${prompt}". Saved as ${names}.)`;
    renderFigure(bubble, reply.render);
  } catch (e) {
    if (busy?.signal.aborted) reply.content = "*(stopped)*";
    else {
      reply.error = true;
      reply.content = `Couldn't make the ${what}: ${errMsg(e)}`;
      bubble.classList.add("error");
    }
    body.innerHTML = md(reply.content);
  } finally {
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    setBusy(null);
    setBusyUi(false);
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    if (hooks) {
      hooks.onDelta?.(reply.render ? `Here's your ${what}.` : `I couldn't make that ${what}.`);
      hooks.onDone?.(!!reply.render);
    }
  }
}

/** /world: the chat model writes a Hy-Nomas world (or the next segment of this chat's last one) and it's rendered, the
 *  whole world so far as one video. An attached picture starts a new world. The world rides on the reply, so "/world
 *  then …" can carry it on. */
export async function makeWorld(text: string, request: string, hooks?: ReplyHooks, picture?: string) {
  if (!inTauri) {
    toast("Worlds are made in the desktop app.");
    return hooks?.onDone?.(false);
  }
  const next = WORLD_NEXT.test(request);
  const prev = next ? [...chat.messages].reverse().find((m) => m.render?.world)?.render?.world : undefined;
  if (next && !prev) {
    toast("There's no world in this chat yet: start one with /world and what it is, e.g. /world a fox in a misty forest");
    return hooks?.onDone?.(false);
  }
  if (prev && prev.json.segments.length >= WORLD_MAX_SEGMENTS) {
    toast(`This world has ${WORLD_MAX_SEGMENTS} segments, as many as fit in system RAM: start a new one with /world`);
    return hooks?.onDone?.(false);
  }
  if (!current) {
    toast("No chat model is available to write the world (start the services first).");
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = text.replace(/\s+/g, " ").slice(0, 60);
  chat.messages.push({ role: "user", content: text, images: picture ? [picture] : undefined });
  renderChat();
  const label = "Hy-Nomas";
  const reply: StoredMessage = { role: "assistant", content: "", model: label };
  const bubble = addAiBubble(label);
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart(label, text);
  body.innerHTML = `<div class="render-progress"><div class="progress"><i></i></div><span class="status-line">Writing the world…</span></div>`;
  scrollDown(true);
  setBusy(new AbortController());
  busy!.signal.addEventListener("abort", () => cancelRender(), { once: true });
  setBusyUi(true, "World");
  const t0 = Date.now();
  try {
    const { text: words, camera } = splitCamera(request.replace(WORLD_NEXT, ""));
    let state: WorldState;
    if (prev) state = { ...prev, json: await nextSegment(current, prev.json, words, camera, busy!.signal), camera: [...prev.camera, camera] };
    else {
      const json = await writeWorld(current, words, busy!.signal, picture);
      state = { json, camera: [null], seed: Math.floor(Math.random() * 2 ** 31) };
      // A picture is segment 0, held still: the user's words become the first segment that moves.
      if (picture) state = { ...state, json: await nextSegment(current, json, words, camera, busy!.signal), camera: [null, camera] };
    }
    const ref = picture && !prev ? await referenceFromBase64(picture) : undefined;
    const got = await renderWorld(state, words || request, (pct, l) => {
      ($(".progress", body) as HTMLElement | null)?.style.setProperty("--v", String(pct));
      const s = $(".status-line", body);
      if (s) s.textContent = l;
    }, ref);
    if (ref) URL.revokeObjectURL(ref.url);
    const a = got[0];
    reply.render = { path: a.path, prompt: words || request, seconds: Math.round((Date.now() - t0) / 1000), kind: "video", world: state };
    const n = state.json.segments.length;
    reply.content = `(I made ${n > 1 ? `the world so far, ${n} segments,` : "a world"} with Hy-Nomas for: "${words || request}". Saved as ${a.name}. "/world then …" continues it.)`;
    renderFigure(bubble, reply.render);
  } catch (e) {
    if (busy?.signal.aborted) reply.content = "*(stopped)*";
    else {
      reply.error = true;
      reply.content = `Couldn't make the world: ${errMsg(e)}`;
      bubble.classList.add("error");
    }
    body.innerHTML = md(reply.content);
  } finally {
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    setBusy(null);
    setBusyUi(false);
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    if (hooks) {
      hooks.onDelta?.(reply.render ? "Here's your world." : "I couldn't make that world.");
      hooks.onDone?.(!!reply.render);
    }
  }
}

/** /3d: Pixal3D turns the picture into a textured .glb (about 5 minutes), shown in the Canvas's 3D viewer and saved with
 *  the renders. */
export async function make3d(text: string, srcB64: string, hooks?: ReplyHooks) {
  if (!inTauri) {
    toast("3D models are made in the desktop app.");
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = text.replace(/\s+/g, " ").slice(0, 60) || "3D model";
  chat.messages.push({ role: "user", content: text, images: [srcB64] });
  renderChat();
  const reply: StoredMessage = { role: "assistant", content: "", model: "Pixal3D" };
  const bubble = addAiBubble("Pixal3D");
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart("Pixal3D", text);
  body.innerHTML = `<div class="render-progress"><div class="progress"><i></i></div><span class="status-line">Starting…</span></div>`;
  scrollDown(true);
  setBusy(new AbortController());
  busy!.signal.addEventListener("abort", () => cancelRender(), { once: true });
  setBusyUi(true, "3D model");
  const t0 = Date.now();
  try {
    const ref = await referenceFromBase64(srcB64);
    const got = await renderModel(ref, (pct, label) => {
      ($(".progress", body) as HTMLElement | null)?.style.setProperty("--v", String(pct));
      const l = $(".status-line", body);
      if (l) l.textContent = label;
    });
    URL.revokeObjectURL(ref.url);
    const a = got[0];
    reply.render = { path: a.path, prompt: "3D model of the picture", seconds: Math.round((Date.now() - t0) / 1000), kind: "model" };
    reply.content = `(I made a textured 3D model of the picture with Pixal3D. Saved as ${a.name}.)`;
    renderFigure(bubble, reply.render);
    openModel(a.path, a.name);
  } catch (e) {
    if (busy?.signal.aborted) reply.content = "*(stopped)*";
    else {
      reply.error = true;
      reply.content = `Couldn't make the 3D model: ${errMsg(e)}`;
      bubble.classList.add("error");
    }
    body.innerHTML = md(reply.content);
  } finally {
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    setBusy(null);
    setBusyUi(false);
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    hooks?.onDone?.(!!reply.render);
  }
}

/** /talk: the line is spoken in the voice (Kokoro or VoxCPM2), then InfiniteTalk lip-syncs the picture to it (about
 *  4 minutes per 3 seconds of speech). The video is shown in the chat and saved with the renders. */
export async function makeTalk(text: string, line: string, srcB64: string, voice: string, hooks?: ReplyHooks) {
  if (!inTauri) {
    toast("Talking videos are made in the desktop app.");
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = text.replace(/\s+/g, " ").slice(0, 60) || "Talking video";
  chat.messages.push({ role: "user", content: text, images: [srcB64] });
  renderChat();
  const reply: StoredMessage = { role: "assistant", content: "", model: "InfiniteTalk" };
  const bubble = addAiBubble("InfiniteTalk");
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart("InfiniteTalk", text);
  body.innerHTML = `<div class="render-progress"><div class="progress"><i></i></div><span class="status-line">Speaking the line…</span></div>`;
  scrollDown(true);
  setBusy(new AbortController());
  busy!.signal.addEventListener("abort", () => cancelRender(), { once: true });
  setBusyUi(true, "Talking video");
  const t0 = Date.now();
  try {
    const speech = await speakLine(line, voice);
    if (busy!.signal.aborted) throw new Error("stopped");
    const ref = await referenceFromBase64(srcB64);
    const got = await renderTalk(
      ref,
      speech.audio,
      speech.seconds,
      "",
      (pct, label) => {
        ($(".progress", body) as HTMLElement | null)?.style.setProperty("--v", String(pct));
        const l = $(".status-line", body);
        if (l) l.textContent = label;
      },
      "chat",
      speech.title,
    );
    URL.revokeObjectURL(ref.url);
    const a = got[0];
    reply.render = { path: a.path, prompt: line, seconds: Math.round((Date.now() - t0) / 1000), kind: "video", reply: true };
    reply.content = `(A talking video of the picture saying: "${line}". Saved as ${a.name}.)`;
    renderFigure(bubble, reply.render);
  } catch (e) {
    if (busy?.signal.aborted) reply.content = "*(stopped)*";
    else {
      reply.error = true;
      reply.content = `Couldn't make the talking video: ${errMsg(e)}`;
      bubble.classList.add("error");
    }
    body.innerHTML = md(reply.content);
  } finally {
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    setBusy(null);
    setBusyUi(false);
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    hooks?.onDone?.(!!reply.render);
  }
}

/** "Make it talk…" on a picture (a render's path, or a character's face): asks what to say and in which voice, then
 *  queues InfiniteTalk. The video opens when it's done; the render queue shows how far it is. */
export async function talkFromPicture(shown: string, pic: string | Reference, voice?: string) {
  if (!inTauri) return toast("Talking videos are made in the desktop app.");
  let speech;
  try {
    await allowRenders();
    speech = await askSpeech(shown, voice || settings.voice, toast);
  } catch (e) {
    return toast(`Couldn't make the speech: ${errMsg(e)}`, "warn");
  }
  if (!speech) return;
  toast(`Making it talk: about ${Math.max(1, Math.round(talkSecs(speech.seconds) / 60))} min. It opens when it's done (the render queue in Studio shows how far it is).`);
  renderTalk(pic, speech.audio, speech.seconds, speech.prompt, () => {}, "Make it talk", speech.title)
    .then((got) => got[0] && openRender(got[0].path))
    .catch((e) => errMsg(e) !== "stopped" && toast(`Couldn't make the talking video: ${errMsg(e)}`, "warn"));
}

/** Lyrics as Markdown: each sung line on its own line, the [Verse] / [Chorus] tags in italics. */
export const lyricsMd = (lyrics: string) =>
  lyrics
    .split("\n")
    .map((l) => l.trim())
    .map((l) => (/^\[.+\]$/.test(l) ? `*${l}*` : l.replace(/([*_`])/g, "\\$1")))
    .join("  \n")
    .replace(/(  \n){2,}/g, "\n\n");

/** /song: the chat model writes the song (title, style, tempo, key, lyrics; songwriter.ts), then ACE-Step sings it. The
 *  song plays in the chat with its lyrics under it, and is saved with the other renders. */
export async function makeSong(text: string, request: string, hooks?: ReplyHooks, images?: string[]) {
  if (!inTauri) {
    toast("Songs are made in the desktop app.");
    return hooks?.onDone?.(false);
  }
  // A song about a picture needs a model that can see: the current one if it can, else an uncensored or other vision model.
  let model = current;
  if (images?.length && (!model || !canSee(model))) {
    const want = seeingModel();
    if (want) {
      selectModel(want);
      toast(`Switched to ${want.name} to look at the picture.`);
      model = want;
    } else toast("No model that can see pictures is installed, so the song is written from your words alone.", "warn");
  }
  if (!model) {
    toast("No model is available to write the song. Start the services first.", "warn");
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = text.replace(/\s+/g, " ").slice(0, 60);
  // The conversation so far, so "a song about that" knows what "that" is.
  const before = chat.messages.filter((m) => !m.error && !m.render).slice(-6);
  chat.messages.push({ role: "user", content: text, ...(images?.length ? { images } : {}) });
  renderChat();
  const label = await modelLabel("audio");
  const reply: StoredMessage = { role: "assistant", content: "", model: label };
  const bubble = addAiBubble(label, () => reply.content);
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart(label, text);
  let lastStatus = 0;
  body.innerHTML = `<div class="render-progress"><div class="progress"><i></i></div><span class="status-line">Starting…</span></div>`;
  const progress = (pct: number, label: string) => {
    ($(".progress", body) as HTMLElement | null)?.style.setProperty("--v", String(pct));
    const l = $(".status-line", body);
    if (l) l.textContent = label;
    if (Date.now() - lastStatus > 2000) {
      lastStatus = Date.now();
      phonePush({ type: "status", chatId: replyChat, text: `${label} (${Math.round(pct)}%)` });
    }
  };
  scrollDown(true);
  setBusy(new AbortController());
  busy!.signal.addEventListener("abort", () => cancelRender(), { once: true });
  setBusyUi(true, "Song");
  const t0 = Date.now();
  try {
    const context = before.length ? `Conversation so far:\n${before.map((m) => `${m.role}: ${m.content.slice(0, 800)}`).join("\n")}\n\nWrite this song: ` : "";
    progress(1, `${model.name} is writing the song…`);
    const seeing = images?.length && canSee(model) ? images : undefined;
    // ComfyUI can still hold its last render's model on the card; the writer reads the picture far faster without it
    // (a song about a picture sat writing for minutes beside a stems job's model). Each song loads its models anyway.
    if (seeing) await http("http://127.0.0.1:8188/free", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) }).catch(() => {});
    const song = await writeSong(model, context + request, songSeconds(), busy!.signal, (n) => progress(1, `${model.name} is writing the song… ${n} characters`), seeing);
    // The lyrics show while ACE-Step sings them.
    reply.content = `**${song.title}**\n\n${song.lyrics ? lyricsMd(song.lyrics) : "*Instrumental*"}`;
    const lyr = document.createElement("div");
    lyr.className = "song-draft";
    renderBody(lyr, reply.content);
    body.appendChild(lyr);
    scrollDown();
    const got = await renderSong(song.style, song.lyrics, progress, { bpm: song.bpm, key: song.key, language: song.language });
    reply.render = { path: got[0].path, prompt: song.style, seconds: Math.round((Date.now() - t0) / 1000), kind: "audio", reply: true, title: song.title };
    renderFigure(bubble, reply.render);
    renderBody(body, reply.content);
    const au = bubble.querySelector<HTMLAudioElement>(".chat-render audio");
    au?.addEventListener("loadedmetadata", () => scrollDown(), { once: true });
  } catch (e) {
    if (busy?.signal.aborted) reply.content = reply.content ? `${reply.content}\n\n*(stopped)*` : "*(stopped)*";
    else {
      reply.error = true;
      reply.content = `Couldn't make the song: ${errMsg(e)}`;
      bubble.classList.add("error");
    }
    body.innerHTML = md(reply.content);
  } finally {
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    setBusy(null);
    setBusyUi(false);
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    if (hooks) {
      hooks.onDelta?.(reply.render ? "Here's your song." : "I couldn't make that song.");
      hooks.onDone?.(!!reply.render);
    }
  }
}
