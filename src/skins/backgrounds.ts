// The living styles' backgrounds: one full-window canvas behind everything, drawn by the picked style's renderer. They
// idle calmly and pick up while Prestige is thinking or rendering (K eases between 0 and 1); Frequency's waves also
// follow the voice while Prestige speaks, like the mustache. Colours come from the theme (accent, trim, background,
// text), so they follow Accent/Trim. With the background still (Settings, or Windows asking for less motion) it draws
// one settled frame. It pauses while the window is hidden or minimised, and draws at most at 2x pixel density.
// To add a style's background: a renderer in RENDERERS under its style id.
import { outputLevel } from "../speech";

type RGB = string; // "r, g, b"
interface Pal {
  ac: RGB;
  ac2: RGB;
  bg: RGB;
  panel: RGB;
  fg: RGB;
}
interface Ctx {
  x: CanvasRenderingContext2D;
  W: number;
  H: number;
  D: any; // the renderer's own state
  K: number; // thinking, 0 to 1
  t: number; // ms
  dt: number; // frames at 60 fps since the last one
  P: Pal;
  mx: number; // pointer x, or -1
  level: number; // Prestige's voice level while it speaks, 0 to 1
}
interface Renderer {
  init?(c: Ctx): void;
  frame(c: Ctx): void;
}

const R = Math.random;
const rgba = (c: RGB, a: number) => `rgba(${c}, ${a})`;
const mix = (a: RGB, b: RGB, f: number): RGB => {
  const p = a.split(",").map(Number);
  const q = b.split(",").map(Number);
  return p.map((v, i) => Math.round(v + (q[i] - v) * f)).join(", ");
};
const WHITE: RGB = "255, 255, 255";

function drawGear(x: CanvasRenderingContext2D, cx: number, cy: number, r: number, n: number, a: number) {
  x.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const t = a + (i * Math.PI) / n;
    const rr = i % 2 ? r : r + r * 0.14;
    x.lineTo(cx + Math.cos(t - 0.12) * rr, cy + Math.sin(t - 0.12) * rr);
    x.lineTo(cx + Math.cos(t + 0.12) * rr, cy + Math.sin(t + 0.12) * rr);
  }
  x.closePath();
  x.stroke();
  x.beginPath();
  x.arc(cx, cy, r * 0.35, 0, 7);
  x.stroke();
  for (let i = 0; i < 5; i++) {
    const t = a + i * 1.2566;
    x.beginPath();
    x.moveTo(cx + Math.cos(t) * r * 0.35, cy + Math.sin(t) * r * 0.35);
    x.lineTo(cx + Math.cos(t) * r * 0.8, cy + Math.sin(t) * r * 0.8);
    x.stroke();
  }
}

type Pt = { x: number; y: number };
function bolt(a: Pt, b: Pt, dev: number, out: Pt[]) {
  if (dev < 3) {
    out.push(b);
    return;
  }
  const m = { x: (a.x + b.x) / 2 + (R() - 0.5) * dev, y: (a.y + b.y) / 2 + (R() - 0.5) * dev };
  bolt(a, m, dev / 2, out);
  bolt(m, b, dev / 2, out);
}

const stars = (c: Ctx) => Array.from({ length: 260 }, () => ({ x: (R() - 0.5) * c.W * 1.6, y: (R() - 0.5) * c.H * 1.6, z: R() * c.W, t: R() * 6 }));

