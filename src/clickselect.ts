import { errMsg, http } from "./backends";
import { type SelectQuery } from "./inpaint";
import { invoke } from "@tauri-apps/api/core";
import { uploadReference } from "./reference";
import { clientId, COMFY, deps, ensureWorkflows, workflows } from "./studio";
import { MODES, type Source } from "./modes";

// ---------- click to select ----------
// SAM 3.1 answers a click in ~3 s, so it's run straight away instead of waiting in the render queue. A second ComfyUI on
// the small card (start-all.ps1 with "comfyQuick": "on" in data\gpu-settings.json, port 8189) takes it when it runs:
// selecting then doesn't wait for a render on the big card, nor unload anything. Measured: 3 s a selection on the
// RTX 2060 (2.0 GB peak) and on the 3060 (1.7 GB).
export const COMFY_QUICK = "http://127.0.0.1:8189";
export let quickAt = 0;
export let quick: string | null = null;

/** The ComfyUI to select with: the quick one on the small card if it's running (checked every 30 s), else the main one. */
export async function selectComfy(): Promise<string> {
  if (Date.now() - quickAt < 30_000) return quick ?? COMFY;
  quickAt = Date.now();
  try {
    quick = (await http(`${COMFY_QUICK}/system_stats`)).ok ? COMFY_QUICK : null;
  } catch {
    quick = null;
  }
  return quick ?? COMFY;
}

/** SAM 3.1's mask for a picture: what's under the clicks (and not under the negative ones), or what's named. White is
 *  selected, at the picture's own size. */
export async function segment(src: Source, q: SelectQuery): Promise<Blob> {
  await ensureWorkflows();
  if (!workflows.select) throw new Error(`workflows\\${MODES.select.file} wasn't found (update the Workstation and add the select pack)`);
  const base = await selectComfy();
  const g = structuredClone(workflows.select);
  g["2"].inputs.image = "path" in src ? await invoke<string>("comfy_upload", { path: src.path }) : await uploadReference(src);
  if (q.text) g["3"].inputs.text = q.text;
  else {
    delete g["3"];
    delete g["4"].inputs.conditioning;
    g["4"].inputs.positive_coords = JSON.stringify(q.points);
    g["4"].inputs.negative_coords = JSON.stringify(q.negative);
  }
  // On the main ComfyUI, a chat model filling its card is unloaded first (SAM needs ~2 GB). It waits for a running render.
  if (base === COMFY) {
    try {
      const free = (await (await http(`${COMFY}/system_stats`)).json()).devices?.[0]?.vram_free ?? 0;
      if (free < 2.5 * 2 ** 30) await deps.freeGpu();
    } catch {
      /* ComfyUI answers the prompt below or says why not */
    }
  }
  let r: Response;
  try {
    r = await http(`${base}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: g, client_id: clientId, front: true }) });
  } catch (e) {
    throw new Error(errMsg(e) === "not reachable" ? "ComfyUI isn't running" : errMsg(e));
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.prompt_id) throw new Error(body.error?.message ?? `ComfyUI answered ${r.status}`);
  for (let t0 = Date.now(); Date.now() - t0 < 20 * 60_000; await new Promise((res) => setTimeout(res, 400))) {
    const h = (await (await http(`${base}/history/${body.prompt_id}`)).json())[body.prompt_id];
    if (!h) continue;
    if (h.status?.status_str === "error") {
      const err = (h.status.messages ?? []).find((m: any) => m[0] === "execution_error")?.[1]?.exception_message;
      throw new Error(String(err ?? "SAM 3.1 failed").split("\n")[0]);
    }
    const f = h.outputs?.["6"]?.images?.[0];
    if (!f) throw new Error("SAM 3.1 returned no mask");
    const url = `${base}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder ?? "")}&type=${f.type ?? "temp"}`;
    return await (await http(url)).blob();
  }
  throw new Error("SAM 3.1 took too long");
}
