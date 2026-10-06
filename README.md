<p align="center">
  <img src="docs/banner.png" alt="Prestige by R.G. Studios: Creating the world around you" width="100%">
</p>

<p align="center">
  <a href="https://github.com/Mr5elfDe5truct/prestige/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/Mr5elfDe5truct/prestige?style=for-the-badge&color=d6202b&label=release"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-d9a441?style=for-the-badge"></a>
  <img alt="Windows 11" src="https://img.shields.io/badge/Windows%2011-native-0078D4?style=for-the-badge&logo=windows11&logoColor=white">
  <img alt="100% local" src="https://img.shields.io/badge/100%25%20local-offline-1a1111?style=for-the-badge&labelColor=d6202b">
  <br>
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-native-CE422B?style=flat-square&logo=rust&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-UI-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Ollama" src="https://img.shields.io/badge/Ollama-models-0f0a0a?style=flat-square&logo=ollama">
  <img alt="llama.cpp" src="https://img.shields.io/badge/llama.cpp-router-0f0a0a?style=flat-square">
  <img alt="ComfyUI" src="https://img.shields.io/badge/ComfyUI-images%20%2B%20video-0f0a0a?style=flat-square">
  <img alt="Kokoro" src="https://img.shields.io/badge/Kokoro-voice-0f0a0a?style=flat-square">
  <img alt="Whisper" src="https://img.shields.io/badge/Whisper-speech%20to%20text-0f0a0a?style=flat-square">
  <img alt="NVIDIA RTX 3060 12 GB" src="https://img.shields.io/badge/GPU-RTX%203060%2012%20GB-76B900?style=flat-square&logo=nvidia&logoColor=white">
</p>

<p align="center">
  <b>Your own AI, in a top hat.</b><br>
  A desktop app that chats, talks back, sees through your webcam and makes images and videos,<br>
  and runs entirely on your PC. No accounts, no cloud, no subscriptions.
</p>

---

## ✨ Made in Prestige

Everything below was made on the reference PC (RTX 3060 12 GB) from inside the app.

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/dragon.jpg" alt="Z-Image-Turbo render: a red and gold dragon coiled around a graphics card" width="100%"><br>
      <b>Studio → Image</b> · Z-Image-Turbo<br>
      <sub>"a red and gold dragon coiled around a glowing graphics card…" · 1024², about 45 s</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/animate-dragon.gif" alt="Wan 2.2 animation of the dragon render" width="100%"><br>
      <b>Studio → Animate</b> · Wan 2.2 image-to-video<br>
      <sub>the same image, brought to life · 5 s, about 11 min</sub>
    </td>
  </tr>
</table>

## 🎩 What it does

