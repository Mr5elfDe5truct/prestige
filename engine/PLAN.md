# Custom AI Workstation — Plan

Goal: a 100% free, local, open-source, agentic AI on this PC, all in one folder
(`C:\Projects\Workspaces\Claude\Custom AI`), with a UI, chat, webcam vision, tool use,
computer control, image and video generation, uncensored models, and a way to keep
discovering new models and projects.

Status: **approved and installed 2026-09-30.** See README.md for how to use it.
Written 2026-09-29.

Changes from this plan during install:
- Web search uses Open WebUI's built-in DuckDuckGo instead of SearXNG (SearXNG doesn't run natively on Windows; no Docker here).
- D: turned out to be a spinning HDD, so the chat models (Qwen3.6, UI-TARS, Ollama) live on C: (NVMe) in `models\`; only the video models are on D:.
- llama.cpp runs in router mode (`bin\llama-models.ini`): Qwen3.6 and UI-TARS load on demand and unload after 3 min idle.
- LTX-2.3 (the current LTX release) instead of LTX-2. Wan 2.2 I2V uses the LightX2V 4-step distilled GGUF.
- Filesystem, shell (Desktop Commander, telemetry off) and Playwright browser tool servers enabled 2026-09-30 after Ryan's approval.
- MiniMax H3 (already in Comfy Desktop) was not tested on the 3060.

---

## 1. What this PC already has (checked 2026-09-29)

| Item | Found |
|---|---|
| GPU | RTX 3060 12 GB, driver 616.92 (CUDA 13.4 capable). ~0.8 GB used at idle by Chrome/desktop |
| CPU / RAM | Ryzen 7 2700X, 32 GB RAM |
| Disk | C: 187 GB free (80% used), D: 1.2 TB free, E: 113 GB free |
| CUDA toolkit (nvcc) | Not installed. Not needed: Ollama, llama.cpp and ComfyUI ship their own CUDA runtimes |
| WSL / Docker | Not installed (WSL not registered). Plan avoids both |
| Python | 3.12.10 (system), 3.10 via uv. **uv 0.12.11** installed (used for all Python envs) |
| Other tools | git 2.55, Node 24.19 / npm 11.17, ffmpeg 9.0.1, winget |
| **Ollama** | 0.34.1 installed (0.35.0 available). Models: `gemma4:e4b` (9.6 GB), `hf.co/LEONW24/Qwen3.5-9B-Uncensored:Q4_K_M` (6.7 GB), `mistral` (4.4 GB) |
| **ComfyUI** | Comfy Desktop, install "My Anime Workflow" (ComfyUI v0.37.0, torch 2.12.1+cu130, Manager enabled). Shared models at `%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared\models` (85 GB): **Z-Image-Turbo** (image) and **MiniMax H3** int8 video + audio VAE |
| Webcam | "1080P Pro Stream" (OK). Insta360 One RS also listed but not connected |
| Other apps | "Open Generative AI", Antigravity IDE, VS Code |

Takeaway: the image/video side is already mostly in place through Comfy Desktop. The missing pieces are
a unified agent UI, tool/computer-use wiring, webcam vision, voice, and a better model lineup.

---

## 2. Architecture

```
            ┌──────────────── Open WebUI (browser UI, localhost:8080) ────────────────┐
            │ chat · voice/video call (webcam) · tools · MCP · image gen · knowledge │
            └───────┬─────────────────┬───────────────────┬───────────────────┬───────┘
                    │                 │                   │                   │
             Ollama :11434     ComfyUI :8188       MCP tool servers     Whisper + Kokoro
          (LLMs + vision LLMs)  (images/video)   (files, shell, web,    (speech in/out,
                    │                              browser, desktop,     local)
                    │                              reddit/HF/GitHub)
             UI-TARS Desktop  ← separate app for full "use my computer" GUI control
