// Models: reads GGUF metadata (so capabilities are detected for any model file, including ones added
// later), downloads catalog models from Hugging Face with progress events, registers them with the
// llama.cpp router (bin\llama-models.ini) and restarts just the router.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::{hidden, stack_root};

// ---------- GGUF metadata ----------

#[derive(Serialize, Clone, Default)]
pub struct GgufInfo {
    arch: Option<String>,
    name: Option<String>,
    size_label: Option<String>,
    params: Option<u64>,
    context: Option<u64>,
    license: Option<String>,
    template_tools: bool,
    template_thinking: bool,
    has_template: bool,
}

#[derive(Default)]
pub struct GgufCache(Mutex<HashMap<String, (u64, GgufInfo)>>);

fn rd_u32<R: Read>(r: &mut R) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}
fn rd_u64<R: Read>(r: &mut R) -> std::io::Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}
fn rd_str<R: Read>(r: &mut R) -> std::io::Result<String> {
    let n = rd_u64(r)? as usize;
    if n > 64 * 1024 * 1024 {
        return Err(std::io::Error::other("string too long"));
    }
    let mut b = vec![0u8; n];
    r.read_exact(&mut b)?;
    Ok(String::from_utf8_lossy(&b).into_owned())
}

enum Val {
    Num(u64),
    Str(String),
    Other,
}

/// Reads one metadata value; skips arrays (like the 150k-entry token list) without keeping them.
fn rd_val(r: &mut BufReader<fs::File>, ty: u32) -> std::io::Result<Val> {
    let fixed = |t: u32| match t {
        0 | 1 | 7 => Some(1u64),
        2 | 3 => Some(2),
        4 | 5 | 6 => Some(4),
        10 | 11 | 12 => Some(8),
        _ => None,
    };
    Ok(match ty {
        4 => Val::Num(rd_u32(r)? as u64),
        5 => Val::Num(rd_u32(r)? as i32 as i64 as u64),
        10 | 11 => Val::Num(rd_u64(r)?),
        8 => Val::Str(rd_str(r)?),
        9 => {
            let et = rd_u32(r)?;
            let n = rd_u64(r)?;
            if let Some(sz) = fixed(et) {
                r.seek_relative((sz * n) as i64)?;
            } else if et == 8 {
                for _ in 0..n {
                    let len = rd_u64(r)?;
                    r.seek_relative(len as i64)?;
                }
            } else {
                return Err(std::io::Error::other("nested arrays not supported"));
            }
            Val::Other
        }
        t => {
            let sz = fixed(t).ok_or_else(|| std::io::Error::other("unknown GGUF type"))?;
            let mut b = vec![0u8; sz as usize];
            r.read_exact(&mut b)?;
            Val::Other
        }
    })
}

fn read_gguf(path: &Path) -> std::io::Result<GgufInfo> {
    let mut r = BufReader::with_capacity(1 << 20, fs::File::open(path)?);
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic)?;
    if &magic != b"GGUF" {
        return Err(std::io::Error::other("not a GGUF file"));
    }
    let _version = rd_u32(&mut r)?;
    let _tensors = rd_u64(&mut r)?;
    let kvs = rd_u64(&mut r)?;
    let mut info = GgufInfo::default();
    let mut nums: HashMap<String, u64> = HashMap::new();
    for _ in 0..kvs {
        let key = rd_str(&mut r)?;
        let ty = rd_u32(&mut r)?;
        match rd_val(&mut r, ty)? {
            Val::Num(n) => {
                nums.insert(key, n);
            }
            Val::Str(s) => match key.as_str() {
                "general.architecture" => info.arch = Some(s),
                "general.name" => info.name = Some(s),
                "general.size_label" => info.size_label = Some(s),
                "general.license" => info.license = Some(s),
                "tokenizer.chat_template" => {
                    info.has_template = true;
                    // Chat templates that know about tools or reasoning say so in their Jinja.
                    info.template_tools = s.contains("tools") || s.contains("tool_call");
                    info.template_thinking = s.contains("<think>")
                        || s.contains("enable_thinking")
                        || s.contains("reasoning_content")
                        || s.contains("<|channel|>");
                }
                _ => {}
            },
            Val::Other => {}
        }
    }
    info.params = nums.get("general.parameter_count").copied();
    if let Some(a) = &info.arch {
        info.context = nums.get(&format!("{a}.context_length")).copied();
    }
    Ok(info)
}

/// Architecture, size, context and what the chat template supports, for a GGUF model file.
#[tauri::command]
pub async fn gguf_info(cache: tauri::State<'_, GgufCache>, path: String) -> Result<GgufInfo, String> {
    let mtime = fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Some((m, i)) = cache.0.lock().unwrap().get(&path) {
        if *m == mtime {
            return Ok(i.clone());
        }
    }
    let p = PathBuf::from(&path);
    let info = tauri::async_runtime::spawn_blocking(move || read_gguf(&p))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    cache.0.lock().unwrap().insert(path, (mtime, info.clone()));
    Ok(info)
}

// ---------- disk space ----------

#[tauri::command]
pub fn disk_free(path: String) -> Result<u64, String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(dir: *const u16, avail: *mut u64, total: *mut u64, free: *mut u64) -> i32;
    }
    // Walk up to a folder that exists (the target may not be created yet).
    let mut p = PathBuf::from(&path);
    while !p.exists() {
        if !p.pop() {
            break;
        }
    }
    let wide: Vec<u16> = p.as_os_str().to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
    let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
    if unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, &mut total, &mut free) } == 0 {
        return Err("couldn't read free disk space".into());
    }
    Ok(avail)
}

