// Mesa, molded: things grow into place. The look itself is mesa.css (on while body has the "mesa" class, which theme.ts
// sets from Settings → Appearance); this adds the motion. Panels rise out of the ground when the launch screen lifts and
// when a section opens, popovers and dialogs grow open from the button that opened them (and fold back into it when
// they close), and new messages grow into the thread. It only watches the page: the rest of the app opens and closes
// things as it always has, by their `hidden` attribute or dialog.showModal().
import "./mesa.css";

/** Popovers and the button each one grows out of. */
const POPOVERS: [string, string][] = [
  ["#model-menu", "#model-btn"],
  ["#persona-menu", "#persona-btn"],
  ["#tools-pop", "#composer-tools"],
  ["#gen-pop", "#composer-gen"],
  ["#cam-pop", "#composer-cam"],
  ["#history", "#history-btn"],
];
/** Panels that rise into place when a section opens. */
const PANELS = ".composer-dock, .card, .create, .rq, .gallery, .voice-stage, .update-banner, .offline";

const on = () => document.body.classList.contains("mesa") && !matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Plays one of mesa.css's animation classes, and takes it off again when it ends (the last frame clips the shadows). */
const runs = new WeakMap<HTMLElement, Record<string, number>>();
function play(el: HTMLElement, cls: string, ms: number) {
  const mine = runs.get(el) ?? {};
  runs.set(el, mine);
  const run = (mine[cls] = (mine[cls] ?? 0) + 1);
  el.classList.remove(cls);
  void el.offsetWidth; // restart it if it was already playing
  el.classList.add(cls);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    el.removeEventListener("animationend", onEnd);
    if (mine[cls] === run) el.classList.remove(cls); // (if it was played again since, that run takes it off)
  };
  const onEnd = (e: AnimationEvent) => e.target === el && e.animationName.startsWith("mesa-") && end();
  el.addEventListener("animationend", onEnd);
  setTimeout(end, ms + 400); // in case it never runs (hidden, or motion turned off meanwhile)
}

/** Panels rise out of the ground one after another. */
function rise(els: HTMLElement[]) {
  if (!on()) return;
  els.forEach((el, i) => {
    el.style.setProperty("--i", String(i));
    play(el, "mesa-rise", 900 + i * 90);
  });
}

/** Rows inside a popover or dialog rise in one after another (lists go one level deeper). */
function riseInside(box: HTMLElement) {
  const rows: HTMLElement[] = [];
  for (const c of Array.from(box.children) as HTMLElement[]) {
    if (c.hidden || c.tagName === "VIDEO") continue;
    const kids = (Array.from(c.children) as HTMLElement[]).filter((k) => !k.hidden);
    if (kids.length >= 3 && (c.tagName === "DIV" || c.tagName === "FORM") && !c.matches(".acts, .look-presets, .tool-row")) rows.push(...kids);
    else rows.push(c);
  }
  // only what's in view (a long dialog scrolls), spread over at most about half a second
  const bottom = box.getBoundingClientRect().bottom;
  const seen = rows.filter((r) => r.getBoundingClientRect().top < bottom);
  const step = Math.min(1, 8 / Math.max(1, seen.length));
  seen.forEach((r, k) => {
    r.style.setProperty("--k", (k * step).toFixed(2));
    play(r, "mesa-sub", 500 + 240 + k * step * 60);
  });
}

/** Where the grow starts: the opener's middle, in the popover's own coordinates, and a radius that covers it all. */
function origin(el: HTMLElement, from: { x: number; y: number }) {
  const b = el.getBoundingClientRect();
  const ox = from.x - b.left;
  const oy = from.y - b.top;
  const far = Math.max(...[[0, 0], [b.width, 0], [0, b.height], [b.width, b.height]].map(([x, y]) => Math.hypot(x - ox, y - oy)));
  el.style.setProperty("--ox", `${Math.round(ox)}px`);
  el.style.setProperty("--oy", `${Math.round(oy)}px`);
  el.style.setProperty("--or", `${Math.round(far + 80)}px`); // + room for the shadow
}
const middle = (el: Element | null) => {
  const r = el?.getBoundingClientRect();
  return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
};