const RENDERERS: Record<string, Renderer> = {
  // Living Matrix: code rain, brighter near the pointer, pouring faster while thinking
  matrix: {
    init(c) {
      c.D.cols = Math.ceil(c.W / 16);
      c.D.y = Array.from({ length: c.D.cols }, () => (R() * c.H) / 16);
    },
    frame({ x, W, H, D, K, dt, P, mx }) {
      x.fillStyle = rgba(P.bg, 0.08 + K * 0.04);
      x.fillRect(0, 0, W, H);
      x.font = '14px "Share Tech Mono", monospace';
      for (let i = 0; i < D.cols; i++) {
        const px = i * 16;
        const py = D.y[i] * 16;
        const near = mx > 0 && Math.abs(px - mx) < 80;
        x.fillStyle = near || R() < 0.04 ? rgba(P.fg, 1) : rgba(P.ac2, 1);
        x.fillText(String.fromCharCode((0x30a0 + R() * 96) | 0), px, py);
        if (py > H && R() > 0.975) D.y[i] = 0;
        D.y[i] += (0.35 + K * 0.9) * dt;
      }
    },
  },
  // Cyberpunk: a neon grid floor rolling toward you under a glowing horizon, glitch bars while thinking
  cyber: {
    frame({ x, W, H, K, t, P }) {
      const k = 1 + K * 3;
      const g = x.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, rgba(P.bg, 1));
      g.addColorStop(0.45, rgba(mix(P.bg, P.ac, 0.2), 1));
      g.addColorStop(0.5, rgba(P.ac, 1));
      g.addColorStop(0.52, rgba(mix(P.bg, P.ac, 0.1), 1));
      g.addColorStop(1, rgba(mix(P.bg, "0, 0, 0", 0.3), 1));
      x.fillStyle = g;
      x.fillRect(0, 0, W, H);
      const hz = H * 0.5;
      x.strokeStyle = rgba(P.ac2, 0.5);
      x.lineWidth = 1;
      const off = (t * 0.04 * k) % 40;
      for (let z = 0; z < 24; z++) {
        const p = Math.pow((z * 40 + off) / 960, 2.2);
        const y = hz + p * H * 0.55;
        x.globalAlpha = Math.min(1, p * 3);
        x.beginPath();
        x.moveTo(0, y);
        x.lineTo(W, y);
        x.stroke();
      }
      x.globalAlpha = 0.5;
      for (let i = -20; i <= 20; i++) {
        x.beginPath();
        x.moveTo(W / 2 + i * 20, hz);
        x.lineTo(W / 2 + i * 160, H);
        x.stroke();
      }
      x.globalAlpha = 1;
      if (R() < 0.02 * k) {
        x.fillStyle = rgba(P.ac, 0.25);
        x.fillRect(0, R() * H, W, 2 + R() * 10);
      }
    },
  },
  // Earth & Nature: fireflies and falling leaves; the fireflies gather round the chat while thinking
  nature: {
    init(c) {
      c.D.f = Array.from({ length: 46 }, () => ({ x: R() * c.W, y: R() * c.H, a: R() * 6, s: 0.3 + R() * 0.6 }));
      c.D.l = Array.from({ length: 10 }, () => ({ x: R() * c.W, y: R() * c.H, r: R() * 6, s: 0.3 + R() * 0.5 }));
    },
    frame({ x, W, H, D, K, t, dt, P }) {
      const g = x.createRadialGradient(W * 0.5, H * 0.3, 0, W * 0.5, H * 0.4, W * 0.8);
      g.addColorStop(0, rgba(mix(P.panel, P.bg, 0.4), 1));
      g.addColorStop(1, rgba(P.bg, 1));
      x.fillStyle = g;
      x.fillRect(0, 0, W, H);
      const fly = mix(P.ac, WHITE, 0.3);
      for (const f of D.f) {
        f.a += 0.02 * dt;
        f.x += (Math.cos(f.a) * f.s + (W * 0.55 - f.x) * 0.004 * K) * dt;
        f.y += (Math.sin(f.a * 1.3) * f.s + (H * 0.45 - f.y) * 0.004 * K) * dt;
        const gl = 0.5 + 0.5 * Math.sin(t * 0.003 + f.a * 3);
        x.fillStyle = rgba(fly, 0.25 + gl * 0.6);
        x.shadowColor = rgba(fly, 1);
        x.shadowBlur = 8 + K * 10;
        x.beginPath();
        x.arc(f.x, f.y, 1.6 + K, 0, 7);
        x.fill();
      }
      x.shadowBlur = 0;
      for (const l of D.l) {
        l.y += l.s * dt;
        l.x += Math.sin(t * 0.001 + l.r) * 0.4;
        l.r += 0.01;
        if (l.y > H + 20) {
          l.y = -20;
          l.x = R() * W;
        }
        x.save();
        x.translate(l.x, l.y);
        x.rotate(l.r);
        x.fillStyle = rgba(mix(P.ac, P.bg, 0.3), 0.35);
        x.beginPath();
        x.ellipse(0, 0, 9, 4, 0, 0, 7);
        x.fill();
        x.restore();
      }
    },
  },
  // Energy: lightning now and then, arcing constantly while thinking
  electric: {
    init(c) {
      c.D.b = [];
    },
    frame(c) {
      const { x, W, H, K, dt, P } = c;
      x.fillStyle = rgba(P.bg, 0.35);
      x.fillRect(0, 0, W, H);
      if (R() < (0.025 + K * 0.25) * dt) {
        const a = { x: R() * W, y: R() < 0.5 ? 0 : R() * H };
        const b = { x: a.x + (R() - 0.5) * W * 0.7, y: a.y + H * (0.3 + R() * 0.6) };
        const pts = [a];
        bolt(a, b, W * 0.18, pts);
        c.D.b.push({ p: pts, l: 1 });
      }
      c.D.b = c.D.b.filter((o: any) => (o.l -= 0.06 * dt) > 0);
      const core = mix(P.ac, WHITE, 0.6);
      for (const o of c.D.b) {
        x.strokeStyle = rgba(core, o.l);
        x.lineWidth = 1.4;
        x.shadowColor = rgba(P.ac, 1);
        x.shadowBlur = 14;
        x.beginPath();
        o.p.forEach((p: Pt, i: number) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)));
        x.stroke();
      }
      x.shadowBlur = 0;
    },
  },
  // Frequency: layered waves that swell while thinking and follow Prestige's voice while it speaks
  waves: {
    init(c) {
      c.D.v = 0;
    },
    frame({ x, W, H, D, K, t, P, level }) {
      D.v += (level - D.v) * (level > D.v ? 0.5 : 0.12);
      x.fillStyle = rgba(P.bg, 1);
      x.fillRect(0, 0, W, H);
      const cs = [P.ac, P.ac2, mix(P.ac, P.ac2, 0.5), mix(P.ac, WHITE, 0.25), P.ac2];
      for (let j = 0; j < 5; j++) {
        x.strokeStyle = rgba(cs[j], 0.25 + (0.1 * j) / 5);
        x.lineWidth = 1.5;
        x.beginPath();
        const amp = (18 + j * 9) * (1 + K * 1.6 + D.v * 3);
        const f = 0.006 + j * 0.002;
        const ph = t * 0.0012 * (1 + j * 0.3) * (1 + K);
        for (let px = 0; px <= W; px += 6) {
          const y = H * 0.5 + Math.sin(px * f + ph) * amp * Math.sin((px / W) * Math.PI) + Math.sin(px * f * 2.3 - ph * 1.4) * amp * 0.35;
          if (px) x.lineTo(px, y);
          else x.moveTo(px, y);
        }
        x.stroke();
      }
    },
  },
  // Biological: drifting cells that pulse and glow from inside while thinking
  bio: {
    init(c) {
      c.D.c = Array.from({ length: 22 }, () => ({ x: R() * c.W, y: R() * c.H, r: 14 + R() * 38, vx: (R() - 0.5) * 0.3, vy: (R() - 0.5) * 0.3, p: R() * 6 }));
    },
    frame({ x, W, H, D, K, dt, P }) {
      const k = 1 + K * 3;
      x.fillStyle = rgba(P.bg, 0.6);
      x.fillRect(0, 0, W, H);
      x.globalCompositeOperation = "lighter";
      const nucleus = mix(P.ac, WHITE, 0.3);
      for (const c of D.c) {
        c.x += c.vx * dt * k;
        c.y += c.vy * dt * k;
        c.p += 0.02 * dt * k;
        if (c.x < -60) c.x = W + 60;
        if (c.x > W + 60) c.x = -60;
        if (c.y < -60) c.y = H + 60;
        if (c.y > H + 60) c.y = -60;
        const r = c.r * (1 + 0.06 * Math.sin(c.p));
        const g = x.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
        g.addColorStop(0, rgba(P.ac, 0.05 + K * 0.08));
        g.addColorStop(0.85, rgba(P.ac, 0.05));
        g.addColorStop(0.95, rgba(P.ac2, 0.18));
        g.addColorStop(1, rgba(P.ac2, 0));
        x.fillStyle = g;
        x.beginPath();
        x.arc(c.x, c.y, r, 0, 7);
        x.fill();
        x.fillStyle = rgba(nucleus, 0.12 + K * 0.2);
        x.beginPath();
        x.arc(c.x + r * 0.2, c.y - r * 0.1, r * 0.18, 0, 7);
        x.fill();
      }
      x.globalCompositeOperation = "source-over";
    },
  },
  // Clockwork: gears turning behind the plates, spinning up while thinking
  clock: {
    init(c) {
      c.D.rot = 0;
      c.D.g = [
        { x: 0.12, y: 0.2, r: 90, n: 18, d: 1 },
        { x: 0.375, y: 0.32, r: 60, n: 12, d: -1.5 },
        { x: 0.82, y: 0.75, r: 120, n: 24, d: 0.75 },
        { x: 0.66, y: 0.55, r: 55, n: 11, d: -1.64 },
        { x: 0.4, y: 0.9, r: 70, n: 14, d: 1.3 },
        { x: 0.92, y: 0.15, r: 50, n: 10, d: -1 },
      ];
    },
    frame({ x, W, H, D, K, dt, P }) {
      const g = x.createRadialGradient(W * 0.5, H * 0.5, 0, W * 0.5, H * 0.5, W * 0.7);
      g.addColorStop(0, rgba(mix(P.panel, P.bg, 0.3), 1));
      g.addColorStop(1, rgba(mix(P.bg, "0, 0, 0", 0.3), 1));
      x.fillStyle = g;
      x.fillRect(0, 0, W, H);
      x.strokeStyle = rgba(mix(P.ac, P.ac2, 0.3), 0.22);
      x.lineWidth = 2;
      D.rot += 0.004 * dt * (1 + K * 3);
      for (const q of D.g) drawGear(x, q.x * W, q.y * H, q.r, q.n, D.rot * q.d);
    },
  },
  // Cosmic: a drifting nebula and twinkling stars that stream past like a warp jump while thinking
  cosmic: {
    init(c) {
      c.D.s = stars(c);
    },
    frame({ x, W, H, D, K, t, dt, P }) {
      x.fillStyle = rgba(P.bg, K > 0.3 ? 0.25 : 1);
      x.fillRect(0, 0, W, H);
      if (K < 0.3) {
        for (const [col, nx, ny] of [[P.ac, 0.3, 0.35], [mix(P.ac, P.ac2, 0.6), 0.75, 0.6], [mix(P.ac, WHITE, 0.2), 0.55, 0.2]] as [RGB, number, number][]) {
          const g = x.createRadialGradient(W * nx + Math.sin(t * 0.0001) * 30, H * ny, 0, W * nx, H * ny, W * 0.45);
          g.addColorStop(0, rgba(col, 0.16));
          g.addColorStop(1, rgba(col, 0));
          x.fillStyle = g;
          x.fillRect(0, 0, W, H);
        }
      }
      for (const p of D.s) {
        p.z -= (0.4 + K * 9) * dt;
        if (p.z < 1) {
          p.z = W;
          p.x = (R() - 0.5) * W * 1.6;
          p.y = (R() - 0.5) * H * 1.6;
        }
        const sc = (W * 0.5) / p.z;
        const tw = 0.5 + 0.5 * Math.sin(t * 0.003 + p.t);
        x.fillStyle = rgba(P.fg, Math.min(1, (0.3 + tw * 0.6) * (1 - p.z / W) * 2));
        x.fillRect(W / 2 + p.x * sc, H / 2 + p.y * sc, 1.4 + sc * 0.5, 1.4 + sc * 0.5);
      }
    },
  },
  // Crystal: light shimmering across a field of facets, flashing in waves while thinking
  crystal: {
    frame({ x, W, H, K, t, P }) {
      x.fillStyle = rgba(P.bg, 1);
      x.fillRect(0, 0, W, H);
      const c = 70;
      x.strokeStyle = rgba(P.fg, 0.05);
      for (let gy = -1; gy < H / c + 1; gy++) {
        for (let gx = -1; gx < W / c + 1; gx++) {
          const ox = (gy % 2) * (c / 2);
          const tris = [
            [0, 0, c, 0, c / 2, c * 0.87],
            [c, 0, c * 1.5, c * 0.87, c / 2, c * 0.87],
          ];
          tris.forEach((tr, j) => {
            const px = gx * c + ox;
            const py = gy * c * 0.87;
            const w = Math.sin(px * 0.01 + py * 0.013 - t * 0.0012 * (1 + K * 3) + j);
            x.fillStyle = rgba(j ? P.ac2 : P.ac, Math.max(0, w) * (0.06 + K * 0.12) + 0.015);
            x.beginPath();
            x.moveTo(px + tr[0], py + tr[1]);
            x.lineTo(px + tr[2], py + tr[3]);
            x.lineTo(px + tr[4], py + tr[5]);
            x.closePath();
            x.fill();
            x.stroke();
          });
        }
      }
    },
  },
};

