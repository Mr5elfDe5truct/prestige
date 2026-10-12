// Search everything by meaning: EmbeddingGemma 2 (google/embeddinggemma-2, the search pack) puts pictures, video
// frames, songs, chats and Knowledge files in one embedding space, so "the dragon in the rain" finds the render by
// what's in it, and "what did we say about the cabin" finds the chat. It runs in its own llama-server (the "search"
// service, :8893, on Ollama's card), which embeds a picture straight from its pixels.
//
// The index is in the app data folder (search\): index.json says what each vector is, vectors.bin holds them.
// Updating it embeds only what's new or changed since (a render by its mtime, a chat by when it was saved, a file by
// when it was read), so opening Search after a few new renders takes seconds.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

use crate::{data_dir, knowledge, stack_root, studio};

/// The search service's llama-server (PRESTIGE_EMBED overrides it, for tests against another server).
fn server() -> String {
    std::env::var("PRESTIGE_EMBED").unwrap_or_else(|_| "http://127.0.0.1:8893".into())
}
pub(crate) const PORT: u16 = 8893;
pub(crate) const MODEL: &str = "embeddinggemma-2-Q8_0.gguf";
pub(crate) const MMPROJ: &str = "mmproj-embeddinggemma-2-Q8_0.gguf";

/// A chat is cut into passages of about this many characters (EmbeddingGemma reads 8k tokens; shorter passages make
/// the snippet shown the part that matched).
const PASSAGE: usize = 1200;
/// Songs' lyrics and prompts past this are left out of their vector.
const MAX_TEXT: usize = 4000;
const BATCH: usize = 16;

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    /// What it is: "render:<path>", "chat:<id>:<n>" or "file:<id>:<n>".
    key: String,
    /// image, video, audio (a song), chat or file.
    kind: String,
    /// Results are grouped by this (the render's path, the chat or the file), so a chat shows once with its best part.
    group: String,
    /// Changes when the source does.
    stamp: String,
    title: String,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    page: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mtime: Option<f64>,
    /// How many vectors it has: a picture has one for its pixels and one for its prompt.
    rows: usize,
}

#[derive(Default, Serialize, Deserialize)]
struct IndexFile {
    model: String,
    dim: usize,
    updated: u64,
    entries: Vec<Entry>,
}

struct Index {
    file: IndexFile,
    data: Vec<f32>, // every entry's rows, in order, each normalised
}

#[derive(Default)]
pub struct Search {
    index: Mutex<Option<Arc<Index>>>,
    working: Mutex<bool>,
}

/// One thing to embed: text (with EmbeddingGemma's document prefix) or a picture.
enum Input {
    Text(String),
    Image(PathBuf),
}

struct Source {
    entry: Entry,
    inputs: Vec<Input>,
}

#[derive(Serialize)]
pub struct Hit {
    kind: String,
    score: f32,
    title: String,
    text: String,
    group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mtime: Option<f64>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// ---------- the embedding server ----------

/// Why the search service isn't answering, from its log when it says (an old llama.cpp doesn't know the model).
fn not_running(root: &Path) -> String {
    let log = fs::read_to_string(root.join("logs").join("search.err.log")).unwrap_or_default();
    if log.contains("unknown model architecture") {
        "the search service needs llama.cpp b11452 or newer: update it in Packs (Engines), then restart the search service".into()
    } else if !root.join("models").join("gguf").join(MODEL).exists() {
        "add the Search pack in Packs (EmbeddingGemma 2, 0.9 GB)".into()
    } else {
        "the search service isn't running: start it in System (Services)".into()
    }
}

fn post(path: &str, body: &serde_json::Value) -> Result<serde_json::Value, ureq::Error> {
    let r = ureq::post(&format!("{}{path}", server()))
        .timeout(std::time::Duration::from_secs(300))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())?;
    Ok(serde_json::from_str(&r.into_string().unwrap_or_default()).unwrap_or_default())
}

fn check(root: &Path, r: Result<serde_json::Value, ureq::Error>) -> Result<serde_json::Value, String> {
    match r {
        Ok(v) => Ok(v),
        Err(ureq::Error::Status(code, r)) => Err(format!("the search service answered {code}: {}", clip(&r.into_string().unwrap_or_default(), 200))),
        Err(_) => Err(not_running(root)),
    }
}

