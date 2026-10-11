// Setup: makes a Workstation from nothing, in Prestige (what install.ps1 did). Each step looks first and only does
// what's missing, so it also repairs a Workstation and is safe to run again. The steps: tools (winget), the
// Workstation's files (shipped inside Prestige, engine.rs; a git clone with an older Prestige), the GPU mode,
// llama.cpp, the Python environments, ComfyUI (Comfy Desktop's when it's there), the model packs picked (packs.rs),
// and one start of everything to check it works. Progress goes to the UI as "setup" events.

use crate::{engine, hidden, packs, prep, services};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicBool;
use tauri::AppHandle;
use tauri::{Emitter, Manager};

const WORKSTATION_REPO: &str = "https://github.com/Mr5elfDe5truct/custom-ai-workstation.git";
const KOKORO_REPO: &str = "https://github.com/remsky/Kokoro-FastAPI.git";
const KOKORO_COMMIT: &str = "b4ef64b1ce60682debda4fe0a066259e284eb1b4";

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Users\Public"))
}

/// PATH as Windows has it now (programs installed a moment ago included), so the next step finds them.
fn refresh_path() {
    let read = |key: &str| -> String {
        let out = hidden(&mut Command::new("reg")).args(["query", key, "/v", "Path"]).stdin(Stdio::null()).output().ok();
        let text = out.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
        text.lines()
            .find_map(|l| l.split_once("REG_EXPAND_SZ").or_else(|| l.split_once("REG_SZ")).map(|x| x.1.trim().to_string()))
            .unwrap_or_default()
    };
    let expand = |s: String| -> String {
        let mut out = s.clone();
        for (k, v) in std::env::vars() {
            out = out.replace(&format!("%{k}%"), &v).replace(&format!("%{}%", k.to_uppercase()), &v);
        }
        out
    };
    let machine = expand(read(r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment"));
    let user = expand(read(r"HKCU\Environment"));
    if machine.is_empty() && user.is_empty() {
        return;
    }
    let mut path = format!("{machine};{user}");
    for extra in [home().join(".local").join("bin"), packs::ollama_exe().parent().unwrap().to_path_buf()] {
        if extra.exists() && !path.to_lowercase().contains(&extra.to_string_lossy().to_lowercase()) {
            path.push(';');
            path.push_str(&extra.to_string_lossy());
        }
    }
    std::env::set_var("PATH", path);
}

fn runs(exe: &str, arg: &str) -> bool {
    hidden(&mut Command::new(exe)).arg(arg).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

struct Tool {
    id: &'static str,
    name: &'static str,
    have: fn() -> bool,
}

fn tools() -> Vec<Tool> {
    vec![
        Tool { id: "Microsoft.VCRedist.2015+.x64", name: "Visual C++ runtime", have: || Path::new(&std::env::var("windir").unwrap_or_else(|_| r"C:\Windows".into())).join("System32").join("vcruntime140_1.dll").exists() },
        Tool { id: "Git.Git", name: "Git", have: || runs("git", "--version") },
        Tool { id: "astral-sh.uv", name: "uv (Python environments)", have: || packs::uv_exe().exists() || runs("uv", "--version") },
        Tool { id: "OpenJS.NodeJS.LTS", name: "Node.js (tool servers)", have: || runs("node", "--version") },
        Tool { id: "Gyan.FFmpeg", name: "FFmpeg (audio and video)", have: || runs("ffmpeg", "-version") },
        Tool { id: "Ollama.Ollama", name: "Ollama", have: || packs::ollama_exe().exists() },
        Tool { id: "eSpeak-NG.eSpeak-NG", name: "eSpeak NG (voice)", have: || Path::new(r"C:\Program Files\eSpeak NG\libespeak-ng.dll").exists() },
    ]
}

/// The packs Setup suggests for this PC (as install.ps1 did).
fn suggested(ram_gb: f64, vram_gb: f64) -> Vec<&'static str> {
    let mut s = vec!["fast", "images"];
    if ram_gb >= 31.0 {
        s.push("main");
    }
    if vram_gb >= 8.0 {
        s.push("voice");
    }
    s
}

/// What Setup needs to know before it asks anything: this PC, where the Workstation would go and what's there already.
#[tauri::command]
pub async fn setup_probe(root: Option<String>) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        refresh_path();
        let default_root = home().join("RG Studios").join("Workstation");
        let root = root.filter(|r| !r.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| crate::stack_root(None));
        let gpus = prep::nvidia_gpus();
        let ram_gb = crate::sys_memory().ok().and_then(|m| m["total"].as_f64()).map(|m| (m / 1024.0).round()).unwrap_or(0.0);
        let vram = gpus.iter().map(prep::Gpu::gb).fold(0.0, f64::max);
        // A new folder doesn't exist yet: the free space is that of the nearest folder that does.
        let near = root.ancestors().find(|p| p.exists()).unwrap_or(&root);
        let free = crate::models::disk_free(near.to_string_lossy().into_owned()).unwrap_or(0);
        json!({
            "root": root,
            "defaultRoot": default_root,
            "found": root.join("start-all.ps1").exists(),
            "gpus": gpus.iter().map(|g| json!({ "index": g.index, "name": g.name, "gb": g.gb() })).collect::<Vec<_>>(),
            "ramGB": ram_gb,
            "freeBytes": free,
            "comfyDesktop": prep::find_comfy(&root).is_some_and(|(d, _)| !d.starts_with(&root)),
            "tools": tools().iter().map(|t| json!({ "name": t.name, "have": (t.have)() })).collect::<Vec<_>>(),
            "winget": runs("winget", "--version"),
            "bundled": engine::BUNDLED.get().is_some_and(|p| p.join("start-all.ps1").exists()),
            "suggested": suggested(ram_gb, vram),
            "packs": packs::catalog(12.0).iter().map(|p| json!({ "id": p.id, "title": p.title, "text": p.text, "gb": p.gb })).collect::<Vec<_>>(),
        })
    })
    .await
    .unwrap_or(json!({}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Opts {
    pub root: String,
    #[serde(default)]
    pub gpu_mode: Option<String>,
    #[serde(default)]
    pub packs: Vec<String>,
    /// Install ComfyUI into the Workstation even when Comfy Desktop is there.
    #[serde(default)]
    pub own_comfy: bool,
    /// Start everything once at the end to check it works.
    #[serde(default = "yes")]
    pub check: bool,
}
fn yes() -> bool {
    true
}

struct Run<'a> {
    app: &'a AppHandle,
    root: PathBuf,
    log: PathBuf,
    cancel: AtomicBool,
}

impl Run<'_> {
    fn emit(&self, step: &str, state: &str, text: &str) {
        let _ = self.app.emit("setup", json!({ "step": step, "state": state, "text": text }));
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&self.log) {
            use std::io::Write;
            let _ = writeln!(f, "[{step}] {state}: {text}");
        }
    }
    fn cmd(&self, dir: &Path, exe: &str, args: &[&str]) -> Result<(), String> {
        let exe = if exe == "uv" { packs::uv_exe() } else { PathBuf::from(exe) };
        packs::run_logged(dir, &exe, &packs::uv(args), &self.log, &self.cancel)
    }
    fn download(&self, step: &str, url: &str, dest: &Path) -> Result<(), String> {
        if dest.exists() {
            return Ok(());
        }
        let name = dest.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let mut last = 0u64;
        packs::fetch_resume(url, dest, &self.cancel, |d, t| {
            if d.saturating_sub(last) > 50_000_000 || d == t {
                last = d;
                self.emit(step, "running", &format!("downloading {name}: {:.1} of {:.1} GB", d as f64 / 1e9, t as f64 / 1e9));
            }
        })
    }
}