/** Grows a popover open from its button; when it closes it folds back into it before it really goes. */
function watchPopover(sel: string, opener: string) {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) return;
  let open = !el.hidden;
  new MutationObserver(() => {
    if (el.hidden === open) {
      // it changed
      open = !el.hidden;
      if (open) {
        el.classList.remove("mesa-out");
        if (!on()) return;
        el.style.setProperty("--mesa-d", getComputedStyle(el).display);
        const from = middle(document.querySelector(opener)) ?? middle(el)!;
        origin(el, from);
        play(el, "mesa-pop", 750);
        riseInside(el);
      } else if (on() && el.style.getPropertyValue("--mesa-d")) {
        el.classList.remove("mesa-pop");
        play(el, "mesa-out", 400);
      }
    }
  }).observe(el, { attributes: true, attributeFilter: ["hidden"] });
}

/** Dialogs grow open from wherever you last clicked (the button that opened them), or from their middle. */
let lastPress: { x: number; y: number } | null = null;
function watchDialogs() {
  document.addEventListener("pointerdown", (e) => (lastPress = { x: e.clientX, y: e.clientY }), true);
  document.addEventListener("keydown", () => (lastPress = null), true);
  for (const d of Array.from(document.querySelectorAll<HTMLDialogElement>("dialog.sheet"))) {
    new MutationObserver(() => {
      if (!d.open || !on()) return;
      origin(d, lastPress ?? middle(d)!);
      play(d, "mesa-pop", 750);
      riseInside(d);
    }).observe(d, { attributes: true, attributeFilter: ["open"] });
  }
}

/** A section's panels rise as it opens. */
function riseScreen(screen: HTMLElement) {
  const all = Array.from(screen.querySelectorAll<HTMLElement>(PANELS)).filter((el) => !el.hidden && el.offsetParent !== null);
  // only the outermost ones: what's inside rises with them
  rise(all.filter((el) => !all.some((o) => o !== el && o.contains(el))).slice(0, 10));
}
function watchScreens() {
  for (const s of Array.from(document.querySelectorAll<HTMLElement>(".screen"))) {
    let shown = !s.hidden;
    new MutationObserver(() => {
      if (s.hidden === !shown) return;
      shown = !s.hidden;
      if (shown && !document.querySelector("#splash:not(.gone)")) riseScreen(s);
    }).observe(s, { attributes: true, attributeFilter: ["hidden"] });
  }
}

/** The launch screen lifts: the HUD, the open section and the dock rise out of the ground. */
function watchSplash() {
  const splash = document.querySelector<HTMLElement>("#splash");
  if (!splash) return;
  let gone = splash.classList.contains("gone");
  new MutationObserver(() => {
    const now = splash.classList.contains("gone");
    if (now === gone) return;
    gone = now;
    if (!gone) return;
    const screen = document.querySelector<HTMLElement>(".screen:not([hidden])");
    const inScreen = screen ? Array.from(screen.querySelectorAll<HTMLElement>(PANELS)).filter((el) => !el.hidden && el.offsetParent !== null) : [];
    const outer = inScreen.filter((el) => !inScreen.some((o) => o !== el && o.contains(el)));
    rise([document.querySelector<HTMLElement>(".hud")!, ...outer.slice(0, 8), document.querySelector<HTMLElement>(".dock")!].filter(Boolean));
  }).observe(splash, { attributes: true, attributeFilter: ["class"] });
}

/** New messages grow in. A whole chat appearing at once (opening a past chat) just shows. */
function watchThread() {
  const thread = document.querySelector<HTMLElement>("#thread");
  if (!thread) return;
  new MutationObserver((records) => {
    if (!on()) return;
    const added = records.flatMap((r) => Array.from(r.addedNodes)).filter((n): n is HTMLElement => n instanceof HTMLElement && n.classList.contains("msg"));
    if (!added.length || added.length > 3) return;
    added.forEach((m, k) => {
      m.style.setProperty("--k", String(k));
      play(m, "mesa-in", 600 + k * 120);
    });
  }).observe(thread, { childList: true });
}

/** A fine grain over the ground, tinted warm, made once (a 160px tile). */
function grain() {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 160;
    const x = c.getContext("2d")!;
    const d = x.createImageData(160, 160);
    for (let i = 0; i < d.data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      d.data[i] = v;
      d.data[i + 1] = v * 0.85;
      d.data[i + 2] = v * 0.7;
      d.data[i + 3] = 20;
    }
    x.putImageData(d, 0, 0);
    document.documentElement.style.setProperty("--grain", `url(${c.toDataURL()})`);
  } catch {
    /* no canvas: a smooth ground */
  }
}

export function initMesa() {
  grain();
  for (const [sel, opener] of POPOVERS) watchPopover(sel, opener);
  watchDialogs();
  watchScreens();
  watchSplash();
  watchThread();
}
