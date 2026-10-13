// Panels you can move and resize. A screen's parts marked data-panel ("Create", "Renders", "Models"…) are laid out in
// columns that fill the window. Drag the line between two columns or two panels to resize them, or a panel's title bar
// to move it: drop it above or below another panel, or on another panel's left or right edge to give it a column of its
// own. Each screen's layout is kept; the ⟲ button on any title bar puts that screen back the way it came.
// Narrow windows (and the phone page) just stack the panels.
// The Chat column can be widened too: drag either side of it (double-click puts it back).

type Col = { w: number; panels: { id: string; h: number }[] };
export type Layout = Col[];

const MIN_W = 280;
const MIN_H = 120;
const narrow = matchMedia("(max-width: 900px)");
const KEY = (screen: string) => `prestige-layout-${screen}`;
const GRIP = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>`;
const RESET = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5" /></svg>`;

interface Space {
  screen: string;
  root: HTMLElement;
  panels: Map<string, HTMLElement>;
  def: Layout;
  layout: Layout;
}

const copy = (l: Layout): Layout => l.map((c) => ({ w: c.w, panels: c.panels.map((p) => ({ ...p })) }));

function load(s: Space): Layout {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(KEY(s.screen)) ?? "null");
  } catch {
    saved = null;
  }
  if (!Array.isArray(saved)) return copy(s.def);
  // Keep what still makes sense: known panels once each, sizes that are numbers. A panel added in a newer version
  // goes where the default puts it if that column is still there, otherwise in the last column.
  const seen = new Set<string>();
  const out: Layout = [];
  for (const c of saved as Col[]) {
    const panels = (Array.isArray(c?.panels) ? c.panels : [])
      .filter((p) => p && s.panels.has(p.id) && !seen.has(p.id) && seen.add(p.id))
      .map((p) => ({ id: p.id, h: Number(p.h) > 0 ? Number(p.h) : 1 }));
    if (panels.length) out.push({ w: Number(c.w) > 0 ? Number(c.w) : 1, panels });
  }
  if (!out.length) return copy(s.def);
  s.def.forEach((c, ci) => c.panels.forEach((p) => {
    if (seen.has(p.id)) return;
    (out[ci] ?? out[out.length - 1]).panels.push({ ...p });
  }));
  return out;
}

function save(s: Space) {
  try {
    localStorage.setItem(KEY(s.screen), JSON.stringify(s.layout));
  } catch {
    /* preview only */
  }
}

function div(cls: string) {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}

/** Puts the panels where the layout says. Panels are moved, not rebuilt, so what's in them carries on. */
function render(s: Space) {
  const kids: HTMLElement[] = [];
  s.layout.forEach((c, ci) => {
    if (ci) kids.push(splitter(s, "v", ci));
    const col = div("ws-col");
    col.style.flex = `${c.w} 1 0`;
    c.panels.forEach((p, pi) => {
      if (pi) col.append(splitter(s, "h", ci, pi));
      const el = s.panels.get(p.id)!;
      el.style.flex = `${p.h} 1 0`;
      col.append(el);
    });
    kids.push(col);
  });
  s.root.replaceChildren(...kids);
}

/** The line between two columns (v) or two panels in a column (h). */
function splitter(s: Space, dir: "v" | "h", ci: number, pi = 0) {
  const line = div(`ws-split ${dir}`);
  line.title = "Drag to resize · double-click to even out";
  // The two sizes this line trades between: two column widths (w) or two panel heights (h).
  const pair = () => (dir === "v" ? [s.layout[ci - 1], s.layout[ci]] : [s.layout[ci].panels[pi - 1], s.layout[ci].panels[pi]]) as unknown as Record<"w" | "h", number>[];
  const key = dir === "v" ? "w" : "h";
  const els = () => [line.previousElementSibling as HTMLElement, line.nextElementSibling as HTMLElement];
  const apply = () => {
    const [a, b] = pair();
    const [ea, eb] = els();
    ea.style.flexGrow = String(a[key]);
    eb.style.flexGrow = String(b[key]);
  };
  line.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || narrow.matches) return;
    e.preventDefault();
    line.setPointerCapture(e.pointerId);
    const [a, b] = pair();
    const [ea, eb] = els();
    const size = (el: HTMLElement) => (dir === "v" ? el.getBoundingClientRect().width : el.getBoundingClientRect().height);
    const sa = size(ea), sb = size(eb), weight = a[key] + b[key], min = dir === "v" ? MIN_W : MIN_H;
    const start = dir === "v" ? e.clientX : e.clientY;
    document.body.classList.add(dir === "v" ? "ws-resizing-v" : "ws-resizing-h");
    line.classList.add("on");
    const move = (m: PointerEvent) => {
      const d = (dir === "v" ? m.clientX : m.clientY) - start;
      const na = Math.max(min, Math.min(sa + sb - min, sa + d));
      a[key] = (weight * na) / (sa + sb);
      b[key] = weight - a[key];
      apply();
    };
    const up = () => {
      line.removeEventListener("pointermove", move);
      line.removeEventListener("pointerup", up);
      line.removeEventListener("pointercancel", up);
      document.body.classList.remove("ws-resizing-v", "ws-resizing-h");
      line.classList.remove("on");
      save(s);
    };
    line.addEventListener("pointermove", move);
    line.addEventListener("pointerup", up);
    line.addEventListener("pointercancel", up);
  });
  line.addEventListener("dblclick", () => {
    const [a, b] = pair();
    a[key] = b[key] = (a[key] + b[key]) / 2;
    apply();
    save(s);
  });
  return line;
}