```

One model is loaded on the GPU at a time. 12 GB cannot hold a chat LLM and a video model together,
so Ollama unloads (keep_alive) before ComfyUI jobs. This is the main constraint of the whole design.

---

## 3. Component picks (per capability)

### 3.1 UI + chat + tools — **Open WebUI**
- Largest local chat UI; supports Ollama, native function calling, Python tools, **native MCP (Streamable HTTP) since v0.6.31**, web search, RAG, image generation through ComfyUI, and **hands-free voice/video call** (sends webcam frames to a vision model).
  Sources: [Open WebUI MCP docs](https://docs.openwebui.com/features/extensibility/mcp/), [Tools docs](https://docs.openwebui.com/features/extensibility/plugin/tools/), [Features](https://docs.openwebui.com/features/), [MCP native setup guide](https://rainbowbreeze.it/openwebui-mcp-http/).
- Install: `uv` venv inside this folder, `pip install open-webui`, data dir set to `.\data\open-webui`. No Docker.
- Alternatives considered: AnythingLLM (stronger zero-config RAG/agent flows, smaller community), LM Studio (great model runner, not an agent portal). [Comparison](https://localaimaster.com/blog/anythingllm-vs-open-webui), [Open WebUI vs AnythingLLM](https://docs.openwebui.com/alternatives/anythingllm/).

### 3.2 LLM backend — **Ollama** (already installed; update to 0.35)
- Keep Ollama as the main runner. Add **llama.cpp** (portable CUDA build in `.\bin\llama.cpp`) only for the MoE model below, because its `--n-cpu-moe` option lets a 35B MoE run with experts in system RAM.
- Set `OLLAMA_MODELS` to a folder here (`.\models\ollama`) so models live in the project. **This is a user environment variable change and needs approval.** Existing 21 GB of models would be moved, not re-downloaded.

### 3.3 Models (all free / open weights, sized for 12 GB)

| Role | Model | Size (Q4) | Why | Source |
|---|---|---|---|---|
| Daily driver, uncensored, tools + vision | **Qwen3.6-35B-A3B Abliterated/Heretic GGUF** (MoE, 3B active) via llama.cpp with experts offloaded to RAM | ~20 GB file, ~8–10 GB VRAM | Newest strong Qwen that runs on 12 GB + 32 GB RAM; keeps vision; refusals removed (1/25 on the author's test) | [Youssofal GGUF](https://huggingface.co/Youssofal/Qwen3.6-35B-A3B-Abliterated-Heretic-GGUF), [mradermacher heretic GGUF](https://huggingface.co/mradermacher/Qwen3.6-35B-A3B-uncensored-heretic-GGUF), [official Qwen3.6](https://huggingface.co/Qwen/Qwen3.6-35B-A3B), [Qwen repo](https://github.com/QwenLM/Qwen3.8) |
| Fast all-GPU fallback, uncensored | **Qwen3.5-9B Uncensored** (already installed) | 6.7 GB | Fully fits in VRAM, fast, vision + tool calling | [unsloth Qwen3.5-9B GGUF](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF) |
| Vision / webcam + audio | **Gemma 4 12B-it** (plus existing `gemma4:e4b` for quick tasks) | ~7.3 GB | Native image, video and audio input, tool calling; good 12 GB fit | [google/gemma-4-12B-it](https://huggingface.co/google/gemma-4-12B-it), [unsloth GGUF](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF), [Gemma 4 overview](https://ai.google.dev/gemma/docs/core) |
| Computer-use (GUI) | **UI-TARS-1.5-7B** (GGUF/Q4) | ~5 GB | Purpose-built screenshot → click/type model | [UI-TARS](https://github.com/bytedance/ui-tars), [UI-TARS-desktop](https://github.com/bytedance/ui-tars-desktop) |
| Remove | `mistral:latest` | −4.4 GB | Superseded | — |

Notes:
- Qwen3.8 (Aug 2026) only ships a 27B dense and a 2.4T MoE so far; the 27B at Q4 (~16 GB) would spill to RAM and be slow on a 3060. Revisit if a small Qwen3.8 appears.
- Newer "Qwen3.6 14B abliterated" listings seen on blog sites don't match any official Qwen release; I'm not using them.
- Speeds are estimates (MoE offload ~10–20 tok/s expected on this CPU/RAM); I'll benchmark after install.
- Community overviews used: [12 GB LLM ranking](https://localaimaster.com/vram/best-llm-12gb-vram), [uncensored model roundup](https://featherless.ai/blog/best-uncensored-ai-models-2026), [abliteration explainer](https://localaimaster.com/blog/best-uncensored-local-llms), [uncensored champions collection](https://huggingface.co/collections/darkc0de/uncensored-champions).

### 3.4 Webcam vision
- Open WebUI **video call** mode with Gemma 4 12B (or Qwen3.6) as the vision model. Nothing extra to install.
- Optional later: a small Python MCP tool `webcam_snapshot` (OpenCV) so the agent can grab a frame on demand during normal chat.

### 3.5 Voice
- Speech-to-text: **faster-whisper** (built into Open WebUI, runs locally).
- Text-to-speech: **Kokoro-FastAPI** (82M model, very light) in a uv env here, wired into Open WebUI's OpenAI-compatible TTS setting.

### 3.6 Tool use (MCP servers, run locally, exposed to Open WebUI via **mcpo** or native HTTP)
- **Filesystem** (scoped to this folder + chosen folders), **shell/terminal** (with confirmation), **fetch/web**, **browser automation (Playwright MCP)**.
- **Web search: SearXNG** (self-hosted, free, no API keys). Runs as a Python app here; no Docker.
- **Reddit / Hugging Face / GitHub research**: Reddit JSON endpoints via fetch, `huggingface_hub` search tool, GitHub via `gh`/REST (free, rate-limited without token). Packaged as one custom "scout" tool.

### 3.7 Computer use (control mouse/keyboard)
- **UI-TARS Desktop** (ByteDance, Apache-2.0) pointed at the local UI-TARS-1.5-7B through Ollama/llama.cpp's OpenAI-compatible endpoint. Sources: [GitHub](https://github.com/bytedance/ui-tars-desktop), [local setup guide](https://localaimaster.com/blog/ui-tars-desktop-automation).
- Alternative inside Open WebUI: a Qwen3-VL-style computer-use agent on Ollama ([Codeeaner/Computer-Use-Agent](https://github.com/Codeeaner/Computer-Use-Agent)).
- Safety: runs only when started by you; stop hotkey; no credentials typed by the agent.

### 3.8 Image generation — **ComfyUI (existing Comfy Desktop)**
- Already have **Z-Image-Turbo** (fast, good quality, fits 12 GB). Add **ComfyUI-GGUF** custom node for quantized models.
- Wire Open WebUI → ComfyUI API (`127.0.0.1:8188`) so chat can generate images.
- Optional: an uncensored SDXL/Illustrious checkpoint for anime (your existing "Anime Workflow").

### 3.9 Video generation — **ComfyUI**
- Already have **MiniMax H3** int8 (text/first-frame to video with audio). It is very large (32B text encoder in NVFP4); I'll test whether it actually runs on a 3060 before relying on it.
- Add **Wan 2.2 14B GGUF (Q4)** — ~6 GB at 480p, the community standard for 12 GB cards, with LoRA support.
- Add **LTX-2** (distilled/GGUF) as the fast option; NVIDIA and Lightricks publish low-VRAM ComfyUI guides.
  Sources: [VRAM guide](https://willitrunai.com/blog/video-generation-gpu-guide-2026), [Wan 2.2 vs LTX-2 vs Hunyuan](https://localaimaster.com/blog/local-ai-video-generation), [LTX low-VRAM guide](https://ltx.io/blog/run-video-generation-model-locally), [NVIDIA LTX-2 ComfyUI guide](https://www.nvidia.com/en-sg/geforce/news/rtx-ai-video-generation-guide/).

### 3.10 Keeping up with new models/projects
- A **"scout" script** (`.\scripts\scout.py`) that pulls: r/LocalLLaMA + r/StableDiffusion + r/comfyui top posts, Hugging Face trending models filtered to ≤12 GB quants, GitHub trending AI repos. Writes `.\reports\scout-YYYY-MM-DD.md`.
- Run on demand from Open WebUI (as a tool) and optionally weekly via Windows Task Scheduler (**needs approval** — system scheduled task).

---

## 4. Folder layout

```
Custom AI\
  PLAN.md
  README.md              how to start/stop everything
  start-all.ps1          launches Ollama, llama.cpp, Open WebUI, SearXNG, Kokoro, MCP servers
  stop-all.ps1
  bin\                   llama.cpp CUDA build, mcpo
  envs\                  uv virtual envs (open-webui, kokoro, searxng, tools)
  models\ollama\         Ollama models (if OLLAMA_MODELS is approved)
  models\gguf\           llama.cpp GGUFs (Qwen3.6 MoE, UI-TARS)
  data\open-webui\       chats, settings
  tools\                 custom MCP/Open WebUI tools (webcam, scout)
  apps\ui-tars-desktop\
  scripts\  reports\  logs\
