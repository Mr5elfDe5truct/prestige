// ---------- reference image slot ----------
import { characterById, characters, faceBlob, onCharactersChange } from "./characters";
import { bindRefChoices, CONSENT, hasFiles, hasRender, hasVideoRender, imageIn, loadReference, onRefPrefsChange, refChoicesHtml, renderIn, setRefPrefs, videoIn, videoRenderIn } from "./reference";
import { swapCharacter, swapShown, swapTake } from "./swap";
import { errMsg } from "./backends";
import { startFrom } from "./renderactions";
import { closeLightbox } from "./gallery";
import { convertFileSrc } from "@tauri-apps/api/core";
import { allowRenders, isRender } from "./renderapi";
import { $, $$, deps, esc, findItem, mode, putRef, ref, refWhat, renderCreate, srcAsset, studioShown, workflows } from "./studio";
import { type Asset, type GenMode, MODES } from "./modes";

export function initRefSlot() {
  const file = $<HTMLInputElement>("#ref-file");
  $("#ref-add").addEventListener("click", () => file.click());
  $("#ref-change").addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    file.value = "";
    if (f) setRef(f);
  });
  $("#ref-clear").addEventListener("click", () => setRef(null));
  $("#ref-character").addEventListener("change", async (e) => {
    const c = characterById((e.target as HTMLSelectElement).value);
    if (!c?.face) return;
    setRefPrefs({ kind: "character" });
    await setRef(faceBlob(c));
  });
  onCharactersChange(() => renderCreate());
  bindRefChoices($("#ref-picks"));
  onRefPrefsChange(() => renderCreate());
  // Drop a picture anywhere on the create bar (a file, or a render dragged from the gallery or chat), or paste one
  // while Studio is open. A dragged render shows where it can go: the reference, or the picture to edit or animate.
  const create = $("#create");
  const choices = $("#drop-choices");
  create.addEventListener("dragover", (e) => {
    if (!(hasFiles(e) || hasRender(e) || hasVideoRender(e)) || mode === "webcam") return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    create.classList.add("drop");
    if (!hasRender(e) || swapShown()) return;
    if (choices.hidden) showDropChoices();
    const over = (e.target as HTMLElement).closest?.("[data-drop]");
    $$("[data-drop]", choices).forEach((x) => x.classList.toggle("over", x === over));
  });
  create.addEventListener("dragleave", (e) => {
    if (create.contains(e.relatedTarget as Node)) return;
    create.classList.remove("drop");
    choices.hidden = true;
  });
  create.addEventListener("drop", (e) => {
    create.classList.remove("drop");
    // The Swap panel takes what's dropped anywhere on it; a video dropped from the gallery opens it.
    const vid = videoRenderIn(e.dataTransfer);
    if (swapShown() || vid) {
      e.preventDefault();
      choices.hidden = true;
      if (mode === "webcam") return;
      if (!swapShown()) {
        if (vid) findItem(vid).then(swapCharacter, (err) => deps.toast(errMsg(err), "warn"));
        return;
      }
      swapTake(e.dataTransfer);
      return;
    }
    const to = (e.target as HTMLElement).closest?.<HTMLElement>("[data-drop]:not([hidden])")?.dataset.drop ?? "ref";
    choices.hidden = true;
    const path = renderIn(e.dataTransfer);
    if (path) {
      e.preventDefault();
      if (mode === "webcam") return;
      if (to === "ref") refFromRender(path);
      else findItem(path).then((a) => startFrom(a, to === "edit" ? "image" : "video"), (err) => deps.toast(errMsg(err), "warn"));
      return;
    }
    const f = imageIn(e.dataTransfer);
    if (!f || mode === "webcam") return;
    e.preventDefault();
    setRef(f);
  });
  document.addEventListener("paste", (e) => {
    if (!studioShown() || mode === "webcam" || (e.target as HTMLElement)?.closest?.("dialog")) return;
    if (swapShown()) {
      if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
      if (videoIn(e.clipboardData) || imageIn(e.clipboardData)) {
        e.preventDefault();
        swapTake(e.clipboardData);
      }
      return;
    }
    const f = imageIn(e.clipboardData);
    if (!f) return;
    e.preventDefault();
    setRef(f);
  });
}

/** Sets (or with null clears) the reference image. `made`: it's a render (see uncensored.ts). */
export async function setRef(src: Blob | null, made = false) {
  try {
    const r = src ? await loadReference(src, made) : null;
    if (ref) URL.revokeObjectURL(ref.url);
    putRef(r);
  } catch (e) {
    deps.toast(errMsg(e), "warn");
  }
  renderCreate();
  if (ref) $("#gen-prompt").focus();
}

/** "Use as reference image" on a render: Studio's create bar takes it as the reference. */
export async function useAsReference(a: Asset) {
  deps.show();
  closeLightbox();
  try {
    await setRef(await (await fetch(convertFileSrc(a.path))).blob(), isRender(a.path));
  } catch (e) {
    deps.toast(`Couldn't read ${a.name}: ${errMsg(e)}`, "warn");
  }
}

/** The drop targets over the create bar for a dragged render: only the ones with their workflows (none when it can
 *  only be the reference, so the whole bar takes it). */
export function showDropChoices() {
  const has = { ref: !!(workflows.ref || workflows.reffast), edit: !!workflows.edit, animate: !!(workflows.animate || workflows.long) };
  const choices = $("#drop-choices");
  $$<HTMLElement>("[data-drop]", choices).forEach((x) => (x.hidden = !has[x.dataset.drop as keyof typeof has]));
  choices.hidden = !has.edit && !has.animate;
}

/** A render dropped on the create bar becomes the reference (the full-size file, not its thumbnail). */
export async function refFromRender(path: string) {
  if (!(workflows.ref || workflows.reffast)) {
    deps.toast(`Reference images need workflows\\${MODES.ref.file} (update the Workstation).`, "warn");
    return;
  }
  try {
    await allowRenders();
    await setRef(await (await fetch(convertFileSrc(path))).blob(), isRender(path));
  } catch (e) {
    deps.toast(`Couldn't read ${path.split(/[\\/]/).pop()}: ${errMsg(e)}`, "warn");
  }
}

export function renderRefSlot(gm: GenMode, webcam: boolean) {
  const usable = !!(workflows.ref || workflows.reffast);
  // While editing, the slot holds a second picture for the edit (image 2).
  $("#ref-slot").hidden = webcam || (!!srcAsset && gm !== "edit") || !usable;
  $("#ref-add").hidden = !!ref;
  $("#ref-set").hidden = !ref;
  // Or one of the characters' faces.
  const faces = characters().filter((c) => c.face);
  $("#ref-char-wrap").hidden = !!ref || !faces.length;
  if (!ref && faces.length) {
    const sel = $<HTMLSelectElement>("#ref-character");
    sel.innerHTML = `<option value="">Pick…</option>` + faces.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  }
  if (!ref) return;
  ($("#ref-img") as HTMLImageElement).src = ref.url;
  $("#ref-what").textContent = refWhat(gm);
  $("#ref-picks").innerHTML = refChoicesHtml(gm === "refvideo");
  $("#ref-consent").textContent = CONSENT;
}
