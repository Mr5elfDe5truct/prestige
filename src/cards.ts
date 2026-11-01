// The gallery: the renders in ComfyUI's output folder as cards, built a page at a time as it scrolls.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { dragRender, dragVideo, sceneOf } from "./reference";
import { errMsg } from "./backends";
import { CUBE_SVG, lyricLines, NOTE_SVG, openLightbox, pick, renderSelection, toggleStar } from "./gallery";
import { showMenu } from "./rendermenu";
import { $, age, deps, filter, fresh, items, job, query, setItems, selected, starred } from "./studio";
import { type Asset, isVideo, songLength } from "./modes";

// The gallery builds this many cards at a time, and more as it scrolls (a big output folder stays quick).
const PAGE = 120;
let shown = 0;

export async function refresh() {
  try {
    const res = await invoke<{ dir: string; exists: boolean; items: Asset[] }>("gallery_list", { root: deps.root() });
    // A reference render's prompt starts with the wording that keeps the subject; show just the scene.
    setItems(res.items.map((a) => (a.prompt ? { ...a, prompt: sceneOf(a.prompt) } : a)));
    const paths = new Set(items.map((a) => a.path));
    for (const p of selected) if (!paths.has(p)) selected.delete(p);
    $("#gallery-note").textContent = res.exists
      ? `${items.length} renders in ${res.dir}`
      : `ComfyUI's output folder (${res.dir}) doesn't exist yet. Renders will appear here.`;
  } catch (e) {
    $("#gallery-note").textContent = `Couldn't read the renders: ${errMsg(e)}`;
  }
  render();
}

// Thumbnails are made (or read from cache) only when a tile scrolls into view.
export const io = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      const fig = en.target as HTMLElement;
      const a = items.find((x) => x.path === fig.dataset.path);
      if (!a) continue;
      invoke<string>("thumbnail", { path: a.path, mtime: a.mtime })
        .catch((e) => (a.kind === "model" ? drawModelThumb(a) : Promise.reject(e)))
        .then((t) => {
          const img = document.createElement("img");
          img.alt = "";
          img.src = convertFileSrc(t);
          $(".pic", fig).prepend(img);
          fig.classList.remove("pending");
        })
        .catch(() => fig.classList.remove("pending"));
    }
  },
  { rootMargin: "300px" },
);

// A 3D model's tile: Rust can't draw a .glb or a splat, so the first time one scrolls into view it's loaded in the same
// viewer as the Canvas, off screen and one at a time, and a picture of it is kept with the other cached thumbnails.
let drawing: Promise<unknown> = Promise.resolve();

function drawModelThumb(a: Asset): Promise<string> {
  const next = drawing.then(async () => {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-10000px;top:0;width:360px;height:360px;pointer-events:none";
    document.body.appendChild(host);
    try {
      const { mountViewer } = await import("./model3d");
      const v = await mountViewer(host, convertFileSrc(a.path), /\.ply$/i.test(a.path));
      try {
        // A splat is sorted for the view (in a worker) before it draws: wait for the first frame that shows something.
        let jpeg: string | null = null;
        for (let i = 0; i < 40 && !jpeg; i++) {
          await new Promise((r) => setTimeout(r, i ? 300 : 600));
          jpeg = v.snapshot(360);
        }
        if (!jpeg) throw new Error("the model didn't draw");
        return await invoke<string>("thumbnail_save", { path: a.path, mtime: a.mtime, jpeg });
      } finally {
        v.dispose();
      }
    } finally {
      host.remove();
    }
  });
  drawing = next.catch(() => {});
  return next;
}

export function render() {
  const g = $("#gallery");
  g.innerHTML = "";
  const list = visible();
  if (!list.length && !job) g.innerHTML = `<p class="note">${items.length && (query.trim() || filter !== "all") ? "Nothing matches." : "Nothing here yet."}</p>`;
  if (job) {
    const p = document.createElement("div");
    p.className = "thumb pending";
    const vid = isVideo(job.mode);
    const n = job.count;
    const badge = job.mode === "song" ? `<span class="badge song">SONG</span>` : `<span class="badge ${vid ? "vid" : ""}">${vid ? "VIDEO" : n > 1 ? `${n} IMAGES` : "IMAGE"}</span>`;
    p.innerHTML = `<div class="pic">${badge}</div><figcaption><span class="p"></span><span class="m">rendering…</span></figcaption>`;
    $(".p", p).textContent = job.prompt;
    g.appendChild(p);
  }
  moreIo.disconnect();
  shown = 0;
  more(list);
  renderSelection();
}

