import { errMsg, LLAMA, OLLAMA, ping } from "./backends";
import { DEFAULT_OWUI } from "./memory";
import { invoke } from "@tauri-apps/api/core";
import { openWebUIOn } from "./workstation";
import { $, inTauri, refreshMemoryStatus, refreshModels, settings, toast } from "./main";

// ---------- launch screen ----------
export const BOOT: { label: string; url: string }[] = [
  { label: "Ollama", url: `${OLLAMA}/api/version` },
  { label: "llama.cpp · Qwen3.6 35B", url: `${LLAMA}/models` },
  { label: "Open WebUI", url: `${DEFAULT_OWUI}/api/config` },
  { label: "ComfyUI", url: "http://127.0.0.1:8188/system_stats" },
  { label: "Kokoro voice", url: "http://127.0.0.1:8880/v1/models" },
];

export function bootRows() {
  const boot = $("#boot");
  boot.innerHTML = "";
  return BOOT.map((b) => {
    const s = document.createElement("span");
    s.textContent = b.label;
    boot.appendChild(s);
    return s;
  });
}

export async function checkAll(spans: HTMLElement[]) {
  const ok = await Promise.all(BOOT.map((b) => ping(b.url)));
  ok.forEach((up, i) => {
    spans[i].className = up ? "ok" : "off";
    spans[i].textContent = up ? BOOT[i].label : `${BOOT[i].label} · offline`;
  });
  return ok;
}

export let starting: Promise<boolean> | null = null;

/** Starts the Workstation's services and ticks each as it comes up. True once a chat backend answers. */
export function startStack(spans: HTMLElement[]): Promise<boolean> {
  if (starting) return starting;
  starting = (async () => {
    try {
      // Prestige's own service manager (services.rs, prep.rs); a folder it can't manage runs start-all.ps1 whole instead.
      await invoke("svc_start", { root: settings.stackRoot ?? null, names: null }).catch(async (e) => {
        if (errMsg(e) !== "unsupported") throw e;
        await invoke("start_services", { root: settings.stackRoot ?? null });
      });
    } catch (e) {
      toast(`Couldn't start the services: ${errMsg(e)}`, "warn");
      return false;
    }
    spans.forEach((s, i) => {
      if (!s.classList.contains("ok")) {
        s.className = "";
        s.textContent = `${BOOT[i].label} · starting…`;
      }
    });
    // Open WebUI takes the longest (about a minute); give everything up to 3 minutes.
    const until = performance.now() + 180_000;
    let chatUp = false;
    while (performance.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
      const ok = await Promise.all(BOOT.map((b) => ping(b.url)));
      ok.forEach((up, i) => {
        if (up) {
          spans[i].className = "ok";
          spans[i].textContent = BOOT[i].label;
        }
      });
      chatUp = ok[0] || ok[1];
      // Open WebUI can be switched off in the Workstation settings; then there's no need to wait for it.
      if (ok[0] && ok[1] && (ok[2] || !openWebUIOn())) break;
    }
    return chatUp;
  })().finally(() => (starting = null));
  return starting;
}

export async function runSplash(autoStart: boolean) {
  const splash = $("#splash");
  splash.classList.remove("gone");
  const spans = bootRows();
  const started = performance.now();
  const ok = await checkAll(spans);
  if (autoStart && inTauri && !ok[0] && !ok[1]) {
    await startStack(spans);
  }
  await refreshModels();
  refreshMemoryStatus();
  const wait = Math.max(0, 2200 - (performance.now() - started));
  setTimeout(() => splash.classList.add("gone"), wait);
}
