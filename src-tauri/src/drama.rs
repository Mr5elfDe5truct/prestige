// Audio drama: Fish Audio's Drama 3 (the drama pack; Fish Audio Community License) reads a multi-speaker script in one
// pass, with speaker tags (<|speaker:0|> to <|speaker:15|>) and cues like [laughs], through audio.cpp's native CLI.
// Each cast member can speak in a saved voice (data\voices\<name>.wav and its transcript, the same clips VoxCPM2
// clones), given as an ordered reference. The script and an optional music bed become one MP3 in the gallery.
//
// On an RTX 3060 12 GB with 32 GB of RAM the Q2-expert model ran in disk-backed expert mode: the routed experts stay
// in the GGUF and a 64-slot cache per layer holds the ones in use. That kept the process at ~10 GB of RAM (resident
// mode needed 23 GB and left the PC at 30.5 of 32 GB) and 9.6-11 GB of VRAM, at 4.3-5.8 s of work per second of audio.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;
use tauri::{AppHandle, Emitter};

use crate::studio::output_dir;
use crate::{hidden, stack_root};

pub(crate) const MODEL: &str = "drama-3-backbone-8bit-experts-Q2_K.gguf";
pub(crate) const DIR: &str = "drama-3";
/// Cache slots per layer for disk-backed experts: 64 was quicker than 32 and 96 on the 12 GB card.
const EXPERT_CACHE: &str = "64";
/// Speech tokens a chunk may make (~21.5 a second, so ~55 s): with the prompt it has to fit the 4k context, and
/// Drama 3's own chunker cuts a script into ~128-character pieces.
const MAX_TOKENS: &str = "1200";

fn model(root: &Path) -> PathBuf {
    root.join("models").join("tts").join(DIR).join(MODEL)
}

/// audio.cpp's CLI: bin\audio.cpp\audiocpp_cli.exe (or in a versioned folder under it).
fn cli(root: &Path) -> Option<PathBuf> {
    let dir = root.join("bin").join("audio.cpp");
    let exe = "audiocpp_cli.exe";
    if dir.join(exe).exists() {
        return Some(dir.join(exe));
    }
    fs::read_dir(&dir).ok()?.flatten().map(|e| e.path().join(exe)).find(|p| p.exists())
}

/// A cast member's voice: a saved voice's clip and the words it says.
fn voice(root: &Path, name: &str) -> Result<(PathBuf, String), String> {
    if name.is_empty() || name.contains(['/', '\\', '.']) {
        return Err(format!("no voice called {name}"));
    }
    let dir = root.join("data").join("voices");
    let wav = dir.join(format!("{name}.wav"));
    let text = fs::read_to_string(dir.join(format!("{name}.txt"))).unwrap_or_default();
    if !wav.exists() {
        return Err(format!("the voice {name} isn't in data\\voices"));
    }
    if text.trim().is_empty() {
        return Err(format!("the voice {name} has no transcript, which Drama 3 needs to clone it (make it again in Voice)"));
    }
    Ok((wav, text.trim().to_string()))
}

#[tauri::command]
pub fn drama_status(root: Option<String>) -> bool {
    let root = stack_root(root);
    model(&root).exists() && cli(&root).is_some()
}

/// The saved voices Drama 3 can speak in: those with a transcript beside their clip.
#[tauri::command]
pub fn drama_voices(root: Option<String>) -> Vec<String> {
    let dir = stack_root(root).join("data").join("voices");
    let mut out: Vec<String> = fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_stem()?.to_str()?.to_string();
            (p.extension()? == "wav" && fs::read_to_string(dir.join(format!("{name}.txt"))).is_ok_and(|t| !t.trim().is_empty())).then_some(name)
        })
        .collect();
    out.sort();
    out
}

