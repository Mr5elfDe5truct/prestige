// Picture to 3D as a splat: Speridlabs' Idol (Apache-2.0; the idol pack) turns one picture into a 3D Gaussian splat, next
// to Pixal3D's textured mesh. The Workstation's tools\splat3d.py does the work in its envs\idol environment; this frees the
// GPU, runs it with the Hugging Face token (its encoders are gated: DINOv3, and FLUX.2-dev's VAE under FLUX's
// non-commercial licence), and saves the .ply with the other 3D models in ComfyUI's output folder (3d\), so it shows
// in the gallery and opens in the Canvas's 3D viewer.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::{hidden, stack_root};

fn installed(root: &Path) -> bool {
    root.join("envs").join("idol").join("Scripts").join("python.exe").exists() && root.join("tools").join("splat3d.py").exists()
}

/// The next free 3d\idol_00001.ply in ComfyUI's output folder.
fn next_out(dir: &Path) -> PathBuf {
    (1..).map(|n| dir.join(format!("idol_{n:05}_.ply"))).find(|p| !p.exists()).unwrap()
}

/// Asks ComfyUI and llama.cpp's router to let go of their models, so Idol's ~6.2 GB fits.
fn free_gpu() {
    let post = |url: &str, body: serde_json::Value| {
        let _ = ureq::post(url).timeout(std::time::Duration::from_secs(30)).set("Content-Type", "application/json").send_string(&body.to_string());
    };
    post("http://127.0.0.1:8188/free", serde_json::json!({ "unload_models": true, "free_memory": true }));
    let Ok(r) = ureq::get("http://127.0.0.1:8081/v1/models").timeout(std::time::Duration::from_secs(3)).call() else { return };
    let v: serde_json::Value = serde_json::from_str(&r.into_string().unwrap_or_default()).unwrap_or_default();
    for m in v["data"].as_array().into_iter().flatten() {
        if m["status"]["value"].as_str().is_some_and(|s| s != "unloaded") {
            post("http://127.0.0.1:8081/models/unload", serde_json::json!({ "model": m["id"] }));
        }
    }
}

/// Whether Idol can run: the pack is there, and a Hugging Face token for its gated encoders.
#[tauri::command]
pub fn idol_status(root: Option<String>) -> serde_json::Value {
    let root = stack_root(root);
    serde_json::json!({ "installed": installed(&root), "token": crate::packs::hf_token(&root).is_some() })
}

/// Makes a splat of the picture at `path` (`mode`: "synthetic" for renders, "real" for photos). Returns the .ply's path.
#[tauri::command]
pub async fn idol_run(root: Option<String>, path: String, mode: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = stack_root(root);
        if !installed(&root) {
            return Err("Picture to 3D · splat needs the Idol pack: add it in Packs".into());
        }
        let Some((token, _)) = crate::packs::hf_token(&root) else {
            return Err("Idol's image encoders are gated on Hugging Face: add your token in Packs (after accepting the DINOv3 and FLUX.2-dev licences)".into());
        };
        let dir = crate::studio::output_dir(Some(root.to_string_lossy().into_owned())).join("3d");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let out = next_out(&dir);
        free_gpu();
        let res = hidden(&mut Command::new(root.join("envs").join("idol").join("Scripts").join("python.exe")))
            .arg(root.join("tools").join("splat3d.py"))
            .arg(&path)
            .arg(&out)
            .arg(if mode == "real" { "real" } else { "synthetic" })
            .current_dir(&root)
            .env("PYTHONIOENCODING", "utf-8")
            .env("HF_TOKEN", token)
            // Its weights live with the other models.
            .env("HF_HUB_CACHE", root.join("models").join("hf").join("hub"))
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("couldn't start Idol: {e}"))?;
        let stdout = String::from_utf8_lossy(&res.stdout);
        let line = stdout.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
        let v: serde_json::Value = serde_json::from_str(line).map_err(|_| {
            let err = String::from_utf8_lossy(&res.stderr);
            format!("Idol ended without a result: {}", err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no message"))
        })?;
        if let Some(e) = v["error"].as_str() {
            return Err(e.to_string());
        }
        Ok(v)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_the_files() {
        let dir = std::env::temp_dir().join(format!("idol-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(next_out(&dir).file_name().unwrap(), "idol_00001_.ply");
        std::fs::write(dir.join("idol_00001_.ply"), b"").unwrap();
        assert_eq!(next_out(&dir).file_name().unwrap(), "idol_00002_.ply");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
