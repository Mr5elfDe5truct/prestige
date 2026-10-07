// Studio: the ComfyUI output gallery (with cached thumbnails and prompts read from file metadata)
// and a websocket bridge to ComfyUI's progress events.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter, Manager};

use crate::{data_dir, hidden, stack_root};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];
const VIDEO_EXT: &[&str] = &["mp4", "webm", "mov"];
const AUDIO_EXT: &[&str] = &["mp3", "flac", "opus", "ogg", "wav"];
const THUMB_SIZE: u32 = 360;

#[derive(Serialize, Clone, serde::Deserialize)]
pub struct Asset {
    path: String,
    name: String,
    kind: String, // image | video | audio
    mtime: f64,   // ms since epoch
    size: u64,
    prompt: Option<String>, // a song's style
    model: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    seed: Option<u64>,
    lyrics: Option<String>,  // a song's
    duration: Option<f64>,   // a song's length in seconds
}

fn is_media(x: &str) -> bool {
    IMAGE_EXT.contains(&x) || VIDEO_EXT.contains(&x) || AUDIO_EXT.contains(&x)
}

/// Metadata is cached per file (path + mtime) so the gallery doesn't re-read every file each refresh.
#[derive(Default)]
pub struct GalleryCache(Mutex<HashMap<String, (f64, Asset)>>);

pub fn output_dir(root: Option<String>) -> PathBuf {
    stack_root(root).join("data").join("comfy-output")
}

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth < 4 {
                walk(&p, out, depth + 1);
            }
        } else {
            if is_media(&ext_of(&p)) {
                out.push(p);
            }
        }
    }
}

/// The positive prompt, main model and seed from a ComfyUI API-format workflow (and a song's lyrics).
fn describe_workflow(json: &str) -> (Option<String>, Option<String>, Option<u64>, Option<String>) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return (None, None, None, None) };
    let Some(nodes) = v.as_object() else { return (None, None, None, None) };
    // Qwen-Image's encoder calls its text input "prompt", ACE-Step's its style "tags".
    let text_of = |id: &str| -> Option<String> {
        let i = &nodes.get(id)?["inputs"];
        i["text"].as_str().or(i["prompt"].as_str()).or(i["tags"].as_str()).map(String::from)
    };
    let lyrics = nodes.values().find_map(|n| n["inputs"]["lyrics"].as_str().map(String::from));
    // Follow the sampler's (or guider's) "positive" link to its text encoder.
    let mut prompt = None;
    for n in nodes.values() {
        if let Some(link) = n["inputs"]["positive"].as_array() {
            if let Some(id) = link.first().and_then(|x| x.as_str()) {
                prompt = text_of(id);
                if prompt.is_some() {
                    break;
                }
            }
        }
    }
    if prompt.is_none() {
        prompt = nodes
            .values()
            .filter(|n| n["class_type"].as_str().is_some_and(|c| c.starts_with("CLIPTextEncode")))
            .find_map(|n| n["inputs"]["text"].as_str().map(String::from));
    }
    let model = nodes.values().find_map(|n| {
        let i = &n["inputs"];
        i["unet_name"].as_str().or(i["ckpt_name"].as_str()).map(|m| {
            Path::new(m).file_stem().and_then(|s| s.to_str()).unwrap_or(m).to_string()
        })
    });
    // The first sampler's seed (lowest node id: LTX's second noise node is a refine pass).
    let seed = nodes
        .iter()
        .filter_map(|(id, n)| {
            let i = &n["inputs"];
            let s = i["seed"].as_u64().or(i["noise_seed"].as_u64())?;
            Some((id.parse::<u64>().unwrap_or(u64::MAX), s))
        })
        .min()
        .map(|(_, s)| s);
    (prompt, model, seed, lyrics)
}