fn step_tools(r: &Run) -> Result<(), String> {
    let missing: Vec<Tool> = tools().into_iter().filter(|t| !(t.have)()).collect();
    if missing.is_empty() {
        r.emit("tools", "done", "all there");
        return Ok(());
    }
    if !runs("winget", "--version") {
        return Err("winget isn't on this PC: install \"App Installer\" from the Microsoft Store, then run Setup again".into());
    }
    for t in &missing {
        r.emit("tools", "running", &format!("installing {} (Windows may ask for permission)", t.name));
        let _ = r.cmd(&r.root, "winget", &["install", "--id", t.id, "-e", "--source", "winget", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"]);
        refresh_path();
        if !(t.have)() {
            return Err(format!("installing {} didn't work; install it yourself (winget install {}) and run Setup again", t.name, t.id));
        }
    }
    r.emit("tools", "done", &format!("installed {}", missing.iter().map(|t| t.name).collect::<Vec<_>>().join(", ")));
    Ok(())
}

fn step_files(r: &Run) -> Result<(), String> {
    let root = &r.root;
    if engine::install(root)? {
        r.emit("files", "done", "from Prestige");
    } else if root.join("start-all.ps1").exists() {
        r.emit("files", "done", "already here");
    } else {
        if root.exists() && fs::read_dir(root).map(|mut d| d.next().is_some()).unwrap_or(false) {
            return Err(format!("{} isn't empty; pick another folder", root.display()));
        }
        r.emit("files", "running", "downloading the Workstation");
        let parent = root.parent().unwrap_or(root);
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        r.cmd(parent, "git", &["clone", WORKSTATION_REPO, &root.to_string_lossy()])?;
        r.emit("files", "done", "downloaded");
    }
    for d in ["apps", "bin", "envs", "logs", "data", r"models\gguf", r"models\ollama", r"models\comfy"] {
        let _ = fs::create_dir_all(root.join(d));
    }
    // Prestige and install.ps1 look for the Workstation here when it isn't in the usual place.
    let rg = home().join("RG Studios");
    let _ = fs::create_dir_all(&rg);
    let _ = fs::write(rg.join("workstation-folder.txt"), root.to_string_lossy().as_bytes());
    Ok(())
}

fn step_gpu(r: &Run, mode: Option<&str>) -> Result<(), String> {
    let gpus = prep::nvidia_gpus();
    let Some(mode) = mode.filter(|_| gpus.len() > 1) else {
        r.emit("gpu", "done", &if gpus.is_empty() { "no NVIDIA GPU found".to_string() } else { format!("{} ({:.0} GB)", gpus[0].name, gpus[0].gb()) });
        return Ok(());
    };
    let file = r.root.join("data").join("gpu-settings.json");
    let mut cfg: Value = fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()).unwrap_or(json!({}));
    cfg["mode"] = json!(mode);
    fs::write(&file, serde_json::to_string_pretty(&cfg).unwrap()).map_err(|e| e.to_string())?;
    r.emit("gpu", "done", &format!("{mode} over {}", gpus.iter().map(|g| g.name.as_str()).collect::<Vec<_>>().join(" + ")));
    Ok(())
}

fn step_llama(r: &Run) -> Result<(), String> {
    let dir = r.root.join("bin").join("llama.cpp");
    if dir.join("llama-server.exe").exists() {
        r.emit("llama", "done", "already here");
        return Ok(());
    }
    let (tag, urls) = packs::llama_latest()?;
    for url in &urls {
        let zip = std::env::temp_dir().join(url.rsplit('/').next().unwrap_or("llama.zip"));
        r.download("llama", url, &zip)?;
        packs::unzip(&zip, &dir)?;
        let _ = fs::remove_file(&zip);
    }
    if !dir.join("llama-server.exe").exists() {
        return Err("llama.cpp didn't unpack as expected".into());
    }
    r.emit("llama", "done", &format!("{tag}, CUDA {} build", packs::cuda_tag()));
    Ok(())
}

fn venv(r: &Run, name: &str, python: &str, req: &str, extra: &[&str]) -> Result<bool, String> {
    let env = format!(r"envs\{name}");
    if r.root.join(&env).join("Scripts").join("python.exe").exists() {
        return Ok(false);
    }
    r.emit("python", "running", &format!("setting up {name}"));
    let _ = fs::remove_dir_all(r.root.join(&env));
    r.cmd(&r.root, "uv", &["venv", &env, "--python", python, "-q"])?;
    // Relative paths: uv splits --override values on spaces, as in "RG Studios".
    let mut args = vec!["pip", "install", "-p", env.as_str(), "-r", req];
    args.extend_from_slice(extra);
    args.push("-q");
    r.cmd(&r.root, "uv", &args)?;
    Ok(true)
}

fn step_python(r: &Run) -> Result<(), String> {
    r.emit("python", "running", "getting Python 3.11 and 3.12");
    r.cmd(&r.root, "uv", &["python", "install", "3.11", "3.12"])?;
    let mut made = Vec::new();
    if venv(r, "tools", "3.12", r"requirements\tools.txt", &[])? {
        made.push("tool server");
    }
    // Kokoro text-to-speech: the FastAPI server at the tested commit, its environment and voice model.
    let k = r.root.join("apps").join("Kokoro-FastAPI");
    if !k.join("api").exists() {
        r.emit("python", "running", "getting Kokoro");
        r.cmd(&r.root, "git", &["clone", KOKORO_REPO, r"apps\Kokoro-FastAPI", "-q"])?;
        r.cmd(&k, "git", &["checkout", "-q", KOKORO_COMMIT])?;
    }
    if venv(r, "kokoro", "3.12", r"requirements\kokoro.txt", &["--override", r"requirements\kokoro-overrides.txt", "--extra-index-url", "https://download.pytorch.org/whl/cpu", "--index-strategy", "unsafe-best-match"])? {
        r.cmd(&r.root, "uv", &["pip", "install", "-p", r"envs\kokoro", "--no-deps", "-e", r"apps\Kokoro-FastAPI", "-q"])?;
        made.push("Kokoro voice");
    }
    let voice = k.join("api").join("src").join("models").join("v1_0");
    r.download("python", "https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/kokoro-v1_0.pth", &voice.join("kokoro-v1_0.pth"))?;
    r.download("python", "https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/config.json", &voice.join("config.json"))?;
    r.emit("python", "done", &if made.is_empty() { "already here".to_string() } else { format!("set up {}", made.join(" and ")) });
    Ok(())
}

fn step_comfy(r: &Run, own: bool) -> Result<(), String> {
    let root = &r.root;
    let mine = root.join("apps").join("ComfyUI");
    let (dir, python) = match prep::find_comfy(root) {
        Some((d, py)) if !own || d.starts_with(root) => (d, py),
        _ => {
            if !mine.join("main.py").exists() {
                r.emit("comfyui", "running", "getting ComfyUI");
                r.cmd(root, "git", &["clone", "--depth", "1", "https://github.com/comfyanonymous/ComfyUI.git", r"apps\ComfyUI", "-q"])?;
            }
            let env = root.join("envs").join("comfyui");
            if !env.join("Scripts").join("python.exe").exists() {
                let index = if packs::cuda_tag() == "13.4" { "cu130" } else { "cu128" };
                r.emit("comfyui", "running", &format!("installing PyTorch for CUDA ({index}), about 3 GB"));
                r.cmd(root, "uv", &["venv", r"envs\comfyui", "--python", "3.12", "-q"])?;
                r.cmd(root, "uv", &["pip", "install", "-p", r"envs\comfyui", "torch", "torchvision", "torchaudio", "--index-url", &format!("https://download.pytorch.org/whl/{index}"), "-q"])?;
                r.cmd(root, "uv", &["pip", "install", "-p", r"envs\comfyui", "-r", r"apps\ComfyUI\requirements.txt", "-q"])?;
            }
            (mine.clone(), env.join("Scripts").join("python.exe"))
        }
    };
    let venv = python.parent().and_then(Path::parent).ok_or("bad ComfyUI python path")?.to_path_buf();
    // The custom nodes the workflows use: GGUF loaders (leejet's, with Qwen-Image-2.1) and KJNodes.
    for (name, url) in [("ComfyUI-GGUF", "https://github.com/leejet/ComfyUI-GGUF.git"), ("ComfyUI-KJNodes", "https://github.com/kijai/ComfyUI-KJNodes.git")] {
        let node = dir.join("custom_nodes").join(name);
        if node.join(".git").exists() {
            // city96's GGUF nodes, as older installs have them: switch to leejet's, which Qwen-Image-2.1 needs.
            let remote = hidden(&mut Command::new("git")).arg("-C").arg(&node).args(["remote", "get-url", "origin"]).output().ok();
            if remote.is_some_and(|o| String::from_utf8_lossy(&o.stdout).contains("city96")) {
                let n = node.to_string_lossy().into_owned();
                let _ = r.cmd(&dir, "git", &["-C", &n, "remote", "set-url", "origin", url]);
                let _ = r.cmd(&dir, "git", &["-C", &n, "pull", "-q", "--ff-only"]);
            }
            continue;
        }
        if node.exists() {
            continue;
        }
        r.emit("comfyui", "running", &format!("getting {name}"));
        r.cmd(&dir, "git", &["clone", "--depth", "1", url, &node.to_string_lossy(), "-q"])?;
        if node.join("requirements.txt").exists() {
            r.cmd(&dir, "uv", &["pip", "install", "-p", &venv.to_string_lossy(), "-r", &node.join("requirements.txt").to_string_lossy(), "-q"])?;
        }
    }
    r.emit("comfyui", "done", &if dir.starts_with(root) { "in the Workstation".to_string() } else { "using Comfy Desktop's".to_string() });
    Ok(())
}

fn step_packs(r: &Run, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        r.emit("packs", "done", "none picked (add them any time in Packs)");
        return Ok(());
    }
    for (i, id) in ids.iter().enumerate() {
        r.emit("packs", "running", &format!("{} of {}: {id}", i + 1, ids.len()));
        let cancel = packs::begin_job(r.app, id).ok_or_else(|| format!("{id} is already downloading"))?;
        let result = packs::run_pack(r.app, &r.root, id, &cancel);
        packs::end_job(r.app, id, &result);
        result?;
    }
    r.emit("packs", "done", &ids.join(", "));
    Ok(())
}

