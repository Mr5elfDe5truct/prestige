// The service manager: Prestige starts, stops and restarts each Workstation service itself. The Workstation's
// start-all.ps1 -Manifest still does the preparing (GPU plan, config files, model folders) and writes
// data\runtime\services.json: each service's program, command line, folder and environment. Prestige runs them from
// that, one at a time if need be, and reads their logs. An older Workstation without -Manifest falls back to running
// start-all.ps1 whole (lib.rs).

use crate::{hidden, stack_root};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub name: String,
    pub port: u16,
    pub exe: String,
    #[serde(default)]
    pub args: String,
    pub work_dir: String,
    /// Set (Some) or removed (None) on top of Prestige's own environment.
    #[serde(default)]
    pub env: BTreeMap<String, Option<String>>,
    #[serde(default)]
    pub gpu: Option<String>,
    pub log: String,
    pub err_log: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Off {
    pub name: String,
    pub port: u16,
    pub why: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Manifest {
    #[serde(default, deserialize_with = "one_or_many")]
    pub services: Vec<Service>,
    #[serde(default, deserialize_with = "one_or_many")]
    pub off: Vec<Off>,
}

/// Windows PowerShell 5 writes a one-item list as the bare item.
fn one_or_many<'de, D, T>(d: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let v = serde_json::Value::deserialize(d)?;
    match v {
        serde_json::Value::Null => Ok(Vec::new()),
        serde_json::Value::Array(_) => serde_json::from_value(v).map_err(serde::de::Error::custom),
        other => Ok(vec![serde_json::from_value(other).map_err(serde::de::Error::custom)?]),
    }
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join("data").join("runtime").join("services.json")
}

/// The Workstation's start-all.ps1 knows -Manifest (2026-10-11 or newer).
pub fn supported(root: &Path) -> bool {
    fs::read_to_string(root.join("start-all.ps1")).map(|t| t.contains("[switch]$Manifest")).unwrap_or(false)
}

fn read_manifest(root: &Path) -> Result<Manifest, String> {
    let text = fs::read_to_string(manifest_path(root)).map_err(|e| format!("services.json: {e}"))?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("services.json: {e}"))
}

/// Runs start-all.ps1 -Manifest: the GPU plan and config files for the current settings, and a fresh services.json.
fn prepare(root: &Path) -> Result<Manifest, String> {
    let script = root.join("start-all.ps1");
    let out = hidden(&mut Command::new("powershell.exe"))
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .args(["-Manifest", "-NoBrowser"])
        .current_dir(root)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run start-all.ps1: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("start-all.ps1 -Manifest failed: {}", err.trim().chars().take(400).collect::<String>()));
    }
    read_manifest(root)
}

fn listening(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(250)).is_ok()
}

/// The process listening on a local port (netstat -ano), if any.
fn port_pid(port: u16) -> Option<u32> {
    let out = hidden(&mut Command::new("netstat")).args(["-ano", "-p", "TCP"]).output().ok()?;
    parse_netstat(&String::from_utf8_lossy(&out.stdout), port)
}

fn parse_netstat(text: &str, port: u16) -> Option<u32> {
    let suffix = format!(":{port}");
    text.lines().find_map(|l| {
        let f: Vec<&str> = l.split_whitespace().collect();
        (f.len() >= 5 && f[0] == "TCP" && f[1].ends_with(&suffix) && f[3] == "LISTENING").then(|| f[4].parse().ok()).flatten()
    })
}

fn spawn(s: &Service) -> Result<(), String> {
    if let Some(dir) = Path::new(&s.log).parent() {
        let _ = fs::create_dir_all(dir);
    }
    let out = fs::File::create(&s.log).map_err(|e| format!("{}: {e}", s.log))?;
    let err = fs::File::create(&s.err_log).map_err(|e| format!("{}: {e}", s.err_log))?;
    let mut cmd = Command::new(&s.exe);
    // The command line exactly as start-all.ps1 wrote it (it already quotes paths with spaces).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.raw_arg(&s.args).creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(not(windows))]
    cmd.args(s.args.split_whitespace());
    for (k, v) in &s.env {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
    cmd.current_dir(&s.work_dir)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("couldn't start {} ({}): {e}", s.name, s.exe))
}

