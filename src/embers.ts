// Ember drift: a few embers in the theme's accent and trim colours rise slowly behind everything, and flare up and
// quicken while Prestige is speaking. Drawn on one canvas behind the app at up to 30 frames a second, paused when
// the window is hidden and off when Windows asks for reduced motion (or in Settings → Appearance).
import { outputLevel } from "./speech";
import { themeRgb } from "./theme";

interface Ember {
  x: number;
  y: number;
  r: number;
  vy: number;
  sway: number;
  phase: number;
  gold: boolean;
  life: number;
}

let on = false;
let canvas: HTMLCanvasElement | null = null;
let raf = 0;
let last = 0;
let embers: Ember[] = [];
let sprites: Record<string, HTMLCanvasElement> = {};
let spriteKey = "";
let voice = 0;
let seeded = false;
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

export function setEmbers(want: boolean) {
  on = want && !reduced.matches;
  if (on && !canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "embers";
    canvas.setAttribute("aria-hidden", "true");
    document.body.prepend(canvas);
    document.addEventListener("visibilitychange", () => on && !document.hidden && start());
  }
  if (canvas) canvas.hidden = !on;
  if (on) start();
  else {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}

function start() {
  if (!raf) raf = requestAnimationFrame(frame);
}

/** A soft round glow, drawn once per colour and stamped for every ember (much cheaper than a canvas shadow). */
function sprite(rgb: string, glow: number) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(255, 244, 220, 1)`);
  grad.addColorStop(0.07, `rgba(${rgb}, 1)`);
  grad.addColorStop(0.3, `rgba(${rgb}, ${0.18 + 0.32 * Math.min(glow, 1.5)})`);
  grad.addColorStop(1, `rgba(${rgb}, 0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

function spawn(w: number, h: number, anywhere: boolean): Ember {
  return {
    x: Math.random() * w,
    y: anywhere ? Math.random() * h : h + 10,
    r: 0.6 + Math.random() * 1.8,
    vy: 8 + Math.random() * 16,
    sway: 6 + Math.random() * 18,
    phase: Math.random() * Math.PI * 2,
    gold: Math.random() < 0.55,
    life: Math.random(),
  };
}

function frame(t: number) {
  raf = 0;
  if (!on || !canvas || document.hidden) return;
  raf = requestAnimationFrame(frame);
  if (t - last < 33) return;
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const { accent, trim, glow } = themeRgb();
  const key = `${accent}|${trim}|${glow}`;
  if (key !== spriteKey) {
    spriteKey = key;
    sprites = { a: sprite(accent, glow), t: sprite(trim, glow) };
  }
  // Prestige's voice livens them up: faster, brighter and a few more.
  voice = voice * 0.85 + outputLevel() * 0.15;
  const want = Math.round(Math.min(70, (w * h) / 26000) * (1 + voice * 0.8));
  // The first ones start spread over the window; later ones rise from the bottom.
  while (embers.length < want) embers.push(spawn(w, h, !seeded));
  seeded = true;
  const g = canvas.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.globalCompositeOperation = "lighter";
  const speed = 1 + voice * 3;
  for (let i = embers.length - 1; i >= 0; i--) {
    const e = embers[i];
    e.y -= e.vy * speed * dt;
    e.phase += dt * (0.6 + e.vy / 30);
    e.life += dt * 0.07;
    const x = e.x + Math.sin(e.phase) * e.sway;
    if (e.y < -20 || x < -30 || x > w + 30) {
      if (embers.length > want) embers.splice(i, 1);
      else embers[i] = spawn(w, h, false);
      continue;
    }
    // Fade in from the bottom, out towards the top, and flicker.
    const rise = 1 - e.y / h;
    const flicker = 0.75 + 0.25 * Math.sin(e.phase * 3.1 + e.life * 9);
    const alpha = Math.min(1, rise * 3) * Math.max(0, 1 - rise * 0.85) * flicker * (0.45 + voice * 0.9);
    if (alpha <= 0.01) continue;
    const size = e.r * (3.5 + 3 * Math.min(glow, 1.5)) * (1 + voice * 0.4);
    g.globalAlpha = Math.min(1, alpha);
    g.drawImage(e.gold ? sprites.t : sprites.a, x - size, e.y - size, size * 2, size * 2);
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";
}
