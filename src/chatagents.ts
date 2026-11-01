// Chat's longer jobs: Research (a planned web search written up as a report), transcribing a recording, and Computer use.
import { phoneDelta, phoneReplyEnd, phoneReplyStart } from "./phoneaccess";
import { deepResearch } from "./research";
import { type ToolStep } from "./tools";
import { stepWork, toolDoing, workBy } from "./working";
import { phonePush } from "./phone";
import { errMsg, streamChat } from "./backends";
import { clock, type MediaSource, summaryPrompt, transcribeMedia, transcriptMd } from "./transcribe";
import { invoke } from "@tauri-apps/api/core";
import { brains, describe as describeAct, doItForMe } from "./computer";
import { $, busy, setBusy, canSee, chat, current, escapeHtml, foldSteps, inTauri, models, type ReplyHooks, saveSettings, scrollDown, setBusyUi, settings, type StoredMessage, systemBase, toast } from "./main";
import { addAiBubble, reactButton, renderBody, renderChat, setThinking } from "./chatrender";
import { persist } from "./chathistory";
import { renderToolStep } from "./chattools";

/** Deep Research: searches, reads pages and writes a cited report with the current model (research.ts). Each search and
 *  page read shows as a step in the reply, with its notes inside. */
export async function runResearch(text: string, question: string, hooks?: ReplyHooks) {
  const model = current;
  if (!model) {
    toast("No model is available. Start the services first.", "warn");
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = `Research: ${question.replace(/\s+/g, " ").slice(0, 50)}`;
  chat.model = model.name;
  chat.messages.push({ role: "user", content: text });
  renderChat();
  const reply: StoredMessage = { role: "assistant", content: "", model: model.name, tools: [] };
  const bubble = addAiBubble(model.name, () => reply.content);
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart(model.name, text);
  body.innerHTML = `<span class="status-line">Starting deep research…</span>`;
  scrollDown(true);
  setBusy(new AbortController());
  setBusyUi(true, "Deep research", model.name);
  const t0 = Date.now();
  let thinking = "";
  let pending = false;
  try {
    // The conversation so far, so "research that" or a follow-up knows what "that" is.
    const before = chat.messages.slice(0, -1).filter((m) => !m.error && !m.render).slice(-6);
    const context = before.length ? `Conversation so far:\n${before.map((m) => `${m.role}: ${m.content.slice(0, 1500)}`).join("\n")}` : "";
    const res = await deepResearch(
      question,
      model,
      {
        step: (name, arg) => {
          const step: ToolStep = { name, args: name === "read" ? { url: arg } : name === "plan" ? { goal: arg } : { query: arg }, by: model.name };
          reply.tools!.push(step);
          renderToolStep(bubble, step);
          stepWork("reply", toolDoing(name, step.args), undefined, name);
          const t = performance.now();
          return {
            done: (ok, result) => {
              step.ok = ok;
              step.ms = Math.round(performance.now() - t);
              step.result = result && result.length > 2000 ? result.slice(0, 2000) + "…" : result;
              renderToolStep(bubble, step);
            },
          };
        },
        status: (s) => {
          stepWork("reply", s, undefined, null);
          if (!reply.content) body.innerHTML = `<span class="status-line">${escapeHtml(s)}</span>`;
          phonePush({ type: "status", chatId: replyChat, text: s });
        },
        thinking: (t) => {
          thinking += t;
          setThinking(bubble, thinking, !reply.content);
        },
        token: (t) => {
          reply.content += t;
          hooks?.onDelta?.(t);
          phoneDelta(replyChat, t);
          if (!pending) {
            pending = true;
            requestAnimationFrame(() => {
              pending = false;
              if (busy) {
                renderBody(body, reply.content, true);
                scrollDown();
              }
            });
          }
        },
      },
      busy!.signal,
      context,
    );
    reply.content = res.report;
    const mins = Math.max(1, Math.round((Date.now() - t0) / 60000));
    reply.note = `deep research · ${res.sources.length} sources used of ${res.pages} pages read · ${mins} min`;
  } catch (e) {
    if (busy?.signal.aborted) reply.content += reply.content ? "\n\n*(stopped)*" : "*(stopped)*";
    else {
      reply.error = true;
      reply.content = `Deep research didn't finish: ${errMsg(e)}`;
      bubble.classList.add("error");
    }
  } finally {
    setBusy(null);
    setBusyUi(false);
    if (thinking) setThinking(bubble, thinking, false);
    reply.thinking = thinking || undefined;
    renderBody(body, reply.content);
    if (reply.note) {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = reply.note;
      bubble.insertBefore(chip, $(".tool-steps", bubble) ?? body);
    }
    if (!reply.error) foldSteps(bubble);
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    hooks?.onDone?.(!reply.error);
  }
}

/** Transcribe (transcribe.ts): a recording or video in, the words with who said them out, then a summary by the chat
 *  model. The reply is the summary with the full transcript folded under it, so later questions can use both. */
export async function runTranscribe(src: MediaSource, hooks?: ReplyHooks) {
  if (!inTauri) {
    toast("Transcribe runs in the desktop app.");
    return hooks?.onDone?.(false);
  }
  if (busy) {
    toast("Wait for the reply to finish first.");
    return hooks?.onDone?.(false);
  }
  const name = "file" in src ? src.file.name : src.name;
  if (chat.messages.length === 0) chat.title = `Transcript: ${name}`.slice(0, 60);
  chat.messages.push({ role: "user", content: `🎧 Transcribe ${name}` });
  renderChat();
  const reply: StoredMessage = { role: "assistant", content: "", model: "Transcribe · Phonon-2" };
  const bubble = addAiBubble(reply.model!, () => reply.content);
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  phoneReplyStart(reply.model!, name);
  body.innerHTML = `<div class="render-progress"><div class="progress"><i></i></div><span class="status-line">Starting…</span></div>`;
  const progress = (pct: number, what: string) => {
    ($(".progress", body) as HTMLElement | null)?.style.setProperty("--v", String(pct));
    const l = $(".status-line", body);
    if (l) l.textContent = what;
  };
  scrollDown(true);
  setBusy(new AbortController());
  setBusyUi(true, "Transcribe");
  try {
    const t = await transcribeMedia(src, settings.stackRoot ?? null, (pct, what) => progress(pct * 0.8, what));
    if (!t.turns.length) throw new Error("no speech was found in it");
    const facts = [
      clock(t.duration),
      t.speakers ? `${t.speakers} speaker${t.speakers === 1 ? "" : "s"}` : "speakers not told apart",
      `transcribed in ${Math.round(t.seconds.total)} s`,
    ].join(" · ");
    reply.note = `transcript · ${facts}`;
    if (t.engines.speakers_error) toast(`Couldn't tell the speakers apart (${t.engines.speakers_error.slice(0, 120)}); the words are all there.`, "warn");
    const folded = `<details><summary>Transcript · ${facts}</summary>\n\n${transcriptMd(t)}\n\n</details>`;
    let summary = "";
    const model = current;
    const compose = () => (summary ? `${summary.replace(/<think>[\s\S]*?<\/think>/g, "").trim()}\n\n${folded}` : folded);
    if (model) {
      progress(82, `${model.name} is writing a summary…`);
      reply.model = `Transcribe · Phonon-2 · ${model.name}`;
      $(".msg-who", bubble).textContent = reply.model;
      try {
        await streamChat(
          model,
          [
            { role: "system", content: systemBase() },
            { role: "user", content: summaryPrompt(name, t) },
          ],
          {
            onToken: (x) => {
              summary += x;
              renderBody(body, compose(), true);
              scrollDown();
            },
            onThinking: () => {},
            onStats: () => {},
          },
          busy!.signal,
          undefined,
          { think: false },
        );
      } catch (e) {
        if (!busy!.signal.aborted) toast(`The transcript is here, but the summary failed: ${errMsg(e)}`, "warn");
      }
    }
    reply.content = compose();
  } catch (e) {
    reply.error = true;
    reply.content = `Couldn't transcribe ${name}: ${errMsg(e)}`;
    bubble.classList.add("error");
  } finally {
    setBusy(null);
    setBusyUi(false);
    renderBody(body, reply.content);
    if (reply.note) {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = reply.note;
      bubble.insertBefore(chip, body);
    }
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    scrollDown();
    persist()
      .catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"))
      .finally(() => phoneReplyEnd(replyChat));
    hooks?.onDone?.(!reply.error);
  }
}

/** /transcribe: the file picker, then Transcribe. */
export async function pickAndTranscribe(hooks?: ReplyHooks) {
  if (!inTauri) return hooks?.onDone?.(false);
  const path = await invoke<string | null>("pick_media").catch((e) => {
    toast(errMsg(e), "warn");
    return null;
  });
  if (!path) return hooks?.onDone?.(false);
  return runTranscribe({ path, name: path.split(/[\\/]/).pop() ?? path }, hooks);
}

/** /do: a vision model works through the task on this PC (computer.ts). A card first says what will happen and which
 *  model drives; Start shrinks Prestige to the step-by-step panel. Afterwards every step and the model's summary are
 *  posted in this reply. */
export async function runComputer(text: string, task: string, hooks?: ReplyHooks) {
  if (!inTauri) {
    toast("Computer use runs in the desktop app.");
    return hooks?.onDone?.(false);
  }
  const list = brains(models, canSee);
  if (!list.length) {
    toast("No model that can see the screen is available. Start the services, or get Qwen3.8 27B or Nex-N2.5-mini from the catalog.", "warn");
    return hooks?.onDone?.(false);
  }
  if (chat.messages.length === 0) chat.title = `Do: ${task.replace(/\s+/g, " ").slice(0, 54)}`;
  chat.messages.push({ role: "user", content: text });
  renderChat();
  const reply: StoredMessage = { role: "assistant", content: "", model: "Computer use", tools: [] };
  const bubble = addAiBubble("Computer use");
  const body = $(".msg-body", bubble);
  const replyChat = chat.id;
  const pick = list.find((m) => m.key === settings.computerModel) ?? list[0];
  body.innerHTML = `<div class="cu-card">
      <p><b>Do it for me:</b> <span class="cu-card-task"></span></p>
      <p class="credit">The model looks at your screen and uses the mouse and keyboard, one step at a time. Prestige shrinks to a
      panel in the corner where you approve each step (or turn that off) and can stop it any time. It won't type passwords,
      pay for anything or send messages; it stops and tells you instead.</p>
      <label class="field">Model<select class="cu-card-model"></select></label>
      <div class="acts"><button type="button" class="btn" data-a="no">Cancel</button><button type="button" class="btn primary" data-a="yes">Start</button></div>
    </div>`;
  $(".cu-card-task", body).textContent = task;
  const sel = $(".cu-card-model", body) as HTMLSelectElement;
  sel.innerHTML = list.map((m) => `<option value="${escapeHtml(m.key)}"${m.key === pick.key ? " selected" : ""}>${escapeHtml(m.name)}</option>`).join("");
  scrollDown(true);
  setBusy(new AbortController());
  setBusyUi(true, "Do it for me");
  const go = await new Promise<boolean>((resolve) => {
    body.querySelectorAll<HTMLButtonElement>("[data-a]").forEach((b) => b.addEventListener("click", () => resolve(b.dataset.a === "yes"), { once: true }));
    busy!.signal.addEventListener("abort", () => resolve(false), { once: true });
  });
  const model = list.find((m) => m.key === sel.value) ?? pick;
  try {
    if (!go) {
      reply.content = "*(not started)*";
      return;
    }
    if (model.key !== settings.computerModel) {
      settings.computerModel = model.key;
      saveSettings().catch(() => {});
    }
    reply.model = `Computer use · ${model.name}`;
    workBy("reply", model.name);
    $(".msg-who", bubble).textContent = reply.model;
    body.innerHTML = `<span class="status-line">Working on it in the panel…</span>`;
    phonePush({ type: "status", chatId: replyChat, text: `Computer use: ${task}` });
    const r = await doItForMe(task, model);
    for (const s of r.steps) {
      const step: ToolStep = {
        by: model.name,
        name: "computer",
        args: { action: describeAct(s.act) },
        ok: s.state === "done",
        denied: s.state === "skipped",
        ms: s.ms,
        result: [s.thought, s.state === "skipped" ? "(you skipped this step)" : "", s.note ? `Failed: ${s.note}` : ""].filter(Boolean).join("\n"),
      };
      reply.tools!.push(step);
      renderToolStep(bubble, step);
    }
    const head = { done: "Done.", failed: "It stopped before finishing.", stopped: "You stopped it.", limit: "It ran out of steps." }[r.status];
    reply.content = r.status === "done" || r.status === "failed" ? r.summary : `${head} ${r.summary === "Stopped." ? "" : r.summary}`.trim();
    reply.note = `computer use · ${r.steps.length} step${r.steps.length === 1 ? "" : "s"} · ${r.status} · ${r.seconds < 90 ? `${r.seconds} s` : `${Math.round(r.seconds / 60)} min`}`;
    if (r.status === "failed") bubble.classList.add("warn");
  } catch (e) {
    reply.error = true;
    reply.content = `Computer use didn't run: ${errMsg(e)}`;
    bubble.classList.add("error");
  } finally {
    setBusy(null);
    setBusyUi(false);
    renderBody(body, reply.content);
    if (reply.note) {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = reply.note;
      bubble.insertBefore(chip, $(".tool-steps", bubble) ?? body);
    }
    chat.messages.push(reply);
    bubble.dataset.i = String(chat.messages.length - 1);
    if (!reply.error) reactButton(bubble, reply);
    scrollDown();
    persist().catch((e) => toast(`Couldn't save this chat: ${e}`, "warn"));
    hooks?.onDone?.(!reply.error);
  }
}
