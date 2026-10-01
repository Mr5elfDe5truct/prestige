// Prestige by R.G. Studios. Native side: GPU and RAM readouts, local chat history and settings,
// launching the workstation's start-all.ps1, and the Studio gallery (studio.rs). All chat traffic goes from the UI to
// Ollama / llama.cpp / Open WebUI on 127.0.0.1 through the HTTP plugin.

mod studio;

use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Where the workstation lives unless the user picks another folder in Settings.
const DEFAULT_STACK_ROOT: &str = r"C:\Projects\Workspaces\Claude\Custom AI";

pub(crate) fn stack_root(root: Option<String>) -> PathBuf {
    match root {
        Some(r) if !r.trim().is_empty() => PathBuf::from(r.trim()),
        _ => PathBuf::from(DEFAULT_STACK_ROOT),
    }
}

/// Runs one of the stack's PowerShell scripts hidden and detached, so it keeps going after Prestige exits.
fn run_script(root: &PathBuf, name: &str, args: &[&str]) -> Result<(), String> {
    let script = root.join(name);
    if !script.exists() {
        return Err(format!("{name} not found in {}", root.display()));
    }
    hidden(&mut Command::new("powershell.exe"))
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run {name}: {e}"))?;
    Ok(())
}

#[derive(Serialize)]
struct GpuStats {
    name: String,
    util: f64,
    mem_used: f64,
    mem_total: f64,
    temp: f64,
    fan: Option<f64>,
    power: Option<f64>,
    power_limit: Option<f64>,
    slowdown_temp: Option<f64>,
    target_temp: Option<f64>,
}

/// The GPU's throttle points don't change, so read them from `nvidia-smi -q` once.
fn throttle_temps() -> (Option<f64>, Option<f64>) {
    static CACHE: std::sync::OnceLock<(Option<f64>, Option<f64>)> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| {
        let Ok(out) = hidden(&mut Command::new("nvidia-smi")).args(["-q", "-d", "TEMPERATURE"]).output() else {
            return (None, None);
        };
        let text = String::from_utf8_lossy(&out.stdout);
        let find = |label: &str| {
            text.lines()
                .find(|l| l.trim_start().starts_with(label))
                .and_then(|l| l.split(':').nth(1))
                .and_then(|v| v.trim().trim_end_matches('C').trim().parse::<f64>().ok())
        };
        (find("GPU Slowdown Temp"), find("GPU Target Temperature"))
    })
}

#[tauri::command]
fn gpu_stats() -> Result<GpuStats, String> {
    let out = hidden(&mut Command::new("nvidia-smi"))
        .args([
            "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,fan.speed,power.draw,power.limit",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .map_err(|e| format!("nvidia-smi: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next().ok_or("nvidia-smi returned nothing")?;
    let f: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
    if f.len() < 5 {
        return Err(format!("unexpected nvidia-smi output: {line}"));
    }
    let num = |s: &str| s.parse::<f64>().unwrap_or(0.0);
    let opt = |i: usize| f.get(i).and_then(|s| s.parse::<f64>().ok());
    let (slowdown_temp, target_temp) = throttle_temps();
    Ok(GpuStats {
        name: f[0].to_string(),
        util: num(f[1]),
        mem_used: num(f[2]),
        mem_total: num(f[3]),
        temp: num(f[4]),
        fan: opt(5),
        power: opt(6),
        power_limit: opt(7),
        slowdown_temp,
        target_temp,
    })
}

/// Total and available system RAM in MiB.
#[tauri::command]
fn sys_memory() -> Result<serde_json::Value, String> {
    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(buf: *mut MemoryStatusEx) -> i32;
    }
    let mut m: MemoryStatusEx = unsafe { std::mem::zeroed() };
    m.length = std::mem::size_of::<MemoryStatusEx>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut m) } == 0 {
        return Err("GlobalMemoryStatusEx failed".into());
    }
    let mib = |b: u64| b as f64 / 1_048_576.0;
    Ok(serde_json::json!({ "total": mib(m.total_phys), "avail": mib(m.avail_phys) }))
}

/// Sizes in bytes of model files (llama.cpp's GGUFs), 0 when missing.
#[tauri::command]
fn file_sizes(paths: Vec<String>) -> Vec<u64> {
    paths.iter().map(|p| fs::metadata(p).map(|m| m.len()).unwrap_or(0)).collect()
}

#[tauri::command]
fn stack_info(root: Option<String>) -> serde_json::Value {
    let root = stack_root(root);
    serde_json::json!({
        "root": root.to_string_lossy(),
        "default": DEFAULT_STACK_ROOT,
        "startScript": root.join("start-all.ps1").exists(),
        "stopScript": root.join("stop-all.ps1").exists(),
    })
}

/// Runs the stack's start-all.ps1 without opening Open WebUI's window.
#[tauri::command]
fn start_services(root: Option<String>) -> Result<(), String> {
    run_script(&stack_root(root), "start-all.ps1", &["-NoBrowser"])
}

#[tauri::command]
fn stop_services(root: Option<String>) -> Result<(), String> {
    run_script(&stack_root(root), "stop-all.ps1", &[])
}

/// Like open-app.ps1: closing the window shuts the workstation down, unless "keep running" is on.
fn stop_on_close(app: &AppHandle) {
    let settings = read_settings(app);
    if settings["keepRunning"].as_bool().unwrap_or(false) {
        return;
    }
    let root = settings["stackRoot"].as_str().map(String::from);
    let _ = run_script(&stack_root(root), "stop-all.ps1", &[]);
}

// ---------- local storage in the app data folder ----------

pub(crate) fn data_dir(app: &AppHandle, sub: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(sub);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn safe_id(id: &str) -> Result<&str, String> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(id)
    } else {
        Err("invalid chat id".into())
    }
}