| | Feature | How |
|---|---|---|
| 💬 | **Chat with every local model** | Streaming from Ollama and the llama.cpp router, a model switcher with roles (Main · Deep thinker · Fast · Vision · General · Code), tokens per second on every reply, history saved on your PC |
| 📚 | **Chat with your files** | Drop PDFs, Word documents, notes or a whole folder into the chat (or the paperclip, or the **Knowledge** book at the top) and ask about them: answers cite the file and page they came from (*[report.pdf, p. 14]*), and each citation opens the file. Files are read on your PC, cut into passages and embedded by Qwen3-Embedding 0.6B in Ollama (one click to get it, 0.6 GB); the vectors stay in Prestige's app data folder. Files dropped into a chat belong to it; **Use my files in every chat** also brings in close matches from everything in Knowledge, and tool-capable models can search further with the **Your files** tool. Reads PDF (text, not scans), .docx, text, Markdown, HTML, CSV, JSON and code |
| 🔬 | **Deep Research** | Type `/research` and a question (or click the magnifier in the message box) and the current model researches it on the web: it plans 3–5 searches, reads the best pages (no more than two per site) and takes notes on each, looks for gaps and searches once more, then writes a report that cites every fact as [1], [2]… with the sources linked at the end. Every search and page shows as a step you can open to see its notes. A few minutes per report; uses the workstation's DuckDuckGo search and page fetching, so nothing but the searches leaves your PC |
| 🎭 | **Characters** | Make personas to talk to (the picker beside the model menu): a name, a personality, a voice (any Kokoro voice, or a VoxCPM2 voice cloned from a 5–30 s recording right in the editor), a face, and their own memory. Pick one and chat, the Voice screen and Live calls talk as them (a Live call shows their face); *"remember that…"* goes into their memory, and the shared memory is theirs too unless you switch it off. Name them (or say "you") in an `/image` or `/video` prompt and their face is the reference picture, or pick them in Studio's **Reference image** slot. Chats remember who they were with |
| 🔧 | **Tools in chat** | Web search, page fetching, the Reddit / Hugging Face / GitHub scout, files, PowerShell and browser control from the workstation's tool server, switched per group. Anything that changes something asks first |
| 🖌️ | **Images in chat** | Type `/image a lighthouse at dusk` (or *"draw me…"*, *"make an image of…"*, or click the picture button) and Qwen-Image-2.1 (or its 4-step turbo) paints it right in the conversation, with live progress. Click the picture to open it; right-click for the full menu. `/video` (or *"make a video of…"*) makes an LTX-2.5 clip with sound the same way |
| 🎮 | **Canvas** | Ask for something you can see or play (*"make me a snake game"*, *"let's play chess"*, a chart, a 3D scene, or `/canvas` and anything) and the model writes it as one HTML page that opens in a panel beside the chat and runs there. **Code** shows (and lets you edit) what it wrote, **Rerun** starts it again, and when the page throws errors **Fix it** sends them back to the model for a corrected version. Pages run sandboxed on their own origin: they can load libraries from a CDN, but can't reach Prestige, your files or the local AI services |
| 🎨 | **Make it yours** | **Settings → Appearance**: seven themes (Dragon red and gold by default, Sapphire, Emerald, Amethyst, Ember, Frost, Rose) or your own accent and trim colours, a **Glow and bloom** slider from Off to 150%, and **Ember drift**: embers rise behind the app and flare up while Prestige talks. Changes show as you make them |
| 😂 | **Emote reactions** | React to any reply with an emote (the smiley beside it), and Prestige reacts to your messages now and then too. It hears about your reaction in its next answer |
| 🎩 | **A mustache that talks** | Whenever Prestige speaks (Live calls, the Voice screen, a speaker button, Read replies aloud) the top hat's mustache moves with the real loudness of the voice |
| 🔊 | **Replies read aloud** | A speaker button on every reply, or switch on **Read replies aloud** in the message box and Kokoro reads each answer as it streams. The mic button talks to it |
| 🔎 | **Search past chats** | Search box in **Past chats** (Ctrl+K) finds every conversation containing your words, shows the passage and jumps to it. Models can search them too (*"what did we decide about…"*), via the **Past chats** tool |
| 🏷️ | **Know your models** | Every model shows what it can do (🔧 tools, 👁 vision, 🧠 thinking, 💻 code, 🔓 uncensored) and whether it fits in VRAM, detected automatically for anything you add |
| 🛒 | **Model catalog** | 29 models checked to run on a 12 GB card, with what each is good at, including Qwen3.8 27B Uncensored (the strongest reasoner here, ~30 tok/s fully on the GPU). One click downloads into the workstation and it's ready to pick |
| 🧠 | **Shared long-term memory** | The same memory as Open WebUI, so every model in both apps knows you. Say *"remember that …"* |
| 📊 | **System dashboard** | Live GPU load, VRAM, temperature and power for every card, Load/Unload for every model, a what's-in-VRAM bar per card, RAM and service status, and a warning before a model won't fit on the card it would load on |
| 🖼️ | **Studio** | A gallery of your real ComfyUI renders, with prompts read from the files, plus image generation (Qwen-Image-2.1, its turbo, or Z-Image-Turbo) and LTX-2.5 text-to-video with sound, with live progress |
| 🧍 | **Reference image** | Put a character or an item from your own picture into a new scene: pick, drop or paste it into Studio's **Reference image** slot (or attach it in chat with the paperclip, paste or drop, then `/image` or `/video`) and describe the scene. Qwen-Image-2.1 keeps the subject's look (about 2 min at 1024²); for a video it makes that first frame at the clip's shape and LTX-2.5 animates it with sound (6–15 min for 4 s at 768×512: the low end when the models are still cached in RAM, the high end when both load from disk), or LTX animates your picture as it is. Mark it **Character** or **Item** for a closer match; these choices and the video's first frame are shared by Studio and chat (they show under the attached picture). Only use photos of real people with their permission |
| ✏️ | **Edit** | Change any image by instruction with Qwen-Image-2.1 ("make it night", "swap the car for a horse") |
| 🖱️ | **Right-click menu** | On any render in the gallery, the viewer or a chat: open, show info, open in folder, edit, animate, use as reference image, reuse or copy the prompt, copy the image, file or path, save a copy, and delete (to the Recycle Bin) |
| 🎬 | **Animate** | Turn any image into a video (5 seconds by default) with Wan 2.2, or switch the model chip to **Wan 2.2 SVI** for a longer video in up to four chained shots (one prompt per shot, split with `|`). Its Settings pick the size, shots, shot length and the high- and low-noise models, which stay on your PC |
| 🎛️ | **Generation settings** | Shape and size, quality (steps), how many images and seed for pictures; resolution, length, frame rate, quality and seed for video. Shared by Studio (**⚙ Settings**) and chat (the sliders button), with defaults that suit a 12 GB card, a time estimate, and a VRAM estimate per card (for LTX-2.5, measured: how much of the model stays on the card; every length up to 10 s fits a 12 GB card) with a warning before a pick is likely to run out of VRAM. Right-click a render to reuse its seed |
| 📞 | **Live calls** | A hands-free voice (and webcam) call: just talk. Whisper turbo hears you, Qwen3.5 answers (seeing the current camera frame when the camera is on) and the reply is spoken as it streams, about 2.5–3.5 s after you stop talking. Talk over it and it stops at once and listens. Mute, camera, voice picker (VoxCPM2 cloned voices included) and the whole call saved in **Past chats**. [How it fits a 12 GB card ↓](#-live-calls) |
| 🎙️ | **Voice conversation** | Push-to-talk or hands-free, with Whisper large-v3-turbo listening on the GPU and Kokoro speaking each sentence as the reply streams. Talk over it to interrupt |
| 🗣️ | **Expressive voices** | Pick a VoxCPM2 voice (Aria, Sterling, Nova, Atlas, Ember) or **Clone a voice…** from a 5–30 second recording. It speaks once the reply is written, and the chat model steps aside on the GPU while it talks |
| 🎩 | **A living avatar** | The top-hat's red eye and gold rings pulse with its actual voice |
| 👀 | **Webcam vision** | *Ask about this* sends the frame to Gemma 4, live captions, and a camera button in chat |
| ⚡ | **One click** | Opening Prestige starts the AI stack; closing it shuts everything down and frees the GPU |

## 📞 Live calls

Click **Live** in the dock (or **Start a Live call** on the Voice screen). Prestige gets the GPU ready (about 5 s, or ~35 s
the first time VoxCPM2 loads), then listens. Talk, pause, and it answers; talk while it's speaking and it stops and listens.
A pause mid-sentence is fine: if you carry on before it says anything, your two halves are joined into one question.
**Esc** or **End** hangs up, and the call is in **Past chats** as *Live call · date*.

Everything stays on the GPU at once, so it fits the card instead of swapping. Measured on the RTX 3060 12 GB with
`nvidia-smi`, including the Windows desktop's ~0.5–1 GB:

| Voice | Loaded together | VRAM in use (whole card) | End of speech → first sound |
|---|---|---|---|
| VoxCPM2 (designed or cloned) | Whisper large-v3-turbo + VoxCPM2 + **Qwen3.5 2B** (16k context) | ~10.6 of 12 GB, ~1.4 GB free | ~2.5–3.5 s (median 3.2 s) |
| Kokoro | Whisper large-v3-turbo + **Qwen3.5 4B** (16k context); Kokoro runs on the CPU | ~5.8 of 12 GB | ~3–4.5 s (median 3.7 s) |

The times include the 0.65 s of silence that tells it you've finished. Each turn's time is shown at the top right of the
call (hover it for where the time went). The Live model is picked to leave ~1 GB free: the 4B doesn't fit beside VoxCPM2
(about 0.4 GB would be left, and when Windows runs short it moves GPU memory into system RAM, making speech many times
slower rather than failing), so VoxCPM2 voices get the 2B. Get both models from the catalog (Qwen3.5 2B and 4B); the
workstation's `voice` pack installs them. With a second GPU (the workstation's split mode), the Live model runs on the
small card and the voices on the big one, so the call picks the model that fits the small card instead.

