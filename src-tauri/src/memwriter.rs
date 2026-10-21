// Hy-Memory-30B-A3B (Tencent Hunyuan, Apache-2.0; the hy-memory pack): a model trained to write long-term memory,
// deciding what to keep and how new facts change the stored ones. Prestige's memory writer (memwriter.ts) can use it
// in place of the chat model. It runs in llama.cpp's router as "hy-memory" with most of its experts in system RAM
// (n-cpu-moe), loaded on demand like the chat models, so it takes the place of a llama.cpp chat model while it writes.

use std::fs;
use std::path::{Path, PathBuf};

use crate::stack_root;

const ID: &str = "hy-memory";
pub(crate) const DIR: &str = "hy-memory";
pub(crate) const MODEL: &str = "Hy-Memory-30B-A3B-Q4_K_M.gguf";
/// 48 layers of 128 experts. With 28 in system RAM it peaked at 11.7 GB on the 12 GB RTX 3060, too close to full; 32
/// leaves room for the desktop.
const CPU_MOE: u32 = 32;

fn router() -> String {
    std::env::var("PRESTIGE_LLAMA").unwrap_or_else(|_| "http://127.0.0.1:8081".into())
}

fn dir(root: &Path) -> PathBuf {
    root.join("models").join("gguf").join(DIR)
}

pub(crate) fn installed(root: &Path) -> bool {
    dir(root).join(MODEL).exists()
}

fn configured(root: &Path) -> bool {
    fs::read_to_string(root.join("bin").join("llama-models.ini")).is_ok_and(|t| t.lines().any(|l| l.trim() == format!("[{ID}]")))
}

/// Adds the model to llama.cpp's router the first time it's used, and restarts the router so it knows it.
fn ensure(root: &Path) -> Result<(), String> {
    if !installed(root) {
        return Err("Hy-Memory needs the Hy-Memory pack (18 GB): add it in Packs".into());
    }
    if configured(root) {
        return Ok(());
    }
    let r = Some(root.to_string_lossy().into_owned());
    crate::models::add_llama_model(
        r.clone(),
        ID.into(),
        dir(root).join(MODEL).to_string_lossy().into_owned(),
        None,
        Some(CPU_MOE),
        Some("Memory writer: Hy-Memory-30B-A3B (Tencent, Apache-2.0) decides what Prestige remembers. Added by Prestige.".into()),
        Some(vec![("c".into(), "16384".into())]),
    )?;
    crate::models::restart_llama(r)?;
    std::thread::sleep(std::time::Duration::from_secs(3));
    for _ in 0..60 {
        if ureq::get(&format!("{}/v1/models", router())).timeout(std::time::Duration::from_secs(3)).call().is_ok_and(|r| r.status() == 200) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    Err("llama.cpp didn't come back after adding Hy-Memory".into())
}

/// Whether Hy-Memory can write memory (the pack is there).
#[tauri::command]
pub fn hymemory_status(root: Option<String>) -> bool {
    installed(&stack_root(root))
}

/// Gets Hy-Memory ready in llama.cpp's router (added the first time); memwriter.ts then talks to it as "hy-memory".
#[tauri::command]
pub async fn hymemory_ready(root: Option<String>) -> Result<String, String> {
    let root = stack_root(root);
    tauri::async_runtime::spawn_blocking(move || ensure(&root).map(|_| ID.to_string())).await.map_err(|e| e.to_string())?
}
