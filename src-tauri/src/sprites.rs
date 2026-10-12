// Sprite sheets for characters: VNCCS (AHEKOT/ComfyUI_VNCCS, MIT) clones a character from one picture into full-body
// sprites in many poses on a transparent background, with Qwen-Image-2.1 and its Pose Studio LoRA. It runs in a ComfyUI of
// its own (apps\ComfyUI-VNCCS, on :8190) so its Python packages never touch the Workstation's ComfyUI. Its Pose Studio
// draws the poses in its web page while a job runs, so Prestige opens that page in a window of its own and drives it
// (sprites.ts); this file installs it, starts it, prepares the character and makes the sheet from the sprites.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::{hidden, stack_root};

pub(crate) const PORT: u16 = 8190;

#[derive(Default)]
pub struct Sprites {
    child: Mutex<Option<Child>>,
    setup: Mutex<Option<Setup>>,
}

#[derive(Clone, Serialize)]
struct Setup {
    stage: String, // running, done, failed
    pct: f64,
    line: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn dir(root: &Path) -> PathBuf {
    root.join("apps").join("ComfyUI-VNCCS")
}
fn python(root: &Path) -> PathBuf {
    dir(root).join("venv").join("Scripts").join("python.exe")
}

/// VNCCS's Qwen-Image-2.1 files (its control_center.json, QI2 entries): (repo, path in the repo, where it goes).
const MODELS: &[(&str, &str, &str)] = &[
    ("Comfy-Org/Qwen-Image-2.1", "diffusion_models/qwen_image_2.1_int8_convrot.safetensors", "models/diffusion_models/qwen_image_2.1_int8_convrot.safetensors"),
    ("Comfy-Org/Qwen-Image-2.1", "text_encoders/qwen3vl_8b_int8_convrot.safetensors", "models/text_encoders/qwen3vl_8b_int8_convrot.safetensors"),
    ("Comfy-Org/Qwen-Image-2.1", "vae/qwen_image_2.1_vae_bf16.safetensors", "models/vae/qwen_image_2.1_vae_bf16.safetensors"),
    ("MIUProject/VNCCS_v3.0", "models/loras/QI2.1/VNCCS/VNCCS_QI2_PoseStudioV1.1.safetensors", "models/loras/QI2.1/VNCCS/VNCCS_QI2_PoseStudioV1.1.safetensors"),
    ("MIUProject/VNCCS_v3.0", "models/loras/QI2.1/VNCCS/VNCCS_QI2_ClothesCoreV2.6.safetensors", "models/loras/QI2.1/VNCCS/VNCCS_QI2_ClothesCoreV2.6.safetensors"),
    ("MIUProject/VNCCS_v3.0", "models/loras/QI2.1/VNCCS/VNCCS_QI2_AnimeOverhaulV1.2.safetensors", "models/loras/QI2.1/VNCCS/VNCCS_QI2_AnimeOverhaulV1.2.safetensors"),
    ("Viggle/Qwen-Image-2.1-viggle-turbo", "Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r128.safetensors", "models/loras/QI2/Viggle/Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r128.safetensors"),
];

fn missing(root: &Path) -> Vec<&'static str> {
    MODELS.iter().filter(|m| !dir(root).join(m.2.replace('/', "\\")).exists()).map(|m| m.2.rsplit('/').next().unwrap()).collect()
}

fn listening() -> bool {
    std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], PORT).into(), std::time::Duration::from_millis(300)).is_ok()
}

/// A character's folder in VNCCS's output (data\comfy-output\VNCCS\Characters\<name>).
fn character_dir(root: &Path, name: &str) -> PathBuf {
    root.join("data").join("comfy-output").join("VNCCS").join("Characters").join(name)
}

/// A name VNCCS can use as a folder.
fn safe_name(name: &str) -> String {
    let s: String = name.trim().chars().filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_').collect();
    let s = s.trim().to_string();
    if s.is_empty() { "Character".into() } else { s.chars().take(40).collect() }
}

// ---------- commands ----------

#[tauri::command]
pub fn sprites_status(app: AppHandle, root: Option<String>) -> serde_json::Value {
    let root = stack_root(root);
    let installed = python(&root).exists() && dir(&root).join("custom_nodes").join("ComfyUI_VNCCS").exists();
    serde_json::json!({
        "installed": installed,
        "missing": missing(&root),
        "running": listening(),
        "setup": *app.state::<Sprites>().setup.lock().unwrap(),
    })
}