/** The renders the gallery shows: the filter (a kind, or Starred) and every word in the search box. */
export function visible() {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((a) => {
    if (filter === "starred" ? !starred.has(a.path) : filter !== "all" && a.kind !== filter) return false;
    if (!words.length) return true;
    const hay = `${a.prompt ?? ""} ${a.name} ${a.model ?? ""} ${a.lyrics ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// The next page of cards is built when the "Show more" button after the last one comes near the screen.
export const moreIo = new IntersectionObserver(
  (entries) => {
    if (!entries.some((en) => en.isIntersecting)) return;
    moreIo.disconnect();
    more();
  },
  { rootMargin: "600px" },
);

/** Adds the next page of cards to the gallery, and a "Show more" button while there are more. */
export function more(list = visible()) {
  const g = $("#gallery");
  $(".gal-more", g)?.remove();
  for (const a of list.slice(shown, shown + PAGE)) g.appendChild(card(a));
  shown = Math.min(list.length, shown + PAGE);
  if (shown < list.length) {
    const m = document.createElement("button");
    m.type = "button";
    m.className = "gal-more";
    m.textContent = `Show more (${list.length - shown} left)`;
    m.addEventListener("click", () => more());
    g.appendChild(m);
    moreIo.observe(m);
  }
}

/** A gallery card for a render. */
export function card(a: Asset) {
  const fig = document.createElement("button");
  const song = a.kind === "audio";
  const model = a.kind === "model";
  fig.className = "thumb" + (song ? " song" : model ? " model" : " pending") + (fresh.has(a.name) ? " fresh" : "") + (selected.has(a.path) ? " sel" : "");
  fig.dataset.path = a.path;
  // A song has no picture: a note and the first lines of its lyrics instead. A 3D model shows a cube until a picture of
  // it is drawn (drawModelThumb), and a click opens
  // it in the 3D viewer.
  const pic = song
    ? `<span class="song-art" aria-hidden="true">${NOTE_SVG}</span><span class="song-lines"></span>`
    : model
      ? `<span class="model-art" aria-hidden="true">${CUBE_SVG}</span>`
      : "";
  fig.innerHTML = `<div class="pic">${pic}<span class="badge ${a.kind === "video" ? "vid" : song ? "song" : model ? "m3d" : ""}">${song ? "SONG" : model ? "3D" : a.kind.toUpperCase()}</span></div><figcaption><span class="p"></span><span class="m"></span></figcaption>`;
  $(".p", fig).textContent = a.prompt || a.name;
  $(".p", fig).title = a.prompt || a.name;
  $(".m", fig).textContent = [a.model, a.duration ? songLength(Math.round(a.duration)) : "", age(a.mtime)].filter(Boolean).join(" · ");
  if (song) $(".song-lines", fig).textContent = lyricLines(a.lyrics, 4);
  // The star in the corner keeps it in the Starred filter.
  const star = document.createElement("span");
  star.className = "star" + (starred.has(a.path) ? " on" : "");
  star.setAttribute("role", "button");
  star.title = "Star (keeps it in the Starred filter)";
  star.textContent = "★";
  star.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleStar(a.path);
  });
  $(".pic", fig).appendChild(star);
  if (a.kind === "video") {
    // Hovering plays the clip, muted.
    fig.addEventListener("mouseenter", () => {
      const v = document.createElement("video");
      v.src = convertFileSrc(a.path);
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.addEventListener("playing", () => v.classList.add("playing"));
      $(".pic", fig).appendChild(v);
      v.play().catch(() => {});
    });
    fig.addEventListener("mouseleave", () => {
      const v = $("video", fig) as HTMLVideoElement | null;
      if (v) {
        v.pause();
        v.removeAttribute("src");
        v.load();
        v.remove();
      }
    });
  }
  // Ctrl- or Shift-click picks it (and while some are picked, a click does too); otherwise it opens.
  fig.addEventListener("click", (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || selected.size) return pick(a, e.shiftKey);
    if (model) deps.openModel(a.path, a.name);
    else openLightbox(a);
  });
  fig.addEventListener("contextmenu", (e) => showMenu(e, a));
  // A picture can be dragged up onto the create bar: the reference, or the picture to edit or animate.
  if (a.kind === "image") dragRender(fig, a.path);
  // A video can be dragged into the Swap panel (or onto the create bar, which opens it).
  if (a.kind === "video") dragVideo(fig, a.path);
  if (!song) io.observe(fig);
  return fig;
}
