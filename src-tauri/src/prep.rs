// Getting the Workstation ready to start, in Prestige: what start-all.ps1 (and its scripts\gpu-config.ps1,
// service-settings.ps1 and tool-config.ps1) did before a start. Which card each service runs on, the config files the
// services read (data\runtime: gpu.json, llama-models.ini, mcpo-config.json, comfy-extra-models.yaml) and how to start
// each service, written to data\runtime\services.json for the service manager (services.rs). No PowerShell involved.
// start-all.ps1 still does the same for anyone running the Workstation without Prestige; the two must agree.

use crate::{hidden, services::listening};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

// ---------- data\service-settings.json ----------

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub ollama_keep_alive: String,
    pub ollama_flash_attention: bool,
    pub ollama_kv_cache: String,
    pub llama_idle_seconds: u32,
    pub llama_models_max: u32,
    pub comfyui: bool,
    pub open_webui: bool,
    pub theme: String,
}

impl Default for Settings {
    /// How the Workstation ran before the file existed (scripts\service-settings.ps1).
    fn default() -> Self {
        Settings {
            ollama_keep_alive: "5m".into(),
            ollama_flash_attention: true,
            ollama_kv_cache: "q8_0".into(),
            llama_idle_seconds: 180,
            llama_models_max: 1,
            comfyui: true,
            open_webui: true,
            theme: "dragon".into(),
        }
    }
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.trim().to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn on_off(v: &str) -> Option<bool> {
    match v.to_ascii_lowercase().as_str() {
        "on" | "true" => Some(true),
        "off" | "false" => Some(false),
        _ => None,
    }
}

fn keep_alive_ok(v: &str) -> bool {
    let v = v.strip_prefix('-').unwrap_or(v);
    let v = v.strip_suffix(['s', 'm', 'h']).unwrap_or(v);
    let (a, b) = v.split_once('.').unwrap_or((v, "0"));
    !a.is_empty() && a.chars().all(|c| c.is_ascii_digit()) && !b.is_empty() && b.chars().all(|c| c.is_ascii_digit())
}

/// The settings, with a warning for each value that's left out because it isn't valid.
pub fn read_settings(json: Option<&Value>) -> (Settings, Vec<String>) {
    let mut s = Settings::default();
    let mut notes = Vec::new();
    let Some(obj) = json.and_then(|j| j.as_object()) else { return (s, notes) };
    for (k, raw) in obj {
        let v = text_of(raw);
        if v.is_empty() {
            continue;
        }
        let ok = match k.as_str() {
            "ollamaKeepAlive" if keep_alive_ok(&v) => {
                s.ollama_keep_alive = v.clone();
                true
            }
            "ollamaKvCache" if ["f16", "q8_0", "q4_0"].contains(&v.as_str()) => {
                s.ollama_kv_cache = v.clone();
                true
            }
            "llamaIdleSeconds" => v.parse().map(|n| s.llama_idle_seconds = n).is_ok(),
            "llamaModelsMax" => v.parse::<u32>().ok().filter(|n| (1..=9).contains(n)).map(|n| s.llama_models_max = n).is_some(),
            "theme" if ["dragon", "neon", "glass", "hud", "off"].contains(&v.as_str()) => {
                s.theme = v.clone();
                true
            }
            "ollamaFlashAttention" => on_off(&v).map(|b| s.ollama_flash_attention = b).is_some(),
            "comfyui" => on_off(&v).map(|b| s.comfyui = b).is_some(),
            "openWebUI" => on_off(&v).map(|b| s.open_webui = b).is_some(),
            "ollamaKeepAlive" | "ollamaKvCache" | "theme" => false,
            _ => {
                notes.push(format!("unknown setting '{k}' in data\\service-settings.json"));
                continue;
            }
        };
        if !ok {
            notes.push(format!("data\\service-settings.json: '{v}' isn't a valid {k}, so the default is used"));
        }
    }
    (s, notes)
}

// ---------- the GPU plan (scripts\gpu-config.ps1) ----------

pub const GPU_SERVICES: [&str; 5] = ["ollama", "openwebui", "voice", "llama", "comfyui"];

#[derive(Debug, Clone, PartialEq)]
pub struct Gpu {
    pub index: u32,
    pub uuid: String,
    pub name: String,
    pub mib: u64,
}

impl Gpu {
    pub fn gb(&self) -> f64 {
        (self.mib as f64 / 1024.0 * 10.0).round() / 10.0
    }
}

/// Every NVIDIA card, from nvidia-smi. Empty without one.
pub fn nvidia_gpus() -> Vec<Gpu> {
    let Ok(out) = hidden(&mut Command::new("nvidia-smi"))
        .args(["--query-gpu=index,uuid,name,memory.total", "--format=csv,noheader,nounits"])
        .stdin(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    parse_gpus(&String::from_utf8_lossy(&out.stdout))
}

pub fn parse_gpus(text: &str) -> Vec<Gpu> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(',').map(str::trim).collect();
            if f.len() < 4 {
                return None;
            }
            let name = f[2].strip_prefix("NVIDIA ").unwrap_or(f[2]);
            let name = name.strip_prefix("GeForce ").unwrap_or(name);
            Some(Gpu { index: f[0].parse().ok()?, uuid: f[1].to_string(), name: name.to_string(), mib: f[3].parse().ok()? })
        })
        .collect()
}

#[derive(Debug, Clone)]
pub struct Plan {
    pub mode: String,
    pub gpus: Vec<Gpu>,
    pub services: BTreeMap<String, Vec<Gpu>>,
    pub notes: Vec<String>,
    pub ollama_context: u32,
    pub llama_fit: bool,
    pub tensor_split: Option<String>,
    pub llama_gb: f64,
    pub comfy_aux: Option<String>,
    pub comfy_quick: Option<Gpu>,
    /// Several cards in the PC (even with some excluded): services get pinned.
    pub multi: bool,
}

/// A setting that's there and not empty (Get-Setting).
fn setting<'a>(s: &'a Value, name: &str) -> Option<&'a Value> {
    s.get(name).filter(|v| !v.is_null() && !(v.as_str().is_some_and(|t| t.is_empty())))
}

fn setting_text(s: &Value, name: &str, default: &str) -> String {
    setting(s, name).map(text_of).unwrap_or_else(|| default.to_string())
}

