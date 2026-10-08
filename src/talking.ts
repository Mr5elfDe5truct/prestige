// Talking characters: a picture and a voice become a lip-synced video. "Make it talk…" (right-click a picture, or a
// character's "Make a talking video") asks what to say and in which voice: any Kokoro voice or VoxCPM2 one (designed or
// cloned), or a recording of your own. The speech is made first, then InfiniteTalk animates the picture to it in
// ComfyUI (studio.ts renderTalk), one 3.24 s part at a time.
import { errMsg } from "./backends";
import { audio, DEFAULT_VOICE, isVox, listVoices, synthesize } from "./speech";
import { TALK_MAX_SECONDS, talkSecs } from "./studio";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;

/** What "Make it talk" hands back: the voice recording, its length, and how the person moves. */
export interface Speech {
  audio: Blob;
  seconds: number;
  prompt: string;
  /** What the render queue calls it: the line, or the recording's name. */
  title: string;
}

/** How long a recording is, in seconds (throws when it isn't audio the webview can read). */
export async function audioSeconds(b: Blob): Promise<number> {
  try {
    return (await audio().decodeAudioData(await b.arrayBuffer())).duration;
  } catch {
    throw new Error("that file isn't audio Prestige can read (try a WAV or MP3)");
  }
}

/** A line spoken in a voice, checked against the longest a talking video takes. */
export async function speakLine(text: string, voice: string): Promise<Speech> {
  const a = await synthesize(text, voice);
  const seconds = await audioSeconds(a);
  if (seconds > TALK_MAX_SECONDS + 0.5) throw new Error(`that's ${Math.round(seconds)} s of speech; a talking video takes up to ${TALK_MAX_SECONDS} s, so say less`);
  return { audio: a, seconds, prompt: "", title: `"${text}"` };
}

const mins = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.round(s / 60)} min`);

/** "Make it talk": asks what to say (or for a recording), the voice and how they move, makes the speech, and resolves
 *  with it (null when cancelled). `picture` is shown at the top; `voice` is picked to start with. */
export async function askSpeech(picture: string, voice: string | undefined, toast: (m: string, k?: string) => void): Promise<Speech | null> {
  const dlg = $("#talk") as HTMLDialogElement;
  const sel = $("#talk-voice") as HTMLSelectElement;
  const text = $("#talk-text") as HTMLTextAreaElement;
  const motion = $("#talk-motion") as HTMLInputElement;
  const file = $("#talk-file") as HTMLInputElement;
  const est = $("#talk-est");
  const go = $("#talk-go") as HTMLButtonElement;
  ($("#talk-pic") as HTMLImageElement).src = picture;
  file.value = "";
  // A recording picked in place of a typed line (set by the file picker below).
  let rec = null as { blob: Blob; seconds: number } | null;
  $("#talk-file-name").textContent = "";
  $("#talk-file-clear").hidden = true;

  const { kokoro, vox } = await listVoices();
  sel.innerHTML = "";
  const group = (label: string, values: string[], name: (v: string) => string) => {
    if (!values.length) return;
    const g = document.createElement("optgroup");
    g.label = label;
    for (const v of values) g.appendChild(new Option(name(v), v));
    sel.appendChild(g);
  };
  group("VoxCPM2 · designed and cloned", vox.map((v) => `vox:${v}`), (v) => v.slice(4));
  group("Kokoro · quick", kokoro.length ? kokoro : [DEFAULT_VOICE], (v) => v);
  const want = voice || DEFAULT_VOICE;
  if (![...sel.options].some((o) => o.value === want)) sel.appendChild(new Option(`${isVox(want) ? want.slice(4) : want} (not running now)`, want));
  sel.value = want;

  // The time it'll take, from the words (about 2.6 per second spoken) or the recording's length.
  const update = () => {
    const secs = rec ? rec.seconds : text.value.trim().split(/\s+/).filter(Boolean).length / 2.6;
    text.disabled = sel.disabled = !!rec;
    go.disabled = !rec && !text.value.trim();
    est.textContent =
      rec && rec.seconds > TALK_MAX_SECONDS
        ? `That recording is ${Math.round(rec.seconds)} s; a talking video takes up to ${TALK_MAX_SECONDS} s.`
        : secs
          ? `About ${Math.max(1, Math.round(secs))} s of speech: the video takes about ${mins(talkSecs(secs))} on an RTX 3060.`
          : `Each 3 seconds of speech takes about 4 minutes to animate on an RTX 3060 (up to ${TALK_MAX_SECONDS} s of speech).`;
    if (rec && rec.seconds > TALK_MAX_SECONDS) go.disabled = true;
  };
  text.oninput = update;
  $("#talk-file-btn").onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      rec = { blob: f, seconds: await audioSeconds(f) };
      $("#talk-file-name").textContent = `${f.name} (${Math.round(rec.seconds)} s)`;
      $("#talk-file-clear").hidden = false;
    } catch (e) {
      toast(errMsg(e), "warn");
    }
    update();
  };
  $("#talk-file-clear").onclick = () => {
    rec = null;
    file.value = "";
    $("#talk-file-name").textContent = "";
    $("#talk-file-clear").hidden = true;
    update();
  };
  update();
  dlg.returnValue = "";
  dlg.showModal();
  text.focus();
  await new Promise((r) => dlg.addEventListener("close", r, { once: true }));
  if (dlg.returnValue !== "go") return null;
  const prompt = motion.value.trim();
  if (rec) return { audio: rec.blob, seconds: rec.seconds, prompt, title: `Talking to ${file.files?.[0]?.name ?? "a recording"}` };
  toast(isVox(sel.value) ? "Speaking the line with VoxCPM2…" : "Speaking the line…");
  const s = await speakLine(text.value.trim(), sel.value);
  return { ...s, prompt };
}