/// ComfyUI stores the workflow as a PNG tEXt chunk named "prompt". Also returns the image size.
fn png_meta(path: &Path) -> (Option<String>, Option<(u32, u32)>) {
    let Ok(mut f) = fs::File::open(path) else { return (None, None) };
    let mut buf = Vec::new();
    // Text chunks come before the image data; 2 MB is plenty.
    if f.by_ref().take(2 * 1024 * 1024).read_to_end(&mut buf).is_err() || buf.len() < 33 || &buf[1..4] != b"PNG" {
        return (None, None);
    }
    let w = u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]]);
    let h = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]);
    let mut i = 8;
    while i + 12 <= buf.len() {
        let n = u32::from_be_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]) as usize;
        let kind = &buf[i + 4..i + 8];
        if kind == b"IDAT" || i + 12 + n > buf.len() {
            break;
        }
        if kind == b"tEXt" {
            let data = &buf[i + 8..i + 8 + n];
            if let Some(z) = data.iter().position(|b| *b == 0) {
                if &data[..z] == b"prompt" {
                    return (Some(String::from_utf8_lossy(&data[z + 1..]).into_owned()), Some((w, h)));
                }
            }
        }
        i += 12 + n;
    }
    (None, Some((w, h)))
}

/// ComfyUI's SaveVideo writes the workflow into the container's "prompt" tag; ffprobe reads it.
fn video_meta(path: &Path) -> (Option<String>, Option<(u32, u32)>) {
    let Ok(out) = hidden(&mut Command::new("ffprobe"))
        .args(["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", "-select_streams", "v:0"])
        .arg(path)
        .output()
    else {
        return (None, None);
    };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else { return (None, None) };
    let prompt = v["format"]["tags"]["prompt"].as_str().map(String::from);
    let s = &v["streams"][0];
    let size = match (s["width"].as_u64(), s["height"].as_u64()) {
        (Some(w), Some(h)) => Some((w as u32, h as u32)),
        _ => None,
    };
    (prompt, size)
}

/// ComfyUI's audio savers write the workflow into the file's "prompt" tag too; ffprobe reads it and the length.
fn audio_meta(path: &Path) -> (Option<String>, Option<f64>) {
    let Ok(out) = hidden(&mut Command::new("ffprobe")).args(["-v", "quiet", "-print_format", "json", "-show_format"]).arg(path).output() else {
        return (None, None);
    };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else { return (None, None) };
    let tags = &v["format"]["tags"];
    let prompt = tags["prompt"].as_str().or(tags["PROMPT"].as_str()).map(String::from);
    (prompt, v["format"]["duration"].as_str().and_then(|d| d.parse().ok()))
}

fn build_asset(p: &Path, mtime: f64, size: u64) -> Asset {
    let x = ext_of(p);
    let kind = if VIDEO_EXT.contains(&x.as_str()) {
        "video"
    } else if AUDIO_EXT.contains(&x.as_str()) {
        "audio"
    } else {
        "image"
    };
    let mut duration = None;
    let (wf, dims) = match x.as_str() {
        "png" => png_meta(p),
        _ if kind == "video" => video_meta(p),
        _ if kind == "audio" => {
            let (wf, d) = audio_meta(p);
            duration = d;
            (wf, None)
        }
        _ => (None, None),
    };
    let (prompt, model, seed, lyrics) = wf.as_deref().map(describe_workflow).unwrap_or((None, None, None, None));
    Asset {
        path: p.to_string_lossy().into_owned(),
        name: p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string(),
        kind: kind.into(),
        mtime,
        size,
        prompt,
        model,
        width: dims.map(|d| d.0),
        height: dims.map(|d| d.1),
        seed,
        lyrics: if kind == "audio" { lyrics } else { None },
        duration,
    }
}

