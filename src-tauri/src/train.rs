// Teach it a face or style: Fizgig (shootthesound/Fizgig, Apache-2.0) trains a Qwen-Image-2.1 LoRA from a handful of
// photos, headless, and the LoRA then shows up in Studio's image settings. Fizgig lives in apps\Fizgig with its own
// Python environment and its Qwen-Image-2.1 training weights (~47 GB); train_setup puts it there.
//
// A training is four steps, each Fizgig's own script: caption the photos with Qwen3-VL-4B (the trigger word first,
// then what's in each photo; a style's captions leave the style out so the trigger takes it), cache the latents,
// cache the text, then train with Fizgig's presets (0.5 MP, adamw8bit, EMA, its training adapter; INT8 on a 12 GB
// card). The finished LoRA is copied into ComfyUI's loras folder and listed in data\training\loras.json.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use crate::{hidden, stack_root};

const TAG: &str = "v7.3.0";
const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp"];
const MIN_PHOTOS: usize = 5;

const FACE_CAPTION: &str = "Write one factual training caption for this image as a single sentence, covering these in order: the subject and what they are doing; the camera viewpoint (e.g. 'viewed from behind', 'side profile', 'close-up') and whether the face is visible; their pose; their clothing; the setting; the lighting. Refer to the main subject only as 'the person', without a name. Start directly with the caption, with no preamble. State only what is visible: no speculation, no names, no style or quality commentary.";
/// A style's captions name what's in each picture and nothing about how it looks, so the look binds to the trigger.
const STYLE_CAPTION: &str = "Write one factual caption for this image as a single sentence that names what is in it: the subjects, what they are doing, the objects, the setting and the colours of the things themselves. Do not describe the medium, the art style, the brushwork, the texture, the colour grade, the lighting or the image quality. Start directly with the caption, with no preamble. No names.";

#[derive(Default)]
pub struct Train {
    job: Mutex<Option<Job>>,
    child: Mutex<Option<Child>>,
}

#[derive(Clone, Serialize)]
struct Job {
    name: String,
    trigger: String,
    kind: String,
    /// caption, latents, text, train, done, failed, stopped (or setup while installing Fizgig).
    stage: String,
    /// 0-100 within the whole job.
    pct: f64,
    line: String,
    started: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Lora {
    /// The file in ComfyUI's loras folder.
    pub file: String,
    pub name: String,
    pub trigger: String,
    pub kind: String,
    pub created: u64,
    pub photos: usize,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn fizgig(root: &Path) -> PathBuf {
    root.join("apps").join("Fizgig")
}
fn python(root: &Path) -> PathBuf {
    fizgig(root).join("venv").join("Scripts").join("python.exe")
}
fn models(root: &Path) -> PathBuf {
    fizgig(root).join("models")
}
const WEIGHTS: &[&str] = &[
    "qwen_image_2.1_bf16.safetensors",
    "qwen_image_2.1_vae_diffusers.safetensors",
    "qwen3vl_8b_bf16.safetensors",
    "fizgig_qwen_image_2.1_training_adapter.safetensors",
    "qwen3vl_4b_fp8_scaled.safetensors",
];

fn list_path(root: &Path) -> PathBuf {
    root.join("data").join("training").join("loras.json")
}

pub(crate) fn loras(root: &Path) -> Vec<Lora> {
    fs::read_to_string(list_path(root)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// A name as a folder and trigger word: lowercase letters, digits and underscores.
fn slug(name: &str) -> String {
    let s: String = name.trim().to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    let s = s.split('_').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("_");
    if s.is_empty() { "subject".into() } else { s.chars().take(40).collect() }
}

fn set(app: &AppHandle, f: impl FnOnce(&mut Job)) {
    let t = app.state::<Train>();
    let mut g = t.job.lock().unwrap();
    if let Some(j) = g.as_mut() {
        f(j);
        let _ = app.emit("train-progress", j.clone());
    }
}

/// Runs one of Fizgig's scripts, passing each output line to `on_line`; Err with the last lines when it fails.
fn run(app: &AppHandle, root: &Path, args: &[String], mut on_line: impl FnMut(&str)) -> Result<(), String> {
    let mut cmd = Command::new(python(root));
    hidden(&mut cmd)
        .args(args)
        .current_dir(fizgig(root))
        .env("PYTHONUTF8", "1")
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONPATH", fizgig(root).join("src"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start Fizgig: {e}"))?;
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    *app.state::<Train>().child.lock().unwrap() = Some(child);
    // stderr carries the progress bars; read both, splitting on \r too so a bar's updates arrive one by one.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    for stream in [Box::new(out) as Box<dyn std::io::Read + Send>, Box::new(err)] {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut r = BufReader::new(stream);
            let mut buf = Vec::new();
            while r.read_until(b'\n', &mut buf).map(|n| n > 0).unwrap_or(false) {
                for part in String::from_utf8_lossy(&buf).split('\r') {
                    let line = part.trim();
                    if !line.is_empty() {
                        let _ = tx.send(line.to_string());
                    }
                }
                buf.clear();
            }
        });
    }
    drop(tx);
    let mut tail: Vec<String> = Vec::new();
    for line in rx {
        on_line(&line);
        tail.push(line);
        if tail.len() > 12 {
            tail.remove(0);
        }
    }
    let status = app.state::<Train>().child.lock().unwrap().take().map(|mut c| c.wait());
    match status {
        Some(Ok(s)) if s.success() => Ok(()),
        Some(Ok(_)) | Some(Err(_)) => Err(tail.iter().rev().find(|l| l.contains("Error") || l.contains("FAIL")).cloned().unwrap_or_else(|| tail.join(" / "))),
        None => Err("stopped".into()),
    }
}

