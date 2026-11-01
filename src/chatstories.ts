// Chat's story makers: a radio drama (/drama), a storyboard for a music video (/storyboard) and the Director's film.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { phoneReplyEnd, phoneReplyStart } from "./phoneaccess";
import { allowRenders, cancelRender, renderShot, renderSong, videoQuality } from "./renderapi";
import { type Line, parseScript, type Script, scriptSeconds, scriptText, taggedText, writeDrama } from "./drama";
import { errMsg, http } from "./backends";
import { unloadAll } from "./system";
import { listen } from "@tauri-apps/api/event";
import { aboutTime } from "./gensettings";
import { askedSeconds, directorSecs, lyricsSrt, PLAN_SECS, planVideo, SHOT_SECONDS, SONG_SECS } from "./director";
import { boardFromPlan, type BoardRender, openStoryboard } from "./storyboard";
import { phonePush } from "./phone";
import { $, busy, setBusy, chat, current, escapeHtml, inTauri, type ReplyHooks, scrollDown, setBusyUi, settings, type StoredMessage, toast } from "./main";
import { addAiBubble, md, reactButton, renderBody, renderChat, renderFigure } from "./chatrender";
import { persist } from "./chathistory";
import { lyricsMd } from "./chatmedia";

/** /drama or /podcast: the chat model writes the script, the cast card gives each character a voice (and lets the
 *  script be changed), then Drama 3 reads it all and an ACE-Step music bed goes under it if asked for. One MP3 out. */
export async function makeDrama(text: string, request: string, hooks?: ReplyHooks) {
  if (!inTauri) {
    toast("Audio dramas are made in the desktop app.");
    return hooks?.onDone?.(false);
  }
  const model = current;
  if (!model) {
    toast("No model is available to write the script. Start the services first.", "warn");
    return hooks?.onDone?.(false);
  }
  if (!(await invoke<boolean>("drama_status", { root: settings.stackRoot ?? null }).catch(() => false))) {
    toast("Audio drama needs the Audio drama pack (Drama 3 and audio.cpp, 18 GB): add it in Packs.", "warn");
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = text.replace(/\s+/g, " ").slice(0, 60);
  chat.messages.push({ role: "user", content: text });
  renderChat();
  const reply: StoredMessage = { role: "assistant", content: "", model: "Drama 3" };
  const bubble = addAiBubble("Drama 3", () => reply.content);
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart("Drama 3", text);
  body.innerHTML = `<div class="render-progress"><div class="progress"><i></i></div><span class="status-line">Starting…</span></div>`;
  const progress = (pct: number, label: string) => {
    ($(".progress", body) as HTMLElement | null)?.style.setProperty("--v", String(pct));
    const l = $(".status-line", body);
    if (l) l.textContent = label;
  };
  scrollDown(true);
  setBusy(new AbortController());
  busy!.signal.addEventListener("abort", () => cancelRender(), { once: true });
  setBusyUi(true, "Drama");
  const t0 = Date.now();
  let unlisten: (() => void) | null = null;
  try {
    progress(1, `${model.name} is writing the script…`);
    const script = await writeDrama(model, request, busy!.signal, (n) => progress(2, `${model.name} is writing the script… ${n} characters`));
    progress(4, "Pick the voices…");
    const cast = await castDrama(script);
    if (!cast) throw new Error("stopped");
    const lines = cast.lines;
    reply.content = `**${script.title}**\n\n${lines.map((l) => `**${l.who}:** ${l.text}`).join("\n\n")}`;
    const draft = document.createElement("div");
    draft.className = "song-draft";
    renderBody(draft, reply.content);
    body.appendChild(draft);
    scrollDown();
    // Drama 3 borrows ComfyUI's card: what's loaded there goes first.
    progress(5, "Freeing the GPU…");
    await http("http://127.0.0.1:8188/free", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) }).catch(() => {});
    await unloadAll(undefined, "comfyui");
    const seconds = scriptSeconds(lines);
    // Measured on an RTX 3060: 4.3-6.4 s of work per second of speech, plus ~15 s to start.
    const est = 15 + seconds * 6;
    unlisten = await listen<number>("drama", (e) => progress(Math.min(cast.music ? 75 : 95, 5 + (e.payload / est) * (cast.music ? 70 : 90)), `Drama 3 is performing it… ${e.payload} s (about ${aboutTime(est)} in all)`));
    const wav = await invoke<string>("drama_render", {
      root: settings.stackRoot ?? null,
      text: taggedText(lines, script.cast),
      cast: script.cast.map((c, i) => ({ speaker: i, voice: cast.voices[i] ?? "" })),
      seed: Math.floor(Math.random() * 2 ** 31),
      name: script.title,
    });
    unlisten();
    unlisten = null;
    let music: string | null = null;
    if (cast.music) {
      const got = await renderSong(cast.music, "", (pct, label) => progress(75 + pct * 0.2, `Music bed: ${label}`), { seconds: Math.min(240, Math.ceil(seconds) + 6) });
      music = got[0]?.path ?? null;
    }
    progress(97, "Putting it together…");
    const mp3 = await invoke<string>("drama_mix", { root: settings.stackRoot ?? null, voice: wav, music });
    reply.render = { path: mp3, prompt: request, seconds: Math.round((Date.now() - t0) / 1000), kind: "audio", reply: true, title: script.title };
    renderFigure(bubble, reply.render);
    renderBody(body, reply.content);
  } catch (e) {
    if (busy?.signal.aborted || errMsg(e) === "stopped") reply.content = reply.content ? `${reply.content}\n\n*(stopped)*` : "*(stopped)*";
    else {
      reply.error = true;
      reply.content = `Couldn't make the audio drama: ${errMsg(e)}`;
      bubble.classList.add("error");
    }
    body.innerHTML = md(reply.content);
  } finally {
    unlisten?.();
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
      hooks.onDelta?.(reply.render ? "Here's your audio drama." : "I couldn't make that audio drama.");
      hooks.onDone?.(!!reply.render);
    }
  }
}