fn stop_one(s_name: &str, port: u16) -> Result<(), String> {
    if let Some(pid) = port_pid(port) {
        // /T takes its children too: llama.cpp's router runs each model as a child process.
        let _ = hidden(&mut Command::new("taskkill")).args(["/PID", &pid.to_string(), "/T", "/F"]).output();
    }
    if s_name == "ollama" {
        // Ollama's model runner can outlive "ollama serve" and keep its VRAM (as in stop-all.ps1).
        let _ = hidden(&mut Command::new("powershell.exe"))
            .args(["-NoProfile", "-Command", "Get-Process llama-server -ErrorAction SilentlyContinue | Where-Object { $_.Path -like \"$env:LOCALAPPDATA\\Programs\\Ollama\\*\" } | Stop-Process -Force"])
            .output();
    }
    let until = Instant::now() + Duration::from_secs(15);
    while listening(port) {
        if Instant::now() > until {
            return Err(format!("{s_name} is still running on port {port}"));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Ok(())
}

/// Starts the named services (all of them when `names` is empty) that aren't running yet. Prepares first, so the
/// current Workstation settings apply. Returns the names it started.
pub fn start(root: &Path, names: &[String]) -> Result<Vec<String>, String> {
    let m = prepare(root)?;
    let mut started = Vec::new();
    let mut errors = Vec::new();
    for s in m.services.iter().filter(|s| names.is_empty() || names.contains(&s.name)) {
        if listening(s.port) {
            continue;
        }
        match spawn(s) {
            Ok(()) => started.push(s.name.clone()),
            Err(e) => errors.push(e),
        }
    }
    if let Some(n) = names.iter().find(|n| !m.services.iter().any(|s| &s.name == *n)) {
        let why = m.off.iter().find(|o| &o.name == n).map(|o| o.why.clone()).unwrap_or_else(|| "not part of this Workstation".into());
        errors.push(format!("{n} isn't started: {why}"));
    }
    // Starting everything carries on past one that fails (the UI shows which aren't up); one asked for by name says why.
    if errors.is_empty() || names.is_empty() {
        Ok(started)
    } else {
        Err(errors.join("; "))
    }
}

pub fn restart(root: &Path, name: &str) -> Result<(), String> {
    let port = read_manifest(root)
        .ok()
        .and_then(|m| m.services.iter().find(|s| s.name == name).map(|s| s.port))
        .ok_or_else(|| format!("{name} isn't in services.json"))?;
    stop_one(name, port)?;
    start(root, &[name.to_string()]).map(|_| ())
}

// ---------- commands ----------

/// Every service in services.json with whether it's answering on its port, plus the ones switched off.
/// `supported` is false with an older Workstation (then the UI keeps its fixed list).
#[tauri::command]
pub async fn svc_list(root: Option<String>) -> serde_json::Value {
    let root = stack_root(root);
    tauri::async_runtime::spawn_blocking(move || {
        if !supported(&root) {
            return serde_json::json!({ "supported": false });
        }
        let m = read_manifest(&root).ok();
        let services: Vec<serde_json::Value> = m
            .as_ref()
            .map(|m| m.services.iter().map(|s| serde_json::json!({ "name": s.name, "port": s.port, "gpu": s.gpu, "up": listening(s.port) })).collect())
            .unwrap_or_default();
        let off: Vec<serde_json::Value> = m
            .as_ref()
            .map(|m| m.off.iter().map(|o| serde_json::json!({ "name": o.name, "port": o.port, "why": o.why })).collect())
            .unwrap_or_default();
        serde_json::json!({ "supported": true, "prepared": m.is_some(), "services": services, "off": off })
    })
    .await
    .unwrap_or(serde_json::json!({ "supported": false }))
}

/// Starts services (all when `names` is empty or missing). Errors with "unsupported" on an older Workstation.
#[tauri::command]
pub async fn svc_start(root: Option<String>, names: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let root = stack_root(root);
    tauri::async_runtime::spawn_blocking(move || {
        if !supported(&root) {
            return Err("unsupported".into());
        }
        start(&root, &names.unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn svc_stop(root: Option<String>, name: String) -> Result<(), String> {
    let root = stack_root(root);
    tauri::async_runtime::spawn_blocking(move || {
        let m = read_manifest(&root)?;
        let s = m.services.iter().find(|s| s.name == name).ok_or_else(|| format!("{name} isn't in services.json"))?;
        stop_one(&s.name, s.port)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn svc_restart(root: Option<String>, name: String) -> Result<(), String> {
    let root = stack_root(root);
    tauri::async_runtime::spawn_blocking(move || restart(&root, &name)).await.map_err(|e| e.to_string())?
}

/// The end of a service's log and error log (the last `max` bytes of each).
#[tauri::command]
pub fn svc_logs(root: Option<String>, name: String, max: Option<u64>) -> Result<serde_json::Value, String> {
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("bad service name".into());
    }
    let logs = stack_root(root).join("logs");
    let max = max.unwrap_or(24_000);
    let tail = |p: PathBuf| -> String {
        let Ok(mut f) = fs::File::open(&p) else { return String::new() };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let _ = f.seek(SeekFrom::Start(len.saturating_sub(max)));
        let mut buf = Vec::new();
        let _ = f.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    };
    Ok(serde_json::json!({
        "out": tail(logs.join(format!("{name}.log"))),
        "err": tail(logs.join(format!("{name}.err.log"))),
        "folder": logs.to_string_lossy(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_powershell_manifests() {
        let one = r#"{"version":1,"services":{"name":"ollama","port":11434,"exe":"C:\\o.exe","args":"serve","workDir":"C:\\w","env":{"A":"1","B":null},"gpu":"ollama","log":"l","errLog":"e"},"off":[]}"#;
        let m: Manifest = serde_json::from_str(one).unwrap();
        assert_eq!(m.services.len(), 1);
        assert_eq!(m.services[0].env.get("B"), Some(&None));
        assert!(m.off.is_empty());
        let many = r#"{"services":[{"name":"a","port":1,"exe":"x","workDir":"w","log":"l","errLog":"e"},{"name":"b","port":2,"exe":"y","args":"--p 2","workDir":"w","env":{},"gpu":null,"log":"l","errLog":"e"}],"off":{"name":"open-webui","port":8080,"why":"off"}}"#;
        let m: Manifest = serde_json::from_str(many).unwrap();
        assert_eq!((m.services.len(), m.off.len()), (2, 1));
    }

    #[test]
    fn finds_the_listening_process() {
        let text = "\nActive Connections\n\n  Proto  Local Address          Foreign Address        State           PID\n  TCP    127.0.0.1:8081         0.0.0.0:0              LISTENING       4242\n  TCP    127.0.0.1:18081        0.0.0.0:0              LISTENING       7\n  TCP    127.0.0.1:50123        127.0.0.1:8081         ESTABLISHED     99\n";
        assert_eq!(parse_netstat(text, 8081), Some(4242));
        assert_eq!(parse_netstat(text, 18081), Some(7));
        assert_eq!(parse_netstat(text, 8188), None);
    }
}