/// Summaries of saved chats, newest first.
#[tauri::command]
fn list_chats(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let dir = data_dir(&app, "chats")?;
    let mut items = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        items.push(serde_json::json!({
            "id": v["id"], "title": v["title"], "updated": v["updated"], "model": v["model"],
        }));
    }
    items.sort_by(|a, b| b["updated"].as_f64().unwrap_or(0.0).total_cmp(&a["updated"].as_f64().unwrap_or(0.0)));
    Ok(items)
}

#[tauri::command]
fn load_chat(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    let path = data_dir(&app, "chats")?.join(format!("{}.json", safe_id(&id)?));
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_chat(app: AppHandle, id: String, chat: serde_json::Value) -> Result<(), String> {
    let path = data_dir(&app, "chats")?.join(format!("{}.json", safe_id(&id)?));
    let text = serde_json::to_string_pretty(&chat).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_chat(app: AppHandle, id: String) -> Result<(), String> {
    let path = data_dir(&app, "chats")?.join(format!("{}.json", safe_id(&id)?));
    fs::remove_file(path).map_err(|e| e.to_string())
}

fn read_settings(app: &AppHandle) -> serde_json::Value {
    data_dir(app, "")
        .ok()
        .and_then(|d| fs::read_to_string(d.join("settings.json")).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::json!({}))
}

#[tauri::command]
fn get_settings(app: AppHandle) -> serde_json::Value {
    read_settings(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let path = data_dir(&app, "")?.join("settings.json");
    fs::write(path, serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // One window only: launching again focuses it (two windows would each stop the stack on close).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_http::init())
        // Voice and webcam: Prestige's own page may use the mic and camera without WebView2 asking every time.
        .on_permission_request(|_, kind| {
            use tauri::webview::{PermissionKind, PermissionResponse};
            match kind {
                PermissionKind::Microphone | PermissionKind::Camera => PermissionResponse::Allow,
                _ => PermissionResponse::Default,
            }
        })
        .manage(studio::GalleryCache::default())
        .manage(studio::ComfyListener::default())
        .invoke_handler(tauri::generate_handler![
            gpu_stats,
            stack_info,
            start_services,
            stop_services,
            list_chats,
            load_chat,
            save_chat,
            delete_chat,
            get_settings,
            save_settings,
            sys_memory,
            file_sizes,
            studio::gallery_list,
            studio::thumbnail,
            studio::reveal,
            studio::read_workflow,
            studio::comfy_listen,
            studio::comfy_upload
        ])
        .build(tauri::generate_context!())
        .expect("error while building Prestige")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_on_close(app);
            }
        });
}