// ---------- downloads ----------

#[derive(Default)]
pub struct Downloads(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Serialize, Clone)]
struct Progress {
    id: String,
    done: u64,
    total: u64,
    state: String, // downloading | finished | failed | cancelled
    error: Option<String>,
}

/// Downloads `url` to `dest` in the background (via a .part file), emitting "download" events.
#[tauri::command]
pub fn download_file(app: AppHandle, state: tauri::State<Downloads>, id: String, url: String, dest: String) -> Result<(), String> {
    if !url.starts_with("https://huggingface.co/") {
        return Err("only Hugging Face downloads are allowed".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    state.0.lock().unwrap().insert(id.clone(), cancel.clone());
    std::thread::spawn(move || {
        let emit = |done: u64, total: u64, st: &str, err: Option<String>| {
            let _ = app.emit("download", Progress { id: id.clone(), done, total, state: st.into(), error: err });
        };
        let result = fetch_to(&url, Path::new(&dest), &cancel, |done, total| emit(done, total, "downloading", None))
            .map(|(done, total)| emit(done, total, "finished", None));
        if let Err(e) = result {
            emit(0, 0, if e == "cancelled" { "cancelled" } else { "failed" }, Some(e));
        }
    });
    Ok(())
}

/// Streams `url` into `dest` through a .part file, calling `progress` every ~0.4 s. Returns (bytes, total).
fn fetch_to(url: &str, dest: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64, u64)) -> Result<(u64, u64), String> {
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let part = dest.with_extension("part");
    let resp = ureq::get(url).call().map_err(|e| e.to_string())?;
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file = fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 1 << 20];
    let mut done = 0u64;
    let mut last = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            let _ = fs::remove_file(&part);
            return Err("cancelled".into());
        }
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if last.elapsed().as_millis() > 400 {
            progress(done, total);
            last = std::time::Instant::now();
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if total > 0 && done != total {
        let _ = fs::remove_file(&part);
        return Err(format!("download ended early ({done} of {total} bytes)"));
    }
    fs::rename(&part, dest).map_err(|e| e.to_string())?;
    Ok((done, total))
}

#[tauri::command]
pub fn cancel_download(state: tauri::State<Downloads>, id: String) {
    if let Some(c) = state.0.lock().unwrap().get(&id) {
        c.store(true, Ordering::Relaxed);
    }
}

// ---------- llama.cpp router ----------

/// Adds a model section to bin\llama-models.ini (if it isn't there yet).
#[tauri::command]
pub fn add_llama_model(
    root: Option<String>,
    id: String,
    model: String,
    mmproj: Option<String>,
    n_cpu_moe: Option<u32>,
    note: Option<String>,
) -> Result<bool, String> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        return Err("bad model id".into());
    }
    let ini = stack_root(root).join("bin").join("llama-models.ini");
    let text = fs::read_to_string(&ini).map_err(|e| format!("{}: {e}", ini.display()))?;
    if text.lines().any(|l| l.trim() == format!("[{id}]")) {
        return Ok(false);
    }
    let mut s = String::new();
    if !text.ends_with('\n') {
        s.push('\n');
    }
    s.push_str(&format!("\n; {}\n[{id}]\nmodel = {model}\n", note.unwrap_or_else(|| "Added from the Prestige model catalog.".into())));
    if let Some(m) = mmproj {
        s.push_str(&format!("mmproj = {m}\n"));
    }
    if let Some(n) = n_cpu_moe {
        s.push_str(&format!("n-cpu-moe = {n}\n"));
    }
    s.push_str("c = 32768\n");
    fs::OpenOptions::new()
        .append(true)
        .open(&ini)
        .and_then(|mut f| f.write_all(s.as_bytes()))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Restarts only the llama.cpp router (it reads llama-models.ini at start) through start-all.ps1,
/// which leaves the services that are already running alone.
#[tauri::command]
pub fn restart_llama(root: Option<String>) -> Result<(), String> {
    let root = stack_root(root);
    let bin = root.join("bin").to_string_lossy().to_string();
    let script = root.join("start-all.ps1");
    let ps = format!(
        "Get-Process llama-server -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -like '{}\\*' }} | Stop-Process -Force; Start-Sleep 2; & '{}' -NoBrowser",
        bin.replace('\'', "''"),
        script.to_string_lossy().replace('\'', "''")
    );
    hidden(&mut Command::new("powershell.exe"))
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", &ps])
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_gguf_metadata() {
        let Ok(path) = std::env::var("PRESTIGE_TEST_GGUF") else { return };
        let i = read_gguf(Path::new(&path)).expect("parse");
        println!(
            "arch={:?} name={:?} params={:?} ctx={:?} tools={} thinking={} template={}",
            i.arch, i.name, i.params, i.context, i.template_tools, i.template_thinking, i.has_template
        );
        assert!(i.arch.is_some() && i.has_template);
    }

    #[test]
    fn downloads_from_hugging_face() {
        if std::env::var("PRESTIGE_TEST_NET").is_err() {
            return;
        }
        let dest = std::env::temp_dir().join("prestige-dl-test").join("README.md");
        let url = "https://huggingface.co/unsloth/gpt-oss-20b-GGUF/resolve/main/README.md";
        let (n, total) = fetch_to(url, &dest, &AtomicBool::new(false), |_, _| {}).expect("download");
        println!("downloaded {n} of {total} bytes to {}", dest.display());
        assert!(n > 0 && dest.exists() && !dest.with_extension("part").exists());
        let _ = fs::remove_dir_all(dest.parent().unwrap());
    }
}
