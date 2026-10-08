// Your own background (Settings → Appearance → Background): a picture or a video you pick, kept as a copy in the app
// data folder (background\) so it still shows if the original moves. Each pick gets its own file name, so Cancel can
// go back to the one before; closing Settings prunes the files the saved look no longer uses.
use crate::data_dir;
use std::fs;
use tauri::{AppHandle, Manager};

/// Pictures and videos a webview can show as a background.
const KINDS: [&str; 8] = ["jpg", "jpeg", "png", "webp", "gif", "avif", "mp4", "webm"];

/// A stored background's file name: "bg-<hash>.<ext>", nothing else (no paths).
fn safe_name(name: &str) -> Option<&str> {
    let (stem, ext) = name.rsplit_once('.')?;
    let ok = stem.len() <= 40 && stem.starts_with("bg-") && stem[3..].chars().all(|c| c.is_ascii_alphanumeric()) && KINDS.contains(&ext);
    ok.then_some(name)
}

/// Saves the picked file's bytes (header x-ext: its extension) and returns the stored file's name.
#[tauri::command]
pub fn background_set(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes".into());
    };
    let ext = request.headers().get("x-ext").and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    if !KINDS.contains(&ext.as_str()) {
        return Err("Pick a picture (JPG, PNG, WebP, GIF, AVIF) or a video (MP4, WebM)".into());
    }
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes.iter().step_by(97).chain(&(bytes.len() as u64).to_le_bytes()) {
        h = (h ^ *b as u64).wrapping_mul(0x100000001b3);
    }
    let name = format!("bg-{h:016x}.{ext}");
    fs::write(data_dir(&app, "background")?.join(&name), bytes).map_err(|e| e.to_string())?;
    Ok(name)
}

/// The full path of a stored background (let through the asset protocol), or None if it's gone.
#[tauri::command]
pub fn background_path(app: AppHandle, name: String) -> Option<String> {
    let path = data_dir(&app, "background").ok()?.join(safe_name(&name)?);
    if !path.is_file() {
        return None;
    }
    let _ = app.asset_protocol_scope().allow_file(&path);
    Some(path.to_string_lossy().into_owned())
}

/// Deletes every stored background except `keep` (the one the saved look uses, if any).
#[tauri::command]
pub fn background_prune(app: AppHandle, keep: Option<String>) -> Result<(), String> {
    let dir = data_dir(&app, "background")?;
    for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if Some(&n) != keep.as_ref() {
            let _ = fs::remove_file(e.path());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn only_stored_background_names() {
        assert!(safe_name("bg-0123abcd.mp4").is_some());
        assert!(safe_name("bg-0123abcd.exe").is_none());
        assert!(safe_name("../settings.json").is_none());
        assert!(safe_name("bg-..\\x.png").is_none());
    }
}
