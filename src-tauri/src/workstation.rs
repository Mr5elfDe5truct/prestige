// Workstation settings: the files the Workstation's start-all.ps1 reads, edited from Prestige so nothing needs a text
// editor. data\gpu-settings.json (which card each service uses; docs\GPUS.md there), data\service-settings.json
// (Ollama, llama.cpp and which services start; docs\SETTINGS.md there) and bin\llama-models.ini (each llama.cpp model).
// The JSON files are written whole from what the UI read (it keeps keys it doesn't know); the ini is edited a key at a
// time so its comments, order and hand edits stay as they are.

use crate::{hidden, stack_root};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn json_file(root: &Path, name: &str) -> Result<PathBuf, String> {
    match name {
        "gpu" => Ok(root.join("data").join("gpu-settings.json")),
        "services" => Ok(root.join("data").join("service-settings.json")),
        _ => Err(format!("unknown settings file {name}")),
    }
}

fn ini_file(root: &Path) -> PathBuf {
    root.join("bin").join("llama-models.ini")
}

/// Written next to it first, so a crash mid-write can't leave half a file.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, text).map_err(|e| format!("{}: {e}", path.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

fn read_json(path: &Path) -> (serde_json::Value, Option<String>) {
    match fs::read_to_string(path) {
        Err(_) => (serde_json::json!({}), None),
        Ok(t) => match serde_json::from_str::<serde_json::Value>(t.trim_start_matches('\u{feff}')) {
            Ok(v) if v.is_object() => (v, None),
            Ok(_) => (serde_json::json!({}), Some("isn't a JSON object".into())),
            Err(e) => (serde_json::json!({}), Some(e.to_string())),
        },
    }
}

/// Everything the Workstation settings screen shows.
#[tauri::command]
pub fn ws_read(root: Option<String>) -> serde_json::Value {
    let root = stack_root(root);
    let (gpu, gpu_err) = read_json(&root.join("data").join("gpu-settings.json"));
    let (services, svc_err) = read_json(&root.join("data").join("service-settings.json"));
    let ini = fs::read_to_string(ini_file(&root)).ok();
    let models: Vec<serde_json::Value> = ini
        .as_deref()
        .map(parse_sections)
        .unwrap_or_default()
        .into_iter()
        .map(|s| serde_json::json!({ "id": s.id, "note": s.note, "keys": s.keys }))
        .collect();
    serde_json::json!({
        "root": root.to_string_lossy(),
        "found": root.join("start-all.ps1").exists(),
        // An older Workstation's start-all.ps1 doesn't read service-settings.json yet.
        "servicesSupported": root.join("scripts").join("service-settings.ps1").exists(),
        "gpu": gpu,
        "gpuError": gpu_err,
        "services": services,
        "servicesError": svc_err,
        "ini": ini,
        "models": models,
    })
}

/// Saves data\gpu-settings.json ("gpu") or data\service-settings.json ("services").
#[tauri::command]
pub fn ws_write_json(root: Option<String>, name: String, value: serde_json::Value) -> Result<(), String> {
    if !value.is_object() {
        return Err("settings must be a JSON object".into());
    }
    let path = json_file(&stack_root(root), &name)?;
    write_atomic(&path, &(serde_json::to_string_pretty(&value).map_err(|e| e.to_string())? + "\n"))
}

/// Changes some keys of one model's section in bin\llama-models.ini: Some(value) sets, None removes.
#[tauri::command]
pub fn ws_llama_set(root: Option<String>, id: String, changes: Vec<(String, Option<String>)>) -> Result<(), String> {
    let path = ini_file(&stack_root(root));
    let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let out = set_keys(&text, &id, &changes)?;
    if out != text {
        backup_once(&path);
        write_atomic(&path, &out)?;
    }
    Ok(())
}

/// Replaces bin\llama-models.ini with text edited by hand in Prestige.
#[tauri::command]
pub fn ws_ini_write(root: Option<String>, text: String) -> Result<(), String> {
    let path = ini_file(&stack_root(root));
    if !text.lines().any(|l| l.trim().starts_with('[')) {
        return Err("that doesn't look like llama-models.ini (it has no [model] sections)".into());
    }
    backup_once(&path);
    write_atomic(&path, &text)
}

/// The first time Prestige changes the ini, the original is kept beside it as llama-models.ini.bak.
fn backup_once(path: &Path) {
    let bak = path.with_extension("ini.bak");
    if !bak.exists() {
        let _ = fs::copy(path, bak);
    }
}

