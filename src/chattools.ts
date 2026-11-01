import { allowRenders, cancelRender, editMedia, isRender, type MediaKind, renderMedia } from "./renderapi";
import { imageToBase64, referenceFromBase64 } from "./reference";
import { phonePush } from "./phone";
import { convertFileSrc } from "@tauri-apps/api/core";
import { describeCall, GROUPS, loadTools, type ToolDef, type ToolStep } from "./tools";
import { stepWork } from "./working";
import { supportsTools } from "./caps";
import { $, chat, current, escapeHtml, inTauri, saveSettings, scrollDown, settings, type StoredMessage, toast } from "./main";
import { renderFigure } from "./chatrender";

// ---------- tools ----------
/** The tool server's render tools. Prestige runs these itself (toolRender) so the result shows in the reply. */
export const RENDER_TOOL = /^(make_image|make_video|edit_image)$/;
export const RENDER_HINT =
  "When the user wants a picture or a video, call make_image or make_video (edit_image changes a picture); " +
  "it waits for the render and the result is shown in this chat, so don't paste file paths or links.";

/** Makes the picture or clip a model asked for with a tool, through the render queue, and shows it in the reply (above
 *  its text). Resolves with what the model is told. */
export async function toolRender(
  op: string,
  args: any,
  r: { reply: StoredMessage; bubble: HTMLElement; body: HTMLElement; chatId: string; images?: string[]; signal: AbortSignal },
): Promise<string> {
  if (!inTauri) throw new Error("pictures and videos are made in the desktop app");
  const kind: MediaKind = op === "make_video" ? "video" : "image";
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) throw new Error("say what to make in prompt");
  // edit_image changes a picture; make_video with image_path starts from one.
  const src = op === "edit_image" || args.image_path ? await toolSource(String(args.image_path ?? ""), r.images) : undefined;
  if (op === "edit_image" && !src) throw new Error("there's no picture to edit. Ask the user to attach one.");
  const ref = src ? await referenceFromBase64(src.b64, src.made) : undefined;
  let last = 0;
  const progress = (pct: number, label: string) => {
    if (!r.reply.content) r.body.innerHTML = `<span class="status-line">${escapeHtml(label)} (${Math.round(pct)}%)</span>`;
    if (Date.now() - last > 2000) {
      last = Date.now();
      phonePush({ type: "status", chatId: r.chatId, text: `${label} (${Math.round(pct)}%)` });
    }
  };
  const stop = () => cancelRender();
  r.signal.addEventListener("abort", stop, { once: true });
  const t0 = Date.now();
  try {
    const got = op === "edit_image" && ref ? await editMedia(prompt, ref, progress) : await renderMedia(kind, prompt, progress, ref);
    const paths = got.map((x) => x.path);
    const prev = r.reply.render;
    // A second render of the same kind in one reply joins the first.
    r.reply.render =
      prev && prev.kind === kind
        ? { ...prev, more: [...(prev.more ?? []), ...paths] }
        : { path: paths[0], prompt, seconds: Math.round((Date.now() - t0) / 1000), kind, reply: true, ...(paths.length > 1 ? { more: paths.slice(1) } : {}) };
    renderFigure(r.bubble, r.reply.render);
    if (!r.reply.content) r.body.innerHTML = "";
    scrollDown();
    const names = got.map((x) => x.name).join(", ");
    return `Done. The ${kind === "video" ? "video" : got.length > 1 ? `${got.length} pictures` : "picture"} (${names}) is already shown to the user in this chat. Don't repeat file paths or links; say a sentence or two about it.`;
  } finally {
    r.signal.removeEventListener("abort", stop);
    if (ref) URL.revokeObjectURL(ref.url);
  }
}

/** The picture a render tool starts from: the path the model gave (a render), else the user's attached picture, else
 *  the last picture made in this chat. `made`: it's a render, not a photo the user brought (see uncensored.ts). */
export async function toolSource(path: string, images?: string[]): Promise<{ b64: string; made: boolean } | undefined> {
  const load = async (p: string) => {
    await allowRenders();
    return { b64: await imageToBase64(await (await fetch(convertFileSrc(p))).blob()), made: isRender(p) };
  };
  if (path && /\.(png|jpe?g|webp)$/i.test(path)) {
    try {
      return await load(path);
    } catch {
      /* not a render Prestige can open: fall back below */
    }
  }
  if (images?.length) return { b64: images[0], made: false };
  const lastPic = [...chat.messages].reverse().find((m) => m.render && (m.render.kind ?? "image") === "image");
  if (lastPic?.render) return load(lastPic.render.path).catch(() => undefined);
  return undefined;
}

export const TOOLS_HINT =
  "You can call tools to look things up or act on this PC. Use a tool when it actually helps; otherwise just answer. " +
  "For current events or facts you aren't sure of, use web_search, then fetch to read a page. " +
  "Never invent tool results, and say which tool you used when it matters.";

export const LOAD_HINT = "More tools are listed in load_tools: when you need one of those groups, call load_tools first.";

/** The tool groups load_tools has added in each chat (by chat id), which stay loaded for its later replies. */
export const loadedGroups = new Map<string, Set<string>>();

export function enabledGroups(): Set<string> {
  return new Set(settings.toolGroups ?? GROUPS.filter((g) => g.defaultOn).map((g) => g.id));
}

