// Knowledge: chat with your files. Files (PDF, Word, text, Markdown, code…) are read here, cut into passages that remember
// their page (or line), and each passage is embedded by an Ollama embedding model. The vectors stay in the app data folder
// (knowledge\), and a search compares a question's vector with every passage's (cosine similarity, all on this PC).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// The workstation's Ollama (PRESTIGE_OLLAMA overrides it, for tests against a second server).
fn ollama() -> String {
    std::env::var("PRESTIGE_OLLAMA").unwrap_or_else(|_| "http://127.0.0.1:11434".into())
}
/// About 200-250 tokens per passage, with a little overlap so a sentence cut at the edge is still found.
const CHUNK: usize = 1000;
const OVERLAP: usize = 150;
const BATCH: usize = 16;
const MAX_FILE: u64 = 300 * 1024 * 1024;
const MAX_FOLDER_FILES: usize = 3000;

const TEXT_EXT: &[&str] = &[
    "txt", "md", "markdown", "rst", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "log", "xml",
    "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "rs", "go", "java", "kt", "c", "h", "cpp", "hpp", "cc", "cs", "ps1", "psm1",
    "sh", "bat", "cmd", "sql", "css", "scss", "lua", "rb", "php", "swift", "r", "tex", "srt", "vtt",
];
const SKIP_DIRS: &[&str] = &["node_modules", ".git", "target", "dist", "build", "__pycache__", ".venv", "venv", "envs", ".cache"];

pub fn supported(p: &Path) -> bool {
    let e = ext(p);
    e == "pdf" || e == "docx" || e == "html" || e == "htm" || TEXT_EXT.contains(&e.as_str())
}

fn ext(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    pub id: String,
    pub name: String,
    /// The file it was read from (for a dropped file, Prestige's own copy in knowledge\files).
    pub path: String,
    pub kind: String,
    pub bytes: u64,
    pub added: u64,
    #[serde(default)]
    pub pages: u32,
    #[serde(default)]
    pub chunks: u32,
    #[serde(default)]
    pub model: String,
    /// "queued", "reading", "embedding", "ready" or "error".
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The folder it came in with, so a folder can be listed (and removed) as one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Chunk {
    #[serde(skip_serializing_if = "Option::is_none")]
    page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<u32>,
    text: String,
}

struct Vectors {
    chunks: Vec<Chunk>,
    dim: usize,
    data: Vec<f32>, // chunks × dim, each row normalised
}

#[derive(Default)]
pub struct Knowledge {
    docs: Mutex<Option<Vec<Doc>>>,
    vectors: Mutex<HashMap<String, Arc<Vectors>>>,
    queue: Mutex<Vec<(String, String)>>, // (doc id, embedding model)
    working: Mutex<bool>,
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::data_dir(app, "knowledge")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn new_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    format!("{:x}{:x}", now_ms(), N.fetch_add(1, Ordering::SeqCst) & 0xfff)
}

fn safe(id: &str) -> Result<&str, String> {
    if !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric()) {
        Ok(id)
    } else {
        Err("invalid file id".into())
    }
}

fn with_docs<T>(app: &AppHandle, f: impl FnOnce(&mut Vec<Doc>) -> T) -> Result<T, String> {
    access(app, true, f)
}

/// The library without saving it again (for lookups).
fn read_docs<T>(app: &AppHandle, f: impl FnOnce(&Vec<Doc>) -> T) -> Result<T, String> {
    access(app, false, |d| f(d))
}

fn access<T>(app: &AppHandle, write: bool, f: impl FnOnce(&mut Vec<Doc>) -> T) -> Result<T, String> {
    let kb = app.state::<Knowledge>();
    let mut guard = kb.docs.lock().unwrap();
    if guard.is_none() {
        let path = dir(app)?.join("library.json");
        let mut docs: Vec<Doc> = fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        // A file that was being read when Prestige closed is picked up again by kb_resume.
        for d in docs.iter_mut().filter(|d| d.state != "ready" && d.state != "error") {
            d.state = "queued".into();
        }
        *guard = Some(docs);
    }
    let docs = guard.as_mut().unwrap();
    let out = f(docs);
    if !write {
        return Ok(out);
    }
    let text = serde_json::to_string_pretty(&*docs).map_err(|e| e.to_string())?;
    fs::write(dir(app)?.join("library.json"), text).map_err(|e| e.to_string())?;
    Ok(out)
}

