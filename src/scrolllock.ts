// While a window is open in front (Settings, the render viewer, Paint to change, the Laser panel, a storyboard, any
// dialog), the mouse wheel scrolls only that window: never the page behind it, and not the page either when the window
// has scrolled as far as it goes.

/** What's open in front: modal dialogs, and the full-screen overlays marked aria-modal (the viewer, Paint to change). */
function foreground(): HTMLElement[] {
  const open = Array.from(document.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"]'));
  return open.filter((el) => {
    if (el instanceof HTMLDialogElement) return el.matches(":modal");
    return !el.hidden && el.getClientRects().length > 0;
  });
}

/** Whether `el` can still scroll the way the wheel turns. */
function canScroll(el: HTMLElement, dx: number, dy: number): boolean {
  const st = getComputedStyle(el);
  if (dy) {
    const y = /(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1;
    if (y && (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1)) return true;
  }
  if (dx) {
    const x = /(auto|scroll)/.test(st.overflowX) && el.scrollWidth > el.clientWidth + 1;
    if (x && (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1)) return true;
  }
  return false;
}

export function initScrollLock() {
  addEventListener(
    "wheel",
    (e) => {
      if (e.defaultPrevented || e.ctrlKey) return; // already handled (a zoom), or the page zoom
      const fronts = foreground();
      if (!fronts.length) return;
      const target = e.target as Node;
      const inside = fronts.find((f) => f.contains(target));
      // Outside every open window (its backdrop, the page behind): nothing scrolls.
      if (!inside) return e.preventDefault();
      // Inside one: only something in it that can still scroll this way does; the page behind never does.
      for (let el = target instanceof HTMLElement ? target : target.parentElement; el; el = el.parentElement) {
        if (canScroll(el, e.deltaX, e.deltaY)) return;
        if (el === inside) break;
      }
      e.preventDefault();
    },
    { passive: false, capture: true },
  );
}