/** The cast card: a voice for each character (a saved voice, or Drama 3's own), the script to change, and whether a
 *  music bed goes under it. Null when cancelled. */
export async function castDrama(script: Script): Promise<{ voices: string[]; lines: Line[]; music: string } | null> {
  const dlg = $("#drama") as HTMLDialogElement;
  const voices = await invoke<string[]>("drama_voices", { root: settings.stackRoot ?? null }).catch(() => [] as string[]);
  $("#dr-title").textContent = script.title;
  const rows = $("#dr-cast");
  rows.innerHTML = "";
  script.cast.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "dr-row";
    const opts = [`<option value="">Drama 3's own voice</option>`, ...voices.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)];
    row.innerHTML = `<span><b>${escapeHtml(c.name)}</b>${c.about ? `<small class="muted">${escapeHtml(c.about)}</small>` : ""}</span><select data-i="${i}">${opts.join("")}</select>`;
    // A different saved voice for each character to start with, in order.
    (row.querySelector("select") as HTMLSelectElement).value = voices[i] ?? "";
    rows.append(row);
  });
  const box = $("#dr-script") as HTMLTextAreaElement;
  box.value = scriptText(script);
  const music = $("#dr-music") as HTMLInputElement;
  const style = $("#dr-style") as HTMLInputElement;
  music.checked = !!script.music;
  style.value = script.music;
  const est = () => {
    const secs = scriptSeconds(parseScript(box.value, script.cast));
    $("#dr-est").textContent = `About ${Math.round(secs)} s of speech; Drama 3 takes ${aboutTime(15 + secs * 6)} on an RTX 3060${music.checked ? ", and the music bed a little more" : ""}.`;
  };
  box.oninput = est;
  music.onchange = est;
  est();
  dlg.returnValue = "";
  dlg.showModal();
  await new Promise((r) => dlg.addEventListener("close", r, { once: true }));
  if (dlg.returnValue !== "go") return null;
  const lines = parseScript(box.value, script.cast);
  if (!lines.length) throw new Error("the script has no lines left");
  return {
    voices: [...rows.querySelectorAll("select")].map((s) => (s as HTMLSelectElement).value),
    lines,
    music: music.checked ? style.value.trim() || "soft ambient underscore" : "",
  };
}

/** /storyboard: the chat model plans the video as the Director would (the song and the shots), and the plan opens as a
 *  storyboard (storyboard.ts) to change before anything is rendered; every shot's frame starts drawing straight away. */
