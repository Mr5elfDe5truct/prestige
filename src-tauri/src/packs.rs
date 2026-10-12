// Model packs and engine updates, in Prestige: what install.ps1's packs did, with progress, pause and resume, and
// Remove. A pack is files from Hugging Face (into models\gguf or models\comfy), Ollama models (pulled into the
// Workstation's own Ollama) and sometimes a Python environment (uv). Status is read from disk, so packs installed by
// install.ps1, by hand, or into Comfy Desktop's shared models folder count too. Engines: llama.cpp (new build with
// roll back), ComfyUI (its own install: git; Comfy Desktop updates itself) and Ollama (winget).

use crate::{hidden, prep, services, stack_root};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

// ---------- the catalog ----------

#[derive(Clone, Debug)]
pub enum Item {
    /// A file from `url` saved at `dest` (relative to the Workstation folder); any of `alts` (same folder) counts as it.
    File { url: String, dest: String, alts: Vec<String> },
    Ollama(String),
    /// A Python environment: `probe` (relative) exists once it's set up; `steps` are uv commands run in the root.
    Env { name: String, probe: String, steps: Vec<Vec<String>> },
    /// A zip unpacked into `dir`, checked against the SHA-256 at `sha_url`; `probe` is a file inside once it's there.
    Zip { url: String, sha_url: String, dir: String, probe: String },
}

#[derive(Clone, Debug)]
pub struct Pack {
    pub id: &'static str,
    pub title: &'static str,
    pub text: String,
    pub gb: f64,
    pub items: Vec<Item>,
    /// Peak VRAM on the card it runs on, for the fit warning (GB), and RAM it wants.
    pub vram: f64,
    pub ram: f64,
    /// Which plan service's card it runs on ("comfyui", "llama", "ollama", "voice").
    pub card: &'static str,
}