fn list_of(v: &Value) -> Vec<&Value> {
    match v {
        Value::Array(a) => a.iter().collect(),
        other => vec![other],
    }
}

/// A card named in the settings: its nvidia-smi index, its UUID, or part of its name ("3060").
fn resolve<'a>(gpus: &'a [Gpu], sel: &Value) -> Option<&'a Gpu> {
    let s = text_of(sel);
    if s.is_empty() || s.eq_ignore_ascii_case("auto") {
        return None;
    }
    let by_id = if s.len() <= 2 && s.chars().all(|c| c.is_ascii_digit()) {
        gpus.iter().find(|g| s.parse() == Ok(g.index))
    } else {
        gpus.iter().find(|g| g.uuid == s)
    };
    by_id.or_else(|| gpus.iter().find(|g| g.name.to_lowercase().contains(&s.to_lowercase())))
}

pub fn gpu_plan(all: &[Gpu], s: &Value, mode: &str) -> Option<Plan> {
    let mut notes = Vec::new();
    let skip: Vec<u32> = setting(s, "exclude").map(list_of).unwrap_or_default().into_iter().filter_map(|v| resolve(all, v)).map(|g| g.index).collect();
    let gpus: Vec<Gpu> = all.iter().filter(|g| !skip.contains(&g.index)).cloned().collect();
    if gpus.is_empty() {
        return None;
    }
    let mut by_vram = gpus.clone();
    by_vram.sort_by(|a, b| b.mib.cmp(&a.mib).then(a.index.cmp(&b.index)));
    let big = setting(s, "bigGpu").and_then(|v| resolve(&gpus, v)).cloned().unwrap_or_else(|| by_vram[0].clone());
    let small = setting(s, "smallGpu")
        .and_then(|v| resolve(&gpus, v))
        .filter(|g| g.index != big.index)
        .cloned()
        .or_else(|| by_vram.iter().find(|g| g.index != big.index).cloned());

    let mut mode = if mode.is_empty() { setting_text(s, "mode", "auto") } else { mode.to_string() }.to_lowercase();
    if !["auto", "single", "split", "pool"].contains(&mode.as_str()) {
        notes.push(format!("unknown GPU mode '{mode}', using auto"));
        mode = "auto".into();
    }
    if mode == "auto" {
        mode = if small.is_some() { "split" } else { "single" }.into();
    }
    if small.is_none() && mode != "single" {
        notes.push(format!("{mode} needs two GPUs; using single"));
        mode = "single".into();
    }

    // Every card in the pool, the big one first: llama.cpp keeps its KV cache and scratch buffers on its first device.
    let mut pool = vec![big.clone()];
    pool.extend(by_vram.iter().filter(|g| g.index != big.index).cloned());
    let mut svc: BTreeMap<String, Vec<Gpu>> = GPU_SERVICES.iter().map(|k| (k.to_string(), vec![big.clone()])).collect();
    if mode != "single" {
        let sm = small.clone().unwrap();
        svc.insert("ollama".into(), vec![sm.clone()]);
        svc.insert("openwebui".into(), vec![sm.clone()]);
        svc.insert("voice".into(), vec![if sm.gb() >= 7.5 { sm } else { big.clone() }]);
        if mode == "pool" {
            svc.insert("llama".into(), pool.clone());
        }
    }
    // Per-service overrides: "big", "small", "all", or a card (index, UUID or name), or a list of them.
    if let Some(over) = setting(s, "services").and_then(|v| v.as_object()) {
        for (name, v) in over {
            let k = name.to_lowercase();
            if !GPU_SERVICES.contains(&k.as_str()) {
                notes.push(format!("unknown service '{name}' in gpu-settings.json"));
                continue;
            }
            let mut cards: Vec<Gpu> = Vec::new();
            for v in list_of(v) {
                match text_of(v).to_lowercase().as_str() {
                    "big" => cards.push(big.clone()),
                    "small" => cards.push(small.clone().unwrap_or_else(|| big.clone())),
                    "all" => cards.extend(pool.iter().cloned()),
                    _ => match resolve(&gpus, v) {
                        Some(g) => cards.push(g.clone()),
                        None => notes.push(format!("no GPU matches '{}' for {k}", text_of(v))),
                    },
                }
            }
            if !cards.is_empty() {
                cards.sort_by_key(|g| g.index);
                cards.dedup_by_key(|g| g.index);
                cards.sort_by(|a, b| (a.index != big.index).cmp(&(b.index != big.index)).then(b.mib.cmp(&a.mib)));
                svc.insert(k, cards);
            }
        }
    }

    // Ollama's context from the smallest card it runs on: 32k (q8 KV) fits beside a 7-9 GB model on 12 GB; smaller
    // cards get less so the model stays on the GPU. Prestige reads it from gpu.json too.
    let ollama_gb = svc["ollama"].iter().map(Gpu::gb).fold(f64::INFINITY, f64::min);
    let ctx_setting = setting_text(s, "ollamaContext", "auto");
    let ollama_context = match ctx_setting.parse::<u32>() {
        Ok(n) if ctx_setting.chars().all(|c| c.is_ascii_digit()) => n,
        _ if ollama_gb >= 11.0 => 32768,
        _ if ollama_gb >= 5.5 => 16384,
        _ => 8192,
    };
    if ollama_gb < 7.5 && mode != "single" {
        notes.push(format!(
            "Ollama's card has {ollama_gb} GB: 4B models run fully on it, the 9B fast chat and Gemma 4 12B partly from RAM (slow). \
             To keep those fast, set Ollama's card to the big one"
        ));
    }

    // llama.cpp: bin\llama-models.ini is tuned by hand for one 12 GB card. On any other card, or a pool, those settings
    // are dropped and llama.cpp's --fit sizes the offload to the VRAM there. A tensor split set by hand turns --fit off.
    let llama_gb: f64 = svc["llama"].iter().map(Gpu::gb).sum();
    let llama_gb = (llama_gb * 10.0).round() / 10.0;
    let fit = setting_text(s, "llamaFit", "auto").to_lowercase();
    let mut llama_fit = match fit.as_str() {
        "on" | "true" => true,
        "off" | "false" => false,
        _ => !(svc["llama"].len() == 1 && (11.0..=13.5).contains(&llama_gb)),
    };
    let mut tensor_split = None;
    let ts = setting_text(s, "tensorSplit", "auto");
    if svc["llama"].len() > 1 && ts != "auto" {
        tensor_split = Some(ts);
        if llama_fit {
            notes.push("tensorSplit is set, so llama.cpp uses the ini's offload settings instead of --fit".into());
            llama_fit = false;
        }
    }

    // ComfyUI on two or more cards: VAEs and the LTX upscaler on the second (tools\comfy_nodes\workstation_gpus).
    let aux: String = setting_text(s, "comfyAux", "auto").to_lowercase().chars().filter(|c| !c.is_whitespace()).collect();
    let comfy_aux = (svc["comfyui"].len() > 1 && !["off", "false", "none"].contains(&aux.as_str()))
        .then(|| if ["auto", "on", "true"].contains(&aux.as_str()) { "upscaler".to_string() } else { aux });

    // comfyQuick "on": a second, small ComfyUI on the small card (port 8189) for click to select.
    let quick = setting_text(s, "comfyQuick", "auto").to_lowercase();
    let comfy_quick = small
        .clone()
        .filter(|sm| ["on", "true"].contains(&quick.as_str()) && !svc["comfyui"].iter().any(|g| g.index == sm.index));

    Some(Plan {
        mode,
        gpus,
        services: svc,
        notes,
        ollama_context,
        llama_fit,
        tensor_split,
        llama_gb,
        comfy_aux,
        comfy_quick,
        multi: all.len() > 1,
    })
}