```
ComfyUI stays in Comfy Desktop's own location; I'll link it from here and add new video/image models to its shared models folder (or point `extra_model_paths` at `.\models\comfy`).

---

## 5. Download / disk budget (approx.)

| Item | Size |
|---|---|
| Open WebUI + envs + Kokoro + SearXNG + tools | ~8 GB |
| llama.cpp CUDA build | ~0.5 GB |
| Qwen3.6-35B-A3B abliterated Q4_K_M | ~21 GB |
| Gemma 4 12B Q4 | ~7.5 GB |
| UI-TARS-1.5-7B Q4 | ~5 GB |
| Wan 2.2 14B GGUF Q4 (high+low noise) + encoders/VAE | ~25 GB |
| LTX-2 distilled | ~15 GB |
| **Total new** | **~80 GB** |

C: has 187 GB free, so it fits, but leaves C: around 100 GB. Option: keep this folder on C: and put big model files on D: via a junction.

---

## 6. Things that need your approval

1. **Downloads** of ~80 GB listed above.
2. **Set `OLLAMA_MODELS`** user env var to `.\models\ollama` and move existing Ollama models there.
3. **Update Ollama** 0.34.1 → 0.35.0.
4. **Delete `mistral:latest`** (4.4 GB).
5. **Big models on D:** (junction) or keep all on C:.
6. Optional: weekly Task Scheduler job for the scout report.
7. Computer-use agent gets mouse/keyboard control only when you launch it.

## 7. Install order after approval
1. Folder skeleton, uv envs, Open WebUI; connect to Ollama. Test chat.
2. llama.cpp + Qwen3.6 MoE; benchmark tok/s; register as OpenAI-compatible endpoint in Open WebUI.
3. Gemma 4 12B; test webcam video call.
4. Whisper + Kokoro voice.
5. SearXNG, mcpo + MCP servers (files, shell, fetch, Playwright), scout tool.
6. ComfyUI: GGUF node, Wan 2.2, LTX-2; wire image gen into Open WebUI; test MiniMax H3 fit.
7. UI-TARS Desktop + UI-TARS-1.5-7B.
8. `start-all.ps1` / `stop-all.ps1`, README.
