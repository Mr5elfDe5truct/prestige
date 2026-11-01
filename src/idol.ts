// Picture to 3D as a splat (idol.rs): Speridlabs' Idol makes a 3D Gaussian splat of a picture, next to Pixal3D's
// textured mesh. It runs outside ComfyUI (in its own Python environment), one at a time, and the .ply lands with the
// other 3D models in the gallery and opens in the Canvas's 3D viewer.
import { invoke } from "@tauri-apps/api/core";
import { errMsg } from "./backends";

let ready = false;
let busy = false;

/** Whether the idol pack is there (checked when Studio opens). */
export const idolReady = () => ready;

export async function checkIdol(root: string | null) {
  try {
    ready = (await invoke<{ installed: boolean }>("idol_status", { root })).installed;
  } catch {
    ready = false;
  }
}

/** Makes a splat of the picture: a photo brought in from outside in Idol's "real" mode, a render in its "synthetic" one. */
export async function makeSplat(
  path: string,
  photo: boolean,
  d: { root: () => string | null; toast: (msg: string, kind?: string) => void; rendering: () => boolean; done: (ply: string) => void },
) {
  if (busy) return d.toast("Idol is already making a splat. One at a time.", "warn");
  // It needs the GPU to itself (ComfyUI's models are unloaded first), so not while a render runs.
  if (d.rendering()) return d.toast("Idol needs the GPU: try again when the render queue has finished.", "warn");
  busy = true;
  d.toast("Making a 3D splat with Idol: about 2 minutes on an RTX 3060 (the first time also downloads 6.4 GB). It opens in the 3D viewer.");
  try {
    const r = await invoke<{ ply: string; seconds: number }>("idol_run", { root: d.root(), path, mode: photo ? "real" : "synthetic" });
    d.toast(`Done in ${Math.round(r.seconds)} s.`);
    d.done(r.ply);
  } catch (e) {
    d.toast(`Couldn't make the splat: ${errMsg(e)}`, "warn");
  } finally {
    busy = false;
  }
}
