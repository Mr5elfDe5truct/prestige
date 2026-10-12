// Translate: Index-Translate 35B-A3B (bilibili's IndexTeam, Apache-2.0; the translate pack) translates text, and the
// text in a picture, between 150 languages. It's a mixture of experts with ~3B active, so it runs like the Main chat
// model: in llama.cpp's router with most of its experts in system RAM (n-cpu-moe), loaded on demand.
//
// It's prompted the way its own client does (inference/llm/call_api.py): a Chinese instruction naming the target
// language in Chinese, greedy decoding, and the chat template with thinking off.

use base64::Engine;
use std::fs;
use std::path::{Path, PathBuf};

use crate::stack_root;

const ID: &str = "index-translate";
/// In a folder of its own under models\gguf, so it can live on another drive through a junction.
pub(crate) const DIR: &str = "Index-Translate";
pub(crate) const MODEL: &str = "Index-Translate-35B-A3B-preview.Q4_K_M.gguf";
pub(crate) const MMPROJ: &str = "Index-Translate-35B-A3B-preview.mmproj-Q8_0.gguf";
/// Expert layers kept in system RAM so the rest and 16k of context fit a 12 GB card (as the Main model does).
const CPU_MOE: u32 = 25;
/// A text longer than this many characters is translated a few paragraphs at a time.
const PART: usize = 4000;

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
        return Err("translating needs the Translate pack (Index-Translate 35B-A3B, 21 GB): add it in Packs".into());
    }
    if configured(root) {
        return Ok(());
    }
    let r = Some(root.to_string_lossy().into_owned());
    let mmproj = dir(root).join(MMPROJ);
    crate::models::add_llama_model(
        r.clone(),
        ID.into(),
        dir(root).join(MODEL).to_string_lossy().into_owned(),
        mmproj.exists().then(|| mmproj.to_string_lossy().into_owned()),
        Some(CPU_MOE),
        Some("Translate: Index-Translate 35B-A3B (Apache-2.0), 150 languages, text and pictures. Added by Prestige.".into()),
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
    Err("llama.cpp didn't come back after adding the translation model".into())
}

/// The language as Index-Translate's prompts name it: Chinese names for the ones its client knows, otherwise the
/// name as given (its docs say full names in English work too).
fn lang_name(lang: &str) -> String {
    let l = lang.trim();
    let key = l.to_ascii_lowercase();
    let zh = match key.as_str() {
        "en" | "english" => "英语",
        "zh" | "chinese" | "chinese (simplified)" => "中文",
        "de" | "german" => "德语",
        "fr" | "french" => "法语",
        "es" | "spanish" => "西班牙语",
        "ja" | "japanese" => "日语",
        "ko" | "korean" => "韩语",
        "pt" | "portuguese" => "葡萄牙语",
        "ru" | "russian" => "俄语",
        "ar" | "arabic" => "阿拉伯语",
        "it" | "italian" => "意大利语",
        "nl" | "dutch" => "荷兰语",
        "pl" | "polish" => "波兰语",
        "ro" | "romanian" => "罗马尼亚语",
        "sv" | "swedish" => "瑞典语",
        "tr" | "turkish" => "土耳其语",
        "hi" | "hindi" => "印地语",
        "vi" | "vietnamese" => "越南语",
        "th" | "thai" => "泰语",
        "id" | "indonesian" => "印尼语",
        "ms" | "malay" => "马来语",
        "fil" | "filipino" | "tagalog" => "菲律宾语",
        "uk" | "ukrainian" => "乌克兰语",
        "fa" | "persian" | "farsi" => "波斯语",
        "cs" | "czech" => "捷克语",
        "el" | "greek" => "希腊语",
        "da" | "danish" => "丹麦语",
        "hu" | "hungarian" => "匈牙利语",
        "fi" | "finnish" => "芬兰语",
        "no" | "nb" | "norwegian" => "书面挪威语",
        "sk" | "slovak" => "斯洛伐克语",
        "bg" | "bulgarian" => "保加利亚语",
        _ => "",
    };
    if zh.is_empty() { l.to_string() } else { zh.to_string() }
}

/// The default translation prompt of Index-Translate's client.
fn text_prompt(text: &str, target: &str) -> String {
    format!("请将以下文本翻译为{}，直接输出翻译结果，不要进行任何解释。\n\n{}", lang_name(target), text.trim())
}