export async function makeStoryboard(text: string, idea: string, hooks?: ReplyHooks) {
  if (!inTauri) {
    toast("Storyboards are made in the desktop app.");
    return hooks?.onDone?.(false);
  }
  const model = current;
  if (!model) {
    toast("No model is available to plan the video. Start the services first.", "warn");
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = text.replace(/\s+/g, " ").slice(0, 60);
  chat.messages.push({ role: "user", content: text });
  renderChat();
  const reply: StoredMessage = { role: "assistant", content: "", model: "Director" };
  const bubble = addAiBubble("Director", () => reply.content);
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart("Director", text);
  body.innerHTML = `<span class="status-line">${model.name} is planning the song and the shots…</span>`;
  scrollDown(true);
  setBusy(new AbortController());
  setBusyUi(true, "Storyboard");
  const seconds = askedSeconds(idea);
  try {
    const plan = await planVideo(model, idea, seconds, busy!.signal, (n) => {
      const l = $(".status-line", body);
      if (l) l.textContent = `${model.name} is planning the song and the shots… ${n} characters`;
    });
    const draft = /\b(draft|quick|fast)\b/i.test(idea);
    const subtitles = !/\b(no|without)\s+(subtitles|captions|lyrics on screen)\b/i.test(idea);
    reply.content =
      `**${plan.title}** · storyboard for a ${seconds} s music video, ${plan.shots.length} shots\n\n*${plan.style}*\n\n${plan.look}\n\n` +
      plan.shots.map((sh, i) => `${i + 1}. ${sh.action}`).join("\n") +
      "\n\nThe storyboard is open, and a frame is being drawn for each shot. Change anything, then **Render the video**. Type `/storyboard` to open it again.";
    renderBody(body, reply.content);
    openStoryboard(boardFromPlan(plan, idea, draft, subtitles), true);
  } catch (e) {
    if (busy?.signal.aborted) reply.content = "*(stopped)*";
    else {
      reply.error = true;
      reply.content = `Couldn't plan the storyboard: ${errMsg(e)}`;
      bubble.classList.add("error");
    }
    body.innerHTML = md(reply.content);
  } finally {
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    setBusy(null);
    setBusyUi(false);
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    if (hooks) {
      hooks.onDelta?.(reply.error ? "I couldn't plan that storyboard." : "The storyboard is ready on the PC.");
      hooks.onDone?.(!reply.error);
    }
  }
}

/** The Director: one prompt becomes a short music video (director.ts). The chat model plans the song and the shots,
 *  ACE-Step makes the song, LTX-2.5 renders each shot (one model at a time, through the render queue), Whisper times the
 *  lyrics for subtitles, and ffmpeg joins it all. Each step shows in the reply as it happens. A storyboard (`board`)
 *  brings its own plan, changed by hand, and each shot with a drawn frame starts on it (LTX-2.5 image-to-video). */
export async function makeDirector(text: string, idea: string, hooks?: ReplyHooks, board?: BoardRender) {
  if (!inTauri) {
    toast("Music videos are made in the desktop app.");
    return hooks?.onDone?.(false);
  }
  const model = current;
  if (!model && !board) {
    toast("No model is available to plan the video. Start the services first.", "warn");
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = text.replace(/\s+/g, " ").slice(0, 60);
  chat.messages.push({ role: "user", content: text });
  renderChat();
  const reply: StoredMessage = { role: "assistant", content: "", model: "Director" };
  const bubble = addAiBubble("Director", () => reply.content);
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart("Director", text);
  body.innerHTML = `<div class="director"><div class="director-plan"></div><div class="render-progress"><div class="progress"><i></i></div><span class="status-line">Starting…</span></div></div>`;
  const planEl = $(".director-plan", body);
  let lastStatus = 0;
  const status = (pct: number, label: string) => {
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
  busy!.signal.addEventListener("abort", () => (cancelRender(), cancelRender("Director")), { once: true });
  setBusyUi(true, "Music video");
  const t0 = Date.now();
  const seconds = board?.plan.seconds ?? askedSeconds(idea);
  // A storyboard's Draft box decides; unticked, the saved Video quality (or standard, if that's draft).
  const quality = board ? (board.draft ? "draft" : videoQuality() === "draft" ? "standard" : videoQuality()) : /\b(draft|quick|fast)\b/i.test(idea) ? "draft" : videoQuality();
  const subtitles = board ? board.subtitles : !/\b(no|without)\s+(subtitles|captions|lyrics on screen)\b/i.test(idea);
  try {
    if (!board) status(1, `${model!.name} is planning the song and the shots…`);
    const plan = board?.plan ?? (await planVideo(model!, idea, seconds, busy!.signal, (n) => status(1, `${model!.name} is planning the song and the shots… ${n} characters`)));
    const n = plan.shots.length;
    // The time it'll take (measured; see director.ts), and each part's share of the progress bar.
    const total = directorSecs(seconds, quality === "draft") - (board ? PLAN_SECS : 0);
    // The plan shows straight away: the title and style, then each shot with its state.
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    planEl.innerHTML =
      `<p class="director-title">🎬 <b>${esc(plan.title)}</b> · ${seconds} s · ${n} shots · about ${Math.max(1, Math.round(total / 60))} min${quality === "draft" ? " (draft)" : ""}</p>` +
      `<p class="credit">${esc(plan.style)}</p>` +
      `<ol class="director-steps"><li data-s="song">The song (ACE-Step)</li>${plan.shots.map((sh, i) => `<li data-s="${i}" title="${esc(sh.prompt)}">Shot ${i + 1}${board?.frames[i] ? " (from its frame)" : ""}: ${esc(sh.action)}</li>`).join("")}${subtitles && plan.lyrics ? `<li data-s="subs">Lyrics as subtitles (Whisper)</li>` : ""}<li data-s="join">Joining it all (ffmpeg)</li></ol>`;
    const step = (k: string, state: "on" | "done") => planEl.querySelector(`[data-s="${k}"]`)?.setAttribute("class", state);
    scrollDown();
    const span = (from: number, to: number) => (pct: number, label: string) => status(from + ((to - from) * pct) / 100, label);
    // The song first: its length is the video's.
    step("song", "on");
    const songT = SONG_SECS / total;
    const song = (await renderSong(plan.style, plan.lyrics, span(2, 2 + 90 * songT), { seconds, bpm: plan.bpm, key: plan.key, language: plan.language }))[0];
    step("song", "done");
    // Then each shot, one at a time.
    const shots: string[] = [];
    const shotT = (90 * (1 - songT)) / n;
    for (let i = 0; i < n; i++) {
      if (busy!.signal.aborted) throw new Error("stopped");
      step(String(i), "on");
      const from = 2 + 90 * songT + shotT * i;
      const got = await renderShot(plan.shots[i].prompt, SHOT_SECONDS, span(from, from + shotT), {
        title: `${plan.title}: shot ${i + 1} of ${n}`,
        note: `Shot ${i + 1} of ${n} · `,
        quality,
        frame: board?.frames[i],
      });
      shots.push(got[0].path);
      step(String(i), "done");
    }
    // The lyrics, timed by Whisper (optional: the video is still made without them).
    let srt = "";
    if (subtitles && plan.lyrics) {
      step("subs", "on");
      status(93, "Timing the lyrics (Whisper)…");
      try {
        await allowRenders();
        srt = await lyricsSrt(await (await fetch(convertFileSrc(song.path))).blob(), plan.lyrics, seconds);
      } catch (e) {
        toast(`The video is made without subtitles: couldn't time the lyrics (${errMsg(e)}).`, "warn");
      }
      step("subs", "done");
    }
    step("join", "on");
    status(97, "Joining the shots, the song and the lyrics…");
    const out = await invoke<string>("director_assemble", {
      root: settings.stackRoot ?? null,
      shots,
      song: song.path,
      seconds,
      width: 768,
      height: 512,
      fps: 24,
      srt: srt || null,
      title: plan.title,
    });
    step("join", "done");
    reply.render = { path: out, prompt: idea, seconds: Math.round((Date.now() - t0) / 1000), kind: "video", reply: true, title: plan.title };
    reply.content =
      `**${plan.title}** · ${seconds} s music video, ${n} shots\n\n*${plan.style}*\n\n` +
      `${plan.look}\n\n` +
      plan.shots.map((sh, i) => `${i + 1}. ${sh.action}`).join("\n") +
      (plan.lyrics ? `\n\n**Lyrics**\n\n${lyricsMd(plan.lyrics)}` : "");
    renderFigure(bubble, reply.render);
    renderBody(body, reply.content);
  } catch (e) {
    if (busy?.signal.aborted) reply.content = "*(stopped)*";
    else {
      reply.error = true;
      reply.content = `Couldn't make the music video: ${errMsg(e)}`;
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
      hooks.onDelta?.(reply.render ? "Here's your music video." : "I couldn't make that music video.");
      hooks.onDone?.(!!reply.render);
    }
  }
}