fn normalised(v: &serde_json::Value) -> Vec<f32> {
    // /embeddings gives [[...]] per input (one row per pooled sequence), /v1/embeddings a flat list.
    let row = if v.get(0).is_some_and(|x| x.is_array()) { &v[0] } else { v };
    let mut x: Vec<f32> = row.as_array().map(|a| a.iter().map(|f| f.as_f64().unwrap_or(0.0) as f32).collect()).unwrap_or_default();
    let norm = x.iter().map(|f| f * f).sum::<f32>().sqrt();
    if norm > 0.0 {
        x.iter_mut().for_each(|f| *f /= norm);
    }
    x
}

fn embed_texts(root: &Path, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    let v = check(root, post("/v1/embeddings", &serde_json::json!({ "input": texts })))?;
    let mut rows: Vec<(u64, Vec<f32>)> = v["data"]
        .as_array()
        .ok_or("the search service returned no embeddings")?
        .iter()
        .map(|d| (d["index"].as_u64().unwrap_or(0), normalised(&d["embedding"])))
        .collect();
    rows.sort_by_key(|r| r.0);
    if rows.len() != texts.len() {
        return Err("the search service returned the wrong number of embeddings".into());
    }
    Ok(rows.into_iter().map(|r| r.1).collect())
}

/// The server's placeholder for a picture in a prompt (llama-server makes up a new one each start).
fn media_marker(root: &Path) -> Result<String, String> {
    let r = ureq::get(&format!("{}/props", server())).timeout(std::time::Duration::from_secs(10)).call().map_err(|_| not_running(root))?;
    let v: serde_json::Value = serde_json::from_str(&r.into_string().unwrap_or_default()).unwrap_or_default();
    v["media_marker"].as_str().map(String::from).ok_or_else(|| "the search service can't read pictures (its vision part, the mmproj file, is missing)".into())
}

fn embed_image(root: &Path, marker: &str, path: &Path) -> Result<Vec<f32>, String> {
    let b64 = base64::engine::general_purpose::STANDARD.encode(fs::read(path).map_err(|e| e.to_string())?);
    let v = check(root, post("/embeddings", &serde_json::json!({ "content": { "prompt_string": marker, "multimodal_data": [b64] } })))?;
    let first = v.get(0).ok_or("the search service returned no embedding for a picture")?;
    Ok(normalised(&first["embedding"]))
}

/// EmbeddingGemma's document format.
fn doc(title: &str, text: &str) -> String {
    format!("title: {} | text: {}", if title.trim().is_empty() { "none" } else { title.trim() }, clip(text.trim(), MAX_TEXT))
}

// ---------- what's indexed ----------

fn renders(app: &AppHandle, root: &Path) -> Vec<Source> {
    let dir = root.join("data").join("comfy-output");
    let Ok(items) = studio::assets(&dir, &app.state::<studio::GalleryCache>()) else { return Vec::new() };
    let mut out = Vec::new();
    for a in items {
        if a.kind == "model" {
            continue;
        }
        let prompt = a.prompt.clone().unwrap_or_default();
        let lyrics = a.lyrics.clone().unwrap_or_default();
        let mut inputs = Vec::new();
        if a.kind == "audio" {
            // A song by its style and its words.
            let words = if lyrics.trim().is_empty() || lyrics.trim().eq_ignore_ascii_case("[instrumental]") { "an instrumental".to_string() } else { lyrics.clone() };
            inputs.push(Input::Text(doc(&a.name, &format!("A song. Style: {prompt}\nLyrics:\n{words}"))));
        } else {
            // A picture by what's in it (a video by a frame), and by the prompt it was made from.
            if let Ok(t) = studio::make_thumb(app, &a.path, a.mtime) {
                inputs.push(Input::Image(t));
            }
            if !prompt.trim().is_empty() {
                inputs.push(Input::Text(doc("none", &prompt)));
            }
        }
        if inputs.is_empty() {
            continue;
        }
        let text = if a.kind == "audio" { format!("{prompt}{}", if lyrics.trim().is_empty() { String::new() } else { format!(" · {}", clip(lyrics.trim(), 160)) }) } else { prompt };
        out.push(Source {
            entry: Entry {
                key: format!("render:{}", a.path),
                kind: a.kind.clone(),
                group: a.path.clone(),
                stamp: format!("{}", a.mtime),
                title: a.name.clone(),
                text: clip(&text, 300),
                path: Some(a.path.clone()),
                page: None,
                mtime: Some(a.mtime),
                rows: 0,
            },
            inputs,
        });
    }
    out
}

