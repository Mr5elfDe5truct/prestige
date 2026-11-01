// Quick talk: Live's other mode, where one small model hears you and answers aloud. LFM3-Audio 2B (Liquid AI, LFM
// Open License v1.0; the quicktalk pack) runs in llama.cpp's router like the chat models, and Live talks to it over
// llama-server's /v1/realtime websocket: the mic's audio goes in as it's spoken, and speech comes back as it's made.
// No Whisper, no chat model and no separate voice, so it answers in about 0.4 s, but in one voice, in English, and
// without much reasoning. It needs llama.cpp v0.8.0 (b11960) or newer, which added LFM3 and /v1/realtime.

use std::fs;
use std::path::Path;

use crate::stack_root;

pub(crate) const ID: &str = "lfm3-audio";
pub(crate) const MODEL: &str = "LFM3-Audio-2B-Q4_K_M.gguf";
pub(crate) const MMPROJ: &str = "mmproj-LFM3-Audio-2B-Q8_0.gguf";
/// The first llama.cpp build with LFM3-Audio and /v1/realtime.
const MIN_BUILD: u32 = 11960;

fn installed(root: &Path) -> bool {
    let g = root.join("models").join("gguf");
    g.join(MODEL).exists() && g.join(MMPROJ).exists()
}

fn configured(root: &Path) -> bool {
    fs::read_to_string(root.join("bin").join("llama-models.ini")).is_ok_and(|t| t.lines().any(|l| l.trim() == format!("[{ID}]")))
}

/// llama.cpp's router (PRESTIGE_LLAMA overrides it, for tests against another server).
fn router() -> String {
    std::env::var("PRESTIGE_LLAMA").unwrap_or_else(|_| "http://127.0.0.1:8081".into())
}

fn get_json(path: &str) -> Option<serde_json::Value> {
    let r = ureq::get(&format!("{}{path}", router())).timeout(std::time::Duration::from_secs(5)).call().ok()?;
    serde_json::from_str(&r.into_string().ok()?).ok()
}

/// The running router's build number, from its /props ("build_info": "b11960-8642541b2").
fn build_of(props: &serde_json::Value) -> Option<u32> {
    props["build_info"].as_str()?.strip_prefix('b')?.split('-').next()?.parse().ok()
}

/// Whether the running router lists the model.
fn listed() -> bool {
    get_json("/v1/models").is_some_and(|v| v["data"].as_array().is_some_and(|a| a.iter().any(|m| m["id"] == ID)))
}

/// Gets Quick talk ready: the pack is there, the running llama.cpp is new enough, and the router knows the model
/// (added the first time, with a restart of the router). Returns the websocket address to talk to it on.
#[tauri::command]
pub async fn quick_talk_prepare(root: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = stack_root(root);
        let url = format!("{}/v1/realtime?model={ID}", router().replacen("http", "ws", 1));
        let Some(props) = get_json("/props") else {
            return Err("llama.cpp isn't running: start it in System (Services)".into());
        };
        if build_of(&props).is_some_and(|b| b < MIN_BUILD) {
            return Err(format!("Quick talk needs llama.cpp b{MIN_BUILD} (v0.8.0) or newer: update it in Packs → Engines"));
        }
        if listed() {
            return Ok(url);
        }
        if !installed(&root) {
            return Err("Quick talk needs the Quick talk pack (LFM3-Audio 2B, 1.4 GB): add it in Packs".into());
        }
        if !configured(&root) {
            let g = root.join("models").join("gguf");
            crate::models::add_llama_model(
                Some(root.to_string_lossy().into_owned()),
                ID.into(),
                g.join(MODEL).to_string_lossy().into_owned(),
                Some(g.join(MMPROJ).to_string_lossy().into_owned()),
                None,
                Some("Quick talk: LFM3-Audio 2B (Liquid AI, LFM Open License v1.0), hears and speaks in Live. Added by Prestige.".into()),
                // Greedy text, as Liquid recommends; the audio sampling settings come with the GGUF.
                Some(vec![("c".into(), "8192".into()), ("temp".into(), "0".into())]),
            )?;
        }
        crate::models::restart_llama(Some(root.to_string_lossy().into_owned()))?;
        // The router answers again once it has restarted.
        std::thread::sleep(std::time::Duration::from_secs(3));
        for _ in 0..60 {
            if listed() {
                return Ok(url);
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        Err("llama.cpp didn't come back after adding Quick talk's model".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds() {
        assert_eq!(build_of(&serde_json::json!({ "build_info": "b11960-8642541b2" })), Some(11960));
        assert_eq!(build_of(&serde_json::json!({ "build_info": "unknown" })), None);
        assert_eq!(build_of(&serde_json::json!({})), None);
    }
}