fn emit(app: &AppHandle, doc: &Doc, done: usize, total: usize) {
    let _ = app.emit("kb-progress", serde_json::json!({ "doc": doc, "done": done, "total": total }));
}

// ---------- reading files ----------

/// The text of a file, one entry per page for a PDF (and one entry for everything else).
fn read_pages(path: &Path) -> Result<(Vec<String>, bool), String> {
    let e = ext(path);
    let meta = fs::metadata(path).map_err(|e| format!("can't open it: {e}"))?;
    if meta.len() > MAX_FILE {
        return Err(format!("it's {} MB; the limit is {} MB", meta.len() / 1_048_576, MAX_FILE / 1_048_576));
    }
    match e.as_str() {
        "pdf" => {
            let bytes = fs::read(path).map_err(|e| e.to_string())?;
            // pdf-extract panics on some unusual PDFs; treat that as an unreadable file instead of losing the app.
            let pages = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(&bytes))
                .map_err(|_| "this PDF couldn't be read".to_string())?
                .map_err(|e| format!("this PDF couldn't be read: {e}"))?;
            Ok((pages, true))
        }
        "docx" => Ok((vec![read_docx(path)?], false)),
        "html" | "htm" => Ok((vec![strip_tags(&read_text(path)?)], false)),
        _ => Ok((vec![read_text(path)?], false)),
    }
}

fn read_text(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    // UTF-16 with a byte-order mark (Windows' "Unicode" text files), otherwise UTF-8 (lossy).
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let u: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return Ok(String::from_utf16_lossy(&u));
    }
    let s = String::from_utf8_lossy(&bytes).into_owned();
    if s.contains('\0') {
        return Err("it looks like a binary file, not text".into());
    }
    Ok(s.trim_start_matches('\u{feff}').to_string())
}

/// A Word document's text: word/document.xml, one line per paragraph.
fn read_docx(path: &Path) -> Result<String, String> {
    let f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(f).map_err(|_| "not a valid .docx file".to_string())?;
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .map_err(|_| "not a valid .docx file".to_string())?
        .read_to_string(&mut xml)
        .map_err(|e| e.to_string())?;
    let xml = xml.replace("</w:p>", "\n").replace("<w:tab/>", "\t").replace("<w:br/>", "\n");
    Ok(strip_tags(&xml))
}

/// Text without its tags (and without scripts and styles), entities decoded.
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len() / 2);
    let lower = s.to_ascii_lowercase();
    let mut i = 0;
    let b = s.as_bytes();
    while i < b.len() {
        if b[i] == b'<' {
            for skip in ["script", "style"] {
                if lower[i + 1..].starts_with(skip) {
                    if let Some(end) = lower[i..].find(&format!("</{skip}")) {
                        i += end;
                    }
                }
            }
            match s[i..].find('>') {
                Some(end) => {
                    let tag = &lower[i..i + end];
                    if tag.starts_with("<br") || tag.starts_with("</p") || tag.starts_with("</div") || tag.starts_with("</li") || tag.starts_with("</h") || tag.starts_with("</tr") {
                        out.push('\n');
                    }
                    i += end + 1;
                }
                None => break,
            }
        } else {
            let next = s[i..].find('<').map(|n| i + n).unwrap_or(s.len());
            out.push_str(&s[i..next]);
            i = next;
        }
    }
    out.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'").replace("&amp;", "&")
}