fn hf(repo: &str, path: &str) -> String {
    format!("https://huggingface.co/{repo}/resolve/main/{path}")
}
fn gguf(repo: &str, path: &str, name: &str) -> Item {
    Item::File { url: hf(repo, path), dest: format!(r"models\gguf\{name}"), alts: vec![] }
}
/// A ComfyUI model: models\comfy\<folder>\<file name of path>.
fn comfy(repo: &str, path: &str, folder: &str) -> Item {
    let name = path.rsplit('/').next().unwrap();
    Item::File { url: hf(repo, path), dest: format!(r"models\comfy\{folder}\{name}"), alts: vec![] }
}
fn comfy_same(repo: &str, path: &str) -> Item {
    let (folder, _) = path.split_once('/').unwrap();
    comfy(repo, path, folder)
}
pub(crate) fn uv(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

/// Every pack. Ollama's fast and vision models depend on the card Ollama runs on (`ollama_gb`), as in install.ps1.
pub fn catalog(ollama_gb: f64) -> Vec<Pack> {
    let fast = if ollama_gb >= 7.5 { "hf.co/LEONW24/Qwen3.5-9B-Uncensored:Q4_K_M" } else { "qwen3.5:4b" };
    let vision = if ollama_gb >= 10.0 { "gemma4:12b" } else if ollama_gb >= 7.5 { "qwen3-vl:8b" } else { "qwen3.5:4b" };
    let q38 = "HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF";
    let ace = "Comfy-Org/ace_step_1.5_ComfyUI_files";
    let wan21 = "Comfy-Org/Wan_2.1_ComfyUI_repackaged";
    let mut deep_main = gguf(q38, "Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q2_K_P.gguf", "Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q2_K_P.gguf");
    if let Item::File { alts, .. } = &mut deep_main {
        // A bigger quant set up by hand (Q3_K_P split over two cards) is the same model.
        alts.extend(["Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q3_K_P.gguf", "Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-IQ4_XS.gguf"].map(String::from));
    }
    vec![
        Pack { id: "fast", title: "Fast chat", text: format!("{} (Ollama), plus the small embedding model that reads your files", if fast.contains("9B") { "Qwen3.5 9B Uncensored" } else { "Qwen3.5 4B, picked for Ollama's card" }), gb: if fast.contains("9B") { 7.3 } else { 4.0 }, items: vec![Item::Ollama(fast.into()), Item::Ollama("qwen3-embedding:0.6b".into())], vram: if fast.contains("9B") { 6.5 } else { 3.4 }, ram: 0.0, card: "ollama" },
        Pack { id: "vision", title: "Vision", text: format!("{vision} (Ollama): pictures, the webcam, tools"), gb: match vision { "gemma4:12b" => 8.0, "qwen3-vl:8b" => 6.1, _ => 3.4 }, items: vec![Item::Ollama(vision.into())], vram: match vision { "gemma4:12b" => 9.0, "qwen3-vl:8b" => 7.0, _ => 3.4 }, ram: 0.0, card: "ollama" },
        Pack { id: "main", title: "Main", text: "Qwen3.6 35B Heretic (llama.cpp): best quality, experts in RAM".into(), gb: 22.1, items: vec![
            gguf("Youssofal/Qwen3.6-35B-A3B-Abliterated-Heretic-GGUF", "Qwen3.6-35B-A3B-Abliterated-Heretic-Q4_K_M/Qwen3.6-35B-A3B-Abliterated-Heretic-Q4_K_M.gguf", "qwen3.6-35b-a3b-heretic-Q4_K_M.gguf"),
            gguf("Youssofal/Qwen3.6-35B-A3B-Abliterated-Heretic-GGUF", "mmproj-Qwen3.6-35B-A3B-Abliterated-Heretic.gguf", "qwen3.6-35b-a3b-heretic-mmproj.gguf"),
        ], vram: 10.0, ram: 32.0, card: "llama" },
        Pack { id: "deep", title: "Deep", text: "Qwen3.8 27B Uncensored (llama.cpp): strongest reasoning".into(), gb: 10.9, items: vec![
            deep_main,
            gguf(q38, "mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf", "mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf"),
        ], vram: 11.0, ram: 0.0, card: "llama" },
        Pack { id: "voice", title: "Voice", text: "Whisper turbo + VoxCPM2 voices and cloning, and the small Live call models (GPU)".into(), gb: 18.1, items: {
            let mut v: Vec<Item> = ["config.json", "special_tokens_map.json", "tokenization_voxcpm2.py", "tokenizer.json", "tokenizer_config.json", "audiovae.pth", "model.safetensors"]
                .iter().map(|f| Item::File { url: hf("openbmb/VoxCPM2", f), dest: format!(r"models\tts\VoxCPM2\{f}"), alts: vec![] }).collect();
            v.push(Item::Env { name: "voice".into(), probe: r"envs\voice\Scripts\python.exe".into(), steps: vec![
                uv(&["venv", r"envs\voice", "--python", "3.12", "-q"]),
                uv(&["pip", "install", "-p", r"envs\voice", "torch", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cu128", "-q"]),
                uv(&["pip", "install", "-p", r"envs\voice", "-r", r"requirements\voice.txt", "-q"]),
            ] });
            v.push(Item::Ollama("qwen3.5:2b".into()));
            v.push(Item::Ollama("qwen3.5:4b".into()));
            v
        }, vram: 7.5, ram: 0.0, card: "voice" },
        Pack { id: "images", title: "Images", text: "Qwen-Image-2.1 (+ 4-step turbo) and Z-Image-Turbo (ComfyUI): text to image and editing".into(), gb: 36.5, items: vec![
            comfy("abenzerps/Qwen-Image-2.1-Uncensored-GGUF", "qwen-image-2.1-UC-Q4_K_M.gguf", "unet"),
            comfy("Abiray/Qwen-Image-2.1-viggle-4-steps-turbo-GGUF", "qwen_image_2.1_turbo_Q4_K_M.gguf", "unet"),
            comfy("unsloth/Qwen3-VL-8B-Instruct-GGUF", "Qwen3-VL-8B-Instruct-UD-Q4_K_XL.gguf", "text_encoders"),
            Item::File { url: hf("unsloth/Qwen3-VL-8B-Instruct-GGUF", "mmproj-F16.gguf"), dest: r"models\comfy\text_encoders\Qwen3-VL-8B-Instruct-mmproj-F16.gguf".into(), alts: vec![] },
            comfy("Comfy-Org/Qwen-Image-2.1", "vae/qwen_image_2.1_vae_bf16.safetensors", "vae"),
            comfy("Comfy-Org/z_image_turbo", "split_files/diffusion_models/z_image_turbo_bf16.safetensors", "diffusion_models"),
            comfy("Comfy-Org/z_image_turbo", "split_files/text_encoders/qwen_3_4b.safetensors", "text_encoders"),
            comfy("Comfy-Org/z_image_turbo", "split_files/vae/ae.safetensors", "vae"),
        ], vram: 10.0, ram: 0.0, card: "comfyui" },
        Pack { id: "video", title: "Video", text: "LTX-2.5 + Wan 2.2 (ComfyUI): text or picture to video, with sound".into(), gb: 60.3, items: vec![
            comfy("jayn7/WAN2.2-I2V_A14B-DISTILL-LIGHTX2V-4STEP-GGUF", "high_noise_260412/wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-Q4_K_M.gguf", "unet"),
            comfy("jayn7/WAN2.2-I2V_A14B-DISTILL-LIGHTX2V-4STEP-GGUF", "low_noise_260412/wan2.2_i2v_A14b_low_noise_lightx2v_4step_720p_260412-Q4_K_M.gguf", "unet"),
            comfy(wan21, "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", "text_encoders"),
            comfy(wan21, "split_files/vae/wan_2.1_vae.safetensors", "vae"),
            comfy("Abiray/LTX-2.5-Distilled-GGUF", "LTX-2.5-Distilled-Q4_K_M.gguf", "unet"),
            comfy_same("comfyicu/LTX-2.5", "text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"),
            comfy_same("comfyicu/LTX-2.5", "vae/ltx-2.5-video-vae-bf16.safetensors"),
            comfy_same("comfyicu/LTX-2.5", "vae/ltx-2.5-audio-vae-bf16.safetensors"),
            comfy_same("comfyicu/LTX-2.5", "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"),
        ], vram: 10.0, ram: 0.0, card: "comfyui" },
        Pack { id: "computer", title: "Computer use", text: "UI-TARS 1.5 7B (llama.cpp): drives the mouse and keyboard".into(), gb: 6.9, items: vec![
            gguf("Mungert/UI-TARS-1.5-7B-GGUF", "UI-TARS-1.5-7B-q5_k_m.gguf", "UI-TARS-1.5-7B-q5_k_m.gguf"),
            gguf("Mungert/UI-TARS-1.5-7B-GGUF", "UI-TARS-1.5-7B-f16.mmproj", "UI-TARS-1.5-7B-f16.mmproj"),
        ], vram: 7.0, ram: 0.0, card: "llama" },
        Pack { id: "nex", title: "Nex-N2.5-mini", text: "The model Do it for me (/do) prefers: a 35B-A3B trained for computer use, experts in RAM (llama.cpp)".into(), gb: 21.6, items: vec![
            gguf("bartowski/nex-agi_Nex-N2.5-mini-GGUF", "nex-agi_Nex-N2.5-mini-Q4_K_M.gguf", "nex-agi_Nex-N2.5-mini-Q4_K_M.gguf"),
            gguf("bartowski/nex-agi_Nex-N2.5-mini-GGUF", "mmproj-nex-agi_Nex-N2.5-mini-f16.gguf", "mmproj-nex-agi_Nex-N2.5-mini-f16.gguf"),
        ], vram: 10.0, ram: 32.0, card: "llama" },
        Pack { id: "music", title: "Music", text: "ACE-Step 1.5 turbo + base (ComfyUI): songs with vocals, the song editor and stems".into(), gb: 14.8, items: [
            ("diffusion_models", "acestep_v1.5_turbo.safetensors"), ("diffusion_models", "acestep_v1.5_base.safetensors"),
            ("text_encoders", "qwen_0.6b_ace15.safetensors"), ("text_encoders", "qwen_1.7b_ace15.safetensors"), ("vae", "ace_1.5_vae.safetensors"),
        ].iter().map(|(d, f)| comfy(ace, &format!("split_files/{d}/{f}"), d)).collect(), vram: 6.0, ram: 0.0, card: "comfyui" },
        Pack { id: "music-xl", title: "Music XL", text: "ACE-Step 1.5 XL turbo (ComfyUI): High quality songs".into(), gb: 10.0, items: [
            ("diffusion_models", "acestep_v1.5_xl_turbo_bf16.safetensors"), ("text_encoders", "qwen_0.6b_ace15.safetensors"),
            ("text_encoders", "qwen_1.7b_ace15.safetensors"), ("vae", "ace_1.5_vae.safetensors"),
        ].iter().map(|(d, f)| comfy(ace, &format!("split_files/{d}/{f}"), d)).collect(), vram: 11.0, ram: 0.0, card: "comfyui" },
        Pack { id: "transcribe", title: "Transcribe", text: "Phonon-2 + Nemotron 3 Diarization: recordings to text with who said what (CPU)".into(), gb: 1.0, items: vec![
            Item::Env { name: "transcribe".into(), probe: r"envs\transcribe\Scripts\fermion.exe".into(), steps: vec![
                uv(&["venv", r"envs\transcribe", "--python", "3.12", "-q"]),
                uv(&["pip", "install", "-p", r"envs\transcribe", "-r", r"requirements\transcribe.txt", "-q"]),
            ] },
            Item::Zip {
                url: "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.2.0/nemo-speech-0.2.0-windows-x86_64-cuda.zip".into(),
                sha_url: "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.2.0/nemo-speech-0.2.0-windows-x86_64-cuda.zip.sha256".into(),
                dir: r"bin\nemo-speech".into(),
                probe: "nemo-speech.exe".into(),
            },
            Item::File { url: hf("nvidia/Nemotron-3-Diarization", "Nemotron-3-Diarization.q8_0.gguf"), dest: r"models\speech\Nemotron-3-Diarization.q8_0.gguf".into(), alts: vec![] },
        ], vram: 0.0, ram: 0.0, card: "" },
        Pack { id: "3d", title: "Picture to 3D", text: "Pixal3D (ComfyUI, int8): a picture to a textured 3D model".into(), gb: 9.3, items: vec![
            comfy_same("Comfy-Org/Pixal3D", "diffusion_models/pixal3d_int8_convrot.safetensors"),
            comfy_same("Comfy-Org/Pixal3D", "clip_vision/dino_v3_L_naf_fp32.safetensors"),
            comfy_same("Comfy-Org/Pixal3D", "vae/trellis_2_shape_vae_bf16.safetensors"),
            comfy_same("Comfy-Org/Pixal3D", "vae/trellis_2_texture_vae_bf16.safetensors"),
            comfy_same("Comfy-Org/MoGe", "geometry_estimation/moge_2_vitl_normal_fp16.safetensors"),
            comfy_same("Comfy-Org/BiRefNet", "background_removal/birefnet.safetensors"),
        ], vram: 5.2, ram: 0.0, card: "comfyui" },
        Pack { id: "talk", title: "Talking", text: "InfiniteTalk on Wan 2.1 14B (ComfyUI): a face and a voice to a lip-synced video".into(), gb: 17.4, items: vec![
            comfy("city96/Wan2.1-I2V-14B-480P-gguf", "wan2.1-i2v-14b-480p-Q4_K_M.gguf", "unet"),
            comfy("Kijai/WanVideo_comfy", "Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors", "loras"),
            comfy(wan21, "split_files/model_patches/wan2.1_infiniteTalk_single_fp16.safetensors", "model_patches"),
            comfy("Kijai/wav2vec2_safetensors", "wav2vec2-chinese-base_fp16.safetensors", "audio_encoders"),
            comfy(wan21, "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", "text_encoders"),
            comfy(wan21, "split_files/vae/wan_2.1_vae.safetensors", "vae"),
        ], vram: 11.0, ram: 22.0, card: "comfyui" },
        Pack { id: "select", title: "Select", text: "SAM 3.1 + BiRefNet (ComfyUI): click or name to select, cut-outs, background removal".into(), gb: 2.2, items: vec![
            comfy_same("Comfy-Org/sam3.1", "checkpoints/sam3.1_multiplex_fp16.safetensors"),
            comfy_same("Comfy-Org/BiRefNet", "background_removal/birefnet.safetensors"),
        ], vram: 2.0, ram: 0.0, card: "comfyui" },
        Pack { id: "upscale", title: "Upscale", text: "SeedVR2 7B + 3B (ComfyUI, int8): pictures to 1080p or 4K, videos to 1080p".into(), gb: 12.3, items: vec![
            comfy_same("Comfy-Org/SeedVR2", "diffusion_models/seedvr2_7b_int8_convrot.safetensors"),
            comfy_same("Comfy-Org/SeedVR2", "diffusion_models/seedvr2_3b_int8_convrot.safetensors"),
            comfy_same("Comfy-Org/SeedVR2", "vae/seedvr2_ema_vae_fp16.safetensors"),
        ], vram: 10.0, ram: 0.0, card: "comfyui" },
        Pack { id: "reshoot", title: "Reshoot", text: "Multiple-Angles + Outfit Swap LoRAs for Qwen-Image-2.1 (ComfyUI): a new camera angle, try on an outfit (needs Images)".into(), gb: 0.5, items: vec![
            Item::File { url: hf("akhaliq/Qwen-Image-2.1-Multiple-Angles-LoRA", "checkpoints_v2/angles_v2_full_qwen21_multiple_angles_v2_qwen21_multiple_angles_v2_000001500.safetensors"), dest: r"models\comfy\loras\qwen-image-2.1-multiple-angles-v2.safetensors".into(), alts: vec![] },
            comfy("ausboss/Qwen-Image-2.1-Outfit-Swap-Consistency-LoRA", "qwen-image-2.1-outfit-swap.safetensors", "loras"),
        ], vram: 10.0, ram: 0.0, card: "comfyui" },
        Pack { id: "search", title: "Search", text: "EmbeddingGemma 2 (llama.cpp): search renders, songs, chats and files by meaning (needs llama.cpp b11452 or newer)".into(), gb: 0.9, items: vec![
            gguf("ggml-org/embeddinggemma-2-GGUF", crate::search::MODEL, crate::search::MODEL),
            gguf("ggml-org/embeddinggemma-2-GGUF", crate::search::MMPROJ, crate::search::MMPROJ),
        ], vram: 1.3, ram: 0.0, card: "ollama" },
        Pack { id: "ocr", title: "Read documents", text: "Unlimited-OCR 3B (llama.cpp): photos, scans and scanned PDFs to text and tables, for Studio and Knowledge".into(), gb: 2.8, items: vec![
            gguf("42ailab/Unlimited-OCR-GGUF", crate::ocr::MODEL, crate::ocr::MODEL),
            gguf("42ailab/Unlimited-OCR-GGUF", crate::ocr::MMPROJ, crate::ocr::MMPROJ),
        ], vram: 5.0, ram: 0.0, card: "llama" },
        Pack { id: "openwebui", title: "Open WebUI", text: "Chat in a browser at localhost:8080 (optional: Prestige has chat, voice and memory)".into(), gb: 2.5, items: vec![
            Item::Env { name: "open-webui".into(), probe: r"envs\open-webui\Scripts\open-webui.exe".into(), steps: vec![
                uv(&["venv", r"envs\open-webui", "--python", "3.11", "-q"]),
                uv(&["pip", "install", "-p", r"envs\open-webui", "-r", r"requirements\open-webui.txt", "-q"]),
            ] },
        ], vram: 0.0, ram: 0.0, card: "" },
    ]
}

// ---------- where things are ----------

fn shared_models() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default().join("Comfy-Desktop").join("ComfyUI-Shared").join("models")
}

/// The ComfyUI folder names that hold the same kind of model (Comfy Desktop keeps text encoders in clip\).
fn comfy_folders(folder: &str) -> Vec<&str> {
    match folder {
        "text_encoders" => vec!["text_encoders", "clip"],
        "unet" => vec!["unet", "diffusion_models"],
        "diffusion_models" => vec!["diffusion_models", "unet"],
        f => vec![f],
    }
}

/// Every place a file of this pack may already be: where Prestige saves it, the alternatives beside it and, for a
/// ComfyUI model, models\comfy-fast and Comfy Desktop's shared models folder.
fn candidates(root: &Path, dest: &str, alts: &[String]) -> Vec<PathBuf> {
    let rel = Path::new(dest);
    let name = rel.file_name().unwrap().to_string_lossy().to_string();
    let mut names = vec![name];
    names.extend(alts.iter().cloned());
    let mut out = Vec::new();
    let parts: Vec<String> = dest.split('\\').map(String::from).collect();
    if parts.len() == 4 && parts[0] == "models" && parts[1] == "comfy" {
        let folder = parts[2].as_str();
        for base in [root.join("models").join("comfy"), root.join("models").join("comfy-fast"), shared_models()] {
            for f in comfy_folders(folder) {
                for n in &names {
                    out.push(base.join(f).join(n));
                }
            }
        }
    } else {
        let dir = root.join(rel.parent().unwrap());
        for n in &names {
            out.push(dir.join(n));
        }
    }
    out
}

fn found(root: &Path, dest: &str, alts: &[String]) -> Option<PathBuf> {
    candidates(root, dest, alts).into_iter().find(|p| p.is_file())
}

fn zip_probe(root: &Path, dir: &str, probe: &str) -> bool {
    // NeMo-Speech unpacks into a versioned folder: bin\nemo-speech\<version>\bin\nemo-speech.exe.
    fs::read_dir(root.join(dir)).map(|rd| rd.flatten().any(|e| e.path().join("bin").join(probe).exists() || e.path().join(probe).exists())).unwrap_or(false)
}

fn ollama_tags() -> Option<HashSet<String>> {
    let r = ureq::get("http://127.0.0.1:11434/api/tags").timeout(std::time::Duration::from_secs(3)).call().ok()?;
    let v: Value = serde_json::from_str(&r.into_string().ok()?).ok()?;
    Some(v["models"].as_array()?.iter().filter_map(|m| m["name"].as_str()).map(|n| n.to_lowercase()).collect())
}

/// "qwen3.5:4b" and "qwen3.5:4b-…" style names, and "gemma4" meaning "gemma4:latest".
fn has_model(tags: &HashSet<String>, name: &str) -> bool {
    let n = name.to_lowercase();
    tags.contains(&n) || (!n.contains(':') && tags.contains(&format!("{n}:latest")))
}

fn present(root: &Path, item: &Item, tags: Option<&HashSet<String>>) -> Option<bool> {
    match item {
        Item::File { dest, alts, .. } => Some(found(root, dest, alts).is_some()),
        Item::Ollama(m) => tags.map(|t| has_model(t, m)),
        Item::Env { probe, .. } => Some(root.join(probe).exists()),
        Item::Zip { dir, probe, .. } => Some(zip_probe(root, dir, probe)),
    }
}

fn item_label(item: &Item) -> String {
    match item {
        Item::File { dest, .. } => Path::new(dest).file_name().unwrap().to_string_lossy().into_owned(),
        Item::Ollama(m) => format!("{m} (Ollama)"),
        Item::Env { name, .. } => format!("{name} Python environment"),
        Item::Zip { url, .. } => url.rsplit('/').next().unwrap_or("").to_string(),
    }
}

// ---------- status ----------

fn plan_and_ollama_gb(root: &Path) -> (Option<prep::Plan>, f64) {
    let settings = fs::read_to_string(root.join("data").join("gpu-settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok())
        .unwrap_or(json!({}));
    let plan = prep::gpu_plan(&prep::nvidia_gpus(), &settings, "");
    let gb = plan.as_ref().and_then(|p| p.services.get("ollama")).map(|c| c.iter().map(prep::Gpu::gb).fold(f64::INFINITY, f64::min)).unwrap_or(12.0);
    (plan, if gb.is_finite() { gb } else { 12.0 })
}

/// What doesn't fit, said plainly (empty when it all does).
fn fit_notes(p: &Pack, plan: Option<&prep::Plan>, ram_gb: f64) -> Vec<String> {
    let mut n = Vec::new();
    if p.vram > 0.0 {
        if let Some(cards) = plan.and_then(|pl| pl.services.get(p.card)) {
            let vram: f64 = if p.card == "llama" { cards.iter().map(prep::Gpu::gb).sum() } else { cards.first().map(prep::Gpu::gb).unwrap_or(0.0) };
            if vram + 0.05 < p.vram {
                n.push(format!("wants about {} GB of VRAM; its card has {vram} GB, so part runs from RAM (slower)", p.vram));
            }
        } else if plan.is_none() {
            n.push("needs an NVIDIA GPU".into());
        }
    }
    if p.ram > 0.0 && ram_gb > 0.0 && ram_gb + 0.5 < p.ram {
        n.push(format!("wants {} GB of RAM; this PC has {ram_gb:.0} GB", p.ram));
    }
    n
}

#[derive(Default)]
pub struct Jobs(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

/// Every pack with what's on disk, whether it fits, and whether it's downloading now.
#[tauri::command]
pub async fn packs_list(root: Option<String>, jobs: tauri::State<'_, Jobs>) -> Result<Value, String> {
    let running: Vec<String> = jobs.0.lock().unwrap().keys().cloned().collect();
    let root = stack_root(root);
    tauri::async_runtime::spawn_blocking(move || {
        let (plan, ollama_gb) = plan_and_ollama_gb(&root);
        let ram_gb = crate::sys_memory().ok().and_then(|m| m["total"].as_f64()).map(|m| (m / 1024.0).round()).unwrap_or(0.0);
        let tags = ollama_tags();
        let packs: Vec<Value> = catalog(ollama_gb)
            .iter()
            .map(|p| {
                let states: Vec<Option<bool>> = p.items.iter().map(|i| present(&root, i, tags.as_ref())).collect();
                let have = states.iter().filter(|s| **s == Some(true)).count();
                let unknown = states.iter().filter(|s| s.is_none()).count();
                let bytes: u64 = p.items.iter().filter_map(|i| match i {
                    Item::File { dest, alts, .. } => found(&root, dest, alts).and_then(|f| fs::metadata(f).ok()).map(|m| m.len()),
                    _ => None,
                }).sum();
                let state = if have == p.items.len() { "installed" } else if have > 0 { "partial" } else if unknown == p.items.len() { "unknown" } else { "missing" };
                json!({
                    "id": p.id, "title": p.title, "text": p.text, "gb": p.gb, "state": state,
                    "have": have, "items": p.items.len(), "unknown": unknown, "bytes": bytes,
                    "missing": p.items.iter().zip(&states).filter(|(_, s)| **s == Some(false)).map(|(i, _)| item_label(i)).collect::<Vec<_>>(),
                    "fit": fit_notes(p, plan.as_ref(), ram_gb),
                    "running": running.iter().any(|r| r == p.id),
                })
            })
            .collect();
        let free = crate::models::disk_free(root.to_string_lossy().into_owned()).unwrap_or(0);
        Ok(json!({ "root": root, "packs": packs, "freeBytes": free, "ollamaUp": tags.is_some(), "ramGB": ram_gb }))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- getting a pack ----------

pub(crate) fn emit(app: &AppHandle, id: &str, state: &str, step: usize, steps: usize, label: &str, done: u64, total: u64, error: Option<String>) {
    let _ = app.emit("pack", json!({ "id": id, "state": state, "step": step, "steps": steps, "label": label, "done": done, "total": total, "error": error }));
}

/// Streams `url` into `dest`, carrying on from a .part file left by a pause or a dropped connection.
pub(crate) fn fetch_resume(url: &str, dest: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let mut req = ureq::get(url).set("User-Agent", "Prestige");
    if have > 0 {
        req = req.set("Range", &format!("bytes={have}-"));
    }
    let resp = match req.call() {
        Ok(r) => r,
        // Asked for more than there is: the .part is already the whole file.
        Err(ureq::Error::Status(416, _)) if have > 0 => {
            fs::rename(&part, dest).map_err(|e| e.to_string())?;
            return Ok(());
        }
        Err(e) => return Err(e.to_string()),
    };
    let resumed = have > 0 && resp.status() == 206;
    let len: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let total = if resumed { have + len } else { len };
    let mut file = if resumed { fs::OpenOptions::new().append(true).open(&part) } else { fs::File::create(&part) }.map_err(|e| e.to_string())?;
    let mut done = if resumed { have } else { 0 };
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 1 << 20];
    let mut last = std::time::Instant::now();
    progress(done, total);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("paused".into());
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
        return Err(format!("the download stopped early ({done} of {total} bytes); Get carries on from there"));
    }
    fs::rename(&part, dest).map_err(|e| e.to_string())
}

fn ollama_pull(name: &str, cancel: &AtomicBool, mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
    let resp = ureq::post("http://127.0.0.1:11434/api/pull")
        .set("Content-Type", "application/json")
        .send_string(&json!({ "model": name, "stream": true }).to_string())
        .map_err(|e| format!("Ollama: {e}"))?;
    for line in BufReader::new(resp.into_reader()).lines() {
        if cancel.load(Ordering::Relaxed) {
            return Err("paused".into());
        }
        let line = line.map_err(|e| e.to_string())?;
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(e) = v["error"].as_str() {
            return Err(format!("Ollama: {e}"));
        }
        if let (Some(d), Some(t)) = (v["completed"].as_u64(), v["total"].as_u64()) {
            progress(d, t);
        }
        if v["status"].as_str() == Some("success") {
            return Ok(());
        }
    }
    Err(format!("Ollama stopped before {name} finished"))
}

/// uv: on PATH, or where its installer puts it.
pub(crate) fn uv_exe() -> PathBuf {
    let local = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default().join(".local").join("bin").join("uv.exe");
    if local.exists() { local } else { PathBuf::from("uv") }
}

/// Runs a command in `root`, its output appended to `log`; stops it if `cancel` is set.
pub(crate) fn run_logged(root: &Path, exe: &Path, args: &[String], log: &Path, cancel: &AtomicBool) -> Result<(), String> {
    let out = fs::OpenOptions::new().create(true).append(true).open(log).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let _ = writeln!(&out, "\n> {} {}", exe.display(), args.join(" "));
    let mut child = hidden(&mut Command::new(exe))
        .args(args)
        .current_dir(root)
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .spawn()
        .map_err(|e| format!("couldn't run {}: {e}", exe.display()))?;
    loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            return if s.success() { Ok(()) } else { Err(format!("{} failed (see {})", exe.file_name().unwrap_or_default().to_string_lossy(), log.display())) };
        }
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            return Err("paused".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
}

fn sha256_hex(path: &Path) -> Result<String, String> {
    // Windows' own certutil, so Prestige needs no hashing library for one checksum.
    let out = hidden(&mut Command::new("certutil")).arg("-hashfile").arg(path).arg("SHA256").output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().nth(1).map(|l| l.trim().replace(' ', "").to_lowercase()).ok_or_else(|| "certutil gave no hash".into())
}

pub(crate) fn unzip(zip: &Path, dir: &Path) -> Result<(), String> {
    let f = fs::File::open(zip).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    z.extract(dir).map_err(|e| e.to_string())
}

fn get_item(app: &AppHandle, root: &Path, id: &str, n: usize, steps: usize, item: &Item, cancel: &AtomicBool) -> Result<(), String> {
    let label = item_label(item);
    let progress = |d: u64, t: u64| emit(app, id, "running", n, steps, &label, d, t, None);
    match item {
        Item::File { url, dest, .. } => fetch_resume(url, &root.join(dest), cancel, progress),
        Item::Ollama(m) => {
            if !services::listening(11434) {
                services::start(root, &["ollama".to_string()])?;
                for _ in 0..40 {
                    if services::listening(11434) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            }
            ollama_pull(m, cancel, progress)
        }
        Item::Env { name, steps: cmds, .. } => {
            let log = root.join("logs").join(format!("pack-{id}.log"));
            let _ = fs::create_dir_all(root.join("logs"));
            // A half-made environment from a stopped install is started over.
            let env_dir = root.join("envs").join(name);
            if env_dir.exists() {
                let _ = fs::remove_dir_all(&env_dir);
            }
            let uvx = uv_exe();
            if let Err(e) = run_logged(root, &uvx, &uv(&["python", "install", "3.11", "3.12"]), &log, cancel) {
                return Err(if e.contains("couldn't run") { "uv isn't installed (Setup installs it)".into() } else { e });
            }
            for (i, c) in cmds.iter().enumerate() {
                emit(app, id, "running", n, steps, &format!("{label}: step {} of {}", i + 1, cmds.len()), 0, 0, None);
                run_logged(root, &uvx, c, &log, cancel)?;
            }
            Ok(())
        }
        Item::Zip { url, sha_url, dir, .. } => {
            let tmp = std::env::temp_dir().join(url.rsplit('/').next().unwrap_or("download.zip"));
            fetch_resume(url, &tmp, cancel, progress)?;
            let want = ureq::get(sha_url).call().map_err(|e| e.to_string())?.into_string().map_err(|e| e.to_string())?;
            let want = want.split_whitespace().next().unwrap_or("").to_lowercase();
            if sha256_hex(&tmp)? != want {
                let _ = fs::remove_file(&tmp);
                return Err("the download didn't match its checksum; try again".into());
            }
            unzip(&tmp, &root.join(dir))?;
            let _ = fs::remove_file(&tmp);
            Ok(())
        }
    }
}

/// One value in data\service-settings.json (the Workstation settings), the rest kept.
pub(crate) fn set_service_setting(root: &Path, key: &str, value: Value) {
    let file = root.join("data").join("service-settings.json");
    let mut v: Value = fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()).filter(Value::is_object).unwrap_or(json!({}));
    v[key] = value;
    let _ = fs::create_dir_all(root.join("data"));
    let _ = fs::write(&file, serde_json::to_string_pretty(&v).unwrap_or_default() + "\n");
}

/// After a pack: llama.cpp's router needs to know Nex (as install.ps1 did); Open WebUI starts once it's there.
fn after_pack(root: &Path, id: &str) {
    if id == "openwebui" {
        set_service_setting(root, "openWebUI", json!("on"));
    }
    if id == "nex" {
        let _ = crate::models::add_llama_model(
            Some(root.to_string_lossy().into_owned()),
            "nex-n2.5-mini".into(),
            r"{ROOT}\models\gguf\nex-agi_Nex-N2.5-mini-Q4_K_M.gguf".into(),
            Some(r"{ROOT}\models\gguf\mmproj-nex-agi_Nex-N2.5-mini-f16.gguf".into()),
            Some(25),
            Some("Nex-N2.5-mini (bartowski/nex-agi_Nex-N2.5-mini-GGUF), a 35B-A3B computer-use model; experts in RAM like Qwen3.6 35B.".into()),
            None,
        );
    }
}

/// Gets everything a pack is missing (in the calling thread), with "pack" events. Setup runs packs this way too.
pub fn run_pack(app: &AppHandle, root: &Path, id: &str, cancel: &AtomicBool) -> Result<usize, String> {
    let (_, ollama_gb) = plan_and_ollama_gb(root);
    let pack = catalog(ollama_gb).into_iter().find(|p| p.id == id).ok_or_else(|| format!("no pack called {id}"))?;
    let tags = ollama_tags();
    let todo: Vec<&Item> = pack.items.iter().filter(|i| present(root, i, tags.as_ref()) != Some(true)).collect();
    for (n, item) in todo.iter().enumerate() {
        get_item(app, root, id, n + 1, todo.len(), item, cancel)?;
    }
    after_pack(root, id);
    Ok(todo.len())
}

/// Registers a running job; None when one with that id is already running.
pub fn begin_job(app: &AppHandle, id: &str) -> Option<Arc<AtomicBool>> {
    let jobs = app.state::<Jobs>();
    let mut j = jobs.0.lock().unwrap();
    if j.contains_key(id) {
        return None;
    }
    let cancel = Arc::new(AtomicBool::new(false));
    j.insert(id.to_string(), cancel.clone());
    Some(cancel)
}

pub fn end_job(app: &AppHandle, id: &str, result: &Result<usize, String>) {
    app.state::<Jobs>().0.lock().unwrap().remove(id);
    match result {
        Ok(_) => emit(app, id, "done", 0, 0, "", 0, 0, None),
        Err(e) if e == "paused" => emit(app, id, "paused", 0, 0, "", 0, 0, None),
        Err(e) => emit(app, id, "failed", 0, 0, "", 0, 0, Some(e.clone())),
    }
}

/// Gets what a pack is missing, in the background, with "pack" events. Running it again after a pause carries on.
#[tauri::command]
pub fn pack_get(app: AppHandle, root: Option<String>, id: String) -> Result<(), String> {
    let root = stack_root(root);
    let cancel = begin_job(&app, &id).ok_or("already downloading")?;
    std::thread::spawn(move || {
        let result = run_pack(&app, &root, &id, &cancel);
        end_job(&app, &id, &result);
    });
    Ok(())
}

/// Pauses a download (what's done so far is kept; Get carries on).
#[tauri::command]
pub fn pack_pause(jobs: tauri::State<'_, Jobs>, id: String) {
    if let Some(c) = jobs.0.lock().unwrap().get(&id) {
        c.store(true, Ordering::Relaxed);
    }
}

// ---------- removing a pack ----------

/// What Remove would delete: the pack's files, models and environments that no other pack on this PC still uses.
fn removal(root: &Path, id: &str, ollama_gb: f64, tags: Option<&HashSet<String>>) -> (Vec<PathBuf>, Vec<String>, Vec<String>) {
    let all = catalog(ollama_gb);
    let Some(pack) = all.iter().find(|p| p.id == id) else { return (vec![], vec![], vec![]) };
    let same = |a: &Item, b: &Item| match (a, b) {
        (Item::File { dest: a, .. }, Item::File { dest: b, .. }) => a == b,
        (Item::Ollama(a), Item::Ollama(b)) => a == b,
        (Item::Env { name: a, .. }, Item::Env { name: b, .. }) => a == b,
        _ => false,
    };
    // Other packs that are here keep what they share with this one. A pack only counts as here when it has something of
    // its own on disk, not just the files it shares with this one (else removing Select would keep birefnet for 3D).
    let others: Vec<&Pack> = all
        .iter()
        .filter(|p| p.id != id && p.items.iter().any(|i| !pack.items.iter().any(|m| same(i, m)) && present(root, i, tags) == Some(true)))
        .collect();
    let shared = |item: &Item| others.iter().any(|p| p.items.iter().any(|o| same(o, item)));
    let (mut files, mut models, mut envs) = (Vec::new(), Vec::new(), Vec::new());
    for item in pack.items.iter().filter(|i| !shared(i)) {
        match item {
            Item::File { dest, alts, .. } => files.extend(candidates(root, dest, alts).into_iter().filter(|p| p.is_file())),
            Item::Ollama(m) if tags.is_some_and(|t| has_model(t, m)) => models.push(m.clone()),
            Item::Env { name, .. } if root.join("envs").join(name).exists() => envs.push(name.clone()),
            Item::Zip { dir, .. } if root.join(dir).exists() => files.push(root.join(dir)),
            _ => {}
        }
    }
    (files, models, envs)
}

/// What Remove would delete, for the confirm dialog.
#[tauri::command]
pub async fn pack_removal(root: Option<String>, id: String) -> Result<Value, String> {
    let root = stack_root(root);
    tauri::async_runtime::spawn_blocking(move || {
        let (_, ollama_gb) = plan_and_ollama_gb(&root);
        let tags = ollama_tags();
        let (files, models, envs) = removal(&root, &id, ollama_gb, tags.as_ref());
        let bytes: u64 = files.iter().filter_map(|f| fs::metadata(f).ok()).filter(|m| m.is_file()).map(|m| m.len()).sum();
        json!({ "files": files, "models": models, "envs": envs, "bytes": bytes })
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pack_remove(root: Option<String>, id: String) -> Result<(), String> {
    let root = stack_root(root);
    tauri::async_runtime::spawn_blocking(move || {
        let (_, ollama_gb) = plan_and_ollama_gb(&root);
        let tags = ollama_tags();
        let (files, models, envs) = removal(&root, &id, ollama_gb, tags.as_ref());
        let mut errors = Vec::new();
        // An environment in use can't be deleted: stop the service that runs from it first.
        for e in &envs {
            let svc = match e.as_str() { "voice" => "voice", "transcribe" => "phonon", "open-webui" => "open-webui", _ => "" };
            if !svc.is_empty() {
                let _ = services::stop_named(&root, svc);
            }
            if let Err(err) = fs::remove_dir_all(root.join("envs").join(e)) {
                errors.push(format!("envs\\{e}: {err}"));
            }
        }
        for f in &files {
            let r = if f.is_dir() { fs::remove_dir_all(f) } else { fs::remove_file(f) };
            if let Err(e) = r {
                errors.push(format!("{}: {e}", f.display()));
            }
        }
        for m in &models {
            if let Err(e) = ureq::delete("http://127.0.0.1:11434/api/delete").set("Content-Type", "application/json").send_string(&json!({ "model": m }).to_string()) {
                errors.push(format!("{m}: {e}"));
            }
        }
        if id == "openwebui" {
            set_service_setting(&root, "openWebUI", json!("off"));
        }
        if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- engines ----------

fn llama_dir(root: &Path) -> PathBuf {
    root.join("bin").join("llama.cpp")
}

/// llama.cpp's build number ("b6543") from `llama-server --version`.
fn llama_version(dir: &Path) -> Option<String> {
    let exe = dir.join("llama-server.exe");
    if !exe.exists() {
        return None;
    }
    let out = hidden(&mut Command::new(exe)).arg("--version").stdin(Stdio::null()).output().ok()?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    parse_llama_version(&text)
}

fn parse_llama_version(text: &str) -> Option<String> {
    // "version: 6543 (1a2b3c4)", or on newer builds "version: 0.5.0-dev (build 11270, commit 748d4225b)".
    let l = text.lines().find(|l| l.trim_start().starts_with("version:"))?;
    let v = l.split_once(':')?.1.trim();
    let from = v.split_once("build ").map_or(v, |(_, rest)| rest);
    let n: String = from.chars().take_while(char::is_ascii_digit).collect();
    (!n.is_empty()).then(|| format!("b{n}"))
}

/// The driver's CUDA version picks llama.cpp's build: 13.x drivers get the CUDA 13 build, older ones CUDA 12.
pub(crate) fn cuda_tag() -> &'static str {
    let out = hidden(&mut Command::new("nvidia-smi")).stdin(Stdio::null()).output().ok();
    let text = out.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    let major = text.split("CUDA Version:").nth(1).or_else(|| text.split("CUDA UMD Version:").nth(1)).and_then(|s| s.trim().split('.').next()?.parse::<u32>().ok()).unwrap_or(12);
    if major >= 13 { "13.4" } else { "12.4" }
}

/// The newest llama.cpp release with a Windows build for this driver: (tag, [asset urls]).
pub(crate) fn llama_latest() -> Result<(String, Vec<String>), String> {
    let tag = cuda_tag();
    let text = ureq::get("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30")
        .set("User-Agent", "Prestige")
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())?;
    let rels: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    for r in rels.as_array().into_iter().flatten() {
        let assets: Vec<(String, String)> = r["assets"].as_array().into_iter().flatten()
            .filter_map(|a| Some((a["name"].as_str()?.to_string(), a["browser_download_url"].as_str()?.to_string())))
            .collect();
        let want = |n: &str| (n.starts_with("llama-b") || n.starts_with("cudart-llama")) && n.ends_with(&format!("-bin-win-cuda-{tag}-x64.zip"));
        let main = assets.iter().any(|(n, _)| n.starts_with("llama-b") && want(n));
        if main {
            return Ok((r["tag_name"].as_str().unwrap_or("").to_string(), assets.into_iter().filter(|(n, _)| want(n)).map(|(_, u)| u).collect()));
        }
    }
    Err(format!("no llama.cpp release has a Windows CUDA {tag} build"))
}

fn comfy_info(root: &Path) -> Value {
    match prep::find_comfy(root) {
        None => json!({ "installed": false }),
        Some((dir, _)) => {
            let own = dir.starts_with(root);
            let version = fs::read_to_string(dir.join("comfyui_version.py"))
                .ok()
                .and_then(|t| t.split('"').nth(1).map(String::from));
            let commit = own
                .then(|| hidden(&mut Command::new("git")).arg("-C").arg(&dir).args(["rev-parse", "--short", "HEAD"]).output().ok())
                .flatten()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
            json!({ "installed": true, "own": own, "folder": dir, "version": version, "commit": commit,
                    "canRollBack": root.join("data").join("comfyui-previous.txt").exists() })
        }
    }
}

pub(crate) fn ollama_exe() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default().join("Programs").join("Ollama").join("ollama.exe")
}

/// The engines, their versions and, with `check`, whether a newer llama.cpp is out.
#[tauri::command]
pub async fn engines(root: Option<String>, check: Option<bool>) -> Result<Value, String> {
    let root = stack_root(root);
    tauri::async_runtime::spawn_blocking(move || {
        let latest = check.unwrap_or(false).then(llama_latest);
        let ollama = hidden(&mut Command::new(ollama_exe())).arg("--version").stdin(Stdio::null()).output().ok().map(|o| {
            let t = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
            t.split_whitespace().last().unwrap_or("").to_string()
        });
        json!({
            "llama": {
                "version": llama_version(&llama_dir(&root)),
                "previous": llama_version(&root.join("bin").join("llama.cpp.old")),
                "latest": latest.as_ref().and_then(|l| l.as_ref().ok()).map(|l| l.0.clone()),
                "error": latest.and_then(|l| l.err()),
                "cuda": cuda_tag(),
            },
            "comfyui": comfy_info(&root),
            "ollama": { "version": ollama, "installed": ollama_exe().exists() },
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/// Puts the newest llama.cpp build in bin\llama.cpp, keeping the one before in bin\llama.cpp.old for Roll back.
fn update_llama(app: &AppHandle, root: &Path, cancel: &AtomicBool) -> Result<String, String> {
    let (tag, urls) = llama_latest()?;
    let new = root.join("bin").join("llama.cpp.new");
    let _ = fs::remove_dir_all(&new);
    for (i, url) in urls.iter().enumerate() {
        let name = url.rsplit('/').next().unwrap_or("llama.zip");
        let zip = std::env::temp_dir().join(name);
        fetch_resume(url, &zip, cancel, |d, t| emit(app, "engine-llama", "running", i + 1, urls.len(), name, d, t, None))?;
        unzip(&zip, &new)?;
        let _ = fs::remove_file(&zip);
    }
    if !new.join("llama-server.exe").exists() {
        return Err("the new llama.cpp didn't unpack as expected".into());
    }
    swap_llama(root, &new)?;
    Ok(tag)
}

/// bin\llama.cpp becomes bin\llama.cpp.old and `incoming` becomes bin\llama.cpp, with llama.cpp stopped meanwhile.
fn swap_llama(root: &Path, incoming: &Path) -> Result<(), String> {
    let cur = llama_dir(root);
    let old = root.join("bin").join("llama.cpp.old");
    let was_up = services::listening(8081);
    let _ = services::stop_named(root, "llama-server");
    let spare = root.join("bin").join("llama.cpp.swap");
    let _ = fs::remove_dir_all(&spare);
    if cur.exists() {
        fs::rename(&cur, &spare).map_err(|e| format!("couldn't move the current llama.cpp aside: {e}"))?;
    }
    if let Err(e) = fs::rename(incoming, &cur) {
        let _ = fs::rename(&spare, &cur);
        return Err(format!("couldn't put the new llama.cpp in place: {e}"));
    }
    let _ = fs::remove_dir_all(&old);
    let _ = fs::rename(&spare, &old);
    if was_up {
        services::start(root, &["llama-server".to_string()])?;
    }
    Ok(())
}

fn update_comfy(root: &Path, cancel: &AtomicBool) -> Result<String, String> {
    let (dir, python) = prep::find_comfy(root).ok_or("ComfyUI isn't installed")?;
    if !dir.starts_with(root) {
        return Err("This is Comfy Desktop's ComfyUI: update it in the Comfy Desktop app".into());
    }
    let log = root.join("logs").join("engine-comfyui.log");
    let head = hidden(&mut Command::new("git")).arg("-C").arg(&dir).args(["rev-parse", "HEAD"]).output().map_err(|e| e.to_string())?;
    fs::write(root.join("data").join("comfyui-previous.txt"), String::from_utf8_lossy(&head.stdout).trim()).map_err(|e| e.to_string())?;
    let was_up = services::listening(8188);
    let _ = services::stop_named(root, "comfyui");
    run_logged(&dir, Path::new("git"), &uv(&["pull", "--ff-only"]), &log, cancel)?;
    let venv = python.parent().and_then(Path::parent).ok_or("bad ComfyUI python path")?;
    run_logged(&dir, &uv_exe(), &["pip".into(), "install".into(), "-p".into(), venv.to_string_lossy().into_owned(), "-r".into(), "requirements.txt".into(), "-q".into()], &log, cancel)?;
    if was_up {
        services::start(root, &["comfyui".to_string()])?;
    }
    Ok(comfy_info(root)["commit"].as_str().unwrap_or("").to_string())
}

fn roll_back_comfy(root: &Path, cancel: &AtomicBool) -> Result<String, String> {
    let (dir, _) = prep::find_comfy(root).ok_or("ComfyUI isn't installed")?;
    let prev_file = root.join("data").join("comfyui-previous.txt");
    let prev = fs::read_to_string(&prev_file).map_err(|_| "there's no earlier ComfyUI to go back to".to_string())?;
    let log = root.join("logs").join("engine-comfyui.log");
    let was_up = services::listening(8188);
    let _ = services::stop_named(root, "comfyui");
    run_logged(&dir, Path::new("git"), &uv(&["reset", "--hard", prev.trim()]), &log, cancel)?;
    let _ = fs::remove_file(prev_file);
    if was_up {
        services::start(root, &["comfyui".to_string()])?;
    }
    Ok(prev.trim().chars().take(7).collect())
}

fn update_ollama(root: &Path, cancel: &AtomicBool) -> Result<String, String> {
    let log = root.join("logs").join("engine-ollama.log");
    let _ = services::stop_named(root, "ollama");
    let r = run_logged(root, Path::new("winget"), &uv(&["upgrade", "--id", "Ollama.Ollama", "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"]), &log, cancel);
    // Ollama's installer opens its tray app, which serves on Ollama's port from its own model folder: close it, so the
    // Workstation's Ollama (with the Workstation's models) takes the port again.
    std::thread::sleep(std::time::Duration::from_secs(3));
    let _ = hidden(&mut Command::new("taskkill")).args(["/IM", "ollama app.exe", "/F"]).output();
    let _ = hidden(&mut Command::new("taskkill")).args(["/IM", "ollama.exe", "/F"]).output();
    std::thread::sleep(std::time::Duration::from_secs(1));
    services::start(root, &["ollama".to_string()])?;
    // winget answers with an error when there's nothing newer; that's not a failure here.
    if let Err(e) = r {
        let text = fs::read_to_string(&log).unwrap_or_default();
        if !text.contains("No available upgrade") && !text.contains("No newer package") {
            return Err(e);
        }
    }
    Ok("done".into())
}

/// Updates (or rolls back) an engine in the background; "pack" events with id "engine-<name>".
#[tauri::command]
pub fn engine_action(app: AppHandle, jobs: tauri::State<'_, Jobs>, root: Option<String>, engine: String, action: String) -> Result<(), String> {
    let root = stack_root(root);
    let id = format!("engine-{engine}");
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut j = jobs.0.lock().unwrap();
        if j.contains_key(&id) {
            return Err("already running".into());
        }
        j.insert(id.clone(), cancel.clone());
    }
    std::thread::spawn(move || {
        emit(&app, &id, "running", 0, 0, "", 0, 0, None);
        let r = match (engine.as_str(), action.as_str()) {
            ("llama", "update") => update_llama(&app, &root, &cancel),
            ("llama", "rollback") => {
                let old = root.join("bin").join("llama.cpp.old");
                if old.join("llama-server.exe").exists() {
                    // The two swap places, so a roll back can be undone the same way.
                    let tmp = root.join("bin").join("llama.cpp.back");
                    let _ = fs::remove_dir_all(&tmp);
                    fs::rename(&old, &tmp).map_err(|e| e.to_string()).and_then(|_| swap_llama(&root, &tmp)).map(|_| "rolled back".into())
                } else {
                    Err("there's no earlier llama.cpp to go back to".into())
                }
            }
            ("comfyui", "update") => update_comfy(&root, &cancel),
            ("comfyui", "rollback") => roll_back_comfy(&root, &cancel),
            ("ollama", "update") => update_ollama(&root, &cancel),
            _ => Err(format!("unknown engine action {engine} {action}")),
        };
        app.state::<Jobs>().0.lock().unwrap().remove(&id);
        match r {
            Ok(v) => emit(&app, &id, "done", 0, 0, &v, 0, 0, None),
            Err(e) => emit(&app, &id, "failed", 0, 0, "", 0, 0, Some(e)),
        }
    });
    Ok(())
}

use tauri::Manager;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_are_well_formed() {
        for gb in [6.0, 8.0, 12.0] {
            let c = catalog(gb);
            let mut ids = HashSet::new();
            for p in &c {
                assert!(ids.insert(p.id), "duplicate pack {}", p.id);
                assert!(!p.items.is_empty());
                for i in &p.items {
                    if let Item::File { url, dest, .. } = i {
                        assert!(url.starts_with("https://huggingface.co/") && url.contains("/resolve/main/"), "{url}");
                        assert!(dest.starts_with(r"models\") && !dest.contains('/'), "{dest}");
                    }
                }
            }
        }
        let small = catalog(6.0);
        assert!(matches!(&small[0].items[0], Item::Ollama(m) if m == "qwen3.5:4b"));
        assert!(matches!(&catalog(12.0)[1].items[0], Item::Ollama(m) if m == "gemma4:12b"));
    }

    #[test]
    fn comfy_models_are_looked_for_everywhere() {
        let c = candidates(Path::new(r"C:\W"), r"models\comfy\text_encoders\t.safetensors", &[]);
        let s: Vec<String> = c.iter().map(|p| p.to_string_lossy().replace('/', "\\")).collect();
        assert!(s.iter().any(|p| p.ends_with(r"models\comfy\text_encoders\t.safetensors")));
        assert!(s.iter().any(|p| p.ends_with(r"models\comfy-fast\clip\t.safetensors")));
        assert!(s.iter().any(|p| p.contains("ComfyUI-Shared") && p.ends_with(r"clip\t.safetensors")));
        let g = candidates(Path::new(r"C:\W"), r"models\gguf\a.gguf", &["b.gguf".into()]);
        assert_eq!(g.len(), 2);
    }

    #[test]
    fn ollama_names() {
        let t: HashSet<String> = ["gemma4:12b", "qwen3.5:4b", "mistral:latest"].map(String::from).into();
        assert!(has_model(&t, "Gemma4:12B") && has_model(&t, "mistral") && !has_model(&t, "qwen3.5:2b"));
    }

    #[test]
    fn llama_versions() {
        assert_eq!(parse_llama_version("ggml_cuda_init: found 2 CUDA devices\nversion: 6543 (1a2b3c4)\nbuilt with MSVC"), Some("b6543".into()));
        assert_eq!(parse_llama_version("version: 0.5.0-dev (build 11270, commit 748d4225b)"), Some("b11270".into()));
        assert_eq!(parse_llama_version("nothing"), None);
    }
}
