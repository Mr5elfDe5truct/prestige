// Prestige by R.G. Studios. Native side: GPU (every card) and RAM readouts, the workstation's GPU plan, local chat history and settings,
// launching the workstation's start-all.ps1, and the Studio gallery (studio.rs). All chat traffic goes from the UI to
// Ollama / llama.cpp / Open WebUI on 127.0.0.1 through the HTTP plugin.

mod canvas;
mod computer;
mod knowledge;
mod models;
mod phone;
mod toolstore;
mod vram;
mod transcribe;
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

/// Where the workstation lives unless the user picks another folder in Settings:
/// %USERPROFILE%\RG Studios\Workstation, next to the other R.G. Studios apps, or else the folder
/// install.ps1 last installed it in (it writes that to %USERPROFILE%\RG Studios\workstation-folder.txt).
fn default_stack_root() -> PathBuf {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Users\Public"));
    let rg = home.join("RG Studios");
    let usual = rg.join("Workstation");
    if usual.join("start-all.ps1").exists() {
        return usual;
    }
    fs::read_to_string(rg.join("workstation-folder.txt"))
        .ok()
        .map(|t| PathBuf::from(t.trim_start_matches('\u{feff}').trim()))
        .filter(|p| p.join("start-all.ps1").exists())
        .unwrap_or(usual)
}

pub(crate) fn stack_root(root: Option<String>) -> PathBuf {
    match root {
        Some(r) if !r.trim().is_empty() => PathBuf::from(r.trim()),
        _ => default_stack_root(),
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
    index: u32,
    uuid: String,
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

/// Each GPU's throttle points (in nvidia-smi's order) don't change, so read them from `nvidia-smi -q` once.
fn throttle_temps() -> &'static Vec<(Option<f64>, Option<f64>)> {
    static CACHE: std::sync::OnceLock<Vec<(Option<f64>, Option<f64>)>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        let Ok(out) = hidden(&mut Command::new("nvidia-smi")).args(["-q", "-d", "TEMPERATURE"]).output() else {
            return Vec::new();
        };
        let text = String::from_utf8_lossy(&out.stdout);
        let value = |l: &str| l.split(':').nth(1).and_then(|v| v.trim().trim_end_matches('C').trim().parse::<f64>().ok());
        // One "GPU 00000000:2B:00.0" section per card.
        let mut cards = Vec::new();
        for l in text.lines() {
            let t = l.trim_start();
            if t.starts_with("GPU 0") {
                cards.push((None, None));
            } else if let Some(c) = cards.last_mut() {
                if t.starts_with("GPU Slowdown Temp") {
                    c.0 = value(t);
                } else if t.starts_with("GPU Target Temperature") {
                    c.1 = value(t);
                }
            }
        }
        cards
    })
}