fn step_check(r: &Run) -> Result<(), String> {
    r.emit("check", "running", "starting everything once");
    services::start(&r.root, &[])?;
    let want: Vec<(String, u16)> = fs::read_to_string(r.root.join("data").join("runtime").join("services.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["services"].as_array().map(|a| a.iter().filter_map(|s| Some((s["name"].as_str()?.to_string(), s["port"].as_u64()? as u16))).collect()))
        .unwrap_or_default();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(240);
    loop {
        let down: Vec<&String> = want.iter().filter(|(_, p)| !services::listening(*p)).map(|(n, _)| n).collect();
        if down.is_empty() {
            r.emit("check", "done", &format!("all {} services answered", want.len()));
            return Ok(());
        }
        if std::time::Instant::now() > until {
            return Err(format!("these didn't start: {} (their logs are in the Workstation's logs folder)", down.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
}

/// Runs Setup in the background; "setup" events report each step, then { step: "all" }.
#[tauri::command]
pub fn setup_run(app: AppHandle, opts: Opts) -> Result<(), String> {
    let root = PathBuf::from(opts.root.trim());
    if !root.is_absolute() {
        return Err("pick a full folder path, like C:\\Users\\you\\RG Studios\\Workstation".into());
    }
    if root.to_string_lossy().to_lowercase().contains(r"\program files") {
        return Err("Program Files won't do: the services write logs, data and models into this folder".into());
    }
    let cancel = packs::begin_job(&app, "setup").ok_or("Setup is already running")?;
    drop(cancel);
    std::thread::spawn(move || {
        // The log goes straight into the Workstation, so it's there even when Setup stops or Prestige is closed midway.
        let _ = fs::create_dir_all(root.join("logs"));
        let log = root.join("logs").join("setup.log");
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&log) {
            use std::io::Write;
            let _ = writeln!(f, "\n==== Setup by Prestige {} ====", env!("CARGO_PKG_VERSION"));
        }
        let r = Run { app: &app, root: root.clone(), log, cancel: AtomicBool::new(false) };
        refresh_path();
        let result = (|| {
            step_tools(&r)?;
            step_files(&r)?;
            step_gpu(&r, opts.gpu_mode.as_deref())?;
            step_llama(&r)?;
            step_python(&r)?;
            step_comfy(&r, opts.own_comfy)?;
            step_packs(&r, &opts.packs)?;
            if opts.check {
                step_check(&r)?;
            } else {
                r.emit("check", "skipped", "not asked for");
            }
            Ok::<(), String>(())
        })();
        app.state::<packs::Jobs>().0.lock().unwrap().remove("setup");
        let _ = app.emit("setup", json!({ "step": "all", "state": if result.is_ok() { "done" } else { "failed" }, "text": result.err().unwrap_or_default(), "root": root }));
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn suggests_packs_for_the_pc() {
        assert_eq!(super::suggested(32.0, 12.0), ["fast", "images", "main", "voice"]);
        assert_eq!(super::suggested(16.0, 6.0), ["fast", "images"]);
    }
}
