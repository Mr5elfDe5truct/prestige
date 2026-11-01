// Read any document: Unlimited-OCR (Baidu, MIT; 42ailab's Q4_K_M GGUF, the ocr pack) turns a photo or scan of a page
// into Markdown: headings, paragraphs and tables in reading order. It's a 3B mixture of experts (~0.5B active) that
// llama.cpp's router loads on demand like the chat models (~5 GB of VRAM with its vision part); on the RTX 3060 a page
// takes 2-3 s once it's loaded.
//
// Studio's "Read the text" and Knowledge (photos of pages, and scanned PDFs, whose pages are pictures) use it.
//
// Unlimited-OCR-2 (Baidu, MIT; the ocr2 pack, "Read whole documents") reads every page of a document in one go, and is
// far better on a full page of text: on a dense test page it got 98.7% of the words where v1 got 7.7% (it fell into a
// loop). It has no llama.cpp support yet, so it runs through transformers in its own environment (tools\ocr2.py), at
// ~8 tokens a second on an RTX 3060: a short page in ~20 s, a full one in ~90 s, plus ~15 s to load and ~7.3 GB of
// VRAM. Scanned PDFs in Knowledge use it when the pack is there; "Read the text" offers it as a second, slower read.
// v1 stays the fallback.

use base64::Engine;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use crate::{hidden, stack_root};

const ID: &str = "unlimited-ocr";
pub(crate) const MODEL: &str = "Unlimited-OCR-3B-Q4_K_M.gguf";
pub(crate) const MMPROJ: &str = "mmproj-Unlimited-OCR-3B-F16.gguf";
/// The prompt Baidu's examples use for one page.
const PROMPT: &str = "document parsing.";
/// Pictures bigger than this (longest side) are scaled down first: the model reads a page at 1024 px.
const MAX_SIDE: u32 = 2048;

/// The Workstation folder Prestige last named (Knowledge reads files without one).
static ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);

fn root_of(root: Option<String>) -> PathBuf {
    if root.as_deref().is_some_and(|r| !r.trim().is_empty()) {
        let r = stack_root(root);
        *ROOT.lock().unwrap() = Some(r.clone());
        return r;
    }
    ROOT.lock().unwrap().clone().unwrap_or_else(|| stack_root(None))
}

/// The Workstation folder to read with when the caller has none (Knowledge).
pub(crate) fn current_root() -> PathBuf {
    root_of(None)
}

/// llama.cpp's router (PRESTIGE_LLAMA overrides it, for tests against another server).
fn router() -> String {
    std::env::var("PRESTIGE_LLAMA").unwrap_or_else(|_| "http://127.0.0.1:8081".into())
}

pub(crate) fn installed(root: &Path) -> bool {
    let g = root.join("models").join("gguf");
    g.join(MODEL).exists() && g.join(MMPROJ).exists()
}

fn configured(root: &Path) -> bool {
    fs::read_to_string(root.join("bin").join("llama-models.ini")).is_ok_and(|t| t.lines().any(|l| l.trim() == format!("[{ID}]")))
}

