import { characterById, characters, faceBlob } from "./characters";
import { lastSeed, reset, settings, type SettingsKey, update } from "./gensettings";
import { CONSENT, loadReference, type Reference, referenceFromBase64, type RefKind, refPrefs, setRefPrefs } from "./reference";
import { animatePick, buttonText, cancelJob, canPick, chained, deps, enqueue, ensureWorkflows, flipModel, frameSize, items, modeOf, pictureMode, promptHint, type QJob, REDRAW_MP, refImageMode, refVideo, refWhat, renderQueue, retryJob, rq, summary, workflowOf, workflows, findItem } from "./studio";
import { type Asset, type GenMode, MP, plan, settingsKey, type Source, type UpscaleSize } from "./modes";
import { fieldValue, loadSviModels, settingsFields, sviModels } from "./settingsform";
import { refresh } from "./cards";
import { fixSeed, removeRender } from "./fileactions";

// ---------- the phone: Studio, Renders and the queue on a paired phone (main.ts passes its requests here) ----------
// The phone keeps its own create bar (mode, picture, reference, prompt) and asks for what that would make; the
// settings, the model picks and the reference choices are the PC's, shared with Studio and chat. Renders it starts go
// into the same queue as the PC's, marked "phone".
export type PhoneMode = "image" | "video" | "music";
export interface PhoneCreate {
  mode: PhoneMode;
  src?: string | null; // a render to edit (Image) or animate (Video)
  ref?: { w: number; h: number } | null; // a reference picture's size, when one is set
}

/** The workflow the phone's create bar runs, as currentMode() does for Studio's. */
export function phoneGm(c: PhoneCreate, src: Asset | null): GenMode {
  if (c.mode === "music") return "song";
  if (c.mode === "video") return src ? animatePick() : c.ref ? "refvideo" : "video";
  if (src) return "edit";
  if (c.ref) return refImageMode();
  return pictureMode();
}

/** The render queue for phones: the last 20, newest last. */
export function phoneQueue() {
  const live = (j: QJob) => j.state === "waiting" || j.state === "running";
  return rq.slice(-20).map((j) => ({
    id: j.id,
    prompt: j.prompt,
    label: j.label,
    from: j.from,
    state: j.state,
    pct: Math.round(j.pct),
    status: j.state === "waiting" ? `Waiting · ${rq.filter((x) => live(x) && rq.indexOf(x) < rq.indexOf(j)).length} ahead` : j.status,
    error: j.error ?? null,
    took: j.took ?? null,
    result: (j.result ?? []).map((a) => ({ path: a.path, kind: a.kind, mtime: a.mtime, name: a.name })),
  }));
}

/** What the phone can do with a render, by what's installed. */
export function actsFor(a: Asset): string[] {
  const out: string[] = [];
  const short = a.width && a.height ? Math.min(a.width, a.height) : 0;
  if (a.kind === "image") {
    if (workflows.edit) out.push("edit");
    if (workflows.animate || workflows.long) out.push("animate");
    if (workflows.ref || workflows.reffast) out.push("reference");
    if (workflows.upimage && short < 1080) out.push("up1080");
    if (workflows.upimage && short < 2160) out.push("up4k");
    const mp = a.width && a.height ? (a.width * a.height) / MP : 0;
    if (workflows.redraw4 && mp && mp < 3.5) out.push("redraw4");
    if (workflows.redraw4 && mp && mp < 7) out.push("redraw8");
    if (workflows.model3d) out.push("model3d");
    if (workflows.cutout) out.push("removebg");
    if (workflows.talk) out.push("talk");
  }
  if (a.kind === "video") {
    if (workflows.upvideo && short < 1080) out.push("up1080");
    if (workflows.vidcut) out.push("vidcut");
  }
  if (a.seed != null && a.kind !== "model") out.push("seed");
  out.push("delete");
  return out;
}