/// Cuts a page into passages of about CHUNK characters, at paragraph or sentence ends where it can.
/// `first_line`: the line the page starts on, for files without pages (citations then say "line N").
fn chunk_page(text: &str, page: Option<u32>, lines: bool) -> Vec<Chunk> {
    let mut out = Vec::new();
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let n = chars.len();
    let mut start = 0;
    while start < n {
        let mut end = (start + CHUNK).min(n);
        if end < n {
            // Prefer a paragraph break, then a sentence end, then a space, in the last third of the passage.
            let from = start + CHUNK * 2 / 3;
            let window = |pred: &dyn Fn(usize) -> bool| (from..end).rev().find(|&k| pred(k));
            let para = window(&|k| chars[k].1 == '\n' && k + 1 < n && chars[k + 1].1 == '\n');
            let sent = window(&|k| matches!(chars[k].1, '.' | '!' | '?') && k + 1 < n && chars[k + 1].1.is_whitespace());
            let space = window(&|k| chars[k].1.is_whitespace());
            if let Some(k) = para.or(sent).or(space) {
                end = k + 1;
            }
        }
        let a = chars[start].0;
        let z = if end < n { chars[end].0 } else { text.len() };
        let piece = text[a..z].split_whitespace().collect::<Vec<_>>().join(" ");
        if piece.chars().filter(|c| c.is_alphanumeric()).count() >= 20 {
            let line = if lines { Some(text[..a].matches('\n').count() as u32 + 1) } else { None };
            out.push(Chunk { page, line, text: piece });
        }
        if end >= n {
            break;
        }
        // Step back a little for the overlap, to the start of a word.
        let mut next = end.saturating_sub(OVERLAP).max(start + 1);
        while next < end && !chars[next - 1].1.is_whitespace() {
            next += 1;
        }
        start = next;
    }
    out
}

// ---------- embeddings ----------

/// What a model wants in front of a passage or a question (Qwen3-Embedding and nomic-embed are trained with these).
fn prefix(model: &str, query: bool) -> &'static str {
    let m = model.to_ascii_lowercase();
    if m.contains("qwen3-embedding") {
        if query { "Instruct: Given a question, retrieve passages from the user's documents that answer it\nQuery: " } else { "" }
    } else if m.contains("nomic-embed") {
        if query { "search_query: " } else { "search_document: " }
    } else if m.contains("mxbai-embed") && query {
        "Represent this sentence for searching relevant passages: "
    } else {
        ""
    }
}

fn embed(model: &str, texts: &[String], query: bool) -> Result<Vec<Vec<f32>>, String> {
    let input: Vec<String> = texts.iter().map(|t| format!("{}{}", prefix(model, query), t)).collect();
    let body = serde_json::json!({
        "model": model, "input": input, "truncate": true, "keep_alive": "10m",
        // The workstation sets a big default context for chat models; passages are short.
        "options": { "num_ctx": 2048 },
    });
    let res = ureq::post(&format!("{}/api/embed", ollama()))
        .timeout(std::time::Duration::from_secs(600))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string());
    let v: serde_json::Value = match res {
        Ok(r) => serde_json::from_str(&r.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            if text.contains("not found") {
                return Err(format!("the embedding model {model} isn't installed"));
            }
            return Err(format!("Ollama answered {code}: {}", text.chars().take(200).collect::<String>()));
        }
        Err(_) => return Err("Ollama isn't running".into()),
    };
    let rows = v["embeddings"].as_array().ok_or("Ollama returned no embeddings")?;
    Ok(rows
        .iter()
        .map(|r| {
            let mut x: Vec<f32> = r.as_array().map(|a| a.iter().map(|f| f.as_f64().unwrap_or(0.0) as f32).collect()).unwrap_or_default();
            let norm = x.iter().map(|f| f * f).sum::<f32>().sqrt();
            if norm > 0.0 {
                x.iter_mut().for_each(|f| *f /= norm);
            }
            x
        })
        .collect())
}

// ---------- the store ----------

