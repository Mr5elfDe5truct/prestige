// Make it sound human: humanizer (jialinyyzz/humanizer, Apache-2.0; Gemma 4 12B fine-tuned to rewrite AI-written
// drafts, the humanize pack) rewrites text so it reads like a person wrote it, keeping every fact, number, name and
// quotation. It runs in llama.cpp's router as "humanizer", loaded on demand like the chat models (Q4_K_M, ~10 GB at
// most).
//
// It's a text-completion model trained on one exact prompt, so it's sent that prompt byte for byte, through the
// completion endpoint, with the sampling its authors evaluated (temperature 1.0, top-p 0.95, nothing else).

use std::fs;
use std::path::Path;

use crate::stack_root;

const ID: &str = "humanizer";
pub(crate) const MODEL: &str = "humanizer-12b-Q4_K_M.gguf";
const INSTR: &str = "Rewrite the text below so it reads like a person wrote it, not a language model.\n\nReorganize it as you see fit. Vary sentence length on purpose. Cut hedging,\nthroat-clearing, and any sentence that only announces what comes next.\nPrefer the concrete word over the abstract one. It is fine to sound uneven.\n\nEvery fact, number, unit, date, name and quotation must survive unchanged.";
const SEP: &str = "\n\n### Rewritten:\n\n";
/// The model reads 8192 tokens for the instruction, the draft and the rewrite: a draft longer than this many
/// characters (~1,500 tokens) is rewritten a few paragraphs at a time.
const PART: usize = 6000;

fn router() -> String {
    std::env::var("PRESTIGE_LLAMA").unwrap_or_else(|_| "http://127.0.0.1:8081".into())
}

/// The prompt it was trained on (its authors check it by this hash: sha256 of prompt("X") starts cc51d66b4c593fbe).
fn prompt(draft: &str) -> String {
    format!("{INSTR}\n\n{}{SEP}", draft.trim())
}

pub(crate) fn installed(root: &Path) -> bool {
    root.join("models").join("gguf").join(MODEL).exists()
}

fn configured(root: &Path) -> bool {
    fs::read_to_string(root.join("bin").join("llama-models.ini")).is_ok_and(|t| t.lines().any(|l| l.trim() == format!("[{ID}]")))
}

/// Adds the model to llama.cpp's router the first time it's used, and restarts the router so it knows it.
fn ensure(root: &Path) -> Result<(), String> {
    if !installed(root) {
        return Err("Make it sound human needs the Humanizer pack (7.6 GB): add it in Packs".into());
    }
    if configured(root) {
        return Ok(());
    }
    let r = Some(root.to_string_lossy().into_owned());
    crate::models::add_llama_model(
        r.clone(),
        ID.into(),
        root.join("models").join("gguf").join(MODEL).to_string_lossy().into_owned(),
        None,
        None,
        Some("Make it sound human: humanizer 12B (Gemma 4, Apache-2.0) rewrites AI-written text. Added by Prestige.".into()),
        Some(vec![("c".into(), "8192".into())]),
    )?;
    crate::models::restart_llama(r)?;
    std::thread::sleep(std::time::Duration::from_secs(3));
    for _ in 0..60 {
        if ureq::get(&format!("{}/v1/models", router())).timeout(std::time::Duration::from_secs(3)).call().is_ok_and(|r| r.status() == 200) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    Err("llama.cpp didn't come back after adding the humanizer model".into())
}

/// A long draft cut at paragraph breaks into parts the model can rewrite whole (a paragraph longer than a part is a
/// part on its own; the model's context still takes it).
fn parts(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for para in text.trim().split("\n\n").map(str::trim).filter(|p| !p.is_empty()) {
        if !cur.is_empty() && cur.chars().count() + para.chars().count() + 2 > PART {
            out.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push_str("\n\n");
        }
        cur.push_str(para);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn rewrite(draft: &str) -> Result<String, String> {
    // Its authors allow about 2.5 times the draft's tokens (~4 characters a token).
    let max = (draft.chars().count() * 25 / 40).clamp(256, 2048);
    let body = serde_json::json!({
        "model": ID,
        "prompt": prompt(draft),
        "max_tokens": max,
        "temperature": 1.0,
        "top_p": 0.95,
        "top_k": 0,
        "min_p": 0.0,
        "repeat_penalty": 1.0,
    });
    let res = ureq::post(&format!("{}/v1/completions", router()))
        .timeout(std::time::Duration::from_secs(900))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string());
    let v: serde_json::Value = match res {
        Ok(r) => serde_json::from_str(&r.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(code, r)) => return Err(format!("llama.cpp answered {code}: {}", r.into_string().unwrap_or_default().chars().take(200).collect::<String>())),
        Err(_) => return Err("llama.cpp isn't running".into()),
    };
    let text = v["choices"][0]["text"].as_str().unwrap_or("").trim().to_string();
    if text.is_empty() {
        return Err("the model returned nothing".into());
    }
    Ok(text)
}

/// Whether Make it sound human can work (the pack is there).
#[tauri::command]
pub fn humanize_status(root: Option<String>) -> bool {
    installed(&stack_root(root))
}

/// `text` rewritten so it reads like a person wrote it.
#[tauri::command]
pub async fn humanize(root: Option<String>, text: String) -> Result<String, String> {
    let root = stack_root(root);
    tauri::async_runtime::spawn_blocking(move || {
        if text.trim().is_empty() {
            return Err("there's nothing to rewrite".to_string());
        }
        ensure(&root)?;
        let out: Result<Vec<String>, String> = parts(&text).iter().map(|p| rewrite(p)).collect();
        Ok(out?.join("\n\n"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_matches_the_trained_one() {
        // The authors' check: the first 16 hex digits of sha256(prompt("X")).
        let p = prompt("  X \n");
        assert!(p.starts_with("Rewrite the text below so it reads like a person wrote it, not a language model.\n\nReorganize"));
        assert!(p.ends_with("must survive unchanged.\n\nX\n\n### Rewritten:\n\n"));
        assert_eq!(p.len(), INSTR.len() + 2 + 1 + SEP.len());
    }

    #[test]
    fn long_drafts_are_cut_at_paragraphs() {
        let para = "word ".repeat(300); // 1,500 characters
        let text = vec![para.trim(); 9].join("\n\n");
        let p = parts(&text);
        assert!(p.len() >= 3, "{}", p.len());
        assert!(p.iter().all(|x| x.chars().count() <= PART));
        assert_eq!(p.join("\n\n"), text);
        assert_eq!(parts("one\n\n\n\ntwo"), vec!["one\n\ntwo".to_string()]);
    }
}