type Drop = { id: string; zone: "before" | "after" | "left" | "right" };

/** Where a panel dragged to (x, y) would land, or null over itself or empty space. */
function dropAt(s: Space, dragged: string, x: number, y: number): Drop | null {
  const over = document.elementFromPoint(x, y)?.closest<HTMLElement>(".ws-panel");
  const id = over?.dataset.wsId;
  if (!over || !id || id === dragged || !s.panels.has(id)) return null;
  const r = over.getBoundingClientRect();
  const rx = (x - r.left) / r.width;
  const roomForColumn = s.root.getBoundingClientRect().width / (s.layout.length + 1) >= MIN_W;
  if (roomForColumn && rx < 0.25) return { id, zone: "left" };
  if (roomForColumn && rx > 0.75) return { id, zone: "right" };
  return { id, zone: y < r.top + r.height / 2 ? "before" : "after" };
}

function showDrop(s: Space, box: HTMLElement, d: Drop | null) {
  box.hidden = !d;
  if (!d) return;
  const root = s.root.getBoundingClientRect();
  const p = s.panels.get(d.id)!.getBoundingClientRect();
  const col = s.panels.get(d.id)!.parentElement!.getBoundingClientRect();
  const r =
    d.zone === "left" ? { l: col.left, t: col.top, w: Math.min(col.width / 2, 160), h: col.height }
    : d.zone === "right" ? { l: col.right - Math.min(col.width / 2, 160), t: col.top, w: Math.min(col.width / 2, 160), h: col.height }
    : d.zone === "before" ? { l: p.left, t: p.top, w: p.width, h: p.height / 2 }
    : { l: p.left, t: p.top + p.height / 2, w: p.width, h: p.height / 2 };
  Object.assign(box.style, { left: `${r.l - root.left}px`, top: `${r.t - root.top}px`, width: `${r.w}px`, height: `${r.h}px` });
}

function move(s: Space, id: string, d: Drop) {
  const L = s.layout;
  const from = L.find((c) => c.panels.some((p) => p.id === id))!;
  from.panels = from.panels.filter((p) => p.id !== id);
  const ti = L.findIndex((c) => c.panels.some((p) => p.id === d.id));
  const to = L[ti];
  if (d.zone === "before" || d.zone === "after") {
    const at = to.panels.findIndex((p) => p.id === d.id) + (d.zone === "after" ? 1 : 0);
    const h = to.panels.reduce((n, p) => n + p.h, 0) / to.panels.length;
    to.panels.splice(at, 0, { id, h });
  } else {
    to.w /= 2;
    L.splice(d.zone === "left" ? ti : ti + 1, 0, { w: to.w, panels: [{ id, h: 1 }] });
  }
  // A column left empty gives its width to the one beside it.
  for (let i = L.length - 1; i >= 0; i--) {
    if (L[i].panels.length) continue;
    const next = L[i - 1] ?? L[i + 1];
    if (next) next.w += L[i].w;
    L.splice(i, 1);
  }
}

/** Dragging a panel by its title bar. */
function bindMove(s: Space, panel: HTMLElement, head: HTMLElement) {
  const id = panel.dataset.wsId!;
  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || narrow.matches || (e.target as HTMLElement).closest("button, input, select, a")) return;
    const x0 = e.clientX, y0 = e.clientY;
    let dragging = false;
    let target: Drop | null = null;
    const box = div("ws-drop");
    head.setPointerCapture(e.pointerId);
    const end = (drop: boolean) => {
      head.removeEventListener("pointermove", onMove);
      head.removeEventListener("pointerup", onUp);
      head.removeEventListener("pointercancel", onCancel);
      removeEventListener("keydown", onKey, true);
      box.remove();
      panel.classList.remove("ws-moving");
      document.body.classList.remove("ws-dragging");
      if (drop && dragging && target) {
        move(s, id, target);
        render(s);
        save(s);
      }
    };
    const onMove = (m: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(m.clientX - x0, m.clientY - y0) < 6) return;
        dragging = true;
        panel.classList.add("ws-moving");
        document.body.classList.add("ws-dragging");
        s.root.append(box);
      }
      target = dropAt(s, id, m.clientX, m.clientY);
      showDrop(s, box, target);
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    const onKey = (k: KeyboardEvent) => {
      if (k.key !== "Escape") return;
      k.preventDefault();
      k.stopPropagation();
      end(false);
    };
    head.addEventListener("pointermove", onMove);
    head.addEventListener("pointerup", onUp);
    head.addEventListener("pointercancel", onCancel);
    addEventListener("keydown", onKey, true);
  });
}

