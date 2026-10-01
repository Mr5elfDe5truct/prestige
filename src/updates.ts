// Auto-update: checks GitHub Releases (latest.json, signed with R.G. Studios' key) when Prestige opens
// and from About, then downloads, verifies and installs the new version and restarts.
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { errMsg } from "./backends";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const inTauri = "__TAURI_INTERNALS__" in window;

let pending: Update | null = null;
let installing = false;
let toast: (m: string, k?: string) => void = () => {};

export async function initUpdates(t: (m: string, k?: string) => void) {
  toast = t;
  if (!inTauri) return;
  $("#about-version").textContent = `Version ${await getVersion()}`;
  $("#check-updates").addEventListener("click", () => checkForUpdates(false));
  $("#update-now").addEventListener("click", installUpdate);
  $("#update-later").addEventListener("click", () => ($("#update-banner").hidden = true));
}

/** Looks for a newer release. Quiet on launch; says so when there's nothing new if asked from About. */
export async function checkForUpdates(quiet: boolean) {
  if (!inTauri || installing) return;
  const status = $("#update-status");
  if (!quiet) status.textContent = "Checking…";
  try {
    pending = await check({ timeout: 15000 });
  } catch (e) {
    if (!quiet) status.textContent = `Couldn't check: ${errMsg(e) === "not reachable" ? "no internet connection" : errMsg(e)}`;
    return;
  }
  if (!pending) {
    if (!quiet) status.textContent = "You're on the latest version.";
    return;
  }
  status.textContent = `Prestige ${pending.version} is available.`;
  $("#update-text").textContent = `Prestige ${pending.version} is available (you have ${pending.currentVersion}).`;
  $("#update-banner").hidden = false;
  if (!quiet) ($("#about") as HTMLDialogElement).close();
}

async function installUpdate() {
  if (!pending || installing) return;
  installing = true;
  const btn = $("#update-now") as HTMLButtonElement;
  btn.disabled = true;
  ($("#update-later") as HTMLButtonElement).hidden = true;
  const bar = $("#update-progress");
  bar.hidden = false;
  let total = 0;
  let got = 0;
  try {
    // Download and check the signature first; nothing changes until the file is verified.
    await pending.download((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        bar.style.setProperty("--v", String(total ? (got / total) * 100 : 50));
        $("#update-text").textContent = `Downloading Prestige ${pending!.version}… ${(got / 1e6).toFixed(1)}${total ? ` of ${(total / 1e6).toFixed(1)}` : ""} MB`;
      }
    });
    $("#update-text").textContent = `Installing Prestige ${pending.version}. Windows may ask for permission; Prestige restarts when it's done.`;
    // The installer closes Prestige and starts the new version, so keep the AI stack running meanwhile.
    await invoke("set_updating", { on: true });
    await pending.install();
    await relaunch();
  } catch (e) {
    await invoke("set_updating", { on: false }).catch(() => {});
    installing = false;
    btn.disabled = false;
    ($("#update-later") as HTMLButtonElement).hidden = false;
    bar.hidden = true;
    $("#update-text").textContent = `The update didn't finish: ${errMsg(e)}`;
    toast("The update didn't finish. Prestige is unchanged.", "warn");
  }
}
