// The talking mustache. Whenever Prestige speaks (Live, the Voice screen, the speaker button, Read replies aloud),
// every copy of the top-hat mark moves its mustache with the loudness of the voice that's actually playing: all
// speech goes through one analyser (speech.ts outputNode), so this follows the real audio, not a timer.
// The mustache is a clipped copy of the silhouette laid over the original, so at rest the mark looks exactly as
// drawn; while it talks the copy lifts and twitches and a dark mouth shows in the gap it leaves.
import markSvg from "./assets/rg-mark.svg?raw";
import { outputLevel } from "./speech";

const NS = "http://www.w3.org/2000/svg";
const CLIP_ID = "rg-stache-clip";
const SIL_D = /class="sil"[^>]*?\sd="([^"]+)"/.exec(markSvg)?.[1] ?? "";
/** The mustache's area in the mark's 600 x 600 drawing: both lobes and the curl, above the chin and the beard. */
const STACHE_AREA = "M244 452L300 452L322 440L400 440L400 502L318 502L314 488L296 488L262 498L244 498Z";
/** The lower edge of the mustache and a band above it: the mouth that shows when the mustache lifts. */
const MOUTH =
  "M250 492L270 488L290 482L308 475L322 480L336 487L348 493L362 492L372 488L380 480L383 468L376 455L362 464L346 472L332 466L308 459L290 467L270 473L250 478Z";
/** Where the mustache pivots: under the nose. */
const PIVOT = "308 470";

/** Adds the moving mustache (and the mouth behind it) to a copy of the mark: an inline <svg> or the shared <symbol>. */
export function addStache(mark: Element | null) {
  if (!mark || !SIL_D || mark.querySelector(".stache")) return;
  ensureClip();
  const mouth = document.createElementNS(NS, "path");
  mouth.setAttribute("class", "stache-mouth");
  mouth.setAttribute("d", MOUTH);
  mouth.setAttribute("opacity", "0");
  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", "stache");
  const sil = document.createElementNS(NS, "path");
  sil.setAttribute("class", "sil");
  sil.setAttribute("fill-rule", "evenodd");
  sil.setAttribute("d", SIL_D);
  sil.setAttribute("clip-path", `url(#${CLIP_ID})`);
  g.appendChild(sil);
  mark.append(mouth, g);
  watch();
}

/** The clip is defined once for the whole page; inline marks and the <symbol> all point at it. */
function ensureClip() {
  if (document.getElementById(CLIP_ID)) return;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  svg.innerHTML = `<defs><clipPath id="${CLIP_ID}" clipPathUnits="userSpaceOnUse"><path d="${STACHE_AREA}"/></clipPath></defs>`;
  document.body.prepend(svg);
}

// ---------- following the voice ----------
let watching = false;
let raf = 0;
let smooth = 0;
let quietSince = 0;

/** A cheap check a few times a second; the per-frame loop runs only while something is being said. */
function watch() {
  if (watching) return;
  watching = true;
  window.setInterval(() => {
    if (!raf && !document.hidden && outputLevel() > 0.01) {
      quietSince = 0;
      raf = requestAnimationFrame(frame);
    }
  }, 120);
}

function frame(t: number) {
  const level = outputLevel();
  // Opens fast, closes a little slower, like a mouth between syllables.
  smooth = level > smooth ? smooth * 0.45 + level * 0.55 : smooth * 0.72 + level * 0.28;
  const open = Math.min(1, smooth * 1.4);
  if (level > 0.01) quietSince = 0;
  else if (!quietSince) quietSince = t;
  const done = !!quietSince && t - quietSince > 600 && open < 0.02;
  const lift = open * 8;
  const tilt = -open * 4.5 + Math.sin(t / 55) * open * 1.8;
  const transform = done ? "" : `translate(0 ${(-lift).toFixed(2)}) rotate(${tilt.toFixed(2)} ${PIVOT})`;
  document.querySelectorAll(".stache").forEach((g) => {
    if (transform) g.setAttribute("transform", transform);
    else g.removeAttribute("transform");
  });
  const o = done ? "0" : Math.min(1, open * 3).toFixed(2);
  document.querySelectorAll(".stache-mouth").forEach((m) => m.setAttribute("opacity", o));
  if (done) {
    smooth = 0;
    raf = 0;
    return;
  }
  raf = requestAnimationFrame(frame);
}