fn save_vectors(app: &AppHandle, id: &str, v: &Vectors) -> Result<(), String> {
    let d = dir(app)?;
    fs::write(d.join(format!("{id}.chunks.json")), serde_json::to_string(&v.chunks).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(4 + v.data.len() * 4);
    bytes.extend_from_slice(&(v.dim as u32).to_le_bytes());
    for f in &v.data {
        bytes.extend_from_slice(&f.to_le_bytes());
    }
    fs::write(d.join(format!("{id}.vec")), bytes).map_err(|e| e.to_string())
}

fn load_vectors(app: &AppHandle, id: &str) -> Option<Arc<Vectors>> {
    let kb = app.state::<Knowledge>();
    if let Some(v) = kb.vectors.lock().unwrap().get(id) {
        return Some(v.clone());
    }
    let d = dir(app).ok()?;
    let chunks: Vec<Chunk> = serde_json::from_str(&fs::read_to_string(d.join(format!("{id}.chunks.json"))).ok()?).ok()?;
    let bytes = fs::read(d.join(format!("{id}.vec"))).ok()?;
    let dim = u32::from_le_bytes(bytes.get(0..4)?.try_into().ok()?) as usize;
    let data: Vec<f32> = bytes[4..].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    if dim == 0 || data.len() != chunks.len() * dim {
        return None;
    }
    let v = Arc::new(Vectors { chunks, dim, data });
    kb.vectors.lock().unwrap().insert(id.to_string(), v.clone());
    Some(v)
}

fn remove_files(app: &AppHandle, doc: &Doc) {
    if let Ok(d) = dir(app) {
        let _ = fs::remove_file(d.join(format!("{}.chunks.json", doc.id)));
        let _ = fs::remove_file(d.join(format!("{}.vec", doc.id)));
        // Prestige's own copy of a dropped file (never the user's original).
        let copies = d.join("files");
        if Path::new(&doc.path).starts_with(&copies) {
            let _ = fs::remove_file(&doc.path);
        }
    }
    app.state::<Knowledge>().vectors.lock().unwrap().remove(&doc.id);
}

/// Reads, cuts and embeds one file.
fn index(app: &AppHandle, id: &str, model: &str) -> Result<(), String> {
    let set = |f: &dyn Fn(&mut Doc)| -> Option<Doc> {
        with_docs(app, |docs| docs.iter_mut().find(|d| d.id == id).map(|d| {
            f(d);
            d.clone()
        }))
        .ok()
        .flatten()
    };
    let Some(doc) = set(&|d| {
        d.state = "reading".into();
        d.error = None;
    }) else {
        return Ok(()); // removed while it waited
    };
    emit(app, &doc, 0, 0);
    let path = PathBuf::from(&doc.path);
    let (pages, paged) = read_pages(&path)?;
    let mut chunks = Vec::new();
    for (i, p) in pages.iter().enumerate() {
        chunks.extend(chunk_page(p, paged.then_some(i as u32 + 1), !paged));
    }
    if chunks.is_empty() {
        return Err(if paged { "no text in it (a scanned PDF needs OCR first)".into() } else { "no text in it".into() });
    }
    let n = chunks.len();
    let Some(doc) = set(&|d| {
        d.state = "embedding".into();
        d.pages = if paged { pages.len() as u32 } else { 0 };
        d.chunks = n as u32;
        d.model = model.to_string();
    }) else {
        return Ok(());
    };
    emit(app, &doc, 0, n);
    let mut data = Vec::new();
    let mut dim = 0;
    for (b, batch) in chunks.chunks(BATCH).enumerate() {
        // Stop early when the file was removed meanwhile.
        if !read_docs(app, |docs| docs.iter().any(|d| d.id == id))? {
            return Ok(());
        }
        let texts: Vec<String> = batch.iter().map(|c| c.text.clone()).collect();
        let rows = embed(model, &texts, false)?;
        if rows.len() != batch.len() {
            return Err("Ollama returned the wrong number of embeddings".into());
        }
        for r in rows {
            dim = r.len();
            data.extend(r);
        }
        emit(app, &doc, ((b + 1) * BATCH).min(n), n);
    }
    let v = Vectors { chunks, dim, data };
    save_vectors(app, id, &v)?;
    app.state::<Knowledge>().vectors.lock().unwrap().insert(id.to_string(), Arc::new(v));
    if let Some(doc) = set(&|d| d.state = "ready".into()) {
        emit(app, &doc, n, n);
    }
    Ok(())
}

/// Works through the queue on one background thread, a file at a time.
fn kick(app: &AppHandle) {
    let kb = app.state::<Knowledge>();
    {
        let mut w = kb.working.lock().unwrap();
        if *w {
            return;
        }
        *w = true;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        let next = {
            let kb = app.state::<Knowledge>();
            let mut q = kb.queue.lock().unwrap();
            if q.is_empty() {
                *kb.working.lock().unwrap() = false;
                None
            } else {
                Some(q.remove(0))
            }
        };
        let Some((id, model)) = next else { break };
        if let Err(e) = index(&app, &id, &model) {
            let doc = with_docs(&app, |docs| docs.iter_mut().find(|d| d.id == id).map(|d| {
                d.state = "error".into();
                d.error = Some(e.clone());
                d.clone()
            }))
            .ok()
            .flatten();
            if let Some(doc) = doc {
                emit(&app, &doc, 0, 0);
            }
        }
    });
}