/// data\runtime\gpu.json, for Prestige's meters and fit warnings and the voice server.
pub fn plan_json(plan: Option<&Plan>) -> Value {
    let Some(p) = plan else {
        return json!({ "mode": "none", "gpus": [], "services": {}, "ollamaContext": 32768, "llamaFit": false, "tensorSplit": null, "comfyAux": [], "notes": [] });
    };
    let services: Map<String, Value> = p.services.iter().map(|(k, v)| (k.clone(), json!(v.iter().map(|g| g.index).collect::<Vec<_>>()))).collect();
    json!({
        "mode": p.mode,
        "gpus": p.gpus.iter().map(|g| json!({ "index": g.index, "uuid": g.uuid, "name": g.name, "gb": g.gb() })).collect::<Vec<_>>(),
        "services": services,
        "ollamaContext": p.ollama_context,
        "llamaFit": p.llama_fit,
        "tensorSplit": p.tensor_split,
        "comfyAux": p.comfy_aux.as_deref().map(|a| a.split(',').collect::<Vec<_>>()).unwrap_or_default(),
        "notes": p.notes,
    })
}

/// The runtime copy of bin\llama-models.ini for this plan (the tuned values stay as they are on one 12 GB card).
pub fn convert_llama_ini(text: &str, plan: Option<&Plan>) -> String {
    let Some(p) = plan.filter(|p| p.llama_fit || p.tensor_split.is_some()) else { return text.to_string() };
    let key = |l: &str| l.split_once('=').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()));
    let mut out: Vec<String> = Vec::new();
    for l in text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)) {
        let mut line = l.to_string();
        if p.llama_fit {
            if let Some((k, v)) = key(l) {
                if ["n-gpu-layers", "ngl", "n-cpu-moe", "cpu-moe"].contains(&k.as_str()) {
                    continue;
                }
                // Small cards: cap the context so --fit spends the VRAM on layers rather than cache.
                let digits: String = v.chars().take_while(char::is_ascii_digit).collect();
                if p.llama_gb < 10.0 && (k == "c" || k == "ctx-size") && digits.parse::<u64>().is_ok_and(|n| n > 16384) {
                    line = format!("{k} = 16384");
                }
            }
        }
        let header = l.trim_start().starts_with("[*]");
        out.push(line);
        if header {
            if let Some(ts) = &p.tensor_split {
                out.push(format!("tensor-split = {ts}"));
            }
        }
    }
    out.join("\r\n")
}

/// The environment that pins a process to the plan's cards for one service (Set-ServiceGpus). With one card (or no
/// plan) only CUDA_VISIBLE_DEVICES is cleared, so a single-GPU PC runs as before.
pub fn gpu_env(plan: Option<&Plan>, service: Option<&str>) -> BTreeMap<String, Option<String>> {
    let mut env = BTreeMap::new();
    let (Some(p), Some(service)) = (plan.filter(|p| p.multi), service) else {
        env.insert("CUDA_VISIBLE_DEVICES".into(), None);
        return env;
    };
    let cards: Vec<&Gpu> = if service == "comfyquick" { p.comfy_quick.iter().collect() } else { p.services.get(service).map(|v| v.iter().collect()).unwrap_or_default() };
    env.insert("CUDA_DEVICE_ORDER".into(), Some("PCI_BUS_ID".into()));
    env.insert("CUDA_VISIBLE_DEVICES".into(), Some(cards.iter().map(|g| g.uuid.as_str()).collect::<Vec<_>>().join(",")));
    // Ollama also finds the cards through Vulkan, which CUDA_VISIBLE_DEVICES doesn't hide.
    if service == "ollama" {
        env.insert("OLLAMA_VULKAN".into(), Some("0".into()));
    }
    if service == "comfyui" {
        let aux = p.comfy_aux.clone();
        env.insert("WORKSTATION_COMFY_AUX_DEVICE".into(), aux.as_ref().map(|_| "1".into()));
        env.insert("WORKSTATION_COMFY_AUX_PARTS".into(), aux);
    }
    env
}

// ---------- config files ----------

fn home() -> String {
    std::env::var("USERPROFILE").unwrap_or_default()
}

fn local_app_data() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(home()).join("AppData").join("Local"))
}