VoxCPM2 runs at about 1.2× real time here, so it streams: each sentence starts playing once enough of it is made to finish
without a gap. Headphones work best; with speakers, echo cancellation keeps its own voice from interrupting it, and a
transcript that's just its own words is ignored.

## 📸 Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/chat.jpg" alt="Chat"><br><p align="center"><b>Chat</b></p></td>
    <td width="50%"><img src="docs/system.jpg" alt="System dashboard"><br><p align="center"><b>System</b></p></td>
  </tr>
  <tr>
    <td><img src="docs/studio.jpg" alt="Studio gallery"><br><p align="center"><b>Studio</b></p></td>
    <td><img src="docs/voice.jpg" alt="Voice with the animated avatar"><br><p align="center"><b>Voice</b></p></td>
  </tr>
</table>

## 🖥️ Requirements

- **The [Custom AI Workstation](https://github.com/Mr5elfDe5truct/custom-ai-workstation) stack**, installed with its models.
  Prestige is its front end: it talks to Ollama, llama.cpp, Open WebUI, ComfyUI, Kokoro and the voice server on `127.0.0.1`,
  and runs the stack's `start-all.ps1` and `stop-all.ps1`. Whisper turbo and the VoxCPM2 voices come with the workstation's
  `voice` pack; without it, Prestige uses Open WebUI's Whisper and Kokoro.
- **An NVIDIA GPU.** Built and tested on an RTX 3060 12 GB with 32 GB of RAM, and on an RTX 3060 12 GB + RTX 2060 6 GB.
  With several cards Prestige shows meters for each, and checks every fit against the card the model will load on (the
  workstation decides which service runs where; see its
  [GPU guide](https://github.com/Mr5elfDe5truct/custom-ai-workstation/blob/main/docs/GPUS.md)). Smaller cards work too:
  fit chips, context sizes and Studio's warnings follow the VRAM that's there.
- **Windows 11** (WebView2 is built in). Linux and macOS are the next goal.

## 🚀 Install

Grab **`Prestige_<version>_x64-setup.exe`** from the [Releases](https://github.com/Mr5elfDe5truct/prestige/releases/latest)
page and run it. It installs to `C:\Program Files\RG Studios\Prestige` (Windows asks for admin approval once) and adds
Prestige to the Start Menu and the desktop.

### 🛠️ Build from source

You need [Node.js](https://nodejs.org) LTS, [Rust](https://rustup.rs) (stable, MSVC) and
[Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with **Desktop development with C++**.

```powershell
git clone https://github.com/Mr5elfDe5truct/prestige
cd prestige
npm install
npm run tauri dev     # development window with hot reload
npm run tauri build   # installer in src-tauri\target\release\bundle\nsis\
```

## ⚙️ First run

On first launch Prestige asks **what to call you** (and, optionally, a few things about you every model should know). It uses them
in the greeting and tells every model who it's talking to. Change them any time in **Settings**.

Open **Settings** (the gear, top right):

1. **Workstation folder**: where the Custom AI Workstation stack lives (the folder with `start-all.ps1`). The default is
   `%USERPROFILE%\RG Studios\Workstation` (for example `C:\Users\you\RG Studios\Workstation`).
2. **Open WebUI API key**, for shared memory (and speech-to-text when the voice pack isn't installed):
   1. In Open WebUI (http://localhost:8080) open **Admin Panel → Settings → General** and turn on **Enable API Keys**.
   2. Open **Settings → Account → API keys → Create new secret key** and copy it.
   3. Paste it into Prestige, then click **Test** and **Save**. It's stored only on your PC, in `%APPDATA%\com.rgstudios.prestige`.
3. Optional: **Keep the AI services running when Prestige closes**.

Mic or camera blocked? Check **Windows Settings → Privacy & security → Microphone / Camera → let desktop apps access**.

## 🏗️ How it's built

| Part | What |
|---|---|
| `src/` (TypeScript + Vite) | `main.ts` chat (and images, read-aloud and search in it) · `knowledge.ts` chat with your files · `research.ts` Deep Research · `characters.ts` Characters · `theme.ts` + `embers.ts` Appearance · `emotes.ts` reactions · `talk.ts` the talking mustache · `canvas.ts` the Canvas · `system.ts` dashboard · `studio.ts` gallery and generation · `reference.ts` reference images · `voice.ts` + `speech.ts` voice · `live.ts` + `livespeech.ts` + `mic-worklet.js` Live calls · `camera.ts` webcam · `tools.ts` chat tools · `memory.ts` shared memory · `backends.ts` Ollama / llama.cpp |
| `src-tauri/` (Rust + Tauri 2) | Knowledge's file reading (PDF pages, .docx, text), passages, embeddings and vector search (`knowledge.rs`), the Canvas's own origin (`canvas.rs`), a small JSON store (characters), GPU (every card) and RAM readouts, the workstation's GPU plan, chat files, chat search and settings, start/stop scripts, gallery thumbnails, ComfyUI websocket and uploads, mic and camera permissions |
| Look | Dragon red & gold · fonts Rye, Oxanium, IBM Plex Sans and JetBrains Mono, bundled from Fontsource (SIL OFL) |

## 🔗 Part of the Custom AI Workstation

Prestige is the desktop app for **[Custom AI Workstation](https://github.com/Mr5elfDe5truct/custom-ai-workstation)**:
one folder, one script, one 12 GB GPU. The workstation holds the services, models and tools; Prestige is the way to use them.

## 🙏 Credits

**Designed and built by Ryan B. Gyles · R.G. Studios.**

Built on [Tauri](https://tauri.app) (PDF text by [pdf-extract](https://github.com/jrmuizel/pdf-extract)), and powered by [Ollama](https://ollama.com), [llama.cpp](https://github.com/ggml-org/llama.cpp),
[Open WebUI](https://github.com/open-webui/open-webui), [ComfyUI](https://github.com/comfyanonymous/ComfyUI),
[Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
and [VoxCPM](https://github.com/OpenBMB/VoxCPM).
Models by Qwen (including Qwen3.5 2B and 4B for Live calls and Qwen3-Embedding for Knowledge), Google (Gemma), Meta (Llama), Lightricks (LTX), Wan-AI, Tongyi (Z-Image), OpenAI (Whisper) and OpenBMB (VoxCPM2).

## 📜 License

[MIT](LICENSE) © 2026 Ryan B. Gyles. The apps and models it connects to keep their own licenses.