const spaces = new Map<string, Space>();

/** Turns a screen's data-panel parts into movable, resizable panels laid out like `def` until the user changes it. */
export function setupPanels(screen: string, def: Layout) {
  const sec = document.querySelector<HTMLElement>(`[data-screen="${screen}"]`);
  if (!sec) return;
  const parts = Array.from(sec.querySelectorAll<HTMLElement>(":scope > [data-panel]"));
  const root = div("ws");
  sec.insertBefore(root, parts[0] ?? null);
  sec.classList.add("ws-screen");
  const s: Space = { screen, root, panels: new Map(), def, layout: [] };
  for (const part of parts) {
    const id = part.dataset.panel!;
    const panel = document.createElement("section");
    panel.className = "ws-panel card";
    panel.dataset.wsId = id;
    panel.setAttribute("aria-label", part.dataset.title ?? id);
    const head = document.createElement("header");
    head.className = "ws-head";
    head.title = "Drag to move this panel";
    head.innerHTML = `<span class="ws-grip">${GRIP}</span><b></b><span class="grow"></span><button type="button" class="icon-btn ghost ws-reset" title="Reset layout: put this screen's panels back where they started" aria-label="Reset layout">${RESET}</button>`;
    head.querySelector("b")!.textContent = part.dataset.title ?? "";
    head.querySelector(".ws-reset")!.addEventListener("click", () => resetPanels(screen));
    const body = div("ws-body");
    body.append(part);
    panel.append(head, body);
    s.panels.set(id, panel);
    bindMove(s, panel, head);
  }
  s.layout = load(s);
  render(s);
  spaces.set(screen, s);
}

/** Puts a screen's panels back the way they came (every screen, and the Chat width, when no screen is named). */
export function resetPanels(screen?: string) {
  for (const s of spaces.values()) {
    if (screen && s.screen !== screen) continue;
    try {
      localStorage.removeItem(KEY(s.screen));
    } catch {
      /* preview only */
    }
    s.layout = copy(s.def);
    render(s);
  }
  if (!screen) setChatWidth(null);
}

// ---------- the Chat column ----------
const CHAT_KEY = "prestige-layout-chat-width";
const CHAT_MIN = 560;

function setChatWidth(px: number | null) {
  const chat = document.querySelector<HTMLElement>('[data-screen="chat"]');
  if (!chat) return;
  if (px) chat.style.setProperty("--chat-w", `${Math.round(px)}px`);
  else chat.style.removeProperty("--chat-w");
  try {
    if (px) localStorage.setItem(CHAT_KEY, String(Math.round(px)));
    else localStorage.removeItem(CHAT_KEY);
  } catch {
    /* preview only */
  }
}

/** Handles on both sides of the Chat column: drag to make it wider or narrower, double-click for the usual width. */
export function setupChatWidth() {
  const chat = document.querySelector<HTMLElement>('[data-screen="chat"]');
  if (!chat) return;
  try {
    const w = Number(localStorage.getItem(CHAT_KEY));
    if (w >= CHAT_MIN) chat.style.setProperty("--chat-w", `${w}px`);
  } catch {
    /* preview only */
  }
  for (const side of ["left", "right"] as const) {
    const h = div(`chat-edge ${side}`);
    h.title = "Drag to make the chat wider or narrower · double-click for the usual width";
    h.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || narrow.matches) return;
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      const r = chat.getBoundingClientRect();
      const mid = r.left + r.width / 2;
      const room = chat.parentElement!.clientWidth - 32;
      document.body.classList.add("ws-resizing-v");
      h.classList.add("on");
      const mv = (m: PointerEvent) => setChatWidth(Math.max(CHAT_MIN, Math.min(room, Math.abs(m.clientX - mid) * 2)));
      const up = () => {
        h.removeEventListener("pointermove", mv);
        h.removeEventListener("pointerup", up);
        h.removeEventListener("pointercancel", up);
        document.body.classList.remove("ws-resizing-v");
        h.classList.remove("on");
      };
      h.addEventListener("pointermove", mv);
      h.addEventListener("pointerup", up);
      h.addEventListener("pointercancel", up);
    });
    h.addEventListener("dblclick", () => setChatWidth(null));
    chat.append(h);
  }
}