/// "12/40" style progress in a tqdm line, as a fraction.
fn fraction(line: &str) -> Option<f64> {
    let re_part = line.split_whitespace().find_map(|w| {
        let w = w.trim_matches(|c: char| !c.is_ascii_digit() && c != '/');
        let (a, b) = w.split_once('/')?;
        Some((a.parse::<f64>().ok()?, b.parse::<f64>().ok()?))
    });
    re_part.filter(|(_, b)| *b > 0.0).map(|(a, b)| (a / b).clamp(0.0, 1.0))
}

fn train_job(app: &AppHandle, root: &Path, dir: &Path, trigger: &str, kind: &str, epochs: u32) -> Result<PathBuf, String> {
    let m = models(root);
    let p = |x: &Path| x.to_string_lossy().replace('\\', "/");
    let images = dir.join("images");
    let toml = dir.join("dataset.toml");
    fs::write(
        &toml,
        format!(
            "[general]\nresolution = [704, 704]\ncaption_extension = \".txt\"\nbatch_size = 1\nnum_repeats = 1\nenable_bucket = true\nbucket_no_upscale = true\n\n[[datasets]]\nimage_directory = \"{}\"\ncache_directory = \"{}\"\n",
            p(&images),
            p(&dir.join("cache"))
        ),
    )
    .map_err(|e| e.to_string())?;
    let list: Vec<String> = fs::read_dir(&images).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).filter(|x| IMAGE_EXT.contains(&x.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str())).map(|x| x.to_string_lossy().into_owned()).collect();
    fs::write(dir.join("list.txt"), list.join("\n")).map_err(|e| e.to_string())?;
    fs::write(dir.join("caption.txt"), if kind == "style" { STYLE_CAPTION } else { FACE_CAPTION }).map_err(|e| e.to_string())?;
    let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let s = |x: PathBuf| x.to_string_lossy().into_owned();

    // 1. Captions (0-15 %).
    set(app, |j| j.stage = "caption".into());
    let mut args = a(&["src/fizgig/scripts/batch_caption.py", "--backend", "qwen", "--trigger", trigger]);
    args.extend([ "--text_encoder".into(), s(m.join("qwen3vl_4b_fp8_scaled.safetensors")), "--list_file".into(), s(dir.join("list.txt")), "--instruction_file".into(), s(dir.join("caption.txt"))]);
    run(app, root, &args, |l| {
        let pct = l.strip_prefix("PROGRESS:").and_then(|r| fraction(&r.trim().replace(' ', "/")));
        set(app, |j| {
            j.line = l.to_string();
            if let Some(f) = pct {
                j.pct = 15.0 * f;
            }
        });
    })?;
    // 2-3. The latent and text caches (15-25 %).
    set(app, |j| {
        j.stage = "latents".into();
        j.pct = 15.0;
    });
    let mut args = a(&["src/fizgig/families/cache.py", "--family", "qwen_image21", "--stage", "latents"]);
    args.extend(["--dataset_config".into(), s(toml.clone()), "--model".into(), s(m.join("qwen_image_2.1_vae_diffusers.safetensors"))]);
    run(app, root, &args, |l| set(app, |j| j.line = l.to_string()))?;
    set(app, |j| {
        j.stage = "text".into();
        j.pct = 18.0;
    });
    let mut args = a(&["src/fizgig/families/cache.py", "--family", "qwen_image21", "--stage", "text"]);
    args.extend(["--dataset_config".into(), s(toml.clone()), "--model".into(), s(m.join("qwen3vl_8b_bf16.safetensors"))]);
    run(app, root, &args, |l| set(app, |j| j.line = l.to_string()))?;

    // 4. Training (25-100 %): Fizgig's Fast preset for a face, its Style preset for a style.
    set(app, |j| {
        j.stage = "train".into();
        j.pct = 25.0;
    });
    let out = dir.join("out");
    let mut args = a(&["src/fizgig/families/train.py", "--family", "qwen_image21"]);
    args.extend([
        "--dataset_config".into(), s(toml),
        "--dit".into(), s(m.join("qwen_image_2.1_bf16.safetensors")),
        "--vae".into(), s(m.join("qwen_image_2.1_vae_diffusers.safetensors")),
        "--training_adapter".into(), s(m.join("fizgig_qwen_image_2.1_training_adapter.safetensors")),
        "--output_dir".into(), s(out.clone()),
        "--output_name".into(), trigger.into(),
        "--max_train_epochs".into(), epochs.to_string(),
        "--save_every_n_epochs".into(), epochs.to_string(),
    ]);
    args.extend(a(&["--seed", "42", "--optimizer_type", "adamw8bit", "--precision", "auto", "--blocks_to_swap", "-1", "--ema_decay", "0.98"]));
    if kind == "style" {
        args.extend(a(&["--network_dim", "16", "--network_alpha", "16", "--learning_rate", "1.5e-4"]));
    } else {
        args.extend(a(&["--network_dim", "8", "--network_alpha", "8", "--learning_rate", "1e-4", "--adaptive_lr", "--adaptive_lr_min", "2e-4", "--adaptive_lr_max", "4e-4"]));
    }
    run(app, root, &args, |l| {
        // The step bar ("steps: 37%|... 120/320") moves the job from 25 to 100 %.
        let f = (l.starts_with("steps") || l.contains("steps:")).then(|| fraction(l)).flatten();
        set(app, |j| {
            j.line = l.chars().take(160).collect();
            if let Some(f) = f {
                j.pct = 25.0 + 75.0 * f;
            }
        });
    })?;
    // The run's last save is the LoRA (Fizgig names it after --output_name).
    fs::read_dir(&out)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|x| x.extension().is_some_and(|e| e == "safetensors"))
        .max_by_key(|x| fs::metadata(x).and_then(|m| m.modified()).ok())
        .ok_or_else(|| "training finished without a LoRA file".to_string())
}

