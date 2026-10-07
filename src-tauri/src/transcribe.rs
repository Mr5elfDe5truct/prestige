// Transcribe: a recording or a video in, the words with who said them out. The Workstation's tools\transcribe.py does
// the work (Phonon-2 for the words, Nemotron 3 Diarization for the speakers) in its envs\transcribe environment; this
// runs it, passes its "PROGRESS <pct> <what>" lines on as "transcribe" events, and returns its JSON.

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

use crate::{data_dir, hidden, stack_root};

/// Audio and video files the chat sends here instead of reading them as documents.
pub const MEDIA_EXT: &[&str] = &[
    "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma", "aiff", "aif", "amr", "mp4", "mkv", "mov", "webm", "avi", "wmv", "m4v", "mpeg", "mpg", "3gp", "ts",
];

fn run(app: &AppHandle, root: Option<String>, path: &Path, speakers: bool) -> Result<serde_json::Value, String> {
    let root = stack_root(root);
    let py = root.join("envs").join("transcribe").join("Scripts").join("python.exe");
    let script = root.join("tools").join("transcribe.py");
    if !py.exists() || !script.exists() {
        return Err("Transcribe needs the Workstation's transcribe pack (install.ps1 -Packs transcribe)".into());
    }
    let mut cmd = Command::new(py);
    hidden(&mut cmd).arg(&script).arg(path).current_dir(&root).env("PYTHONIOENCODING", "utf-8").stdout(Stdio::piped()).stderr(Stdio::piped());
    if !speakers {
        cmd.arg("--speakers-off");
    }
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start transcribe.py: {e}"))?;
    let err = child.stderr.take().unwrap();
    let app2 = app.clone();
    let tail = std::thread::spawn(move || {
        let mut last = String::new();
        for line in BufReader::new(err).lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("PROGRESS ") {
                let (pct, what) = rest.split_once(' ').unwrap_or((rest, ""));
                let _ = app2.emit("transcribe", serde_json::json!({ "pct": pct.parse::<f64>().unwrap_or(0.0), "what": what }));
            } else if !line.trim().is_empty() {
                last = line;
            }
        }
        last
    });
    let mut out = String::new();
    child.stdout.take().unwrap().read_to_string(&mut out).map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    let last_err = tail.join().unwrap_or_default();
    let line = out.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
    let v: serde_json::Value = serde_json::from_str(line).map_err(|_| {
        if last_err.is_empty() { format!("transcribe.py ended without a result ({status})") } else { last_err.clone() }
    })?;
    if let Some(e) = v["error"].as_str() {
        return Err(e.to_string());
    }
    Ok(v)
}

/// Transcribes a file on this PC (picked with the dialog).
#[tauri::command]
pub async fn transcribe_file(app: AppHandle, root: Option<String>, path: String, speakers: bool) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || run(&app, root, &PathBuf::from(path), speakers)).await.map_err(|e| e.to_string())?
}

/// Transcribes a file dropped or attached in the chat: the raw bytes, its name in the "x-name" header, "x-speakers: 0"
/// to skip the speakers. Written to the app's data folder for the run and deleted after.
#[tauri::command]
pub async fn transcribe_bytes(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<serde_json::Value, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes".into());
    };
    let h = request.headers();
    let header = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).map(String::from);
    let name = header("x-name").unwrap_or_else(|| "recording.mp3".into());
    let root = header("x-root").filter(|r| !r.is_empty());
    let speakers = header("x-speakers").as_deref() != Some("0");
    // Only the extension of the name is kept (it tells ffmpeg nothing it couldn't guess, but keeps the file tidy).
    let ext = Path::new(&name).extension().and_then(|e| e.to_str()).unwrap_or("bin").to_ascii_lowercase();
    let ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(5).collect();
    let dir = data_dir(&app, "transcribe")?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let file = dir.join(format!("upload-{stamp}.{ext}"));
    fs::write(&file, bytes).map_err(|e| e.to_string())?;
    let f2 = file.clone();
    let res = tauri::async_runtime::spawn_blocking(move || run(&app, root, &f2, speakers)).await.map_err(|e| e.to_string());
    let _ = fs::remove_file(&file);
    res?
}

/// The file dialog for Transcribe, filtered to audio and video. None if cancelled.
#[tauri::command]
pub async fn pick_media(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let dialog = app.dialog().file().add_filter("Audio and video", MEDIA_EXT).set_title("Transcribe a recording");
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file()).await.map_err(|e| e.to_string())?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}
