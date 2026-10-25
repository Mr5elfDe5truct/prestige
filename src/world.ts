// Explore a world (Tencent's Hy-Nomas world model, chat's /world): the chat model writes the world in the structured
// format Hy-Nomas was trained on (Tencent's prompt rewriter's: one subject, timed segments, <Action#> sentences, follow-ups
// starting "Compared to the previous segment, "), and studio.ts renders it a segment at a time. Loosely written
// follow-ups are mostly ignored by the model, which is why the chat model writes them.
//   /world a fox walking through a misty forest          a new world (an attached picture starts it)
//   /world then the fox stops and sniffs the flowers     the next 5 s of the last world in this chat
//   /world then camera: W 2, W+Left 1.5                  the next segment steered by camera keys
import { streamChat, type ModelInfo } from "./backends";

/** "/world …" (or /explore). */
export const WORLD_CMD = /^\/(?:world|explore)\b\s*/i;
/** "/world then …" (or next, continue, more): continue the last world. */
export const WORLD_NEXT = /^(?:then|next|continue|more|and then)\b[\s,:]*/i;
/** "camera: W 2, W+Left 1.5" inside a /world request: Hy-Nomas camera keys (W/A/S/D move, arrows turn, seconds each). */
const CAMERA = /\bcamera\s*:\s*([^;]+?)\s*$/i;

/** A world as Hy-Nomas reads it (HyNomasWorldPrompt's world_json). */
export interface WorldJson {
  perspective_view: string;
  Style: string;
  subject_list: { subject_id: string; display_name: string; subject_attribute: string }[];
  segments: WorldSegment[];
}
export interface WorldSegment {
  start_time: string;
  end_time: string;
  visual_description_long: string | null;
  description_change: string | null;
  contained_actions: { start_time: string; end_time: string; action_description: string }[];
}
/** A world so far: its JSON, each segment's camera keys (null: none), and the seed it was started with. */
export interface WorldState {
  json: WorldJson;
  camera: (string | null)[];
  seed: number;
  start?: string; // a picture it started from, in ComfyUI's input folder (segment 0 describes it)
}

/** Segments a world may have: each 5 s at 832×480 keeps ~2.5 GB of history in system RAM. */
export const WORLD_MAX_SEGMENTS = 4;

const FORMAT = `Hy-Nomas is a world model: it makes a video one segment at a time, each continuing the last. You write its
input as one JSON object, in exactly this format and in English:
{"perspective_view": "first-person" | "second-person" | "third-person follow" | "third-person observer",
 "Style": "real-world footage" | "animation/anime" | "CG" | "video game",
 "subject_list": [{"subject_id": "<|Subject1|>", "display_name": "short name", "subject_attribute": "..."}],
 "segments": [{"start_time": "00:00.000", "end_time": "00:05.000", "visual_description_long": "...", "description_change": null,
   "contained_actions": [{"start_time": "00:00.000", "end_time": "00:05.000", "action_description": "<Action1><|Subject1|> ...</Action1>."}]}]}
Rules:
- Exactly one subject, <|Subject1|>: the person, animal, vehicle or group the story follows. display_name is a few words.
  subject_attribute is how it looks (static: species, build, clothes, colours, materials), then one sentence for the
  viewpoint: third-person follow "The camera is placed behind the X, and follows the X throughout the whole video. The
  camera is tracking the X and the X should be placed in the center of the video."; third-person observer "The camera
  films the X from an external position, without following its movement."; first-person "The camera is the X's own
  eyes."; second-person "The X faces the camera and looks into it."
- perspective: third-person follow when the subject walks, runs or drives around (and then Style is usually "video
  game" unless the request says otherwise); third-person observer when something is watched from one place (Style
  usually "real-world footage"); first-person for "I"/"my view"; second-person for selfies and talking to camera.
- The first segment's visual_description_long describes the world in 80 to 200 words: the place, ground, light,
  weather, objects and other moving things, as scene sentences. Never mention the subject there. A camera move, if
  asked, is a sentence wrapped in <Camera1>...</Camera1>.
- Everything the subject does goes in contained_actions, each "<ActionN><|Subject1|> verb ...</ActionN>." numbered
  from 1 within the segment, with its own start_time and end_time inside the segment. Actions must not overlap. Simple,
  physical, visible actions.
- Times are "MM:SS.mmm". A segment is 2 to 5 seconds (5 when unsure); make it long enough for its actions.
- Never add text, captions, logos, watermarks or game HUDs unless asked.`;

