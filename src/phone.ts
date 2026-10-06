// Phone access, on the desktop side: the Settings section that switches the phone server (phone.rs) on and off and
// shows the address, QR code, pairing code and paired phones, and the helpers main.ts uses to keep phones up to date
// (what's streaming, which chat changed, which models there are).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errMsg } from "./backends";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const inTauri = "__TAURI_INTERNALS__" in window;

interface Status {
  running: boolean;
  port: number;
  code: string;
  urls: string[];
  qr: string;
  devices: { id: string; name: string; added: number; lastSeen: number }[];
  error?: string | null;
}

interface Deps {
  toast: (msg: string, kind?: string) => void;
  enabled: () => boolean;
  setEnabled: (on: boolean) => void;
  port: () => number | undefined;
}
let deps: Deps;
let running = false;

/** Sends an event to every phone that's connected (does nothing when phone access is off). */
export function phonePush(event: Record<string, unknown>) {
  if (running) invoke("phone_push", { event }).catch(() => {});
}

/** Tells the phone page what to show in its header: the models, the current one and character, and whether it's busy. */
export function phoneState(state: Record<string, unknown>) {
  if (!running) return;
  invoke("phone_set_state", { state }).catch(() => {});
  phonePush({ type: "state" });
}

const when = (ms: number) => (ms ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never");

function show(s: Status) {
  running = s.running;
  ($("#phone-on") as HTMLInputElement).checked = s.running;
  $("#phone-box").hidden = !s.running;
  if (s.error) deps.toast(`Phone access: ${s.error}`, "warn");
  if (!s.running) return;
  $("#phone-qr").innerHTML = s.qr;
  $("#phone-urls").innerHTML = s.urls.length ? s.urls.map((u) => `<div>${u}</div>`).join("") : "This PC isn't on a network right now.";
  $("#phone-code").textContent = s.code;
  const box = $("#phone-devices");
  box.innerHTML = "";
  if (!s.devices.length) box.innerHTML = `<span class="muted">None yet. Open the address on your phone (or scan the code) and enter the pairing code.</span>`;
  for (const d of s.devices) {
    const row = document.createElement("div");
    row.className = "d";
    row.innerHTML = `<span></span><small></small><button class="linkish" type="button">unpair</button>`;
    $("span", row).textContent = d.name;
    $("small", row).textContent = `paired ${when(d.added)} · last used ${when(d.lastSeen)}`;
    $("button", row).addEventListener("click", async () => show(await invoke<Status>("phone_forget", { id: d.id })));
    box.appendChild(row);
  }
}

/** Starts the phone server when it was left on (at launch). */
export async function initPhone(d: Deps) {
  deps = d;
  if (!inTauri) {
    ($("#phone-on") as HTMLInputElement).disabled = true;
    return;
  }
  $("#phone-on").addEventListener("change", async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    try {
      const s = await invoke<Status>(on ? "phone_start" : "phone_stop", on ? { port: deps.port() ?? null } : {});
      deps.setEnabled(on && s.running);
      show(s);
      if (on && s.running) deps.toast("Phone access is on. Open the address on your phone.");
    } catch (err) {
      deps.toast(`Phone access: ${errMsg(err)}`, "warn");
    }
  });
  $("#phone-new-code").addEventListener("click", async () => show(await invoke<Status>("phone_new_code")));
  listen("phone-paired", async () => {
    deps.toast("A phone was paired with Prestige.");
    show(await invoke<Status>("phone_status"));
  });
  if (deps.enabled()) show(await invoke<Status>("phone_start", { port: deps.port() ?? null }));
}

/** Settings opened: show the current state. */
export async function refreshPhone() {
  if (inTauri) show(await invoke<Status>("phone_status"));
}

export const phoneOn = () => running;