/// A chat's words as passages: each message labelled with who said it, cut where a passage gets long.
fn chat_passages(v: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for m in v["messages"].as_array().into_iter().flatten() {
        let who = match m["role"].as_str() {
            Some("user") => "Me",
            Some("assistant") => "Prestige",
            _ => continue,
        };
        let text = m["content"].as_str().unwrap_or("").trim();
        if text.is_empty() {
            continue;
        }
        let line = format!("{who}: {text}\n");
        if !cur.is_empty() && cur.chars().count() + line.chars().count() > PASSAGE {
            out.push(std::mem::take(&mut cur));
        }
        // A very long message is cut on its own.
        let chars: Vec<char> = line.chars().collect();
        for piece in chars.chunks(PASSAGE) {
            if cur.chars().count() + piece.len() > PASSAGE && !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            cur.extend(piece);
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

fn chats(app: &AppHandle) -> Vec<Source> {
    let Ok(dir) = data_dir(app, "chats") else { return Vec::new() };
    let mut out = Vec::new();
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Some(v) = fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else { continue };
        let Some(id) = v["id"].as_str() else { continue };
        let title = v["title"].as_str().unwrap_or("Chat").to_string();
        let stamp = v["updated"].to_string();
        for (n, passage) in chat_passages(&v).into_iter().enumerate() {
            out.push(Source {
                entry: Entry {
                    key: format!("chat:{id}:{n}"),
                    kind: "chat".into(),
                    group: id.to_string(),
                    stamp: stamp.clone(),
                    title: title.clone(),
                    text: clip(passage.trim(), 300),
                    path: None,
                    page: None,
                    mtime: v["updated"].as_f64(),
                    rows: 0,
                },
                inputs: vec![Input::Text(doc(&title, &passage))],
            });
        }
    }
    out
}

fn files(app: &AppHandle) -> Vec<Source> {
    let mut out = Vec::new();
    for (d, chunks) in knowledge::passages(app) {
        let stamp = format!("{}:{}", d.added, chunks.len());
        for (n, (page, line, text)) in chunks.into_iter().enumerate() {
            out.push(Source {
                entry: Entry {
                    key: format!("file:{}:{n}", d.id),
                    kind: "file".into(),
                    group: d.id.clone(),
                    stamp: stamp.clone(),
                    title: d.name.clone(),
                    text: clip(text.trim(), 300),
                    path: Some(d.path.clone()),
                    page: page.or(line),
                    mtime: Some(d.added as f64),
                    rows: 0,
                },
                inputs: vec![Input::Text(doc(&d.name, &text))],
            });
        }
    }
    out
}

// ---------- the store ----------

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    data_dir(app, "search")
}

fn load(app: &AppHandle) -> Option<Arc<Index>> {
    let s = app.state::<Search>();
    if let Some(i) = s.index.lock().unwrap().as_ref() {
        return Some(i.clone());
    }
    let d = dir(app).ok()?;
    let file: IndexFile = serde_json::from_str(&fs::read_to_string(d.join("index.json")).ok()?).ok()?;
    let bytes = fs::read(d.join("vectors.bin")).ok()?;
    let data: Vec<f32> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let rows: usize = file.entries.iter().map(|e| e.rows).sum();
    if file.dim == 0 || data.len() != rows * file.dim {
        return None;
    }
    let i = Arc::new(Index { file, data });
    *s.index.lock().unwrap() = Some(i.clone());
    Some(i)
}

fn save(app: &AppHandle, i: Index) -> Result<(), String> {
    let d = dir(app)?;
    let mut bytes = Vec::with_capacity(i.data.len() * 4);
    for f in &i.data {
        bytes.extend_from_slice(&f.to_le_bytes());
    }
    fs::write(d.join("vectors.bin"), bytes).map_err(|e| e.to_string())?;
    fs::write(d.join("index.json"), serde_json::to_string(&i.file).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    *app.state::<Search>().index.lock().unwrap() = Some(Arc::new(i));
    Ok(())
}

/// Brings the index up to date: what's gone is dropped, what's unchanged keeps its vectors, the rest is embedded.
fn update(app: &AppHandle, root: &Path) -> Result<usize, String> {
    let mut sources = renders(app, root);
    sources.extend(chats(app));
    sources.extend(files(app));
    let old = load(app);
    let mut kept: HashMap<&str, (&Entry, &[f32])> = HashMap::new();
    if let Some(old) = old.as_ref() {
        let mut at = 0;
        for e in &old.file.entries {
            let n = e.rows * old.file.dim;
            kept.insert(e.key.as_str(), (e, &old.data[at..at + n]));
            at += n;
        }
    }
    let total = sources.iter().filter(|s| !kept.get(s.entry.key.as_str()).is_some_and(|(e, _)| e.stamp == s.entry.stamp)).count();
    let _ = app.emit("search-progress", serde_json::json!({ "done": 0, "total": total }));
    let mut marker: Option<String> = None;
    let mut entries = Vec::with_capacity(sources.len());
    let mut data = Vec::new();
    let mut dim = old.as_ref().map(|o| o.file.dim).unwrap_or(0);
    let mut done = 0;
    // Texts are embedded in batches, so the sources waiting on a batch are held until it's sent.
    let mut pending: Vec<(Entry, Vec<Option<Vec<f32>>>, Vec<(usize, String)>)> = Vec::new();
    let flush = |pending: &mut Vec<(Entry, Vec<Option<Vec<f32>>>, Vec<(usize, String)>)>, entries: &mut Vec<Entry>, data: &mut Vec<f32>, dim: &mut usize| -> Result<(), String> {
        let texts: Vec<String> = pending.iter().flat_map(|p| p.2.iter().map(|t| t.1.clone())).collect();
        let mut vecs = if texts.is_empty() { Vec::new() } else { embed_texts(root, &texts)? }.into_iter();
        for (mut e, mut rows, wanted) in pending.drain(..) {
            for (slot, _) in wanted {
                rows[slot] = vecs.next();
            }
            let rows: Vec<Vec<f32>> = rows.into_iter().flatten().collect();
            if rows.is_empty() {
                continue;
            }
            *dim = rows[0].len();
            e.rows = rows.len();
            rows.iter().for_each(|r| data.extend_from_slice(r));
            entries.push(e);
        }
        Ok(())
    };
    for s in sources {
        if let Some((e, v)) = kept.get(s.entry.key.as_str()).filter(|(e, _)| e.stamp == s.entry.stamp) {
            entries.push((*e).clone());
            data.extend_from_slice(v);
            continue;
        }
        let mut rows: Vec<Option<Vec<f32>>> = Vec::new();
        let mut wanted = Vec::new();
        for input in s.inputs {
            match input {
                Input::Image(p) => {
                    if marker.is_none() {
                        marker = Some(media_marker(root)?);
                    }
                    // A picture that can't be read is still found by its prompt.
                    rows.push(embed_image(root, marker.as_deref().unwrap(), &p).ok());
                }
                Input::Text(t) => {
                    wanted.push((rows.len(), t));
                    rows.push(None);
                }
            }
        }
        pending.push((s.entry, rows, wanted));
        done += 1;
        if pending.iter().map(|p| p.2.len()).sum::<usize>() >= BATCH || done % 25 == 0 {
            flush(&mut pending, &mut entries, &mut data, &mut dim)?;
            let _ = app.emit("search-progress", serde_json::json!({ "done": done, "total": total }));
        }
    }
    flush(&mut pending, &mut entries, &mut data, &mut dim)?;
    let count = entries.len();
    save(app, Index { file: IndexFile { model: MODEL.into(), dim, updated: now_ms(), entries }, data })?;
    let _ = app.emit("search-progress", serde_json::json!({ "done": total, "total": total }));
    Ok(count)
}

// ---------- commands ----------

/// Updates the index in the background; "search-progress" says how far it is and "search-done" when it's finished
/// (with an error, if it stopped).
#[tauri::command]
pub fn search_index(app: AppHandle, root: Option<String>) -> Result<bool, String> {
    let root = stack_root(root);
    {
        let s = app.state::<Search>();
        let mut w = s.working.lock().unwrap();
        if *w {
            return Ok(false);
        }
        *w = true;
    }
    std::thread::spawn(move || {
        let r = update(&app, &root);
        *app.state::<Search>().working.lock().unwrap() = false;
        let _ = app.emit("search-done", match r {
            Ok(n) => serde_json::json!({ "count": n }),
            Err(e) => serde_json::json!({ "error": e }),
        });
    });
    Ok(true)
}

/// What's in the index, per kind, and whether it's being updated.
#[tauri::command]
pub fn search_status(app: AppHandle) -> serde_json::Value {
    let working = *app.state::<Search>().working.lock().unwrap();
    let Some(i) = load(&app) else { return serde_json::json!({ "working": working, "counts": {}, "updated": null }) };
    let mut groups: HashMap<&str, std::collections::HashSet<&str>> = HashMap::new();
    for e in &i.file.entries {
        groups.entry(e.kind.as_str()).or_default().insert(e.group.as_str());
    }
    let counts: HashMap<&str, usize> = groups.into_iter().map(|(k, v)| (k, v.len())).collect();
    serde_json::json!({ "working": working, "counts": counts, "updated": i.file.updated })
}

/// The best matches for `query` (of the `kinds` asked for, or all), each render, chat or file once with its best part.
#[tauri::command]
pub async fn search_everything(app: AppHandle, root: Option<String>, query: String, kinds: Option<Vec<String>>, k: Option<usize>) -> Result<Vec<Hit>, String> {
    let root = stack_root(root);
    // The results show renders' thumbnails, which the webview may load even if Studio hasn't been opened.
    if let Ok(t) = data_dir(&app, "thumbs") {
        let _ = app.asset_protocol_scope().allow_directory(&t, false);
    }
    let Some(i) = load(&app) else { return Ok(Vec::new()) };
    if query.trim().is_empty() || i.file.entries.is_empty() {
        return Ok(Vec::new());
    }
    let k = k.unwrap_or(30).clamp(1, 200);
    tauri::async_runtime::spawn_blocking(move || {
        let q = embed_texts(&root, &[format!("task: search result | query: {}", query.trim())])?.pop().ok_or("no embedding for the search")?;
        if q.len() != i.file.dim {
            return Err("the index was made with another model: update it".into());
        }
        let mut best: HashMap<&str, (f32, &Entry)> = HashMap::new();
        let mut at = 0;
        for e in &i.file.entries {
            let n = e.rows * i.file.dim;
            let rows = &i.data[at..at + n];
            at += n;
            if kinds.as_ref().is_some_and(|ks| !ks.iter().any(|x| x == &e.kind)) {
                continue;
            }
            let score = rows.chunks_exact(i.file.dim).map(|r| r.iter().zip(&q).map(|(a, b)| a * b).sum::<f32>()).fold(f32::MIN, f32::max);
            let slot = best.entry(e.group.as_str()).or_insert((f32::MIN, e));
            if score > slot.0 {
                *slot = (score, e);
            }
        }
        let mut hits: Vec<Hit> = best
            .into_values()
            .map(|(score, e)| Hit { kind: e.kind.clone(), score, title: e.title.clone(), text: e.text.clone(), group: e.group.clone(), path: e.path.clone(), page: e.page, mtime: e.mtime })
            .collect();
        hits.sort_by(|a, b| b.score.total_cmp(&a.score));
        hits.truncate(k);
        Ok(hits)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chats_are_cut_into_passages() {
        let long = "word ".repeat(400);
        let v = serde_json::json!({ "messages": [
            { "role": "system", "content": "not this" },
            { "role": "user", "content": "Paint a cabin in the snow" },
            { "role": "assistant", "content": long },
            { "role": "user", "content": "thanks" },
        ]});
        let p = chat_passages(&v);
        assert!(p.len() >= 2, "{}", p.len());
        assert!(p.iter().all(|x| x.chars().count() <= PASSAGE));
        assert!(p[0].starts_with("Me: Paint a cabin"));
        assert!(!p.join("").contains("not this"));
        assert!(p.last().unwrap().contains("Me: thanks"));
    }

    #[test]
    fn documents_have_embeddinggemmas_prefix() {
        assert_eq!(doc("", "a fox"), "title: none | text: a fox");
        assert_eq!(doc("notes.md", " hi "), "title: notes.md | text: hi");
    }

    #[test]
    fn embeddings_are_normalised_either_shape() {
        let flat = normalised(&serde_json::json!([3.0, 4.0]));
        let nested = normalised(&serde_json::json!([[3.0, 4.0]]));
        assert_eq!(flat, vec![0.6, 0.8]);
        assert_eq!(nested, flat);
    }
}