/// Adds the model to llama.cpp's router the first time it's used, and restarts the router so it knows it.
fn ensure(root: &Path) -> Result<(), String> {
    if !installed(root) {
        return Err("reading documents needs the Read documents pack (Unlimited-OCR, 2.8 GB): add it in Packs".into());
    }
    if configured(root) {
        return Ok(());
    }
    let g = root.join("models").join("gguf");
    crate::models::add_llama_model(
        Some(root.to_string_lossy().into_owned()),
        ID.into(),
        g.join(MODEL).to_string_lossy().into_owned(),
        Some(g.join(MMPROJ).to_string_lossy().into_owned()),
        None,
        Some("Read documents: Unlimited-OCR 3B (Baidu, MIT), pages to Markdown. Added by Prestige's Read the text.".into()),
        // Its tables and layout marks are special tokens, which llama.cpp leaves out unless asked.
        Some(vec![("special".into(), "true".into()), ("c".into(), "16384".into())]),
    )?;
    crate::models::restart_llama(Some(root.to_string_lossy().into_owned()))?;
    // The router answers again once it has restarted.
    std::thread::sleep(std::time::Duration::from_secs(3));
    for _ in 0..60 {
        if ureq::get(&format!("{}/v1/models", router())).timeout(std::time::Duration::from_secs(3)).call().is_ok_and(|r| r.status() == 200) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    Err("llama.cpp didn't come back after adding the reading model".into())
}

/// A picture as a PNG or JPEG that isn't bigger than the model needs.
fn prepared(bytes: &[u8]) -> Result<(Vec<u8>, &'static str), String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("that picture couldn't be read: {e}"))?;
    if img.width().max(img.height()) <= MAX_SIDE && (bytes.starts_with(&[0x89, b'P']) || bytes.starts_with(&[0xFF, 0xD8])) {
        return Ok((bytes.to_vec(), if bytes[0] == 0xFF { "image/jpeg" } else { "image/png" }));
    }
    let small = if img.width().max(img.height()) > MAX_SIDE { img.resize(MAX_SIDE, MAX_SIDE, image::imageops::FilterType::Lanczos3) } else { img };
    let mut out = std::io::Cursor::new(Vec::new());
    small.to_rgb8().write_to(&mut out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok((out.into_inner(), "image/png"))
}

// ---------- Unlimited-OCR-2 ----------

/// Where the ocr2 pack puts the model (its files at a fixed revision: the model's own code runs from here).
pub(crate) const OCR2_DIR: &str = r"models\unlimited-ocr-2";

pub(crate) fn installed2(root: &Path) -> bool {
    root.join("envs").join("ocr2").join("Scripts").join("python.exe").exists()
        && root.join(OCR2_DIR).join("model-00002-of-00002.safetensors").exists()
        && root.join("tools").join("ocr2.py").exists()
}

/// Every page of a document, read together by Unlimited-OCR-2, as Markdown (one string a page).
pub(crate) fn read_document(root: &Path, pages: &[Vec<u8>]) -> Result<Vec<String>, String> {
    if !installed2(root) {
        return Err("reading whole documents needs the Read whole documents pack (Unlimited-OCR-2): add it in Packs".into());
    }
    // The pictures go to a folder of their own for the run (as PNG or JPEG, no bigger than needed).
    let dir = std::env::temp_dir().join(format!("prestige-ocr2-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for (i, p) in pages.iter().enumerate() {
        let (img, mime) = prepared(p)?;
        let f = dir.join(format!("page-{:03}.{}", i + 1, if mime == "image/jpeg" { "jpg" } else { "png" }));
        fs::write(&f, img).map_err(|e| e.to_string())?;
        files.push(f);
    }
    // The chat model and the other llama.cpp models make room on the GPU first.
    free_llama();
    let out = hidden(&mut Command::new(root.join("envs").join("ocr2").join("Scripts").join("python.exe")))
        .arg(root.join("tools").join("ocr2.py"))
        .arg(root.join(OCR2_DIR))
        .args(&files)
        .current_dir(root)
        .env("PYTHONIOENCODING", "utf-8")
        // The model's code is cached by its folder's name; a cache of its own keeps another copy's from clashing.
        .env("HF_MODULES_CACHE", root.join("data").join("ocr2-modules"))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("couldn't start Unlimited-OCR-2: {e}"));
    let _ = fs::remove_dir_all(&dir);
    let out = out?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
    let v: serde_json::Value = serde_json::from_str(line).map_err(|_| {
        let err = String::from_utf8_lossy(&out.stderr);
        format!("Unlimited-OCR-2 ended without a result: {}", err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no message"))
    })?;
    if let Some(e) = v["error"].as_str() {
        return Err(e.to_string());
    }
    let mut md = pages_to_markdown(v["text"].as_str().unwrap_or(""));
    // One string a page, whatever the model's page marks said.
    md.resize(pages.len(), String::new());
    Ok(md)
}

/// Unloads what llama.cpp's router has loaded, so Unlimited-OCR-2's ~7.3 GB fits.
fn free_llama() {
    let Ok(r) = ureq::get(&format!("{}/v1/models", router())).timeout(std::time::Duration::from_secs(3)).call() else { return };
    let v: serde_json::Value = serde_json::from_str(&r.into_string().unwrap_or_default()).unwrap_or_default();
    for m in v["data"].as_array().into_iter().flatten() {
        if m["status"]["value"].as_str().is_some_and(|s| s != "unloaded") {
            let body = serde_json::json!({ "model": m["id"] }).to_string();
            let _ = ureq::post(&format!("{}/models/unload", router())).timeout(std::time::Duration::from_secs(30)).set("Content-Type", "application/json").send_string(&body);
        }
    }
}

/// Unlimited-OCR-2's output: `<PAGE>` before each page, then `<BLOCK>kind<LEVELn>[x0, y0, x1, y1]<FORK>content`
/// blocks in reading order (tables as HTML).
pub(crate) fn pages_to_markdown(raw: &str) -> Vec<String> {
    let raw = raw.replace("<｜end▁of▁sentence｜>", "").replace("<|end▁of▁sentence|>", "");
    raw.split("<PAGE>").skip(usize::from(raw.trim_start().starts_with("<PAGE>"))).map(page_markdown).collect()
}

fn page_markdown(page: &str) -> String {
    let mut blocks: Vec<String> = Vec::new();
    for part in page.split("<BLOCK>") {
        let Some((head, body)) = part.split_once("<FORK>") else {
            if !part.trim().is_empty() {
                blocks.push(part.trim().to_string());
            }
            continue;
        };
        let body = body.trim();
        if body.is_empty() {
            continue;
        }
        let kind = head.split(['<', '[']).next().unwrap_or("text").trim().to_ascii_lowercase();
        let level = head.split("<LEVEL").nth(1).and_then(|r| r.split('>').next()).and_then(|n| n.parse::<usize>().ok()).unwrap_or(1).clamp(1, 4);
        blocks.push(match kind.as_str() {
            "title" | "doc_title" | "paragraph_title" | "section_title" | "sub_title" => format!("{} {body}", "#".repeat(level)),
            "table" => html_table(body),
            "equation" | "formula" | "interline_equation" => format!("$$\n{}\n$$", body.trim_matches('$').trim()),
            "page_number" | "page_header" | "page_footer" | "header" | "footer" | "image" | "figure" | "chart" | "seal" => continue,
            _ => body.to_string(),
        });
    }
    blocks.join("\n\n")
}

/// The text of a picture of a page, as Markdown.
pub(crate) fn read_image(root: Option<String>, bytes: &[u8]) -> Result<String, String> {
    let root = root_of(root);
    ensure(&root)?;
    let (img, mime) = prepared(bytes)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(img);
    let body = serde_json::json!({
        "model": ID,
        "messages": [{ "role": "user", "content": [
            { "type": "text", "text": PROMPT },
            { "type": "image_url", "image_url": { "url": format!("data:{mime};base64,{b64}") } },
        ]}],
        "temperature": 0,
        "max_tokens": 8192,
        // Baidu blocks repeating 35-token runs; DRY does the same job in llama.cpp.
        "dry_multiplier": 0.8,
        "dry_allowed_length": 32,
        "dry_penalty_last_n": 1024,
    });
    let res = ureq::post(&format!("{}/v1/chat/completions", router()))
        .timeout(std::time::Duration::from_secs(900))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string());
    let v: serde_json::Value = match res {
        Ok(r) => serde_json::from_str(&r.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(code, r)) => return Err(format!("llama.cpp answered {code}: {}", r.into_string().unwrap_or_default().chars().take(200).collect::<String>())),
        Err(_) => return Err("llama.cpp isn't running".into()),
    };
    let raw = v["choices"][0]["message"]["content"].as_str().unwrap_or("");
    Ok(to_markdown(raw))
}

/// Unlimited-OCR's page: `<|det|>kind [x0, y0, x1, y1]<|/det|>content` blocks in reading order, tables as HTML.
pub(crate) fn to_markdown(raw: &str) -> String {
    let raw = raw.replace("<｜end▁of▁sentence｜>", "").replace("<|end▁of▁sentence|>", "");
    let mut blocks: Vec<String> = Vec::new();
    let parts: Vec<&str> = raw.split("<|det|>").collect();
    // Text before the first mark (a model that answers without them) is kept as it is.
    if !parts[0].trim().is_empty() {
        blocks.push(parts[0].trim().to_string());
    }
    for part in &parts[1..] {
        let (head, body) = part.split_once("<|/det|>").unwrap_or(("text", part));
        let kind = head.split_whitespace().next().unwrap_or("text").to_ascii_lowercase();
        let body = body.trim();
        if body.is_empty() {
            continue;
        }
        blocks.push(match kind.as_str() {
            "title" | "doc_title" => format!("# {body}"),
            "sub_title" | "subtitle" | "section_title" | "paragraph_title" | "header" => format!("## {body}"),
            "table" => html_table(body),
            "equation" | "formula" | "interline_equation" => format!("$$\n{}\n$$", body.trim_matches('$').trim()),
            "image" | "figure" | "chart" | "seal" => continue,
            _ => body.to_string(),
        });
    }
    blocks.join("\n\n")
}

/// An HTML table as a Markdown table (the first row is the header; merged cells take one column).
fn html_table(html: &str) -> String {
    let cell_text = |s: &str| {
        let mut out = String::new();
        let mut tag = false;
        for c in s.chars() {
            match c {
                '<' => tag = true,
                '>' => tag = false,
                _ if !tag => out.push(c),
                _ => {}
            }
        }
        out.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ").replace('|', "\\|").split_whitespace().collect::<Vec<_>>().join(" ")
    };
    // Each <tr>'s <td> and <th> cells.
    let rows: Vec<Vec<String>> = html
        .split("<tr")
        .skip(1)
        .map(|r| r.split("<t").skip(1).filter(|c| ["d>", "d ", "h>", "h "].iter().any(|p| c.starts_with(p))).map(|c| cell_text(&format!("<t{c}"))).collect())
        .collect();
    let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    if width == 0 {
        return cell_text(html);
    }
    let line = |r: &Vec<String>| format!("| {} |", (0..width).map(|i| r.get(i).map(String::as_str).unwrap_or("")).collect::<Vec<_>>().join(" | "));
    let mut out = vec![line(&rows[0]), format!("|{}", " --- |".repeat(width))];
    out.extend(rows[1..].iter().map(line));
    out.join("\n")
}

// ---------- scanned PDFs ----------

/// The picture on each page of a PDF that has one big picture per page (what scanners make), by page number from 1.
/// Pages without one are left out.
pub(crate) fn pdf_page_images(bytes: &[u8]) -> Vec<(u32, Vec<u8>)> {
    let Ok(doc) = lopdf::Document::load_mem(bytes) else { return Vec::new() };
    let mut out = Vec::new();
    for (n, page) in doc.get_pages() {
        let Ok(images) = doc.get_page_images(page) else { continue };
        // The biggest picture on the page is the scan.
        let Some(img) = images.into_iter().max_by_key(|i| i.width * i.height) else { continue };
        let filters = img.filters.clone().unwrap_or_default();
        let png = if filters.iter().any(|f| f == "DCTDecode") {
            Some(img.content.to_vec())
        } else if filters.iter().all(|f| f == "FlateDecode") {
            raw_to_png(&doc, &img)
        } else {
            None // JBIG2, CCITT: not read here
        };
        if let Some(p) = png {
            out.push((n, p));
        }
    }
    out
}

/// An 8-bit grey or RGB picture stored raw (Flate-compressed) in a PDF, as a PNG.
fn raw_to_png(doc: &lopdf::Document, img: &lopdf::xobject::PdfImage) -> Option<Vec<u8>> {
    if img.bits_per_component != Some(8) {
        return None;
    }
    let stream = doc.get_object(img.id).ok()?.as_stream().ok()?;
    let data = stream.decompressed_content().ok()?;
    let (w, h) = (img.width as u32, img.height as u32);
    let buf = match img.color_space.as_deref() {
        Some("DeviceGray") if data.len() >= (w * h) as usize => image::DynamicImage::ImageLuma8(image::GrayImage::from_raw(w, h, data[..(w * h) as usize].to_vec())?),
        Some("DeviceRGB") if data.len() >= (w * h * 3) as usize => image::DynamicImage::ImageRgb8(image::RgbImage::from_raw(w, h, data[..(w * h * 3) as usize].to_vec())?),
        _ => return None,
    };
    let mut out = std::io::Cursor::new(Vec::new());
    buf.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

// ---------- commands ----------

/// Whether reading documents can work: the pack is there (and whether llama.cpp knows the model yet).
#[tauri::command]
pub fn ocr_status(root: Option<String>) -> serde_json::Value {
    let root = root_of(root);
    serde_json::json!({ "installed": installed(&root), "configured": configured(&root), "accurate": installed2(&root) })
}

/// The text of a picture (a render, or a file from the PC), as Markdown, and how long it took. `accurate`: read
/// it with Unlimited-OCR-2 (slower, better on a full page of text).
#[tauri::command]
pub async fn ocr_read(root: Option<String>, path: String, accurate: Option<bool>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
        let t0 = std::time::Instant::now();
        let markdown = if accurate == Some(true) {
            read_document(&root_of(root), &[bytes])?.remove(0)
        } else {
            read_image(root, &bytes)?
        };
        Ok(serde_json::json!({ "markdown": markdown, "secs": t0.elapsed().as_secs_f64() }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_become_markdown() {
        let raw = "<|det|>title [49, 53, 411, 93]<|/det|>Invoice No. 2026-1043\n<|det|>text [46, 119, 152, 142]<|/det|>R.G. Studios\n<|det|>table [41, 298, 894, 504]<|/det|><table><tr><td>Item</td><td>Qty</td></tr><tr><td>Cabin render, 4K</td><td>2</td></tr></table>\n<|det|>image [0, 0, 9, 9]<|/det|>\n<|det|>text [44, 611, 620, 661]<|/det|>Thanks | bye<｜end▁of▁sentence｜>";
        assert_eq!(
            to_markdown(raw),
            "# Invoice No. 2026-1043\n\nR.G. Studios\n\n| Item | Qty |\n| --- | --- |\n| Cabin render, 4K | 2 |\n\nThanks | bye"
        );
    }

    #[test]
    fn tables_keep_their_shape() {
        let t = html_table("<table><tr><th>A</th><th>B</th></tr><tr><td>1 &amp; 2</td></tr></table>");
        assert_eq!(t, "| A | B |\n| --- | --- |\n| 1 & 2 |  |");
        assert_eq!(html_table("<table><tr><td>x|y</td></tr></table>"), "| x\\|y |\n| --- |");
    }

    #[test]
    fn whole_documents_become_markdown() {
        let raw = "<PAGE><BLOCK>title<LEVEL1>[88, 72, 335, 96]<FORK>Cabin Project Report\n<BLOCK>text[86, 126, 474, 142]<FORK>Prepared by R.G. Studios.\n<BLOCK>page_number[475, 932, 560, 948]<FORK>Page 1 of 3\n<PAGE><BLOCK>title<LEVEL2>[84, 76, 167, 97]<FORK>Budget\n<BLOCK>table[84, 167, 830, 306]<FORK><table><tr><td>Item</td><td>Cost</td></tr><tr><td>Windows</td><td>6,480</td></tr></table>";
        assert_eq!(
            pages_to_markdown(raw),
            vec!["# Cabin Project Report\n\nPrepared by R.G. Studios.".to_string(), "## Budget\n\n| Item | Cost |\n| --- | --- |\n| Windows | 6,480 |".to_string()]
        );
    }

    #[test]
    fn text_without_marks_is_kept() {
        assert_eq!(to_markdown("Just text."), "Just text.");
    }
}
