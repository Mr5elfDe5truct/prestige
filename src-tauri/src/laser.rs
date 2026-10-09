// Laser: saves an engraving (a PNG with its DPI in it) or a cut file (an SVG in millimetres) made in laser.ts. Into the
// gallery's laser folder (laser_00001.png), or wherever the user picks.

use std::fs;
use std::path::PathBuf;

use crate::studio::output_dir;

/// %41 → 'A' (the UI sends names and the folder percent-encoded, since headers are ASCII).
fn unpercent(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The body is the file; headers: "x-ext" (png or svg), "x-name" (a name to suggest), "x-root" (the Workstation folder,
/// or empty), "x-ask" ("1" to pick where with a Save dialog). Returns the saved path, or null if the dialog was cancelled.
#[tauri::command]
pub async fn laser_save(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes".into());
    };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(unpercent).unwrap_or_default();
    let ext = match header("x-ext").as_str() {
        "png" => "png",
        "svg" => "svg",
        _ => return Err("only PNG and SVG files are saved here".into()),
    };
    let root = Some(header("x-root")).filter(|r| !r.is_empty());
    let name: String = header("x-name").chars().filter(|c| !"\\/:*?\"<>|".contains(*c) && !c.is_control()).take(80).collect();
    let name = if name.trim().is_empty() { "laser".to_string() } else { name.trim().to_string() };
    let ask = header("x-ask") == "1";
    let bytes = bytes.clone();

    let dest: PathBuf = if ask {
        let mut dialog = app
            .dialog()
            .file()
            .set_file_name(format!("{name}.{ext}"))
            .add_filter(if ext == "png" { "Engraving (PNG)" } else { "Cut file (SVG)" }, &[ext]);
        if let Some(dir) = std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("Pictures")).filter(|d| d.exists()) {
            dialog = dialog.set_directory(dir);
        }
        let Some(p) = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file()).await.map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        p.into_path().map_err(|e| e.to_string())?
    } else {
        let dir = output_dir(root).join("laser");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        (1..100_000)
            .map(|n| dir.join(format!("laser_{n:05}.{ext}")))
            .find(|p| !p.exists())
            .ok_or("the laser folder is full")?
    };
    fs::write(&dest, &bytes).map_err(|e| format!("Couldn't save to {}: {e}", dest.display()))?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}
