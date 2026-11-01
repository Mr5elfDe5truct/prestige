import { ocrReady, readText } from "./ocr";
import { openTranslate, translateReady } from "./translate";
import { swapCharacter } from "./swap";
import { $, $$, deps, isInstrumental, starred, workflows } from "./studio";
import { type Asset } from "./modes";
import { useAsReference } from "./refslot";
import { closeLightbox, makeModel, openLightbox, toggleStar } from "./gallery";
import { addSound, laser, makeManga, newAngle, paintToChange, personCutout, removeBackground, restorePhoto, songEditItems, startFrom, tryOnOutfit, upscaleItems, videoCutout } from "./renderactions";
import { deleteRender, fileAction, reusePrompt, reuseSeed, revealFile, saveAs } from "./fileactions";

// ---------- right-click menu ----------
export type MenuItem = { label: string; run: () => void; key?: string; danger?: boolean } | "-";
export let menuEl: HTMLElement | null = null;

export function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}

export function showMenu(e: MouseEvent, a: Asset) {
  e.preventDefault();
  e.stopPropagation();
  closeMenu();
  const image = a.kind === "image";
  const model = a.kind === "model";
  const list: MenuItem[] = [
    ...(model ? [{ label: "Open in 3D viewer", run: () => deps.openModel(a.path, a.name) }] : []),
    { label: image ? "Open" : model ? "Open in default app" : "Play", run: () => fileAction("open_render", a, {}), key: model ? "3D Viewer, Blender…" : "in default app" },
    { label: "Show info", run: () => openLightbox(a) },
    { label: starred.has(a.path) ? "Unstar" : "Star", run: () => toggleStar(a.path), key: "Starred filter" },
    { label: "Open in folder", run: () => revealFile(a) },
    "-",
    ...(image && workflows.edit ? [{ label: "Edit with Qwen-Image…", run: () => startFrom(a, "image") }] : []),
    ...(image && workflows.inpaint ? [{ label: "Paint to change…", run: () => paintToChange(a) }] : []),
    ...(image && workflows.select ? [{ label: "Select to change or cut out…", run: () => paintToChange(a, true), key: "SAM 3.1" }] : []),
    ...(image && workflows.cutout ? [{ label: "Remove background", run: () => removeBackground(a), key: "transparent PNG" }] : []),
    ...(image && workflows.angle ? [{ label: "New camera angle…", run: () => newAngle(a), key: "reshoot" }] : []),
    ...(image && workflows.outfit ? [{ label: "Try on outfit…", run: () => tryOnOutfit(a), key: "dress up" }] : []),
    ...(image && workflows.restore ? [{ label: "Restore photo…", run: () => restorePhoto(a), key: "blur, noise, old prints" }] : []),
    ...(image && workflows.manga ? [{ label: "Make it manga", run: () => makeManga(a), key: "black & white page" }] : []),
    ...(image && ocrReady() ? [{ label: "Read the text", run: () => (closeLightbox(), readText(a.path, a.name)), key: "Unlimited-OCR" }] : []),
    ...(image && translateReady() ? [{ label: "Translate the text…", run: () => (closeLightbox(), openTranslate("", a.path)), key: "Index-Translate" }] : []),
    ...(a.kind === "video" && workflows.person && workflows.select ? [{ label: "Cut out a person…", run: () => personCutout(a), key: "click, MatAnyone2" }] : []),
    ...(a.kind === "video" && workflows.vidcut ? [{ label: "Cut out a subject…", run: () => videoCutout(a), key: "green screen" }] : []),
    ...(a.kind === "video" && workflows.foley ? [{ label: "Add sound…", run: () => addSound(a), key: "Foley" }] : []),
    ...(a.kind === "video" && workflows.swap ? [{ label: "Swap a character…", run: () => swapCharacter(a), key: "SCAIL-2" }] : []),
    ...upscaleItems(a),
    ...songEditItems(a),
    ...(image && (workflows.animate || workflows.long) ? [{ label: "Animate (image → video)…", run: () => startFrom(a, "video") }] : []),
    ...(image && (workflows.ref || workflows.reffast) ? [{ label: "Use as reference image", run: () => useAsReference(a) }] : []),
    ...(image && workflows.model3d ? [{ label: "Make a 3D model", run: () => makeModel(a), key: "Pixal3D" }] : []),
    ...(image && workflows.talk ? [{ label: "Make it talk…", run: () => deps.makeTalk(a.path), key: "InfiniteTalk" }] : []),
    ...(image && workflows.song ? [{ label: "Make a song about it", run: () => deps.songFromPicture(a.path), key: "in chat" }] : []),
    ...(image ? [{ label: "Make a laser file…", run: () => laser(a), key: "engrave or cut" }] : []),
    ...(a.prompt ? [{ label: a.kind === "audio" ? "Reuse style and lyrics" : "Reuse prompt", run: () => reusePrompt(a) }] : []),
    ...(a.seed != null ? [{ label: "Reuse seed", run: () => reuseSeed(a), key: String(a.seed) }] : []),
    "-",
    ...(image ? [{ label: "Copy image", run: () => fileAction("copy_render", a, { asImage: true }, "Image copied.") }] : []),
    { label: "Copy file", run: () => fileAction("copy_render", a, { asImage: false }, "File copied. Paste it into a folder or a chat app."), key: "to paste elsewhere" },
    ...(a.prompt ? [{ label: a.kind === "audio" ? "Copy style" : "Copy prompt", run: () => copy(a.prompt || "", a.kind === "audio" ? "Style" : "Prompt") }] : []),
    ...(a.kind === "audio" && a.lyrics && !isInstrumental(a.lyrics) ? [{ label: "Copy lyrics", run: () => copy(a.lyrics || "", "Lyrics") }] : []),
    { label: "Copy file path", run: () => copy(a.path, "Path") },
    { label: "Save a copy as…", run: () => saveAs(a) },
    "-",
    { label: "Delete…", run: () => deleteRender(a), key: "Recycle Bin", danger: true },
  ];
  const m = document.createElement("div");
  m.className = "ctx-menu";
  m.setAttribute("role", "menu");
  let prev: MenuItem | null = "-";
  for (const it of list) {
    if (it === "-") {
      if (prev !== "-") m.appendChild(document.createElement("hr"));
    } else {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      if (it.danger) b.className = "danger";
      b.innerHTML = `<span></span>${it.key ? "<kbd></kbd>" : ""}`;
      $("span", b).textContent = it.label;
      if (it.key) $("kbd", b).textContent = it.key;
      b.addEventListener("click", () => {
        closeMenu();
        it.run();
      });
      m.appendChild(b);
    }
    prev = it;
  }
  if (m.lastElementChild?.tagName === "HR") m.lastElementChild.remove();
  document.body.appendChild(m);
  // Keep it on screen: open up or left when there's no room.
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(e.clientX, innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(e.clientY, innerHeight - r.height - 4))}px`;
  menuEl = m;
  ($("button", m) as HTMLButtonElement | null)?.focus();
}

document.addEventListener("mousedown", (e) => {
  if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (!menuEl) return;
  if (e.key === "Escape") {
    e.stopPropagation();
    closeMenu();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const bs = $$<HTMLButtonElement>("button", menuEl);
    const i = bs.indexOf(document.activeElement as HTMLButtonElement);
    bs[(i + (e.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length]?.focus();
  }
}, true);
addEventListener("blur", closeMenu);
addEventListener("resize", closeMenu);
addEventListener("scroll", closeMenu, true);

export async function copy(text: string, what = "Prompt") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  deps.toast(`${what} copied.`);
}