// ---------- running it ----------
let canvas: HTMLCanvasElement | null = null;
let c: Ctx | null = null;
let id: string | null = null;
let still = false;
let raf = 0;
let last = 0;
let frames = 0;
let rendering = false;
let mx = -1;

/** "r, g, b" of a theme colour variable (any CSS colour), read through the canvas so hsl() works too. */
function rgbOf(x: CanvasRenderingContext2D, name: string, fallback: string): RGB {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  x.fillStyle = fallback;
  x.fillStyle = v;
  const m = /^#([0-9a-f]{6})$/i.exec(String(x.fillStyle));
  if (!m) return String(x.fillStyle).replace(/^rgba?\(|\)$/g, "").split(",").slice(0, 3).join(",");
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}
const palette = (x: CanvasRenderingContext2D): Pal => ({
  ac: rgbOf(x, "--red", "#d6202b"),
  ac2: rgbOf(x, "--gold", "#d9a441"),
  bg: rgbOf(x, "--bg", "#0a0707"),
  panel: rgbOf(x, "--panel", "#120c0c"),
  fg: rgbOf(x, "--fg", "#efe4d6"),
});

function size() {
  if (!canvas || !c) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  c.W = innerWidth;
  c.H = innerHeight;
  canvas.width = Math.round(c.W * dpr);
  canvas.height = Math.round(c.H * dpr);
  c.x.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function start() {
  if (!c || !id) return;
  size();
  c.D = {};
  c.P = palette(c.x);
  c.x.fillStyle = rgba(c.P.bg, 1);
  c.x.fillRect(0, 0, c.W, c.H);
  RENDERERS[id]?.init?.(c);
  cancelAnimationFrame(raf);
  if (still) {
    // One settled frame: run it on a while, then hold.
    for (let i = 0; i < 90; i++) {
      c.t = i * 16.7;
      c.dt = 1;
      RENDERERS[id]?.frame(c);
    }
    return;
  }
  last = performance.now();
  raf = requestAnimationFrame(tick);
}

function tick(t: number) {
  if (!c || !id || still) return;
  if (document.hidden) return; // resumes on visibilitychange
  c.dt = Math.min(50, t - last) / 16.7;
  last = t;
  c.t = t;
  // Thinking: a chat reply, a Live call thinking, or a render running.
  if (++frames % 30 === 0) {
    rendering = !!document.querySelector(".rq-row.running");
    c.P = palette(c.x); // follows Accent/Trim changes
  }
  const thinking = document.body.classList.contains("busy") || document.body.dataset.live === "thinking" || rendering;
  c.K += ((thinking ? 1 : 0) - c.K) * 0.05 * c.dt;
  c.mx = mx;
  c.level = id === "waves" ? outputLevel() : 0;
  RENDERERS[id]?.frame(c);
  raf = requestAnimationFrame(tick);
}

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  addEventListener("resize", () => id && start());
  addEventListener("pointermove", (e) => (mx = e.clientX), { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && id && !still) {
      last = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    }
  });
}

/** Shows a living style's background (or none, with null). `hold`: draw one still frame instead of moving. */
export function setLiveBg(style: string | null, hold: boolean) {
  const want = style && RENDERERS[style] ? style : null;
  if (!want) {
    cancelAnimationFrame(raf);
    canvas?.remove();
    canvas = null;
    c = null;
    id = null;
    return;
  }
  wire();
  const changed = want !== id || hold !== still || !canvas;
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "livebg";
    canvas.setAttribute("aria-hidden", "true");
    document.body.prepend(canvas);
    const x = canvas.getContext("2d")!;
    c = { x, W: 0, H: 0, D: {}, K: 0, t: 0, dt: 1, P: palette(x), mx: -1, level: 0 };
  }
  id = want;
  still = hold;
  if (changed) start();
  else if (c) c.P = palette(c.x);
  // Colours changed while still (a new accent): draw the still frame again.
  if (!changed && still) start();
}