/** A character's face, small, for the phone's picker (faces are up to 2048 px). */
export const faceThumbs = new Map<string, string>();
export async function faceThumb(c: Parameters<typeof faceBlob>[0]) {
  const key = `${c.id}:${c.face!.length}`;
  let t = faceThumbs.get(key);
  if (!t) {
    const bmp = await createImageBitmap(faceBlob(c));
    const k = Math.min(1, 160 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement("canvas");
    cv.width = Math.round(bmp.width * k);
    cv.height = Math.round(bmp.height * k);
    cv.getContext("2d")!.drawImage(bmp, 0, 0, cv.width, cv.height);
    bmp.close();
    t = cv.toDataURL("image/jpeg", 0.8).split(",")[1];
    faceThumbs.set(key, t);
  }
  return t;
}

/** What the phone's create bar would make: the model, the settings as chips and as a form, the warning, the words. */
export async function phoneInfo(c: PhoneCreate) {
  await ensureWorkflows();
  const src = c.src ? await findItem(c.src) : null;
  const gm = phoneGm(c, src);
  const m = modeOf(gm);
  if ((m.family === "svi" || m.family === "wan") && !sviModels) await loadSviModels().catch(() => {});
  // The picture it starts from, for sizes that follow it (only its size matters here).
  const from: Source | null = src ?? (c.ref ? ({ path: "", name: "", kind: "image", mtime: 0, size: 0, width: c.ref.w, height: c.ref.h } as Asset) : null);
  const chain = chained(gm);
  const first = refImageMode();
  const missing = !workflowOf(gm) ? m.file : chain && !workflows[first] ? modeOf(first).file : "";
  const p = plan(gm, from);
  const shown = chain ? { ...p, secs: p.secs + plan(first, from, frameSize()).secs } : p;
  const key = settingsKey(gm);
  return {
    gm,
    key,
    label: chain ? `${modeOf(first).label} → ${m.label}` : m.label,
    canPick: canPick(gm),
    missing,
    chips: missing ? [] : summary(gm, shown),
    warn: p.warn,
    cards: p.cards ?? "",
    fields: settingsFields(gm, from),
    seed: settings()[key].seed,
    lastSeed: lastSeed(key) ?? null,
    button: buttonText(gm),
    placeholder: promptHint(gm),
    refOk: !!(workflows.ref || workflows.reffast) && !src && c.mode !== "music",
    refWhat: c.ref ? refWhat(gm) : "",
    refPrefs: refPrefs(),
    refVideo: gm === "refvideo",
    consent: CONSENT,
    faces: await Promise.all(
      characters()
        .filter((x) => x.face)
        .map(async (x) => ({ id: x.id, name: x.name, thumb: await faceThumb(x).catch(() => "") })),
    ),
    srcWhat: src ? `${gm === "edit" ? "Editing" : "Animating"} this picture with ${m.label}` : "",
    song: !!workflows.song,
    queue: phoneQueue(),
  };
}

/** Queues what the phone's create bar asked for. A reference is a base64 JPEG from the phone, or a character's face. */
export async function phoneGenerate(a: any) {
  await ensureWorkflows();
  const prompt = String(a.prompt ?? "").trim();
  if (!prompt) throw new Error("Describe what to make first.");
  const src = a.src ? await findItem(a.src) : null;
  let r: Reference | null = null;
  let kind: RefKind = refPrefs().kind;
  if (!src && a.mode !== "music") {
    if (a.ref) r = await referenceFromBase64(String(a.ref));
    else if (a.character) {
      const c = characterById(String(a.character));
      if (!c?.face) throw new Error("That character has no face picture.");
      r = await loadReference(faceBlob(c));
      kind = "character"; // a character's face is always a Character
    }
  }
  const gm = phoneGm({ mode: a.mode, ref: r ? { w: r.width, h: r.height } : null }, src);
  for (const need of chained(gm) ? [gm, refImageMode()] : [gm]) if (!workflowOf(need)) throw new Error(`workflows\\${modeOf(need).file} wasn't found on the PC`);
  const ahead = rq.filter((j) => j.state === "waiting" || j.state === "running").length;
  if (chained(gm)) refVideo(prompt, r!, kind, undefined, "phone").catch(() => {}); // the queue shows how it went
  else {
    const from = gm === "ref" || gm === "reffast" || gm === "refvideo" ? r : src;
    enqueue(gm, prompt, from, { kind, lyrics: gm === "song" ? String(a.lyrics ?? "") : undefined }, { from: "phone" });
  }
  return { ok: true, ahead, queue: phoneQueue() };
}

/** A render action from the phone's viewer: upscale, 3D, remove the background, cut out of a video, seed, delete. */
export async function phoneAct(path: string, what: string, text: string) {
  await ensureWorkflows();
  const a = await findItem(path);
  const queued = (j: QJob) => ({ ok: true, queued: j.id, queue: phoneQueue() });
  switch (what) {
    case "redraw4":
    case "redraw8":
      if (!workflows[what]) throw new Error("Redraw needs the Qwen-Image edit workflow (the Workstation's images pack).");
      return queued(enqueue(what, a.prompt || a.name, a, {}, { from: "phone", title: `${a.name} redrawn at ${REDRAW_MP[what]} MP` }));
    case "up1080":
    case "up4k": {
      const size: UpscaleSize = what === "up4k" ? 2160 : 1080;
      const video = a.kind === "video";
      if (!workflows[video ? "upvideo" : "upimage"]) throw new Error("Upscaling needs the Workstation's upscale pack.");
      return queued(enqueue(video ? "upvideo" : "upimage", a.prompt || a.name, a, { upscale: size }, { from: "phone", title: `${a.name} to ${size === 1080 ? "1080p" : "4K"}` }));
    }
    case "model3d":
      if (!workflows.model3d) throw new Error("Picture to 3D needs the Workstation's 3d pack.");
      return queued(enqueue("model3d", `3D model of ${a.name}`, a, {}, { from: "phone" }));
    case "removebg":
      if (!workflows.cutout) throw new Error("Remove background needs the Workstation's select pack.");
      return queued(enqueue("cutout", `${a.name} without its background`, a, {}, { from: "phone" }));
    case "vidcut":
      if (!workflows.vidcut) throw new Error("Cutting out of a video needs the Workstation's select pack.");
      if (!text.trim()) throw new Error("Say what should stay.");
      return queued(enqueue("vidcut", text.trim(), a, {}, { from: "phone", title: `${text.trim()}, cut out of ${a.name}` }));
    case "seed":
      return { ok: true, message: fixSeed(a) };
    case "delete":
      await removeRender(a);
      return { ok: true, message: `Moved ${a.name} to the Recycle Bin on the PC.` };
  }
  throw new Error(`unknown action ${what}`);
}

/** The gallery for phones, newest first, a page at a time. */
export async function phoneGallery(filter: string, offset: number, limit: number) {
  if (offset === 0) await refresh();
  const list = items.filter((a) => filter === "all" || a.kind === filter);
  return {
    total: list.length,
    items: list.slice(offset, offset + limit).map((a) => ({ ...a, acts: actsFor(a) })),
  };
}

/** A request from a paired phone (phone.rs → main.ts). Throws with words the phone shows. */
export async function phoneStudio(action: string, a: any = {}): Promise<unknown> {
  switch (action) {
    case "info":
      return phoneInfo(a);
    case "set": {
      const key = a.key as SettingsKey;
      if (!(key in settings())) throw new Error("unknown settings");
      if (a.reset) reset(key);
      else if (a.k === "seed") {
        const n = Math.floor(Number(a.value));
        update(key, { seed: a.value === "last" ? (lastSeed(key) ?? null) : a.value == null || a.value === "" || !Number.isFinite(n) || n < 0 ? null : n });
      } else {
        const k = String(a.k);
        if (!["aspect", "size", "quality", "count", "res", "seconds", "fps", "shots", "frames", "high", "low", "bpm", "key", "meter", "language", "lora", "fromPicture", "edits", "moss", "editModel", "sage", "transparent"].includes(k)) throw new Error(`unknown setting ${k}`);
        update(k === "fromPicture" || k === "sage" ? "video" : key, { [k]: fieldValue(k, String(a.value ?? "")) } as any);
      }
      return phoneInfo(a.create ?? { mode: "image" });
    }
    case "pick":
      flipModel(a.create?.mode === "video");
      return phoneInfo(a.create ?? { mode: "image" });
    case "refPrefs":
      setRefPrefs({ ...(a.kind ? { kind: a.kind } : {}), ...(a.frame ? { frame: a.frame } : {}) });
      return phoneInfo(a.create ?? { mode: "image" });
    case "generate":
      return phoneGenerate(a);
    case "lyrics": {
      const style = String(a.style ?? "").trim();
      if (!style) throw new Error("Describe the song's style or what it's about first.");
      return { lyrics: await deps.writeLyrics(style, settings().music.seconds, AbortSignal.timeout(280_000)) };
    }
    case "queue":
      return { queue: phoneQueue() };
    case "cancel":
    case "retry":
    case "clear": {
      if (action === "clear") for (let i = rq.length - 1; i >= 0; i--) if (!["waiting", "running"].includes(rq[i].state)) rq.splice(i, 1);
      const j = rq.find((x) => x.id === Number(a.id));
      if (j && action === "cancel") cancelJob(j);
      if (j && action === "retry" && (j.state === "failed" || j.state === "stopped")) retryJob(j);
      renderQueue();
      return { queue: phoneQueue() };
    }
    case "gallery":
      return phoneGallery(String(a.filter ?? "all"), Math.max(0, Number(a.offset) || 0), Math.min(120, Math.max(1, Number(a.limit) || 48)));
    case "act":
      return phoneAct(String(a.path ?? ""), String(a.what ?? ""), String(a.text ?? ""));
  }
  throw new Error(`unknown Studio action ${action}`);
}