/// {ROOT} and {HOME} in the Workstation's templates; `json` escapes the backslashes for a JSON file.
pub fn expand(text: &str, root: &Path, json: bool) -> String {
    let (mut r, mut h) = (root.to_string_lossy().into_owned(), home());
    if json {
        r = r.replace('\\', "\\\\");
        h = h.replace('\\', "\\\\");
    }
    text.replace("{ROOT}", &r).replace("{HOME}", &h)
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    if let Some(d) = path.parent() {
        fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
    }
    let tmp = path.with_extension("prep-tmp");
    fs::write(&tmp, text).map_err(|e| format!("{}: {e}", path.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

fn read_json_file(path: &Path, notes: &mut Vec<String>) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
        Ok(v) => Some(v),
        Err(e) => {
            notes.push(format!("{} isn't valid JSON, so it's ignored: {e}", path.file_name().unwrap_or_default().to_string_lossy()));
            None
        }
    }
}

/// tools\mcpo-config.json plus the tools added from Prestige's tool store (data\mcpo-extra.json); a built-in server's
/// name can't be taken by an added tool (scripts\tool-config.ps1).
pub fn tool_config(base: &str, extra: Option<&str>, root: &Path, notes: &mut Vec<String>) -> Result<Value, String> {
    let mut base: Value = serde_json::from_str(expand(base, root, true).trim_start_matches('\u{feff}')).map_err(|e| format!("tools\\mcpo-config.json: {e}"))?;
    let Some(extra) = extra else { return Ok(base) };
    match serde_json::from_str::<Value>(expand(extra, root, true).trim_start_matches('\u{feff}')) {
        Ok(x) => {
            let servers = base["mcpServers"].as_object_mut().ok_or("tools\\mcpo-config.json has no mcpServers")?;
            for (name, v) in x["mcpServers"].as_object().cloned().unwrap_or_default() {
                if servers.contains_key(&name) {
                    notes.push(format!("tool store: '{name}' is a built-in tool server name, skipped"));
                } else {
                    servers.insert(name, v);
                }
            }
        }
        Err(e) => notes.push(format!("data\\mcpo-extra.json couldn't be read, so the added tools are left out: {e}")),
    }
    Ok(base)
}

/// ComfyUI: the one install.ps1 puts in apps\ComfyUI, or else Comfy Desktop's install with the GGUF nodes, then the
/// most recently used. (folder, python)
pub fn find_comfy(root: &Path) -> Option<(PathBuf, PathBuf)> {
    let own = root.join("apps").join("ComfyUI");
    if own.join("main.py").exists() {
        return Some((own, root.join("envs").join("comfyui").join("Scripts").join("python.exe")));
    }
    let installs = local_app_data().join("Comfy-Desktop").join("ComfyUI-Installs");
    let mut found: Vec<(bool, std::time::SystemTime, PathBuf)> = fs::read_dir(installs)
        .ok()?
        .flatten()
        .map(|e| e.path().join("ComfyUI"))
        .filter(|c| c.join(".venv").join("Scripts").join("python.exe").exists())
        .map(|c| {
            let nodes = c.join("custom_nodes");
            let modified = fs::metadata(&nodes).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            (nodes.join("ComfyUI-GGUF").exists(), modified, c)
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    found.into_iter().next().map(|(_, _, c)| {
        let py = c.join(".venv").join("Scripts").join("python.exe");
        (c, py)
    })
}

/// Model folders ComfyUI should see: models\comfy (and models\comfy-fast), plus Comfy Desktop's shared models.
pub fn comfy_yaml(root: &Path, fast: bool, shared: Option<&Path>) -> String {
    let mut y = String::from("# Written by Prestige (or start-all.ps1) on every start.\n");
    for dir in ["comfy", "comfy-fast"] {
        if dir == "comfy-fast" && !fast {
            continue;
        }
        y.push_str(&format!(
            "workstation_{}:\n  base_path: {}\\models\\{dir}\n  checkpoints: checkpoints/\n  diffusion_models: |\n    diffusion_models/\n    unet/\n  unet: unet/\n  text_encoders: text_encoders/\n  clip: text_encoders/\n  vae: vae/\n  loras: loras/\n  latent_upscale_models: latent_upscale_models/\n  upscale_models: upscale_models/\n  clip_vision: clip_vision/\n  geometry_estimation: geometry_estimation/\n  background_removal: background_removal/\n  model_patches: model_patches/\n  audio_encoders: audio_encoders/\n  matanyone2: matanyone2/\n\n",
            dir.replace('-', "_"),
            root.display()
        ));
    }
    if let Some(sh) = shared {
        y.push_str(&format!(
            "\ncomfy_desktop_shared:\n  base_path: {}\n  is_default: true\n  checkpoints: checkpoints/\n  diffusion_models: diffusion_models/\n  unet: unet/\n  text_encoders: text_encoders/\n  clip: clip/\n  clip_vision: clip_vision/\n  vae: vae/\n  loras: loras/\n  upscale_models: upscale_models/\n  latent_upscale_models: latent_upscale_models/\n  audio_encoders: audio_encoders/\n  model_patches: model_patches/\n  controlnet: controlnet/\n  embeddings: embeddings/\n",
            sh.display()
        ));
    }
    y
}

/// The Python packages a requirements.txt names that aren't installed in `site_packages` (looked up by their
/// .dist-info folder, so nothing is imported). Comments, options and environment markers are skipped.
pub fn missing_packages(requirements: &str, site_packages: &Path) -> Vec<String> {
    let installed: Vec<String> = fs::read_dir(site_packages)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            let dist = name.strip_suffix(".dist-info").or_else(|| name.strip_suffix(".egg-info"))?.to_string();
            Some(dist.split('-').next().unwrap_or("").replace('.', "_"))
        })
        .collect();
    requirements
        .lines()
        .map(|l| l.split('#').next().unwrap_or("").trim())
        .filter(|l| !l.is_empty() && !l.starts_with('-') && !l.contains("://"))
        .filter_map(|l| {
            let name: String = l.chars().take_while(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c)).collect();
            let key = name.to_lowercase().replace(['-', '.'], "_");
            (!key.is_empty() && !installed.contains(&key)).then_some(name)
        })
        .collect()
}