/// Starts VNCCS's ComfyUI if it isn't running, and waits for it (up to 3 minutes: the first start loads its nodes).
#[tauri::command]
pub async fn sprites_start(app: AppHandle, root: Option<String>) -> Result<(), String> {
    let root = stack_root(root);
    tauri::async_runtime::spawn_blocking(move || {
        if listening() {
            return Ok(());
        }
        if !python(&root).exists() {
            return Err("set up sprites first".to_string());
        }
        fs::create_dir_all(root.join("logs")).map_err(|e| e.to_string())?;
        let log = fs::File::create(root.join("logs").join("vnccs.log")).map_err(|e| e.to_string())?;
        let err = log.try_clone().map_err(|e| e.to_string())?;
        // --reserve-vram leaves room for the desktop and VNCCS's Pose Studio page on the same card: past the card's
        // memory the driver spills into system RAM and a 2-minute pose takes half an hour.
        let child = hidden(&mut Command::new(python(&root)))
            .args(["main.py", "--listen", "127.0.0.1", "--port", &PORT.to_string(), "--disable-smart-memory", "--reserve-vram", "2", "--output-directory"])
            .arg(root.join("data").join("comfy-output"))
            .current_dir(dir(&root))
            .env("PYTHONUTF8", "1")
            .stdin(Stdio::null())
            .stdout(log)
            .stderr(err)
            .spawn()
            .map_err(|e| format!("couldn't start VNCCS's ComfyUI: {e}"))?;
        *app.state::<Sprites>().child.lock().unwrap() = Some(child);
        for _ in 0..180 {
            if listening() {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        Err("VNCCS's ComfyUI didn't start (see logs\\vnccs.log)".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Closes VNCCS's window and stops its ComfyUI if Prestige started it (it holds VRAM the main ComfyUI needs).
#[tauri::command]
pub fn sprites_stop(app: AppHandle) {
    if let Some(w) = app.get_webview_window("vnccs") {
        let _ = w.destroy();
    }
    if let Some(mut c) = app.state::<Sprites>().child.lock().unwrap().take() {
        let _ = c.kill();
    }
}

/// Writes the character's VNCCS settings before it's picked in VNCCS: its name and sex, and no hair, eyes or body words
/// (VNCCS's defaults would steer every sprite away from the picture).
#[tauri::command]
pub fn sprites_character(root: Option<String>, name: String, sex: String) -> Result<String, String> {
    let root = stack_root(root);
    let name = safe_name(&name);
    let cdir = character_dir(&root, &name);
    fs::create_dir_all(&cdir).map_err(|e| e.to_string())?;
    let file = cdir.join(format!("{name}_config.json"));
    let mut config: serde_json::Value = fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| serde_json::json!({}));
    config["character_info"] = serde_json::json!({
        "name": name, "sex": if sex == "male" { "male" } else { "female" }, "age": 25, "race": "human", "skin_color": "",
        "hair": "", "eyes": "", "face": "", "body": "", "additional_details": "", "nsfw": false,
        "aesthetics": "masterpiece, best quality", "negative_prompt": "bad quality, worst quality", "lora_prompt": "",
        "background_color": "Green",
    });
    config["character_path"] = serde_json::json!(cdir.to_string_lossy());
    if config.get("config_version").is_none() {
        config["config_version"] = serde_json::json!("2.0");
    }
    fs::write(&file, serde_json::to_string_pretty(&config).unwrap()).map_err(|e| e.to_string())?;
    Ok(name)
}

/// Opens VNCCS in a window of Prestige's and runs `script` in it once its page has loaded (sprites.ts's driver).
#[tauri::command]
pub async fn sprites_window(app: AppHandle, script: String) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{PORT}/");
    if let Some(w) = app.get_webview_window("vnccs") {
        let _ = w.show();
        let _ = w.set_focus();
        // A reload starts the page fresh for the new job.
        w.eval(&format!("location.href = {}", serde_json::json!(url))).map_err(|e| e.to_string())?;
        std::thread::sleep(std::time::Duration::from_secs(3));
        return w.eval(&script).map_err(|e| e.to_string());
    }
    let w = WebviewWindowBuilder::new(&app, "vnccs", WebviewUrl::External(url.parse().unwrap()))
        .title("Prestige · Making sprites (VNCCS)")
        .inner_size(1400.0, 900.0)
        .initialization_script(&script)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = w.set_focus();
    Ok(())
}

/// The sprites VNCCS made for a character, as one transparent sheet (rows of up to 6, each sprite centred in its cell),
/// saved next to them so it's in Studio's gallery. Returns its path and how many sprites it has.
#[tauri::command]
pub async fn sprite_sheet(root: Option<String>, name: String, since: Option<u64>) -> Result<serde_json::Value, String> {
    let root = stack_root(root);
    tauri::async_runtime::spawn_blocking(move || {
        let name = safe_name(&name);
        let cdir = character_dir(&root, &name);
        let mut files = Vec::new();
        walk_pngs(&cdir.join("Sprites"), &mut files);
        // Only this run's sprites (earlier runs and costumes stay in their folders).
        if let Some(since) = since {
            let since = std::time::UNIX_EPOCH + std::time::Duration::from_millis(since);
            files.retain(|p| fs::metadata(p).and_then(|m| m.modified()).is_ok_and(|t| t >= since));
        }
        files.sort();
        if files.is_empty() {
            return Err(format!("VNCCS made no sprites for {name}"));
        }
        let imgs: Vec<image::RgbaImage> = files.iter().filter_map(|p| image::open(p).ok()).map(|i| i.to_rgba8()).collect();
        let (cw, ch) = imgs.iter().fold((0, 0), |(w, h), i| (w.max(i.width()), h.max(i.height())));
        let cols = imgs.len().min(6) as u32;
        let rows = (imgs.len() as u32).div_ceil(cols);
        let mut sheet = image::RgbaImage::new(cw * cols, ch * rows);
        for (k, img) in imgs.iter().enumerate() {
            let (c, r) = (k as u32 % cols, k as u32 / cols);
            let x = c * cw + (cw - img.width()) / 2;
            let y = r * ch + (ch - img.height()) / 2;
            image::imageops::overlay(&mut sheet, img, x as i64, y as i64);
        }
        let out = cdir.join(format!("{name}-sprite-sheet.png"));
        sheet.save(&out).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "path": out.to_string_lossy(), "count": imgs.len() }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How VNCCS's job is going: whether it's still queued or running, how many sprites it has saved since `since` (ms),
/// and its error if it failed.
#[tauri::command]
pub async fn sprites_progress(root: Option<String>, name: String, since: u64) -> serde_json::Value {
    let root = stack_root(root);
    tauri::async_runtime::spawn_blocking(move || {
        let get = |path: &str| -> Option<serde_json::Value> {
            ureq::get(&format!("http://127.0.0.1:{PORT}{path}")).timeout(std::time::Duration::from_secs(5)).call().ok()?.into_string().ok().and_then(|t| serde_json::from_str(&t).ok())
        };
        let busy = get("/queue").map(|q| {
            q["queue_running"].as_array().map_or(0, |a| a.len()) + q["queue_pending"].as_array().map_or(0, |a| a.len()) > 0
        });
        let error = get("/history?max_items=1").and_then(|h| {
            let job = h.as_object()?.values().next()?.clone();
            (job["status"]["status_str"] == "error").then(|| {
                job["status"]["messages"].as_array().into_iter().flatten()
                    .find(|m| m[0] == "execution_error")
                    .and_then(|m| m[1]["exception_message"].as_str().map(|s| s.trim().to_string()))
                    .unwrap_or_else(|| "VNCCS's job failed".into())
            })
        });
        let mut files = Vec::new();
        walk_pngs(&character_dir(&root, &safe_name(&name)).join("Sprites"), &mut files);
        let since = std::time::UNIX_EPOCH + std::time::Duration::from_millis(since);
        let done = files.iter().filter(|p| fs::metadata(p).and_then(|m| m.modified()).is_ok_and(|t| t >= since)).count();
        serde_json::json!({ "running": listening(), "busy": busy, "done": done, "error": error })
    })
    .await
    .unwrap_or_default()
}

fn walk_pngs(d: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(d).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_pngs(&p, out);
        } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("png")) {
            out.push(p);
        }
    }
}

/// Installs VNCCS's own ComfyUI in apps\ComfyUI-VNCCS: ComfyUI and the two VNCCS node packs (git), a Python 3.12
/// environment (uv) with CUDA PyTorch and their requirements, and VNCCS's Qwen-Image-2.1 files (~18 GB).
/// "sprites-setup" events follow it.
#[tauri::command]
pub fn sprites_setup(app: AppHandle, root: Option<String>) -> Result<(), String> {
    let root = stack_root(root);
    {
        let s = app.state::<Sprites>();
        let mut g = s.setup.lock().unwrap();
        if g.as_ref().is_some_and(|x| x.stage == "running") {
            return Err("already setting up".into());
        }
        *g = Some(Setup { stage: "running".into(), pct: 0.0, line: "Starting…".into(), error: None });
    }
    std::thread::spawn(move || {
        let step = |pct: f64, line: &str| {
            let s = app.state::<Sprites>();
            let mut g = s.setup.lock().unwrap();
            if let Some(x) = g.as_mut() {
                x.pct = pct;
                x.line = line.to_string();
                let _ = app.emit("sprites-setup", x.clone());
            }
        };
        let r = (|| -> Result<(), String> {
            let d = dir(&root);
            let run = |cmd: &mut Command, what: &str| -> Result<(), String> {
                let out = hidden(cmd).stdin(Stdio::null()).output().map_err(|e| format!("{what}: {e}"))?;
                if out.status.success() {
                    Ok(())
                } else {
                    Err(format!("{what} failed: {}", String::from_utf8_lossy(&out.stderr).lines().rev().take(2).collect::<Vec<_>>().join(" / ")))
                }
            };
            if !d.join("main.py").exists() {
                step(2.0, "Getting ComfyUI…");
                run(Command::new("git").args(["clone", "--depth", "1", "https://github.com/comfyanonymous/ComfyUI.git"]).arg(&d), "git clone ComfyUI")?;
            }
            for repo in ["ComfyUI_VNCCS", "ComfyUI_VNCCS_Utils"] {
                let to = d.join("custom_nodes").join(repo);
                if !to.exists() {
                    step(5.0, &format!("Getting {repo}…"));
                    run(Command::new("git").args(["clone", "--depth", "1", &format!("https://github.com/AHEKOT/{repo}.git")]).arg(&to), &format!("git clone {repo}"))?;
                }
            }
            if !python(&root).exists() {
                step(8.0, "Making its Python environment…");
                run(Command::new("uv").args(["venv", "venv", "--python", "3.12", "-q"]).current_dir(&d), "uv venv")?;
            }
            let py = python(&root).to_string_lossy().into_owned();
            let pip = |args: &[&str], what: &str| run(Command::new("uv").args(["pip", "install", "-p", &py, "-q"]).args(args).current_dir(&d), what);
            step(10.0, "Installing PyTorch (CUDA)…");
            pip(&["torch", "torchvision", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cu128"], "PyTorch")?;
            step(25.0, "Installing ComfyUI and VNCCS's packages…");
            pip(&["-r", "requirements.txt"], "ComfyUI's requirements")?;
            pip(&["-r", "custom_nodes/ComfyUI_VNCCS_Utils/requirements.txt"], "VNCCS-Utils' requirements")?;
            // llama-cpp-python (VNCCS's "Analyze captions") has no Windows build on PyPI: its own CUDA wheels.
            let req = fs::read_to_string(d.join("custom_nodes").join("ComfyUI_VNCCS").join("requirements.txt")).unwrap_or_default();
            let rest: Vec<&str> = req.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#') && !l.to_lowercase().starts_with("llama-cpp")).collect();
            pip(&rest, "VNCCS's requirements")?;
            let _ = pip(&["llama-cpp-python>=0.3.16", "--only-binary=:all:", "--extra-index-url", "https://abetlen.github.io/llama-cpp-python/whl/cu124"], "llama-cpp-python");
            // Its workflows, one click away in its Workflows panel.
            let wf = d.join("user").join("default").join("workflows");
            fs::create_dir_all(&wf).map_err(|e| e.to_string())?;
            for e in fs::read_dir(d.join("custom_nodes").join("ComfyUI_VNCCS").join("workflows")).into_iter().flatten().flatten() {
                if e.path().extension().is_some_and(|x| x == "json") {
                    let _ = fs::copy(e.path(), wf.join(e.file_name()));
                }
            }
            for (i, (repo, path, local)) in MODELS.iter().enumerate() {
                let dest = d.join(local.replace('/', "\\"));
                if dest.exists() {
                    continue;
                }
                let name = local.rsplit('/').next().unwrap();
                let base = 40.0 + 60.0 * i as f64 / MODELS.len() as f64;
                step(base, &format!("Downloading {name}…"));
                let cancel = std::sync::atomic::AtomicBool::new(false);
                crate::packs::fetch_resume(&format!("https://huggingface.co/{repo}/resolve/main/{path}"), &dest, &cancel, |done, total| {
                    if total > 0 {
                        step(base + 60.0 / MODELS.len() as f64 * done as f64 / total as f64, &format!("Downloading {name}… {} of {} MB", done >> 20, total >> 20));
                    }
                })?;
            }
            Ok(())
        })();
        let s = app.state::<Sprites>();
        let mut g = s.setup.lock().unwrap();
        if let Some(x) = g.as_mut() {
            match r {
                Ok(()) => {
                    x.stage = "done".into();
                    x.pct = 100.0;
                }
                Err(e) => {
                    x.stage = "failed".into();
                    x.error = Some(e);
                }
            }
            let _ = app.emit("sprites-setup", x.clone());
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_folder_safe() {
        assert_eq!(safe_name("  Mira O'Neil!! "), "Mira ONeil");
        assert_eq!(safe_name("../.."), "Character");
    }
}