export function renderToolStep(bubble: HTMLElement, step: ToolStep) {
  let box = $(".tool-steps", bubble) as HTMLElement | null;
  if (!box) {
    box = document.createElement("div");
    box.className = "tool-steps";
    bubble.insertBefore(box, $(".msg-body", bubble));
  }
  const steps = Array.from(box.children) as (HTMLElement & { _step?: ToolStep })[];
  let el = steps.find((x) => x._step === step) as (HTMLDetailsElement & { _step?: ToolStep }) | undefined;
  if (!el) {
    el = document.createElement("details") as HTMLDetailsElement & { _step?: ToolStep };
    el._step = step;
    el.className = "tool-step";
    el.innerHTML = `<summary><span class="ico"></span><span class="what"></span><span class="by"></span><span class="ms"></span></summary><pre></pre>`;
    box.appendChild(el);
  }
  const state = step.denied ? "denied" : step.ok === true ? "ok" : step.ok === false ? "fail" : "run";
  el.dataset.state = state;
  $(".ico", el).textContent = { ok: "✓", fail: "✗", denied: "⛔", run: "…" }[state]!;
  $(".what", el).textContent = describeCall(step.name, step.args);
  $(".by", el).textContent = step.by ? `by ${step.by}` : "";
  $(".ms", el).textContent = step.denied ? "not allowed" : step.ms != null ? `${(step.ms / 1000).toFixed(1)} s` : "running";
  $("pre", el).textContent =
    `Arguments\n${JSON.stringify(step.args ?? {}, null, 2)}` + (step.result != null ? `\n\nResult\n${step.result}` : "");
  scrollDown();
}

/** An inline "Allow this?" card in the reply; resolves when the user decides (or the reply is stopped). */
export function confirmTool(bubble: HTMLElement, def: ToolDef, args: any, signal: AbortSignal): Promise<boolean> {
  stepWork("reply", "Waiting for you to allow it…", undefined, def.name);
  return new Promise((resolve) => {
    const card = document.createElement("div");
    card.className = "tool-confirm";
    const group = GROUPS.find((g) => g.id === def.group)?.label ?? def.group;
    card.innerHTML = `<div class="q">Allow <b></b>? <span class="grp"></span></div><pre></pre>
      <div class="acts"><button class="btn" data-a="no">Don't allow</button><button class="btn primary" data-a="yes">Allow</button></div>`;
    $("b", card).textContent = def.name;
    $(".grp", card).textContent = `(${group})`;
    $("pre", card).textContent = JSON.stringify(args ?? {}, null, 2);
    bubble.insertBefore(card, $(".msg-body", bubble));
    scrollDown(true);
    const done = (ok: boolean) => {
      card.remove();
      resolve(ok);
    };
    card.querySelectorAll<HTMLButtonElement>("[data-a]").forEach((b) => b.addEventListener("click", () => done(b.dataset.a === "yes")));
    signal.addEventListener("abort", () => done(false), { once: true });
    toast(`${model_name(def)} wants to run ${def.name}. Allow it in the chat.`);
  });
}
export const model_name = (_: ToolDef) => current?.name ?? "The model";

export async function renderToolsMenu() {
  const pop = $("#tools-pop");
  const list = $("#tools-list");
  const on = enabledGroups();
  list.innerHTML = "";
  const { tools, errors } = await loadTools();
  for (const g of GROUPS) {
    const n = tools.filter((t) => t.group === g.id).length;
    const ask = tools.filter((t) => t.group === g.id && t.confirm).length;
    const row = document.createElement("label");
    row.className = "tool-group";
    row.innerHTML = `<input type="checkbox" /><span><b></b><small></small></span>`;
    const cb = $("input", row) as HTMLInputElement;
    cb.checked = on.has(g.id);
    cb.disabled = n === 0;
    $("b", row).textContent = g.label;
    $("small", row).textContent = n ? `${g.hint} · ${n} tools${ask ? `, ${ask} ask first` : ""}` : `${g.hint} · not available`;
    cb.addEventListener("change", () => {
      const next = enabledGroups();
      cb.checked ? next.add(g.id) : next.delete(g.id);
      settings.toolGroups = [...next];
      saveSettings();
      updateToolsButton();
    });
    list.appendChild(row);
  }
  const note = $("#tools-note");
  const can = current ? await supportsTools(current) : false;
  note.textContent = [
    errors.length ? `Not reachable: ${errors.join("; ")}` : "",
    current && !can ? `${current.name} can't call tools; pick Qwen3.6 35B, Qwen3.5 9B, Gemma 4 or Llama 3.1.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  pop.hidden = false;
}

export function updateSpeakButton() {
  const btn = $("#composer-speak");
  btn.classList.toggle("on", !!settings.speakReplies);
  btn.title = settings.speakReplies ? "Reading replies aloud (click to turn off)" : "Read replies aloud";
  btn.setAttribute("aria-pressed", String(!!settings.speakReplies));
}

export function updateToolsButton() {
  const n = enabledGroups().size;
  const btn = $("#composer-tools");
  btn.classList.toggle("on", n > 0);
  btn.title = n ? `Tools: ${n} group${n === 1 ? "" : "s"} on` : "Tools are off";
  $("#tools-count").textContent = n ? String(n) : "";
}