/// The card ComfyUI renders on (data\runtime\gpu.json), which Drama 3 borrows the same way.
fn comfy_card(root: &Path) -> Option<String> {
    let text = fs::read_to_string(root.join("data").join("runtime").join("gpu.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let index = v["services"]["comfyui"][0].as_u64()?;
    v["gpus"].as_array()?.iter().find(|g| g["index"].as_u64() == Some(index))?["uuid"].as_str().map(String::from)
}

#[derive(Deserialize)]
pub struct CastVoice {
    /// The speaker number in the script's tags.
    speaker: u32,
    /// A saved voice's name, or empty for Drama 3's own voice.
    voice: String,
}

/// Reads a tagged script with Drama 3 and saves it as a WAV in ComfyUI's output folder (audio\), returning its path.
/// It runs on ComfyUI's card. Emits "drama" events with the seconds it has been working.
#[tauri::command]
pub async fn drama_render(app: AppHandle, root: Option<String>, text: String, cast: Vec<CastVoice>, seed: u64, name: String) -> Result<String, String> {
    let root = stack_root(root.clone());
    let out_dir = output_dir(Some(root.to_string_lossy().into_owned())).join("audio");
    tauri::async_runtime::spawn_blocking(move || {
        let exe = cli(&root).ok_or("Audio drama needs the Drama pack (audio.cpp and Drama 3): add it in Packs")?;
        let m = model(&root);
        if !m.exists() {
            return Err("Audio drama needs the Drama pack (Drama 3, 17 GB): add it in Packs".into());
        }
        let mut refs = Vec::new();
        for c in cast.iter().filter(|c| !c.voice.is_empty()) {
            let (wav, said) = voice(&root, &c.voice)?;
            refs.push(serde_json::json!({ "text": format!("<|speaker:{}|> {said}", c.speaker), "audio_path": wav.to_string_lossy() }));
        }
        fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
        let stem: String = name.chars().map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' }).collect::<String>().trim_matches('-').chars().take(40).collect();
        let stem = if stem.is_empty() { "drama".to_string() } else { stem };
        let file = (1..1000).map(|n| out_dir.join(format!("drama-{stem}{}.wav", if n == 1 { String::new() } else { format!("-{n}") }))).find(|p| !p.exists()).ok_or("too many versions")?;
        // The script goes in a file: a long one is past Windows' command-line limit.
        let script = std::env::temp_dir().join(format!("prestige-drama-{}.txt", std::process::id()));
        fs::write(&script, &text).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(&exe);
        hidden(&mut cmd)
            .current_dir(exe.parent().unwrap_or(&root))
            .args(["--task", "tts", "--family", "fish_drama3", "--backend", "cuda", "--mode", "offline", "--model"])
            .arg(&m)
            .arg("--batch-text-file")
            .arg(&script)
            .args(["--batch-merge-audio", "concat", "--seed", &seed.to_string(), "--threads", "8", "--max-tokens", MAX_TOKENS])
            .args(["--session-option", "fish_drama3.disk_experts=true"])
            .args(["--session-option", &format!("fish_drama3.expert_cache_size={EXPERT_CACHE}")])
            .args(["--session-option", "fish_drama3.cpu_expert_layers=0"])
            .args(["--session-option", "fish_drama3.context_length=4096"])
            .arg("--out")
            .arg(&file);
        if !refs.is_empty() {
            cmd.args(["--request-option", &format!("references={}", serde_json::Value::Array(refs))]);
        }
        if let Some(card) = comfy_card(&root) {
            cmd.env("CUDA_VISIBLE_DEVICES", card);
        }
        let log = root.join("logs").join("drama.log");
        let _ = fs::create_dir_all(root.join("logs"));
        if let Ok(f) = fs::File::create(&log) {
            if let Ok(f2) = f.try_clone() {
                cmd.stdout(f).stderr(f2);
            }
        }
        let mut child = cmd.spawn().map_err(|e| format!("audio.cpp: {e}"))?;
        let t0 = std::time::Instant::now();
        let status = loop {
            if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
                break s;
            }
            let _ = app.emit("drama", t0.elapsed().as_secs());
            std::thread::sleep(std::time::Duration::from_secs(1));
        };
        let _ = fs::remove_file(&script);
        if !status.success() || !file.exists() {
            let tail: String = fs::read_to_string(&log).unwrap_or_default().lines().rev().filter(|l| !l.trim().is_empty()).take(3).collect::<Vec<_>>().join(" / ");
            return Err(format!("Drama 3 stopped: {}", if tail.is_empty() { "see logs\\drama.log" } else { &tail }));
        }
        Ok(file.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The drama as an MP3 next to its WAV, with a music bed under it (quiet, faded out at the end) if one is given. The
/// WAV and the music track are removed once the MP3 is made.
#[tauri::command]
pub async fn drama_mix(root: Option<String>, voice: String, music: Option<String>) -> Result<String, String> {
    let out_dir = output_dir(root);
    tauri::async_runtime::spawn_blocking(move || {
        let v = PathBuf::from(&voice);
        if !v.starts_with(&out_dir) || !v.is_file() {
            return Err(format!("{} isn't a render", v.display()));
        }
        let mp3 = v.with_extension("mp3");
        let mut cmd = Command::new("ffmpeg");
        hidden(&mut cmd).args(["-v", "error", "-y", "-i"]).arg(&v);
        let bed = music.map(PathBuf::from).filter(|m| m.starts_with(&out_dir) && m.is_file());
        if let Some(m) = &bed {
            let secs: f64 = String::from_utf8_lossy(&hidden(&mut Command::new("ffprobe")).args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"]).arg(&v).output().map_err(|e| format!("ffprobe: {e}"))?.stdout).trim().parse().unwrap_or(60.0);
            // The music loops if it's shorter than the drama, sits ~15 dB under the voices and fades out over its last 4 s.
            cmd.args(["-stream_loop", "-1", "-i"]).arg(m).arg("-filter_complex").arg(format!(
                "[1:a]volume=0.18,afade=t=in:d=2,afade=t=out:st={:.2}:d=4[bed];[0:a][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]",
                (secs - 4.0).max(0.0)
            ));
            cmd.args(["-map", "[a]"]);
        }
        cmd.args(["-c:a", "libmp3lame", "-q:a", "2"]).arg(&mp3);
        let ok = cmd.status().map_err(|e| format!("ffmpeg: {e}"))?;
        if !ok.success() || !mp3.exists() {
            return Err("ffmpeg couldn't make the MP3".into());
        }
        let _ = fs::remove_file(&v);
        if let Some(m) = bed {
            let _ = fs::remove_file(m);
        }
        Ok(mp3.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}
