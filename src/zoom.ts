// Zoom for a picture in a box: the mouse wheel zooms in and out around the pointer, and a bar under it has a slider,
// − and + and Fit. 100% is the picture fitted in the box, up to 800%. Zoomed in, the box scrolls (its scroll bars, or
// dragging with the pan button), and the picture is sized rather than scaled, so clicks on it (painting, selecting) still
// land where they should. Used by the render viewer, Paint to change and the Laser panel.

const MAX = 8;

export interface Zoom {
  /** Back to fitted (a new picture). */
  reset(): void;
  /** The picture changed size (or a different one is shown): measures it again and keeps the zoom. */
  refresh(): void;
  readonly level: number;
}

interface Options {
  /** The element that's zoomed (the picture, or a frame around it), or null when there's nothing to zoom. */
  target: () => HTMLElement | null;
  /** Where the bar goes. */
  bar: HTMLElement;
  /** The mouse button that drags the view around when zoomed in: 0 (left) for viewers, 1 (middle) where left paints. */
  panButton?: number;
}

export function attachZoom(box: HTMLElement, o: Options): Zoom {
  let z = 1;
  let base: { w: number; h: number } | null = null;
  o.bar.classList.add("zoom-bar");
  o.bar.innerHTML =
    `<button type="button" class="icon-btn" data-z="out" title="Zoom out">−</button>` +
    `<input type="range" min="100" max="${MAX * 100}" step="5" value="100" aria-label="Zoom" />` +
    `<button type="button" class="icon-btn" data-z="in" title="Zoom in">+</button>` +
    `<span class="zoom-pct">100%</span>` +
    `<button type="button" class="linkish" data-z="fit" title="Fit the whole picture (or double-click it)">Fit</button>`;
  const slider = o.bar.querySelector("input") as HTMLInputElement;
  const pct = o.bar.querySelector(".zoom-pct") as HTMLElement;

  /** The picture's fitted size: its size with no zoom applied. */
  function measure() {
    const t = o.target();
    if (!t) return (base = null);
    const keep = [t.style.width, t.style.height, t.style.maxWidth, t.style.maxHeight];
    t.style.width = t.style.height = t.style.maxWidth = t.style.maxHeight = "";
    box.classList.remove("zoomed");
    const r = t.getBoundingClientRect();
    base = r.width && r.height ? { w: r.width, h: r.height } : null;
    // A picture shown "contained" can be smaller than its box: the picture's own shape is what's zoomed.
    if (base && t instanceof HTMLImageElement && t.naturalWidth && t.naturalHeight) {
      const k = Math.min(r.width / t.naturalWidth, r.height / t.naturalHeight);
      base = { w: t.naturalWidth * k, h: t.naturalHeight * k };
    }
    [t.style.width, t.style.height, t.style.maxWidth, t.style.maxHeight] = keep;
    return base;
  }

  /** Zooms to `level`, keeping the point at (cx, cy) on screen (the pointer, or the middle of the box) still. */
  function set(level: number, cx?: number, cy?: number) {
    const t = o.target();
    level = Math.min(MAX, Math.max(1, level));
    if (!t || (!base && !measure())) return;
    const b = box.getBoundingClientRect();
    const px = (cx ?? b.left + b.width / 2) - b.left;
    const py = (cy ?? b.top + b.height / 2) - b.top;
    // Where that point is on the picture, as a share of its size, before the change.
    const tr = t.getBoundingClientRect();
    const fx = (px + b.left - tr.left) / tr.width;
    const fy = (py + b.top - tr.top) / tr.height;
    z = level;
    if (z === 1) {
      t.style.width = t.style.height = t.style.maxWidth = t.style.maxHeight = "";
      box.classList.remove("zoomed");
    } else {
      box.classList.add("zoomed");
      t.style.maxWidth = t.style.maxHeight = "none";
      t.style.width = `${base!.w * z}px`;
      t.style.height = `${base!.h * z}px`;
      // Scroll so the same point of the picture is under the pointer again.
      const nr = t.getBoundingClientRect();
      box.scrollLeft += nr.left + fx * nr.width - (b.left + px);
      box.scrollTop += nr.top + fy * nr.height - (b.top + py);
    }
    slider.value = String(Math.round(z * 100));
    pct.textContent = `${Math.round(z * 100)}%`;
  }

  box.addEventListener(
    "wheel",
    (e) => {
      if (!o.target()) return;
      e.preventDefault();
      // A notch (deltaY 100) is about 16%; a touchpad's small steps zoom smoothly.
      set(z * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    },
    { passive: false },
  );
  box.addEventListener("dblclick", (e) => {
    if (o.panButton === 0 && o.target()) set(z > 1 ? 1 : 2, e.clientX, e.clientY);
  });
  slider.addEventListener("input", () => set(Number(slider.value) / 100));
  o.bar.addEventListener("click", (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>("[data-z]")?.dataset.z;
    if (k === "in") set(z * 1.25);
    else if (k === "out") set(z / 1.25);
    else if (k === "fit") set(1);
  });

  // Dragging moves the view when zoomed in.
  let drag: { x: number; y: number; l: number; t: number } | null = null;
  box.addEventListener("pointerdown", (e) => {
    if (z === 1 || e.button !== (o.panButton ?? 0)) return;
    e.preventDefault();
    drag = { x: e.clientX, y: e.clientY, l: box.scrollLeft, t: box.scrollTop };
    box.setPointerCapture(e.pointerId);
    box.classList.add("panning");
  });
  box.addEventListener("pointermove", (e) => {
    if (!drag) return;
    box.scrollLeft = drag.l - (e.clientX - drag.x);
    box.scrollTop = drag.t - (e.clientY - drag.y);
  });
  const end = () => {
    drag = null;
    box.classList.remove("panning");
  };
  box.addEventListener("pointerup", end);
  box.addEventListener("pointercancel", end);
  // The middle button would otherwise start the browser's autoscroll.
  box.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
  // The fitted size changes with the window.
  addEventListener("resize", () => {
    if (z > 1) {
      const keep = z;
      measure();
      set(keep);
    } else base = null;
  });

  return {
    reset() {
      z = 1;
      base = null;
      const t = o.target();
      if (t) t.style.width = t.style.height = t.style.maxWidth = t.style.maxHeight = "";
      box.classList.remove("zoomed");
      slider.value = "100";
      pct.textContent = "100%";
    },
    refresh() {
      const keep = z;
      measure();
      set(keep);
    },
    get level() {
      return z;
    },
  };
}