/// Every image and video in ComfyUI's output folder, newest first.
#[tauri::command]
pub fn gallery_list(app: AppHandle, cache: tauri::State<GalleryCache>, root: Option<String>) -> Result<serde_json::Value, String> {
    let dir = output_dir(root);
    if !dir.exists() {
        return Ok(serde_json::json!({ "dir": dir.to_string_lossy(), "exists": false, "items": [] }));
    }
    // Let the webview load these files (and our thumbnails) through the asset protocol.
    let scope = app.asset_protocol_scope();
    let _ = scope.allow_directory(&dir, true);
    if let Ok(t) = data_dir(&app, "thumbs") {
        let _ = scope.allow_directory(&t, false);
    }

    let mut files = Vec::new();
    walk(&dir, &mut files, 0);
    let mut items = Vec::new();
    let mut c = cache.0.lock().map_err(|e| e.to_string())?;
    for p in files {
        let Ok(md) = fs::metadata(&p) else { continue };
        let mtime = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64).unwrap_or(0.0);
        let key = p.to_string_lossy().into_owned();
        let asset = match c.get(&key) {
            Some((m, a)) if *m == mtime => a.clone(),
            _ => {
                let a = build_asset(&p, mtime, md.len());
                c.insert(key, (mtime, a.clone()));
                a
            }
        };
        items.push(asset);
    }
    items.sort_by(|a, b| b.mtime.total_cmp(&a.mtime));
    Ok(serde_json::json!({ "dir": dir.to_string_lossy(), "exists": true, "items": items }))
}

/// A small cached JPEG for the grid, so full-size renders never load there.
#[tauri::command]
pub async fn thumbnail(app: AppHandle, path: String, mtime: f64) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let dir = data_dir(&app, "thumbs")?;
    let key = format!("{:x}", fxhash(&format!("{path}|{mtime}")));
    let out = dir.join(format!("{key}.jpg"));
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    let x = ext_of(&src);
    let out2 = out.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if VIDEO_EXT.contains(&x.as_str()) {
            let status = hidden(&mut Command::new("ffmpeg"))
                .args(["-v", "error", "-y", "-ss", "0.5", "-i"])
                .arg(&src)
                .args(["-frames:v", "1", "-vf", &format!("scale={THUMB_SIZE}:-2"), "-q:v", "4"])
                .arg(&out2)
                .status()
                .map_err(|e| format!("ffmpeg: {e}"))?;
            if !status.success() || !out2.exists() {
                return Err("ffmpeg couldn't read a frame".into());
            }
        } else {
            let img = image::open(&src).map_err(|e| e.to_string())?;
            let t = img.thumbnail(THUMB_SIZE * 2, THUMB_SIZE * 2).to_rgb8();
            t.save_with_format(&out2, image::ImageFormat::Jpeg).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(out.to_string_lossy().into_owned())
}