fn enqueue(app: &AppHandle, ids: &[String], model: &str) {
    let kb = app.state::<Knowledge>();
    {
        let mut q = kb.queue.lock().unwrap();
        for id in ids {
            if !q.iter().any(|(x, _)| x == id) {
                q.push((id.clone(), model.to_string()));
            }
        }
    }
    kick(app);
}

/// Every supported file in a folder (and its subfolders), skipping hidden, build and package folders.
fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if out.len() >= MAX_FOLDER_FILES {
            return;
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') || name.starts_with('~') {
            continue;
        }
        if p.is_dir() {
            if !SKIP_DIRS.contains(&name.to_ascii_lowercase().as_str()) {
                walk(&p, out);
            }
        } else if supported(&p) {
            out.push(p);
        }
    }
}

/// (file, the folder it came in with, a name to show instead of the file's own)
type NewFile = (PathBuf, Option<String>, Option<String>);

fn add_files(app: &AppHandle, files: Vec<NewFile>, model: &str) -> Result<Vec<Doc>, String> {
    let added = with_docs(app, |docs| {
        let mut added = Vec::new();
        for (p, folder, shown) in files {
            let path = p.to_string_lossy().to_string();
            // Adding a file that's already there reads it again (it may have changed).
            if let Some(d) = docs.iter_mut().find(|d| d.path.eq_ignore_ascii_case(&path)) {
                d.state = "queued".into();
                d.error = None;
                d.bytes = fs::metadata(&p).map(|m| m.len()).unwrap_or(d.bytes);
                added.push(d.clone());
                continue;
            }
            let doc = Doc {
                id: new_id(),
                name: shown.unwrap_or_else(|| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone())),
                kind: ext(&p),
                bytes: fs::metadata(&p).map(|m| m.len()).unwrap_or(0),
                path,
                added: now_ms(),
                pages: 0,
                chunks: 0,
                model: model.to_string(),
                state: "queued".into(),
                error: None,
                folder,
            };
            docs.push(doc.clone());
            added.push(doc);
        }
        added
    })?;
    enqueue(app, &added.iter().map(|d| d.id.clone()).collect::<Vec<_>>(), model);
    Ok(added)
}

// ---------- commands ----------

#[tauri::command]
pub fn kb_list(app: AppHandle) -> Result<Vec<Doc>, String> {
    read_docs(&app, |docs| docs.clone())
}