/// The workflows' custom nodes (GGUF loaders, KJNodes) need Python packages in ComfyUI's environment. Comfy Desktop
/// rebuilds its .venv when it updates, which drops them and ComfyUI then fails every render with "Node 'UnetLoaderGGUF'
/// not found": put them back before ComfyUI starts.
fn ensure_node_packages(dir: &Path, python: &Path, notes: &mut Vec<String>) {
    let Some(venv) = python.parent().and_then(Path::parent) else { return };
    let site = venv.join("Lib").join("site-packages");
    let nodes: Vec<PathBuf> = fs::read_dir(dir.join("custom_nodes"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().is_some_and(|n| ["comfyui-gguf", "comfyui-kjnodes"].contains(&n.to_string_lossy().to_lowercase().as_str())))
        .collect();
    for node in nodes {
        let req = node.join("requirements.txt");
        let missing = missing_packages(&fs::read_to_string(&req).unwrap_or_default(), &site);
        if missing.is_empty() {
            continue;
        }
        let name = node.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let out = hidden(&mut Command::new(crate::packs::uv_exe()))
            .args(["pip", "install", "-q", "-p"])
            .arg(venv)
            .arg("-r")
            .arg(&req)
            .stdin(Stdio::null())
            .output();
        match out {
            Ok(o) if o.status.success() => notes.push(format!("ComfyUI: put back {name}'s Python packages ({})", missing.join(", "))),
            Ok(o) => notes.push(format!("ComfyUI: {name} is missing {} and installing them failed: {}", missing.join(", "), String::from_utf8_lossy(&o.stderr).trim())),
            Err(e) => notes.push(format!("ComfyUI: {name} is missing {} and uv couldn't run: {e}", missing.join(", "))),
        }
    }
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)?.flatten() {
        let p = e.path();
        if p.file_name().is_some_and(|n| n == "__pycache__") {
            continue;
        }
        if p.is_dir() {
            copy_dir(&p, &to.join(e.file_name()))?;
        } else {
            fs::copy(&p, to.join(e.file_name()))?;
        }
    }
    Ok(())
}

const TOOL_SERVERS: &str = r#"[{"url":"http://127.0.0.1:8200/workstation","path":"openapi.json","auth_type":"none","key":"","config":{"enable":true},"info":{"id":"workstation","name":"workstation"}},{"url":"http://127.0.0.1:8200/fetch","path":"openapi.json","auth_type":"none","key":"","config":{"enable":true},"info":{"id":"fetch","name":"fetch"}},{"url":"http://127.0.0.1:8200/filesystem","path":"openapi.json","auth_type":"none","key":"","config":{"enable":true},"info":{"id":"filesystem","name":"filesystem"}},{"url":"http://127.0.0.1:8200/desktop","path":"openapi.json","auth_type":"none","key":"","config":{"enable":true},"info":{"id":"desktop","name":"desktop"}},{"url":"http://127.0.0.1:8200/browser","path":"openapi.json","auth_type":"none","key":"","config":{"enable":true},"info":{"id":"browser","name":"browser"}}]"#;

// ---------- services.json ----------

fn quote(p: &Path) -> String {
    format!("\"{}\"", p.display())
}

fn set(env: &mut BTreeMap<String, Option<String>>, pairs: &[(&str, &str)]) {
    for (k, v) in pairs {
        env.insert(k.to_string(), Some(v.to_string()));
    }
}

struct Builder<'a> {
    root: &'a Path,
    plan: Option<&'a Plan>,
    services: Vec<Value>,
    off: Vec<Value>,
}

impl Builder<'_> {
    fn add(&mut self, name: &str, port: u16, exe: &Path, args: String, work_dir: &Path, gpu: Option<&str>, mut env: BTreeMap<String, Option<String>>) {
        if !exe.exists() {
            self.off.push(json!({ "name": name, "port": port, "why": format!("not installed ({} is missing)", exe.display()) }));
            return;
        }
        for (k, v) in gpu_env(self.plan, gpu) {
            env.insert(k, v);
        }
        let logs = self.root.join("logs");
        self.services.push(json!({
            "name": name, "port": port, "exe": exe, "args": args, "workDir": work_dir, "env": env, "gpu": gpu,
            "log": logs.join(format!("{name}.log")), "errLog": logs.join(format!("{name}.err.log")),
        }));
    }
    fn off(&mut self, name: &str, port: u16, why: &str) {
        self.off.push(json!({ "name": name, "port": port, "why": why }));
    }
}

/// What a prepare wrote (services.json, with its notes).
pub struct Prepared {
    pub manifest: Value,
}