const FIRST = `${FORMAT}
Write the first segment of the world the user asks for. Reply with the JSON object only.`;

const NEXT = `${FORMAT}
The world so far is given. Write ONLY the next segment, as {"segments": [ {...} ]}, continuing it:
- start_time is the previous segment's end_time; end_time 2 to 5 seconds later.
- visual_description_long is null. description_change starts exactly "Compared to the previous segment, " and says
  what changes in the scene (light, weather, things appearing or moving, camera moves as <Camera1>...</Camera1>). With
  nothing changing: "Compared to the previous segment, the visible scene, background, and other-object layout remain
  unchanged." Never mention the subject in it.
- contained_actions: what <|Subject1|> does now, numbered from <Action1> again. The same subject, never a new one.
- When camera keys are given, the camera moves that way on its own: describe only what the scene looks like from the
  new viewpoint, no camera sentence, and let the subject carry on (or no actions).
- A sudden change of the whole place doesn't happen: changes grow out of the scene.
Reply with the JSON object only.`;

const PERSPECTIVES = ["first-person", "second-person", "third-person follow", "third-person observer"];
const VIEW_SENTENCE: Record<string, (x: string) => string> = {
  "third-person follow": (x) =>
    `The camera is placed behind the ${x}, and follows the ${x} throughout the whole video. The camera is tracking the ${x} and the ${x} should be placed in the center of the video.`,
  "third-person observer": (x) => `The camera films the ${x} from an external position, without following its movement.`,
  "first-person": (x) => `The camera is the ${x}'s own eyes.`,
  "second-person": (x) => `The ${x} faces the camera and looks into it.`,
};