/// Adds files and folders (every supported file inside) and starts reading them.
#[tauri::command]
pub fn kb_add_paths(app: AppHandle, paths: Vec<String>, model: String) -> Result<Vec<Doc>, String> {
    let mut files = Vec::new();
    for p in paths {
        let p = PathBuf::from(p);
        if p.is_dir() {
            let mut found = Vec::new();
            walk(&p, &mut found);
            let folder = p.to_string_lossy().to_string();
            files.extend(found.into_iter().map(|f| (f, Some(folder.clone()), None)));
        } else if p.is_file() {
            if !supported(&p) {
                return Err(format!("{} isn't a kind of file Prestige can read yet", p.file_name().unwrap_or_default().to_string_lossy()));
            }
            files.push((p, None, None));
        }
    }
    if files.is_empty() {
        return Err("no files Prestige can read there (PDF, Word, text, Markdown, code…)".into());
    }
    add_files(&app, files, &model)
}

/// A dropped file (its bytes, since a drop doesn't say where the file is): kept as a copy in knowledge\files.
#[tauri::command]
pub fn kb_add_bytes(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Vec<Doc>, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes".into());
    };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let name = header("x-name").map(|n| percent_decode(&n)).unwrap_or_else(|| "file.txt".into());
    let model = header("x-model").unwrap_or_default();
    let folder = header("x-folder").map(|f| percent_decode(&f)).filter(|f| !f.is_empty());
    let name: String = name.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    if !supported(Path::new(&name)) {
        return Err(format!("{name} isn't a kind of file Prestige can read yet"));
    }
    let copies = dir(&app)?.join("files");
    fs::create_dir_all(&copies).map_err(|e| e.to_string())?;
    // The same file dropped again (same name and size) is already here.
    let len = bytes.len() as u64;
    let known = read_docs(&app, |docs| {
        docs.iter().find(|d| d.name == name && d.bytes == len && d.state != "error" && Path::new(&d.path).starts_with(&copies)).cloned()
    })?;
    if let Some(d) = known {
        return Ok(vec![d]);
    }
    let dest = copies.join(format!("{}-{}", new_id(), name));
    fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    add_files(&app, vec![(dest, folder, Some(name))], &model)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
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