/// Its image translation prompt.
fn image_prompt(target: &str) -> String {
    format!("请将图片中的文本翻译为{}，直接输出翻译结果，不要进行任何解释。", lang_name(target))
}

/// A long text cut at paragraph breaks into parts translated one at a time.
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

fn chat(content: serde_json::Value, max_tokens: usize) -> Result<String, String> {
    let body = serde_json::json!({
        "model": ID,
        "messages": [{ "role": "user", "content": content }],
        "temperature": 0,
        "max_tokens": max_tokens,
        "chat_template_kwargs": { "enable_thinking": false },
    });
    let res = ureq::post(&format!("{}/v1/chat/completions", router()))
        .timeout(std::time::Duration::from_secs(1200))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string());
    let v: serde_json::Value = match res {
        Ok(r) => serde_json::from_str(&r.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(code, r)) => return Err(format!("llama.cpp answered {code}: {}", r.into_string().unwrap_or_default().chars().take(200).collect::<String>())),
        Err(_) => return Err("llama.cpp isn't running".into()),
    };
    let text = v["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string();
    // A reply that still opens with an empty think block (some templates leave one) loses it.
    let text = text.strip_prefix("<think>").and_then(|t| t.split_once("</think>")).map(|(_, rest)| rest.trim().to_string()).unwrap_or(text);
    if text.is_empty() {
        return Err("the model returned nothing".into());
    }
    Ok(text)
}

/// Whether Translate can work (the pack is there).
#[tauri::command]
pub fn translate_status(root: Option<String>) -> bool {
    installed(&stack_root(root))
}

/// `text` in `target` (a language code like "fr", or a name).
#[tauri::command]
pub async fn translate_text(root: Option<String>, text: String, target: String) -> Result<String, String> {
    let root = stack_root(root);
    tauri::async_runtime::spawn_blocking(move || {
        if text.trim().is_empty() {
            return Err("there's nothing to translate".to_string());
        }
        ensure(&root)?;
        let out: Result<Vec<String>, String> = parts(&text)
            .iter()
            .map(|p| chat(serde_json::json!(text_prompt(p, &target)), (p.chars().count() * 3 / 2).clamp(256, 8192)))
            .collect();
        Ok(out?.join("\n\n"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The text in the picture at `path`, translated into `target`.
#[tauri::command]
pub async fn translate_image(root: Option<String>, path: String, target: String) -> Result<String, String> {
    let root = stack_root(root);
    tauri::async_runtime::spawn_blocking(move || {
        ensure(&root)?;
        if !dir(&root).join(MMPROJ).exists() {
            return Err("translating pictures needs the Translate pack's vision part: add the pack again in Packs".into());
        }
        let bytes = fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
        let img = image::load_from_memory(&bytes).map_err(|e| format!("that picture couldn't be read: {e}"))?;
        // The vision part reads ~1-2 megapixels; bigger pictures are scaled down first.
        let img = if img.width().max(img.height()) > 2048 { img.resize(2048, 2048, image::imageops::FilterType::Lanczos3) } else { img };
        let mut png = std::io::Cursor::new(Vec::new());
        img.to_rgb8().write_to(&mut png, image::ImageFormat::Png).map_err(|e| e.to_string())?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
        chat(
            serde_json::json!([
                { "type": "text", "text": image_prompt(&target) },
                { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{b64}") } },
            ]),
            4096,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_match_the_official_client() {
        assert_eq!(text_prompt("  Hello  ", "fr"), "请将以下文本翻译为法语，直接输出翻译结果，不要进行任何解释。\n\nHello");
        assert_eq!(image_prompt("English"), "请将图片中的文本翻译为英语，直接输出翻译结果，不要进行任何解释。");
        // Languages its client doesn't name keep the name given.
        assert_eq!(lang_name("Welsh"), "Welsh");
        assert_eq!(lang_name("ZH"), "中文");
    }

    #[test]
    fn long_texts_are_cut_at_paragraphs() {
        let para = "mot ".repeat(400);
        let text = vec![para.trim(); 6].join("\n\n");
        let p = parts(&text);
        assert!(p.len() >= 2 && p.iter().all(|x| x.chars().count() <= PART));
        assert_eq!(p.join("\n\n"), text);
    }
}