fn fxhash(s: &str) -> u64 {
    // FNV-1a: stable across runs, unlike std's randomized hasher.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Shows a file selected in File Explorer, or its folder if the file is gone.
#[tauri::command]
pub fn reveal(path: String) -> Result<(), String> {
    let p = PathBuf::from(path.replace('/', "\\"));
    let mut cmd = Command::new("explorer.exe");
    if p.exists() {
        // Explorer only reads /select when the path itself is quoted, not the whole argument (which is
        // what Command::arg does for a path with spaces, and Explorer then opens Documents instead).
        #[cfg(windows)]
        cmd.raw_arg(format!("/select,\"{}\"", p.display()));
    } else if let Some(dir) = p.parent().filter(|d| d.exists()) {
        cmd.arg(dir);
    } else {
        return Err("That file and its folder are gone".into());
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// A render the Studio may act on: an existing image, video or song inside ComfyUI's output folder.
pub(crate) fn render_path(root: Option<String>, path: &str) -> Result<PathBuf, String> {
    let dir = output_dir(root).canonicalize().map_err(|_| "ComfyUI's output folder doesn't exist".to_string())?;
    let p = PathBuf::from(path.replace('/', "\\"));
    let real = p.canonicalize().map_err(|_| "That file doesn't exist any more".to_string())?;
    if !real.starts_with(&dir) || !is_media(&ext_of(&real)) {
        return Err("Only renders in ComfyUI's output folder can be changed here".into());
    }
    // The checked path, but without canonicalize's \\?\ prefix, which Explorer and PowerShell don't take.
    Ok(p)
}

/// Runs a short PowerShell snippet with the file path in $env:PRESTIGE_PATH (never spliced into the script).
fn powershell(script: &str, path: &Path, sta: bool) -> Result<(), String> {
    let mut cmd = Command::new("powershell.exe");
    hidden(&mut cmd).args(["-NoProfile", "-NonInteractive"]);
    if sta {
        cmd.arg("-STA"); // the clipboard needs a single-threaded apartment
    }
    let out = cmd
        .args(["-Command", script])
        .env("PRESTIGE_PATH", path)
        .output()
        .map_err(|e| format!("powershell: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).lines().find(|l| !l.trim().is_empty()).unwrap_or("PowerShell failed").to_string())
    }
}

/// Opens a render in its default app (Photos, the video player, ...).
#[tauri::command]
pub fn open_render(root: Option<String>, path: String) -> Result<(), String> {
    let p = render_path(root, &path)?;
    let mut cmd = Command::new("explorer.exe");
    #[cfg(windows)]
    cmd.raw_arg(format!("\"{}\"", p.display()));
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Moves a render to the Recycle Bin and forgets its cached thumbnail and metadata.
#[tauri::command]
pub async fn delete_render(app: AppHandle, root: Option<String>, path: String, mtime: f64) -> Result<(), String> {
    let p = render_path(root, &path)?;
    let p2 = p.clone();
    tauri::async_runtime::spawn_blocking(move || {
        powershell(
            "Add-Type -AssemblyName Microsoft.VisualBasic; \
             [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:PRESTIGE_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')",
            &p2,
            false,
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    if p.exists() {
        return Err("Windows didn't move the file to the Recycle Bin".into());
    }
    if let Ok(dir) = data_dir(&app, "thumbs") {
        let _ = fs::remove_file(dir.join(format!("{:x}.jpg", fxhash(&format!("{path}|{mtime}")))));
    }
    if let Ok(mut c) = app.state::<GalleryCache>().0.lock() {
        c.remove(&path);
    }
    Ok(())
}

/// Puts a render on the clipboard: the picture itself (paste into chats, Paint, ...) or the file
/// (paste into Explorer, Discord, ...).
#[tauri::command]
pub async fn copy_render(root: Option<String>, path: String, as_image: bool) -> Result<(), String> {
    let p = render_path(root, &path)?;
    if as_image && !IMAGE_EXT.contains(&ext_of(&p).as_str()) {
        return Err("Only images can be copied as a picture".into());
    }
    let script = if as_image {
        "Add-Type -AssemblyName System.Windows.Forms, System.Drawing; \
         $img = [System.Drawing.Image]::FromFile($env:PRESTIGE_PATH); \
         [System.Windows.Forms.Clipboard]::SetImage($img); $img.Dispose()"
    } else {
        "Add-Type -AssemblyName System.Windows.Forms; \
         $files = New-Object System.Collections.Specialized.StringCollection; [void]$files.Add($env:PRESTIGE_PATH); \
         [System.Windows.Forms.Clipboard]::SetFileDropList($files)"
    };
    tauri::async_runtime::spawn_blocking(move || powershell(script, &p, true)).await.map_err(|e| e.to_string())?
}

/// Saves a copy of a render wherever the user picks. Returns the new path, or null if they cancelled.
#[tauri::command]
pub async fn save_render_as(app: AppHandle, root: Option<String>, path: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let p = render_path(root, &path)?;
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let x = ext_of(&p);
    let (kind, folder) = if VIDEO_EXT.contains(&x.as_str()) {
        ("Video", "Videos")
    } else if AUDIO_EXT.contains(&x.as_str()) {
        ("Song", "Music")
    } else {
        ("Image", "Pictures")
    };
    let mut dialog = app.dialog().file().set_file_name(&name).add_filter(kind, &[x.as_str()]);
    if let Some(dir) = std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join(folder)).filter(|d| d.exists()) {
        dialog = dialog.set_directory(dir);
    }
    let Some(dest) = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file()).await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let dest = dest.into_path().map_err(|e| e.to_string())?;
    fs::copy(&p, &dest).map_err(|e| format!("Couldn't save to {}: {e}", dest.display()))?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

/// The stack's ComfyUI API workflows, by name.
#[tauri::command]
pub fn read_workflow(root: Option<String>, name: String) -> Result<serde_json::Value, String> {
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err("bad workflow name".into());
    }
    let p = stack_root(root).join("workflows").join(&name);
    let text = fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Uploads an image to ComfyUI's input folder (for image-to-video) and returns the name ComfyUI gave it.
#[tauri::command]
pub async fn comfy_upload(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let src = PathBuf::from(&path);
        let bytes = fs::read(&src).map_err(|e| e.to_string())?;
        let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("image.png").to_string();
        upload_image(&name, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Uploads image bytes sent straight from the UI (a reference image that was picked, pasted or dropped).
/// The body is the raw file; the "x-name" header is the name to give it in ComfyUI's input folder.
#[tauri::command]
pub async fn comfy_upload_bytes(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the image's bytes".into());
    };
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).unwrap_or("reference.jpg").to_string();
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || upload_image(&name, &bytes))
        .await
        .map_err(|e| e.to_string())?
}

/// A plain multipart POST to ComfyUI's /upload/image over a socket, with a local Origin so ComfyUI accepts it.
fn upload_image(name: &str, bytes: &[u8]) -> Result<String, String> {
    use std::io::Write;
    let name = name.replace(['"', '\\', '/', '\r', '\n'], "");
    let boundary = format!("----prestige{}", fxhash(&format!("{name}{}", bytes.len())));
    let mut body = Vec::new();
    write!(body, "--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").unwrap();
    body.extend_from_slice(bytes);
    write!(body, "\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n").unwrap();

    let mut s = std::net::TcpStream::connect("127.0.0.1:8188").map_err(|_| "ComfyUI isn't running".to_string())?;
    write!(
        s,
        "POST /upload/image HTTP/1.1\r\nHost: 127.0.0.1:8188\r\nOrigin: http://127.0.0.1\r\nContent-Type: multipart/form-data; boundary={boundary}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .map_err(|e| e.to_string())?;
    s.write_all(&body).map_err(|e| e.to_string())?;
    let mut resp = String::new();
    s.read_to_string(&mut resp).map_err(|e| e.to_string())?;
    let status = resp.split_whitespace().nth(1).unwrap_or("");
    let json = resp.split("\r\n\r\n").nth(1).unwrap_or("");
    // ComfyUI may answer with chunked encoding; the JSON object is the part between the braces.
    let json = match (json.find('{'), json.rfind('}')) {
        (Some(a), Some(b)) => &json[a..=b],
        _ => json,
    };
    if status != "200" {
        return Err(format!("ComfyUI answered {status}: {}", json.chars().take(200).collect::<String>()));
    }
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let mut n = v["name"].as_str().ok_or("ComfyUI didn't return a name")?.to_string();
    if let Some(sub) = v["subfolder"].as_str().filter(|s| !s.is_empty()) {
        n = format!("{sub}/{n}");
    }
    Ok(n)
}

/// Forwards ComfyUI's websocket messages to the UI as "comfy" events. ComfyUI rejects the webview's
/// own origin, so the socket lives here with a local Origin header. Reconnects until the app exits.
#[tauri::command]
pub fn comfy_listen(app: AppHandle, client_id: String, state: tauri::State<ComfyListener>) {
    let mut started = state.0.lock().unwrap();
    if *started {
        return;
    }
    *started = true;
    std::thread::spawn(move || loop {
        use tungstenite::client::IntoClientRequest;
        let url = format!("ws://127.0.0.1:8188/ws?clientId={client_id}");
        if let Ok(mut req) = url.into_client_request() {
            req.headers_mut().insert("Origin", "http://127.0.0.1".parse().unwrap());
            if let Ok((mut ws, _)) = tungstenite::connect(req) {
                let _ = app.emit("comfy", serde_json::json!({ "type": "prestige_connected" }));
                while let Ok(msg) = ws.read() {
                    if let tungstenite::Message::Text(t) = msg {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(t.as_str()) {
                            let _ = app.emit("comfy", v);
                        }
                    }
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
    });
}

#[derive(Default)]
pub struct ComfyListener(Mutex<bool>);