/// Opens a file or folder picker and adds what's picked. Returns the new entries (empty when cancelled).
#[tauri::command]
pub async fn kb_pick(app: AppHandle, folder: bool, model: String) -> Result<Vec<Doc>, String> {
    use tauri_plugin_dialog::DialogExt;
    let a = app.clone();
    let picked: Vec<String> = tauri::async_runtime::spawn_blocking(move || {
        let d = a.dialog().file();
        if folder {
            d.blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| vec![p.to_string_lossy().to_string()]).unwrap_or_default()
        } else {
            let mut exts = vec!["pdf", "docx", "html", "htm"];
            exts.extend_from_slice(TEXT_EXT);
            d.add_filter("Documents", &exts)
                .blocking_pick_files()
                .map(|v| v.into_iter().filter_map(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string()).collect())
                .unwrap_or_default()
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    if picked.is_empty() {
        return Ok(Vec::new());
    }
    kb_add_paths(app, picked, model)
}

/// Removes files from Knowledge (their passages and vectors; the user's own files stay where they are).
#[tauri::command]
pub fn kb_remove(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let gone = with_docs(&app, |docs| {
        let (gone, keep): (Vec<Doc>, Vec<Doc>) = docs.drain(..).partition(|d| ids.contains(&d.id));
        *docs = keep;
        gone
    })?;
    app.state::<Knowledge>().queue.lock().unwrap().retain(|(id, _)| !ids.contains(id));
    for d in gone {
        remove_files(&app, &d);
    }
    Ok(())
}

/// Reads files again (changed on disk, or a different embedding model).
#[tauri::command]
pub fn kb_reindex(app: AppHandle, ids: Vec<String>, model: String) -> Result<(), String> {
    with_docs(&app, |docs| {
        for d in docs.iter_mut().filter(|d| ids.contains(&d.id)) {
            d.state = "queued".into();
            d.error = None;
        }
    })?;
    for id in &ids {
        app.state::<Knowledge>().vectors.lock().unwrap().remove(id);
    }
    enqueue(&app, &ids, &model);
    Ok(())
}

/// Picks up files that were still waiting when Prestige last closed.
#[tauri::command]
pub fn kb_resume(app: AppHandle, model: String) -> Result<(), String> {
    let ids = with_docs(&app, |docs| docs.iter().filter(|d| d.state == "queued").map(|d| d.id.clone()).collect::<Vec<_>>())?;
    if !ids.is_empty() {
        enqueue(&app, &ids, &model);
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    doc: String,
    name: String,
    path: String,
    page: Option<u32>,
    line: Option<u32>,
    text: String,
    score: f32,
}

/// The passages most like `query`, best first, from the files in `ids` (or every ready file).
#[tauri::command]
pub async fn kb_search(app: AppHandle, query: String, ids: Option<Vec<String>>, k: Option<usize>) -> Result<Vec<Hit>, String> {
    let docs: Vec<Doc> = read_docs(&app, |docs| {
        docs.iter().filter(|d| d.state == "ready" && ids.as_ref().map_or(true, |ids| ids.contains(&d.id))).cloned().collect()
    })?;
    if docs.is_empty() || query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let k = k.unwrap_or(6).clamp(1, 40);
    tauri::async_runtime::spawn_blocking(move || {
        // Files embedded with different models can't be compared with one question vector: ask each model once.
        let mut by_model: HashMap<String, Vec<&Doc>> = HashMap::new();
        for d in &docs {
            by_model.entry(d.model.clone()).or_default().push(d);
        }
        let mut hits: Vec<Hit> = Vec::new();
        for (model, group) in by_model {
            let q = embed(&model, &[query.clone()], true)?.pop().ok_or("no embedding for the question")?;
            for d in group {
                let Some(v) = load_vectors(&app, &d.id) else { continue };
                if v.dim != q.len() {
                    continue;
                }
                for (i, c) in v.chunks.iter().enumerate() {
                    let row = &v.data[i * v.dim..(i + 1) * v.dim];
                    let score: f32 = row.iter().zip(&q).map(|(a, b)| a * b).sum();
                    hits.push(Hit { doc: d.id.clone(), name: d.name.clone(), path: d.path.clone(), page: c.page, line: c.line, text: c.text.clone(), score });
                }
            }
        }
        hits.sort_by(|a, b| b.score.total_cmp(&a.score));
        // Overlapping neighbours say the same thing twice; keep the better one.
        let mut out: Vec<Hit> = Vec::new();
        for h in hits {
            if out.len() >= k {
                break;
            }
            let dup = out.iter().any(|o| o.doc == h.doc && o.page == h.page && o.line.zip(h.line).map_or(o.line.is_none() && o.text == h.text, |(a, b)| a.abs_diff(b) <= 2));
            if !dup {
                out.push(h);
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens a file in its usual app; a PDF opens at the page when the default browser or reader takes #page=N.
#[tauri::command]
pub fn kb_open(app: AppHandle, id: String) -> Result<(), String> {
    safe(&id)?;
    let path = read_docs(&app, |docs| docs.iter().find(|d| d.id == id).map(|d| d.path.clone()))?.ok_or("that file isn't in Knowledge any more")?;
    if !Path::new(&path).exists() {
        return Err("the file isn't there any more (moved or deleted)".into());
    }
    crate::hidden(&mut std::process::Command::new("explorer.exe")).arg(&path).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_keep_pages_and_overlap() {
        let text = "The dragon sleeps under the mountain. ".repeat(80);
        let c = chunk_page(&text, Some(3), false);
        assert!(c.len() >= 3);
        assert!(c.iter().all(|x| x.page == Some(3) && x.text.len() <= CHUNK + 10));
        // Each passage ends on a sentence.
        assert!(c[0].text.ends_with('.'));
    }

    #[test]
    fn chunks_count_lines_for_text_files() {
        let text = (1..=200).map(|i| format!("line {i} has some words in it to read")).collect::<Vec<_>>().join("\n");
        let c = chunk_page(&text, None, true);
        assert_eq!(c[0].line, Some(1));
        assert!(c[1].line.unwrap() > 10);
    }

    #[test]
    fn short_or_empty_pages_make_no_chunks() {
        assert!(chunk_page("", Some(1), false).is_empty());
        assert!(chunk_page("  12  ", Some(1), false).is_empty());
    }

    #[test]
    fn handles_multibyte_text() {
        let text = "Ünïcödé façade — naïve café. ".repeat(100);
        let c = chunk_page(&text, None, true);
        assert!(!c.is_empty());
    }

    #[test]
    fn strips_html_and_docx_markup() {
        let s = strip_tags("<html><style>p{}</style><p>Hello &amp; welcome</p><script>x()</script><div>Bye</div></html>");
        assert!(s.contains("Hello & welcome") && s.contains("Bye") && !s.contains("x()") && !s.contains("p{}"));
    }

    #[test]
    fn decodes_percent_names() {
        assert_eq!(percent_decode("My%20Report%20%E2%80%94%20v2.pdf"), "My Report — v2.pdf");
        assert_eq!(percent_decode("plain.txt"), "plain.txt");
        assert_eq!(percent_decode("odd%2"), "odd%2");
    }

    /// KB_SAMPLE=path\to\file cargo test --lib reads_a_real_file -- --ignored --nocapture
    #[test]
    #[ignore]
    fn reads_a_real_file() {
        let p = PathBuf::from(std::env::var("KB_SAMPLE").expect("set KB_SAMPLE"));
        let (pages, paged) = read_pages(&p).unwrap();
        let chunks: Vec<Chunk> = pages.iter().enumerate().flat_map(|(i, t)| chunk_page(t, paged.then_some(i as u32 + 1), !paged)).collect();
        println!("{} pages, {} passages", pages.len(), chunks.len());
        for c in chunks.iter().take(3) {
            println!("[p {:?} l {:?}] {}", c.page, c.line, c.text.chars().take(160).collect::<String>());
        }
        assert!(!chunks.is_empty());
    }

    /// Needs Ollama with qwen3-embedding:0.6b (PRESTIGE_OLLAMA to use another server):
    /// cargo test --lib embeds_and_ranks -- --ignored --nocapture
    #[test]
    #[ignore]
    fn embeds_and_ranks() {
        let model = "qwen3-embedding:0.6b";
        let passages = [
            "The warranty covers the KeyLab controller for two years from the date of purchase, parts and labour.",
            "To set the DAW mode, press Map + Pad 2. The controller is then set up for FL Studio.",
            "Our quarterly revenue rose 12 percent, driven by strong sales in Europe and Asia.",
            "Sourdough needs a starter, flour, water and salt, and a long cold proof overnight.",
        ];
        let docs = embed(model, &passages.iter().map(|s| s.to_string()).collect::<Vec<_>>(), false).unwrap();
        for (q, want) in [("How long is the warranty?", 0), ("how do I switch the keyboard to DAW mode", 1), ("what ingredients for bread", 3)] {
            let qv = embed(model, &[q.to_string()], true).unwrap().pop().unwrap();
            let scores: Vec<f32> = docs.iter().map(|d| d.iter().zip(&qv).map(|(a, b)| a * b).sum()).collect();
            println!("{q}: {scores:.3?}");
            let best = scores.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
            assert_eq!(best, want);
        }
        let off = embed(model, &["who won the football match last night".to_string()], true).unwrap().pop().unwrap();
        let top = docs.iter().map(|d| d.iter().zip(&off).map(|(a, b)| a * b).sum::<f32>()).fold(f32::MIN, f32::max);
        println!("unrelated question, best score {top:.3}");
    }

    #[test]
    fn finds_supported_files() {
        assert!(supported(Path::new("a.PDF")) && supported(Path::new("b.docx")) && supported(Path::new("c.md")));
        assert!(!supported(Path::new("d.exe")) && !supported(Path::new("e.png")));
    }
}