/// Everything start-all.ps1 -Manifest does: the settings, the GPU plan, the config files in data\runtime, the
/// Workstation's ComfyUI nodes, Open WebUI's theme, and services.json.
pub fn prepare(root: &Path) -> Result<Prepared, String> {
    if !root.join("bin").exists() || !root.join("tools").join("mcpo-config.json").exists() {
        return Err(format!("{} doesn't look like a Workstation folder", root.display()));
    }
    let runtime = root.join("data").join("runtime");
    fs::create_dir_all(root.join("logs")).map_err(|e| e.to_string())?;
    let mut notes = Vec::new();
    let svc_json = read_json_file(&root.join("data").join("service-settings.json"), &mut notes);
    let (svc, more) = read_settings(svc_json.as_ref());
    notes.extend(more);

    // Which card each service runs on.
    let gpu_settings = read_json_file(&root.join("data").join("gpu-settings.json"), &mut notes).unwrap_or(json!({}));
    let plan = gpu_plan(&nvidia_gpus(), &gpu_settings, "");
    let plan = plan.as_ref();
    if let Some(p) = plan {
        notes.extend(p.notes.iter().cloned());
    }
    write(&runtime.join("gpu.json"), &serde_json::to_string_pretty(&plan_json(plan)).unwrap())?;

    // llama.cpp's models, for this folder and plan.
    let ini = fs::read_to_string(root.join("bin").join("llama-models.ini")).map_err(|e| format!("bin\\llama-models.ini: {e}"))?;
    write(&runtime.join("llama-models.ini"), &convert_llama_ini(&expand(&ini, root, false), plan))?;

    // The tool server's config, with the tools added from Prestige's tool store.
    let base = fs::read_to_string(root.join("tools").join("mcpo-config.json")).map_err(|e| format!("tools\\mcpo-config.json: {e}"))?;
    let extra = fs::read_to_string(root.join("data").join("mcpo-extra.json")).ok();
    let tools = tool_config(&base, extra.as_deref(), root, &mut notes)?;
    write(&runtime.join("mcpo-config.json"), &serde_json::to_string_pretty(&tools).unwrap())?;

    let shared = local_app_data().join("Comfy-Desktop").join("ComfyUI-Shared").join("models");
    let yaml = runtime.join("comfy-extra-models.yaml");
    write(&yaml, &comfy_yaml(root, root.join("models").join("comfy-fast").exists(), shared.exists().then_some(shared.as_path())))?;

    let mut b = Builder { root, plan, services: Vec::new(), off: Vec::new() };
    let py = |env: &str| root.join("envs").join(env).join("Scripts").join("python.exe");
    let mut common = BTreeMap::new();
    // Every service numbers cards as nvidia-smi does (start-all.ps1 left this set for all of them), so a service with
    // no CUDA_VISIBLE_DEVICES still sees cuda:0 as the first card, not the fastest.
    set(&mut common, &[("PYTHONUTF8", "1"), ("HF_HUB_DISABLE_SYMLINKS_WARNING", "1"), ("CUDA_DEVICE_ORDER", "PCI_BUS_ID")]);
    common.insert("PYTHONPATH".into(), None);

    // 1. Ollama: fast chat, vision, Live calls. With several cards it runs on the small one.
    let mut env = BTreeMap::new();
    let ctx = plan.map(|p| p.ollama_context).unwrap_or(32768).to_string();
    let models = root.join("models").join("ollama");
    set(&mut env, &[
        ("OLLAMA_MODELS", &models.to_string_lossy()),
        ("OLLAMA_KEEP_ALIVE", &svc.ollama_keep_alive),
        ("OLLAMA_CONTEXT_LENGTH", &ctx),
        ("OLLAMA_FLASH_ATTENTION", if svc.ollama_flash_attention { "1" } else { "0" }),
        ("OLLAMA_KV_CACHE_TYPE", &svc.ollama_kv_cache),
    ]);
    b.add("ollama", 11434, &local_app_data().join("Programs").join("Ollama").join("ollama.exe"), "serve".into(), root, Some("ollama"), env);

    // 2. llama.cpp's router: the big models, loaded on demand and unloaded when idle.
    let mut args = format!("--models-preset {} --models-max {}", quote(&runtime.join("llama-models.ini")), svc.llama_models_max);
    if svc.llama_idle_seconds > 0 {
        args += &format!(" --sleep-idle-seconds {}", svc.llama_idle_seconds);
    }
    args += " --host 127.0.0.1 --port 8081";
    b.add("llama-server", 8081, &root.join("bin").join("llama.cpp").join("llama-server.exe"), args, root, Some("llama"), BTreeMap::new());

    // 3. Kokoro text-to-speech (CPU).
    let k = root.join("apps").join("Kokoro-FastAPI");
    let mut env = common.clone();
    let ks = k.to_string_lossy();
    set(&mut env, &[
        ("PHONEMIZER_ESPEAK_LIBRARY", r"C:\Program Files\eSpeak NG\libespeak-ng.dll"),
        ("PROJECT_ROOT", &ks),
        ("USE_GPU", "false"),
        ("PYTHONPATH", &format!("{ks};{ks}\\api")),
        ("MODEL_DIR", "src/models"),
        ("VOICES_DIR", "src/voices/v1_0"),
        ("WEB_PLAYER_PATH", &format!("{ks}\\web")),
    ]);
    b.add("kokoro", 8880, &py("kokoro"), "-m uvicorn api.src.main:app --host 127.0.0.1 --port 8880".into(), &k, None, env);

    // 3b. Voice server (voice pack): Whisper and VoxCPM2 on the GPU.
    let voice = py("voice").exists();
    if voice {
        b.add("voice", 8890, &py("voice"), quote(&root.join("tools").join("voice_server.py")), root, Some("voice"), common.clone());
    }
    // 3c. Phonon speech-to-text (transcribe pack), CPU.
    let fermion = root.join("envs").join("transcribe").join("Scripts").join("fermion.exe");
    if fermion.exists() {
        b.add("phonon", 8891, &fermion, "serve phonon-2 --port 8891".into(), root, None, common.clone());
    }
    // 3d. Search everything (search pack): EmbeddingGemma 2 with its vision part, on Ollama's card (~1.2 GB; with two
    // cards, the small one). Its own llama-server, so embedding never waits for a chat model to load.
    let gguf = root.join("models").join("gguf");
    if gguf.join(crate::search::MODEL).exists() {
        let mut args = format!("-m {} --embedding -c 8192 -b 8192 -ub 8192 -ngl 99 --host 127.0.0.1 --port {}", quote(&gguf.join(crate::search::MODEL)), crate::search::PORT);
        if gguf.join(crate::search::MMPROJ).exists() {
            args += &format!(" --mmproj {}", quote(&gguf.join(crate::search::MMPROJ)));
        }
        b.add("search", crate::search::PORT, &root.join("bin").join("llama.cpp").join("llama-server.exe"), args, root, Some("ollama"), BTreeMap::new());
    }

    // 4. The tool server, with --hot-reload so tools added in Prestige apply while it runs.
    let mcpo = root.join("envs").join("tools").join("Scripts").join("mcpo.exe");
    b.add("mcpo", 8200, &mcpo, format!("--host 127.0.0.1 --port 8200 --config {} --hot-reload", quote(&runtime.join("mcpo-config.json"))), root, None, common.clone());

    // 5. ComfyUI (images, video, songs, 3D), headless.
    if !svc.comfyui {
        b.off("comfyui", 8188, "switched off in the Workstation settings");
    } else if let Some((dir, python)) = find_comfy(root) {
        // The Workstation's own nodes (and ashukae's MangaScreen), copied on every start so they follow this folder's version.
        for n in ["workstation_gpus", "workstation_music", "workstation_lora", "manga_screen"] {
            let from = root.join("tools").join("comfy_nodes").join(n);
            if from.exists() {
                if let Err(e) = copy_dir(&from, &dir.join("custom_nodes").join(n)) {
                    notes.push(format!("couldn't copy ComfyUI node {n}: {e}"));
                }
            }
        }
        ensure_node_packages(&dir, &python, &mut notes);
        let output = root.join("data").join("comfy-output");
        let args = |port: u16| format!("main.py --listen 127.0.0.1 --port {port} --disable-smart-memory --extra-model-paths-config {} --output-directory {}", quote(&yaml), quote(&output));
        b.add("comfyui", 8188, &python, args(8188), &dir, Some("comfyui"), common.clone());
        if plan.is_some_and(|p| p.comfy_quick.is_some()) {
            let a = format!("{} --temp-directory {}", args(8189), quote(&root.join("data").join("comfy-quick")));
            b.add("comfyui-quick", 8189, &python, a, &dir, Some("comfyquick"), common.clone());
        }
    } else {
        b.off("comfyui", 8188, "not installed");
    }

    // 6. Open WebUI (optional): chat in a browser, with its own memory.
    if svc.open_webui {
        let owui = root.join("envs").join("open-webui");
        let mut env = common.clone();
        let data = root.join("data").join("open-webui");
        set(&mut env, &[
            ("DATA_DIR", &data.to_string_lossy()),
            ("WEBUI_AUTH", "False"),
            ("OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
            ("OPENAI_API_BASE_URLS", "http://127.0.0.1:8081/v1"),
            ("OPENAI_API_KEYS", "none"),
            ("ENABLE_MEMORIES", "True"),
            ("ENABLE_MEMORY_SYSTEM_CONTEXT", "True"),
            ("ENABLE_MEMORY_BACKGROUND_REVIEW", "True"),
            ("MEMORIES_REVIEW_INTERVAL_TURNS", "4"),
            ("MEMORIES_USER_CHAR_LIMIT", "6000"),
            ("MEMORIES_CONTEXT_CHAR_LIMIT", "6000"),
            ("ENABLE_EVALUATION_ARENA_MODELS", "False"),
            ("ENABLE_WEB_SEARCH", "True"),
            ("WEB_SEARCH_ENGINE", "duckduckgo"),
            ("WHISPER_MODEL", "base"),
            ("AUDIO_TTS_ENGINE", "openai"),
            ("AUDIO_TTS_OPENAI_API_BASE_URL", "http://127.0.0.1:8880/v1"),
            ("AUDIO_TTS_OPENAI_API_KEY", "none"),
            ("AUDIO_TTS_MODEL", "kokoro"),
            ("AUDIO_TTS_VOICE", "af_heart"),
            ("ENABLE_IMAGE_GENERATION", "True"),
            ("IMAGE_GENERATION_ENGINE", "comfyui"),
            ("COMFYUI_BASE_URL", "http://127.0.0.1:8188"),
            ("TOOL_SERVER_CONNECTIONS", TOOL_SERVERS),
        ]);
        if voice {
            // Speech-to-text through the voice server (Whisper turbo on the GPU).
            set(&mut env, &[
                ("AUDIO_STT_ENGINE", "openai"),
                ("AUDIO_STT_OPENAI_API_BASE_URL", "http://127.0.0.1:8890/v1"),
                ("AUDIO_STT_OPENAI_API_KEY", "none"),
                ("AUDIO_STT_MODEL", "whisper-large-v3-turbo"),
            ]);
            let script = root.join("scripts").join("owui-voice-config.py");
            if script.exists() && owui.join("Scripts").join("python.exe").exists() && !listening(8080) {
                let _ = hidden(&mut Command::new(owui.join("Scripts").join("python.exe")))
                    .arg(&script)
                    .arg(data.join("webui.db"))
                    .stdin(Stdio::null())
                    .output();
            }
        }
        // Theme: Open WebUI serves /static/custom.css and loader.js on every page.
        if let Ok(loader) = fs::read_to_string(root.join("theme").join("loader.js")) {
            let loader = format!("window.CAI_DEFAULT_THEME = '{}';\n{loader}", svc.theme);
            let pkg = owui.join("Lib").join("site-packages").join("open_webui");
            for dir in [pkg.join("frontend").join("static"), pkg.join("static")] {
                if dir.exists() {
                    let _ = fs::copy(root.join("theme").join("custom.css"), dir.join("custom.css"));
                    let _ = fs::write(dir.join("loader.js"), &loader);
                }
            }
        }
        b.add("open-webui", 8080, &owui.join("Scripts").join("open-webui.exe"), "serve --host 127.0.0.1 --port 8080".into(), root, Some("openwebui"), env);
    } else {
        b.off("open-webui", 8080, "switched off in the Workstation settings");
    }

    let written = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let manifest = json!({ "version": 1, "by": "prestige", "written": written, "root": root, "services": b.services, "off": b.off, "notes": notes });
    write(&runtime.join("services.json"), &serde_json::to_string_pretty(&manifest).unwrap())?;
    Ok(Prepared { manifest })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_packages_reads_dist_info() {
        let site = std::env::temp_dir().join(format!("prep-site-{}", std::process::id()));
        let _ = fs::remove_dir_all(&site);
        for d in ["Pillow-11.3.0.dist-info", "opencv_python_headless-4.12.0.dist-info", "sentencepiece-0.2.1.dist-info"] {
            fs::create_dir_all(site.join(d)).unwrap();
        }
        let req = "# main
gguf>=0.13.0
# optional - tokenizer
sentencepiece
pillow>=10.3.0
opencv-python-headless
color-matcher ; python_version >= '3.9'
-e git+https://x/y
";
        assert_eq!(missing_packages(req, &site), vec!["gguf", "color-matcher"]);
        let _ = fs::remove_dir_all(&site);
    }

    fn cards() -> Vec<Gpu> {
        parse_gpus("0, GPU-aaa, NVIDIA GeForce RTX 3060, 12288\n1, GPU-bbb, NVIDIA GeForce RTX 2060, 6144\n")
    }

    #[test]
    fn reads_nvidia_smi() {
        let g = cards();
        assert_eq!(g[0], Gpu { index: 0, uuid: "GPU-aaa".into(), name: "RTX 3060".into(), mib: 12288 });
        assert_eq!((g[0].gb(), g[1].gb()), (12.0, 6.0));
    }

    #[test]
    fn settings_fall_back_on_bad_values() {
        let (s, notes) = read_settings(Some(&json!({ "ollamaKeepAlive": "30m", "llamaIdleSeconds": 0, "llamaModelsMax": 12, "comfyui": "false", "openWebUI": "off", "theme": "pink", "x": 1 })));
        assert_eq!(s.ollama_keep_alive, "30m");
        assert_eq!(s.llama_idle_seconds, 0);
        assert_eq!(s.llama_models_max, 1);
        assert!(!s.comfyui && !s.open_webui);
        assert_eq!(s.theme, "dragon");
        assert_eq!(notes.len(), 3, "{notes:?}");
        assert!(keep_alive_ok("-1") && keep_alive_ok("1.5h") && !keep_alive_ok("5 m") && !keep_alive_ok("m"));
    }

    #[test]
    fn split_puts_the_small_models_on_the_small_card() {
        let p = gpu_plan(&cards(), &json!({}), "").unwrap();
        assert_eq!(p.mode, "split");
        let idx = |k: &str| p.services[k].iter().map(|g| g.index).collect::<Vec<_>>();
        assert_eq!((idx("ollama"), idx("openwebui"), idx("voice"), idx("llama"), idx("comfyui")), (vec![1], vec![1], vec![0], vec![0], vec![0]));
        assert_eq!(p.ollama_context, 16384);
        assert!(!p.llama_fit, "one 12 GB card keeps the hand-tuned ini");
        assert_eq!(p.comfy_aux, None);
        assert!(p.multi && p.notes.iter().any(|n| n.contains("6 GB")));
    }

    #[test]
    fn overrides_like_ryans() {
        // Ryan's PC: the big model pooled over both cards, ComfyUI's VAEs on the 2060, the quick ComfyUI on.
        let s = json!({ "mode": "split", "services": { "llama": ["3060", "2060"], "comfyui": "all" }, "comfyAux": "vae,upscaler", "comfyQuick": "on", "ollamaContext": "20480" });
        let p = gpu_plan(&cards(), &s, "").unwrap();
        assert_eq!(p.services["llama"].iter().map(|g| g.index).collect::<Vec<_>>(), [0, 1]);
        assert!(p.llama_fit);
        assert_eq!(p.llama_gb, 18.0);
        assert_eq!(p.comfy_aux.as_deref(), Some("vae,upscaler"));
        assert_eq!(p.comfy_quick, None, "the quick ComfyUI never shares ComfyUI's cards");
        assert_eq!(p.ollama_context, 20480);
        let env = gpu_env(Some(&p), Some("comfyui"));
        assert_eq!(env["CUDA_VISIBLE_DEVICES"].as_deref(), Some("GPU-aaa,GPU-bbb"));
        assert_eq!(env["WORKSTATION_COMFY_AUX_PARTS"].as_deref(), Some("vae,upscaler"));
        let p = gpu_plan(&cards(), &json!({ "comfyQuick": true }), "").unwrap();
        assert_eq!(p.comfy_quick.map(|g| g.index), Some(1));
    }

    #[test]
    fn one_card_and_bad_modes() {
        let one = &cards()[..1];
        let p = gpu_plan(one, &json!({ "mode": "pool" }), "").unwrap();
        assert_eq!(p.mode, "single");
        assert!(!p.multi && p.notes[0].contains("needs two GPUs"));
        assert_eq!(gpu_env(Some(&p), Some("ollama")), BTreeMap::from([("CUDA_VISIBLE_DEVICES".to_string(), None)]));
        let p = gpu_plan(&cards(), &json!({ "exclude": "2060" }), "").unwrap();
        assert_eq!((p.mode.as_str(), p.gpus.len(), p.multi), ("single", 1, true));
        assert!(gpu_plan(&[], &json!({}), "").is_none());
        let p = gpu_plan(&cards(), &json!({ "mode": "fast" }), "pool").unwrap();
        assert_eq!((p.mode.as_str(), p.services["llama"].len()), ("pool", 2));
        let p = gpu_plan(&cards(), &json!({ "services": { "olama": "big", "voice": "9090" } }), "").unwrap();
        assert_eq!(p.notes.iter().filter(|n| n.contains("olama") || n.contains("9090")).count(), 2);
    }

    #[test]
    fn llama_ini_for_the_plan() {
        let ini = "[*]\r\nn-gpu-layers = 99\r\n\r\n[qwen]\r\nmodel = x\r\nn-cpu-moe = 25\r\nc = 32768\r\nn-gpu-layers-draft = 9";
        assert_eq!(convert_llama_ini(ini, None), ini);
        let mut p = gpu_plan(&cards(), &json!({ "mode": "pool" }), "").unwrap();
        assert!(p.llama_fit);
        assert_eq!(convert_llama_ini(ini, Some(&p)), "[*]\r\n\r\n[qwen]\r\nmodel = x\r\nc = 32768\r\nn-gpu-layers-draft = 9");
        p.llama_gb = 6.0;
        assert!(convert_llama_ini(ini, Some(&p)).contains("c = 16384"));
        let p = gpu_plan(&cards(), &json!({ "mode": "pool", "tensorSplit": "3,1" }), "").unwrap();
        assert!(!p.llama_fit);
        assert_eq!(convert_llama_ini("[*]\nngl = 99\n", Some(&p)), "[*]\r\ntensor-split = 3,1\r\nngl = 99\r\n");
    }

    #[test]
    fn tool_store_tools_join_but_cant_replace() {
        let root = Path::new(r"C:\RG\Workstation");
        let base = r#"{"mcpServers":{"fetch":{"command":"{ROOT}\\envs\\f.exe"}}}"#;
        let extra = r#"{"mcpServers":{"fetch":{"command":"evil"},"weather":{"command":"npx","args":["w"]}}}"#;
        let mut notes = Vec::new();
        let v = tool_config(base, Some(extra), root, &mut notes).unwrap();
        assert_eq!(v["mcpServers"]["fetch"]["command"], r"C:\RG\Workstation\envs\f.exe");
        assert_eq!(v["mcpServers"]["weather"]["command"], "npx");
        assert_eq!(notes.len(), 1);
        let v = tool_config(base, Some("{nope"), root, &mut notes).unwrap();
        assert_eq!(v["mcpServers"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn comfy_model_folders() {
        let y = comfy_yaml(Path::new(r"C:\W"), false, Some(Path::new(r"C:\S")));
        assert!(y.contains("workstation_comfy:\n  base_path: C:\\W\\models\\comfy\n"));
        assert!(!y.contains("comfy_fast"));
        assert!(y.contains("comfy_desktop_shared:\n  base_path: C:\\S\n  is_default: true"));
        assert!(comfy_yaml(Path::new("W"), true, None).contains("workstation_comfy_fast:"));
    }
}