// ---------- commands ----------

/// Whether Fizgig and its weights are there, the job running (or the last one), and the LoRAs trained so far.
#[tauri::command]
pub fn train_status(app: AppHandle, root: Option<String>) -> serde_json::Value {
    let root = stack_root(root);
    let missing: Vec<&str> = WEIGHTS.iter().filter(|w| !models(&root).join(w).exists()).copied().collect();
    serde_json::json!({
        "installed": python(&root).exists(),
        "weights": missing.is_empty(),
        "missing": missing,
        "job": *app.state::<Train>().job.lock().unwrap(),
        "loras": loras(&root),
    })
}

/// Teaches Qwen-Image a face or a style from `photos`; "train-progress" events follow it, and the LoRA is listed
/// when it's done. One at a time.
#[tauri::command]
pub fn train_start(app: AppHandle, root: Option<String>, name: String, kind: String, photos: Vec<String>, epochs: Option<u32>) -> Result<String, String> {
    let root = stack_root(root);
    if !python(&root).exists() || WEIGHTS.iter().any(|w| !models(&root).join(w).exists()) {
        return Err("set up training first (Fizgig and its ~47 GB of Qwen-Image weights)".into());
    }
    let photos: Vec<PathBuf> = photos.into_iter().map(PathBuf::from).filter(|p| p.is_file() && IMAGE_EXT.contains(&p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str())).collect();
    if photos.len() < MIN_PHOTOS {
        return Err(format!("pick at least {MIN_PHOTOS} photos (10-30 is best)"));
    }
    let kind = if kind == "style" { "style" } else { "face" }.to_string();
    let trigger = slug(&name);
    {
        let t = app.state::<Train>();
        let mut g = t.job.lock().unwrap();
        if g.as_ref().is_some_and(|j| !matches!(j.stage.as_str(), "done" | "failed" | "stopped")) {
            return Err("a training is already running".into());
        }
        *g = Some(Job { name: name.trim().to_string(), trigger: trigger.clone(), kind: kind.clone(), stage: "caption".into(), pct: 0.0, line: String::new(), started: now_ms(), error: None });
    }
    // Its own folder, with copies of the photos (the captions are written beside them).
    let dir = root.join("data").join("training").join(format!("{trigger}-{}", now_ms() / 1000));
    let images = dir.join("images");
    fs::create_dir_all(&images).map_err(|e| e.to_string())?;
    for (i, p) in photos.iter().enumerate() {
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("png").to_ascii_lowercase();
        fs::copy(p, images.join(format!("{i:03}.{ext}"))).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    let n = photos.len();
    let epochs = epochs.unwrap_or(if kind == "style" { 20 } else { 30 }).clamp(1, 100);
    let answer = trigger.clone();
    std::thread::spawn(move || {
        let r = train_job(&app, &root, &dir, &trigger, &kind, epochs);
        let r = r.and_then(|lora| {
            let loras_dir = root.join("models").join("comfy").join("loras");
            fs::create_dir_all(&loras_dir).map_err(|e| e.to_string())?;
            let file = format!("prestige-{trigger}.safetensors");
            fs::copy(&lora, loras_dir.join(&file)).map_err(|e| e.to_string())?;
            let mut all = loras(&root);
            all.retain(|l| l.file != file);
            all.insert(0, Lora { file, name: app.state::<Train>().job.lock().unwrap().as_ref().map(|j| j.name.clone()).unwrap_or_default(), trigger: trigger.clone(), kind: kind.clone(), created: now_ms(), photos: n });
            fs::write(list_path(&root), serde_json::to_string_pretty(&all).unwrap()).map_err(|e| e.to_string())
        });
        set(&app, |j| match r {
            Ok(()) => {
                j.stage = "done".into();
                j.pct = 100.0;
            }
            Err(e) => {
                j.stage = if e == "stopped" { "stopped" } else { "failed" }.into();
                j.error = Some(e);
            }
        });
    });
    Ok(answer)
}

/// Photos picked from the PC.
#[tauri::command]
pub async fn train_pick(app: AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let picked: Vec<PathBuf> = app
            .dialog()
            .file()
            .add_filter("Photos", IMAGE_EXT)
            .set_title("Photos to learn from")
            .blocking_pick_files()
            .map(|v| v.into_iter().filter_map(|p| p.into_path().ok()).collect())
            .unwrap_or_default();
        // The window shows them as thumbnails.
        for p in &picked {
            let _ = app.asset_protocol_scope().allow_file(p);
        }
        picked.iter().map(|p| p.to_string_lossy().into_owned()).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Stops the running training (its step is lost; the photos and captions stay for a retry).
#[tauri::command]
pub fn train_stop(app: AppHandle) {
    if let Some(mut c) = app.state::<Train>().child.lock().unwrap().take() {
        let _ = c.kill();
    }
}

/// Puts Fizgig in apps\Fizgig (its source from GitHub, then its own installer) and downloads its Qwen-Image-2.1
/// training weights; "train-progress" events with stage "setup" follow it.
#[tauri::command]
pub fn train_setup(app: AppHandle, root: Option<String>) -> Result<(), String> {
    let root = stack_root(root);
    {
        let t = app.state::<Train>();
        let mut g = t.job.lock().unwrap();
        if g.as_ref().is_some_and(|j| !matches!(j.stage.as_str(), "done" | "failed" | "stopped")) {
            return Err("training is busy".into());
        }
        *g = Some(Job { name: "Setting up training".into(), trigger: String::new(), kind: String::new(), stage: "setup".into(), pct: 0.0, line: String::new(), started: now_ms(), error: None });
    }
    std::thread::spawn(move || {
        let r = (|| -> Result<(), String> {
            let dir = fizgig(&root);
            if !dir.join("install_fizgig.py").exists() {
                set(&app, |j| j.line = format!("Downloading Fizgig {TAG}…"));
                let zip = root.join("apps").join(format!("Fizgig-{TAG}.zip"));
                fs::create_dir_all(root.join("apps")).map_err(|e| e.to_string())?;
                let mut res = ureq::get(&format!("https://github.com/shootthesound/Fizgig/archive/refs/tags/{TAG}.zip")).call().map_err(|e| e.to_string())?.into_reader();
                let mut f = fs::File::create(&zip).map_err(|e| e.to_string())?;
                std::io::copy(&mut res, &mut f).map_err(|e| e.to_string())?;
                let mut a = zip::ZipArchive::new(fs::File::open(&zip).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                // The archive's files sit under Fizgig-<version>\; they go straight into apps\Fizgig.
                for i in 0..a.len() {
                    let mut e = a.by_index(i).map_err(|e| e.to_string())?;
                    let Some(rel) = e.enclosed_name() else { continue };
                    let rel: PathBuf = rel.components().skip(1).collect();
                    if rel.as_os_str().is_empty() {
                        continue;
                    }
                    let to = dir.join(rel);
                    if e.is_dir() {
                        fs::create_dir_all(&to).map_err(|e| e.to_string())?;
                    } else {
                        if let Some(p) = to.parent() {
                            fs::create_dir_all(p).map_err(|e| e.to_string())?;
                        }
                        std::io::copy(&mut e, &mut fs::File::create(&to).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                    }
                }
                let _ = fs::remove_file(&zip);
            }
            set(&app, |j| {
                j.pct = 5.0;
                j.line = "Installing Fizgig's Python environment (PyTorch and the rest, ~10 GB)…".into();
            });
            if !python(&root).exists() {
                // Its installer wants a Python 3.10-3.13 on PATH; uv provides one if there isn't.
                let py = Command::new("uv").args(["python", "find", "3.12"]).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_else(|| "python".into());
                let out = hidden(&mut Command::new(py)).arg("install_fizgig.py").current_dir(&dir).env("DISABLE_CUDA", "1").env("PYTHONUTF8", "1").stdin(Stdio::null()).output().map_err(|e| format!("couldn't run Fizgig's installer: {e}"))?;
                if !python(&root).exists() {
                    return Err(format!("Fizgig's installer failed: {}", String::from_utf8_lossy(&out.stdout).lines().rev().take(3).collect::<Vec<_>>().join(" / ")));
                }
            }
            set(&app, |j| {
                j.pct = 20.0;
                j.line = "Downloading the Qwen-Image-2.1 training weights (~47 GB)…".into();
            });
            run(&app, &root, &["-m".into(), "fizgig.scripts.fetch_models".into(), "--family".into(), "qwen_image21".into(), "--progress".into()], |l| {
                // "[progress] done total name"
                let f = l.strip_prefix("[progress]").and_then(|r| {
                    let mut it = r.split_whitespace();
                    let (a, b) = (it.next()?.parse::<f64>().ok()?, it.next()?.parse::<f64>().ok()?);
                    (b > 0.0).then(|| a / b)
                });
                set(&app, |j| {
                    j.line = l.chars().take(160).collect();
                    if let Some(f) = f {
                        j.pct = 20.0 + 80.0 * f;
                    }
                });
            })
        })();
        set(&app, |j| match r {
            Ok(()) => {
                j.stage = "done".into();
                j.pct = 100.0;
            }
            Err(e) => {
                j.stage = "failed".into();
                j.error = Some(e);
            }
        });
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_become_trigger_words() {
        assert_eq!(slug("  Mira Okafor "), "mira_okafor");
        assert_eq!(slug("Neon Noir!!"), "neon_noir");
        assert_eq!(slug("??"), "subject");
    }

    #[test]
    fn progress_bars_are_read() {
        assert_eq!(fraction("steps:  37%|###    | 120/320 [02:10<03:40, 1.1s/it]"), Some(0.375));
        assert_eq!(fraction("no numbers here"), None);
        assert_eq!(fraction("PROGRESS 3/8"), Some(0.375));
    }
}