/// Every NVIDIA card, in nvidia-smi's order (the index the workstation's GPU plan uses).
#[tauri::command]
fn gpu_stats() -> Result<Vec<GpuStats>, String> {
    let out = hidden(&mut Command::new("nvidia-smi"))
        .args([
            "--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,fan.speed,power.draw,power.limit",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .map_err(|e| format!("nvidia-smi: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let throttle = throttle_temps();
    let mut gpus = Vec::new();
    for (i, line) in text.lines().filter(|l| !l.trim().is_empty()).enumerate() {
        let f: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        if f.len() < 7 {
            return Err(format!("unexpected nvidia-smi output: {line}"));
        }
        let num = |s: &str| s.parse::<f64>().unwrap_or(0.0);
        let opt = |i: usize| f.get(i).and_then(|s| s.parse::<f64>().ok());
        let (slowdown_temp, target_temp) = throttle.get(i).copied().unwrap_or((None, None));
        gpus.push(GpuStats {
            index: f[0].parse().unwrap_or(i as u32),
            uuid: f[1].to_string(),
            name: f[2].to_string(),
            util: num(f[3]),
            mem_used: num(f[4]),
            mem_total: num(f[5]),
            temp: num(f[6]),
            fan: opt(7),
            power: opt(8),
            power_limit: opt(9),
            slowdown_temp,
            target_temp,
        });
    }
    if gpus.is_empty() {
        return Err("nvidia-smi returned nothing".into());
    }
    Ok(gpus)
}

/// What each process holds in each card's VRAM, measured (Windows' GPU counters; nvidia-smi can't say per process on
/// Windows), largest first, with nvidia-smi's card numbers. Empty when the counters aren't there.
#[tauri::command]
async fn gpu_procs() -> Result<Vec<vram::ProcVram>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let cards: Vec<(u32, String, f64)> = gpu_stats()?.into_iter().map(|g| (g.index, g.name, g.mem_total)).collect();
        Ok(vram::per_process(&cards))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Which card each workstation service runs on: data\runtime\gpu.json, written by start-all.ps1 on every start.
/// Null with an older workstation, or before it has started once.
#[tauri::command]
fn gpu_plan(root: Option<String>) -> Option<serde_json::Value> {
    let text = fs::read_to_string(stack_root(root).join("data").join("runtime").join("gpu.json")).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
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
        "default": default_stack_root().to_string_lossy(),
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

/// Set while an update installs: the installer closes Prestige and starts the new version straight
/// away, so stopping the AI stack in between would only make it start again.
static UPDATING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn set_updating(on: bool) {
    UPDATING.store(on, std::sync::atomic::Ordering::SeqCst);
}

/// Like open-app.ps1: closing the window shuts the workstation down, unless "keep running" is on.
fn stop_on_close(app: &AppHandle) {
    if UPDATING.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
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

/// For the phone page (phone.rs): the same chat list and chat files the app uses.
pub(crate) fn chat_list(app: &AppHandle) -> Result<Vec<serde_json::Value>, String> {
    list_chats(app.clone())
}

pub(crate) fn chat_load(app: &AppHandle, id: String) -> Result<serde_json::Value, String> {
    load_chat(app.clone(), id)
}

/// A piece of `text` around byte offset `at`, about `width` characters long, on one line.
fn snippet(text: &str, at: usize, width: usize) -> String {
    let before = width / 3;
    let start = text[..at].char_indices().rev().nth(before).map(|(i, _)| i).unwrap_or(0);
    let end = text[at..].char_indices().nth(width - before).map(|(i, _)| at + i).unwrap_or(text.len());
    let mut s = text[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    if start > 0 {
        s.insert(0, '…');
    }
    if end < text.len() {
        s.push('…');
    }
    s
}

/// Where `term` (already lowercase) first appears in `text`, as a byte offset into `text`.
fn find_ci(text: &str, term: &str) -> Option<usize> {
    // Lowercase one character at a time, remembering where each lowercase byte came from: lowercasing can
    // change byte lengths (and even the number of characters) outside ASCII.
    let mut lower = String::with_capacity(text.len());
    let mut origin = Vec::with_capacity(text.len());
    for (b, c) in text.char_indices() {
        for l in c.to_lowercase() {
            lower.push(l);
            origin.resize(lower.len(), b);
        }
    }
    lower.find(term).map(|i| origin[i])
}

/// Saved chats containing every word of `query` (in the title or any message), newest first,
/// each with a snippet from the best-matching message and that message's index.
#[tauri::command]
fn search_chats(app: AppHandle, query: String, exclude: Option<String>, width: Option<usize>) -> Result<Vec<serde_json::Value>, String> {
    let terms: Vec<String> = query.to_lowercase().split_whitespace().map(String::from).collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let width = width.unwrap_or(140).clamp(40, 1200);
    let dir = data_dir(&app, "chats")?;
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        if exclude.as_deref().is_some_and(|x| v["id"].as_str() == Some(x)) {
            continue;
        }
        let title = v["title"].as_str().unwrap_or("");
        let msgs: Vec<&str> = v["messages"]
            .as_array()
            .map(|a| a.iter().map(|m| m["content"].as_str().unwrap_or("")).collect())
            .unwrap_or_default();
        let all = format!("{}\n{}", title, msgs.join("\n")).to_lowercase();
        if !terms.iter().all(|t| all.contains(t.as_str())) {
            continue;
        }
        // The message with the most of the words wins; ties go to the earliest.
        let mut best: Option<(usize, usize, usize)> = None; // (words found, message index, byte offset)
        let mut hits = 0;
        for (i, m) in msgs.iter().enumerate() {
            let found: Vec<usize> = terms.iter().filter_map(|t| find_ci(m, t)).collect();
            if found.is_empty() {
                continue;
            }
            hits += 1;
            if best.map_or(true, |b| found.len() > b.0) {
                best = Some((found.len(), i, *found.iter().min().unwrap()));
            }
        }
        let (index, snip) = match best {
            Some((_, i, at)) => (Some(i), snippet(msgs[i], at, width)),
            None => (None, String::new()),
        };
        out.push(serde_json::json!({
            "id": v["id"], "title": v["title"], "updated": v["updated"], "model": v["model"],
            "hits": hits, "index": index, "snippet": snip,
            "role": index.and_then(|i| v["messages"][i]["role"].as_str()),
        }));
    }
    out.sort_by(|a, b| b["updated"].as_f64().unwrap_or(0.0).total_cmp(&a["updated"].as_f64().unwrap_or(0.0)));
    out.truncate(50);
    Ok(out)
}

/// Small JSON documents kept in the app data folder's store\ (characters, …), by a plain name.
fn store_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.len() > 40 || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err("invalid store name".into());
    }
    Ok(data_dir(app, "store")?.join(format!("{name}.json")))
}

#[tauri::command]
fn store_get(app: AppHandle, name: String) -> Result<serde_json::Value, String> {
    let text = fs::read_to_string(store_path(&app, &name)?).unwrap_or_default();
    Ok(serde_json::from_str(&text).unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
fn store_set(app: AppHandle, name: String, value: serde_json::Value) -> Result<(), String> {
    let path = store_path(&app, &name)?;
    // Written next to it first, so a crash mid-write can't leave half a file.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string(&value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub(crate) fn read_settings(app: &AppHandle) -> serde_json::Value {
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        // "Your render is done" while Prestige is in the background (the render queue).
        .plugin(tauri_plugin_notification::init())
        // Voice and webcam: Prestige's own page may use the mic and camera without WebView2 asking every time.
        .on_permission_request(|_, kind| {
            use tauri::webview::{PermissionKind, PermissionResponse};
            match kind {
                PermissionKind::Microphone | PermissionKind::Camera => PermissionResponse::Allow,
                _ => PermissionResponse::Default,
            }
        })
        // The Canvas: pages the chat model wrote, on their own origin (canvas.rs).
        .register_uri_scheme_protocol("canvas", canvas::serve)
        .manage(canvas::Canvases::default())
        .manage(studio::GalleryCache::default())
        .manage(models::GgufCache::default())
        .manage(models::Downloads::default())
        .manage(studio::ComfyListener::default())
        .manage(knowledge::Knowledge::default())
        .manage(phone::Phone::default())
        .invoke_handler(tauri::generate_handler![
            gpu_stats,
            gpu_plan,
            gpu_procs,
            stack_info,
            start_services,
            set_updating,
            stop_services,
            list_chats,
            load_chat,
            save_chat,
            delete_chat,
            search_chats,
            get_settings,
            save_settings,
            store_get,
            store_set,
            sys_memory,
            file_sizes,
            studio::gallery_list,
            studio::thumbnail,
            studio::reveal,
            studio::open_render,
            studio::delete_render,
            studio::copy_render,
            studio::save_render_as,
            studio::read_workflow,
            studio::comfy_listen,
            studio::comfy_upload,
            studio::comfy_upload_bytes,
            models::gguf_info,
            models::disk_free,
            models::download_file,
            models::cancel_download,
            models::add_llama_model,
            models::restart_llama,
            canvas::canvas_put,
            knowledge::kb_list,
            knowledge::kb_add_paths,
            knowledge::kb_add_bytes,
            knowledge::kb_pick,
            knowledge::kb_remove,
            knowledge::kb_reindex,
            knowledge::kb_resume,
            knowledge::kb_search,
            knowledge::kb_open,
            phone::phone_start,
            phone::phone_stop,
            phone::phone_status,
            phone::phone_new_code,
            phone::phone_forget,
            phone::phone_push,
            phone::phone_set_state,
            toolstore::tools_extra_get,
            toolstore::tools_extra_set,
            toolstore::tools_setup,
            toolstore::tools_open_link,
            transcribe::transcribe_file,
            transcribe::transcribe_bytes,
            transcribe::pick_media,
            computer::cu_screenshot,
            computer::cu_act,
            computer::cu_panel
        ])
        .build(tauri::generate_context!())
        .expect("error while building Prestige")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_on_close(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{find_ci, snippet};

    #[test]
    fn finds_words_regardless_of_case_and_accents() {
        assert_eq!(find_ci("Hello Dragon theme", "dragon"), Some(6));
        assert_eq!(find_ci("İstanbul trip, then Dragon", "dragon"), Some("İstanbul trip, then ".len()));
        assert_eq!(find_ci("nothing here", "dragon"), None);
    }

    #[test]
    fn snippets_stay_on_char_boundaries() {
        let text = "é".repeat(200) + " the dragon theme " + &"ü".repeat(200);
        let at = find_ci(&text, "dragon").unwrap();
        let s = snippet(&text, at, 60);
        assert!(s.contains("dragon") && s.starts_with('…') && s.ends_with('…'));
        assert_eq!(snippet("short dragon", 6, 140), "short dragon");
    }
}