/** The first JSON object in a reply (models wrap it in prose or code fences). */
function firstJson(text: string): any {
  const m = text.replace(/```(?:json)?/g, "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

async function ask(model: ModelInfo, system: string, user: string, signal: AbortSignal, images?: string[]) {
  let out = "";
  await streamChat(
    model,
    [
      { role: "system", content: system },
      { role: "user", content: user, ...(images?.length ? { images } : {}) },
    ],
    { onToken: (t) => (out += t), onThinking: () => {}, onStats: () => {} },
    signal,
    undefined,
    { think: false },
  );
  return firstJson(out);
}

const ms = (t: string) => {
  const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(String(t).trim());
  return m ? Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000) : NaN;
};
const stamp = (n: number) => {
  const s = n / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(3).padStart(6, "0")}`;
};

/** A segment made sound: times in order, 2 to 5 s long from `from` (ms), actions inside it and numbered from 1. */
function fixSegment(s: any, from: number, first: boolean): WorldSegment {
  let len = ms(s?.end_time) - ms(s?.start_time);
  if (!Number.isFinite(len)) len = 5000;
  len = Math.min(5000, Math.max(2000, len));
  // The model's times, moved so the segment starts at `from`, kept inside it and one action after another.
  const shift = from - (Number.isFinite(ms(s?.start_time)) ? ms(s.start_time) : from);
  const clamp = (t: unknown, d: number) => {
    const v = ms(String(t ?? ""));
    return Math.min(from + len, Math.max(from, Number.isFinite(v) ? v + shift : d));
  };
  const acts: WorldSegment["contained_actions"] = [];
  let at = from;
  for (const a of Array.isArray(s?.contained_actions) ? s.contained_actions : []) {
    const text = String(a?.action_description ?? "").replace(/<\/?Action\d+>/g, "").trim().replace(/\.$/, "");
    const a0 = Math.max(at, clamp(a?.start_time, at));
    const a1 = clamp(a?.end_time, from + len);
    if (!text || a1 <= a0) continue;
    const n = acts.length + 1;
    acts.push({ start_time: stamp(a0), end_time: stamp(a1), action_description: `<Action${n}>${text}</Action${n}>.` });
    at = a1;
  }
  let change = s?.description_change ? String(s.description_change) : null;
  if (!first && (!change || !/^Compared to the previous segment, /.test(change)))
    change = `Compared to the previous segment, ${change ? change.replace(/^compared to the previous segment,?\s*/i, "") : "the visible scene, background, and other-object layout remain unchanged."}`;
  return {
    start_time: stamp(from),
    end_time: stamp(from + len),
    visual_description_long: first ? String(s?.visual_description_long ?? "") : null,
    description_change: first ? null : change,
    contained_actions: acts,
  };
}

/** The camera keys in a request ("… camera: W 2, W+Left 1.5") and the rest of it. */
export function splitCamera(text: string): { text: string; camera: string | null } {
  const m = CAMERA.exec(text);
  return m ? { text: text.slice(0, m.index).replace(/[,;\s]+$/, ""), camera: m[1] } : { text, camera: null };
}

/** A new world from the user's words (and a picture it starts from, described as its first segment). */
export async function writeWorld(model: ModelInfo, request: string, signal: AbortSignal, picture?: string): Promise<WorldJson> {
  const user = picture
    ? `The world starts from the attached picture: describe the picture itself as the first segment (the place, and the subject as it looks there, standing still). The user's words: ${request || "explore it"}`
    : request;
  const j = await ask(model, FIRST, user, signal, picture ? [picture] : undefined);
  const subject = j?.subject_list?.[0];
  const seg = j?.segments?.[0];
  if (!subject?.subject_attribute || !seg?.visual_description_long) throw new Error("the chat model didn't write a world (try again, or a bigger model)");
  const view = PERSPECTIVES.includes(j.perspective_view) ? j.perspective_view : "third-person follow";
  const name = String(subject.display_name ?? "subject");
  // The viewpoint sentence Tencent's rewriter always adds; a 9B model left it out.
  let look = String(subject.subject_attribute).trim();
  if (!/\bcamera\b/i.test(look)) look = `${look.replace(/\.?$/, ".")} ${VIEW_SENTENCE[view](name)}`;
  return {
    perspective_view: view,
    Style: String(j.Style ?? "video game"),
    subject_list: [{ subject_id: "<|Subject1|>", display_name: name, subject_attribute: look }],
    segments: [fixSegment(seg, 0, true)],
  };
}

/** The world with one more segment, for what the user asks next (camera keys steer it when given). */
export async function nextSegment(model: ModelInfo, w: WorldJson, request: string, camera: string | null, signal: AbortSignal): Promise<WorldJson> {
  const user =
    `The world so far:\n${JSON.stringify(w)}\n\n` +
    (camera ? `Camera keys for the next segment (the camera moves this way on its own): ${camera}\n` : "") +
    `What happens next: ${request || (camera ? "the camera moves as the keys say" : "carry on")}`;
  const j = await ask(model, NEXT, user, signal);
  const seg = j?.segments?.[0] ?? (j?.start_time ? j : null);
  if (!seg) throw new Error("the chat model didn't write the next segment (try again)");
  const last = w.segments[w.segments.length - 1];
  return { ...w, segments: [...w.segments, fixSegment(seg, ms(last.end_time), false)] };
}

/** The world's length in seconds. */
export const worldSeconds = (w: WorldJson) => ms(w.segments[w.segments.length - 1].end_time) / 1000;