/// Stops every service and waits until it's done; the UI starts them again, ticking each as it comes up.
#[tauri::command]
pub async fn ws_stop_and_wait(root: Option<String>) -> Result<(), String> {
    let root = stack_root(root);
    tauri::async_runtime::spawn_blocking(move || {
        if crate::services::supported(&root) {
            crate::services::stop_all_and_wait(&root);
        } else {
            let script = root.join("stop-all.ps1");
            if !script.exists() {
                return Err(format!("stop-all.ps1 not found in {}", root.display()));
            }
            let out = hidden(&mut Command::new("powershell.exe"))
                .args(["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&script)
                .current_dir(&root)
                .stdin(Stdio::null())
                .output()
                .map_err(|e| format!("could not run stop-all.ps1: {e}"))?;
            if !out.status.success() {
                return Err(format!("stop-all.ps1 failed: {}", String::from_utf8_lossy(&out.stderr).chars().take(300).collect::<String>()));
            }
        }
        // Give Windows a moment to release the ports and the VRAM.
        std::thread::sleep(std::time::Duration::from_secs(2));
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- llama-models.ini ----------

#[derive(Debug, PartialEq)]
struct Section {
    id: String,
    /// The comment lines right above the section's header, without the ';'.
    note: String,
    keys: Vec<(String, String)>,
}

fn header(line: &str) -> Option<&str> {
    let t = line.trim();
    t.strip_prefix('[')?.strip_suffix(']').map(str::trim)
}

fn is_comment(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with(';') || t.starts_with('#')
}

fn key_value(line: &str) -> Option<(String, String)> {
    if is_comment(line) {
        return None;
    }
    let (k, v) = line.split_once('=')?;
    let k = k.trim();
    if k.is_empty() {
        return None;
    }
    Some((k.to_string(), v.trim().to_string()))
}

fn parse_sections(text: &str) -> Vec<Section> {
    let mut out: Vec<Section> = Vec::new();
    let mut comments: Vec<String> = Vec::new();
    for line in text.lines() {
        if let Some(id) = header(line) {
            out.push(Section { id: id.to_string(), note: comments.join(" "), keys: Vec::new() });
            comments.clear();
        } else if is_comment(line) {
            comments.push(line.trim_start().trim_start_matches([';', '#']).trim().to_string());
        } else if line.trim().is_empty() {
            comments.clear();
        } else if let (Some(s), Some(kv)) = (out.last_mut(), key_value(line)) {
            s.keys.push(kv);
            comments.clear();
        }
    }
    out
}

fn check_key(k: &str, v: Option<&str>) -> Result<(), String> {
    if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("bad setting name {k:?}"));
    }
    if let Some(v) = v {
        if v.contains(['\n', '\r', '[', ']', ';']) {
            return Err(format!("bad value for {k}"));
        }
    }
    Ok(())
}

/// The ini with `changes` made in section `id`, everything else (comments, order, line endings) untouched.
fn set_keys(text: &str, id: &str, changes: &[(String, Option<String>)]) -> Result<String, String> {
    for (k, v) in changes {
        check_key(k, v.as_deref())?;
    }
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.lines().map(String::from).collect();
    let start = lines.iter().position(|l| header(l) == Some(id)).ok_or_else(|| format!("[{id}] isn't in llama-models.ini"))?;
    for (k, v) in changes {
        let end = lines[start + 1..].iter().position(|l| header(l).is_some()).map_or(lines.len(), |i| start + 1 + i);
        let at = (start + 1..end).find(|&i| key_value(&lines[i]).is_some_and(|(key, _)| key == *k));
        match (at, v) {
            (Some(i), Some(v)) => lines[i] = format!("{k} = {v}"),
            (Some(i), None) => {
                lines.remove(i);
            }
            (None, Some(v)) => {
                // After the section's last setting, so it doesn't land below the next section's comments.
                let last = (start + 1..end).rev().find(|&i| key_value(&lines[i]).is_some()).unwrap_or(start);
                lines.insert(last + 1, format!("{k} = {v}"));
            }
            (None, None) => {}
        }
    }
    let mut out = lines.join(nl);
    if text.ends_with('\n') {
        out.push_str(nl);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const INI: &str = "version = 1\n\n; Shared\n[*]\nn-gpu-layers = 99\n\n; Main agent: big MoE.\n; Second line.\n[qwen]\nmodel = C:\\m\\q.gguf\nn-cpu-moe = 25\nc = 32768\n\n; Next one.\n[tars]\nmodel = C:\\m\\t.gguf\n";

    #[test]
    fn reads_sections_and_their_notes() {
        let s = parse_sections(INI);
        assert_eq!(s.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["*", "qwen", "tars"]);
        assert_eq!(s[1].note, "Main agent: big MoE. Second line.");
        assert_eq!(s[1].keys, [("model".into(), "C:\\m\\q.gguf".into()), ("n-cpu-moe".into(), "25".into()), ("c".into(), "32768".into())]);
    }

    #[test]
    fn changes_only_the_keys_asked_for() {
        let out = set_keys(INI, "qwen", &[("c".into(), Some("20480".into())), ("n-cpu-moe".into(), None), ("cache-type-k".into(), Some("q8_0".into()))]).unwrap();
        assert!(out.contains("[qwen]\nmodel = C:\\m\\q.gguf\nc = 20480\ncache-type-k = q8_0\n\n; Next one.\n[tars]"), "{out}");
        assert!(out.starts_with("version = 1\n\n; Shared\n[*]\nn-gpu-layers = 99\n"));
        // The last section, at the end of the file.
        let out = set_keys(INI, "tars", &[("c".into(), Some("8192".into()))]).unwrap();
        assert!(out.ends_with("[tars]\nmodel = C:\\m\\t.gguf\nc = 8192\n"), "{out}");
    }

    #[test]
    fn keeps_windows_line_endings() {
        let crlf = INI.replace('\n', "\r\n");
        let out = set_keys(&crlf, "*", &[("device".into(), Some("CUDA0".into()))]).unwrap();
        assert!(out.contains("[*]\r\nn-gpu-layers = 99\r\ndevice = CUDA0\r\n\r\n"), "{out:?}");
        assert!(!out.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn refuses_bad_input() {
        assert!(set_keys(INI, "nope", &[("c".into(), Some("1".into()))]).is_err());
        assert!(set_keys(INI, "qwen", &[("c".into(), Some("1\n[evil]".into()))]).is_err());
        assert!(set_keys(INI, "qwen", &[("bad key".into(), Some("1".into()))]).is_err());
    }
}
