# GPUs: one card, several cards, small cards

The Workstation was built on one RTX 3060 12 GB, but it runs on whatever NVIDIA cards a PC has. On every start,
`start-all.ps1` reads the cards with `nvidia-smi`, decides which card each service runs on, and prints the result:

```
  GPUs (split):
    [0] RTX 2060 6 GB: Ollama, Open WebUI
    [1] RTX 3060 12 GB: voice server, llama.cpp, ComfyUI
    Ollama context 16k; llama.cpp 12 GB presets
```

The plan is saved to `data\runtime\gpu.json`. Prestige reads it to show a meter for every card and to warn against
the right card, and the voice and tool servers read it so they only unload models that share their card.

## Modes

| Mode | What runs where | Good for |
|---|---|---|
| `single` | Everything on the biggest card. The only mode on a PC with one card. | one card; or a second card you want left alone |
| `split` | **Default with two or more cards.** Ollama (fast chat, vision, Live calls) and Open WebUI's embeddings on the second-biggest card; llama.cpp's big model and ComfyUI on the biggest. The voice server (Whisper + VoxCPM2, ~7 GB) joins the small card when it has 8 GB or more, otherwise it stays on the big one. | chatting while images or video render; Live calls beside a loaded big model |
| `pool` | Like `split`, but llama.cpp spreads its model over every card (llama.cpp's `--fit` picks the tensor split from each card's free memory). | models too big for one card |

Each service is pinned with `CUDA_VISIBLE_DEVICES` set to its cards' UUIDs, with `CUDA_DEVICE_ORDER=PCI_BUS_ID`. CUDA
numbers cards fastest-first and `nvidia-smi` by PCI slot, and on mixed cards the two orders differ; UUIDs avoid that.
Ollama also gets `OLLAMA_VULKAN=0`, because otherwise it finds the hidden card again through Vulkan and loads there, slowly.

Pick a mode for one start, or for good:

```powershell
.\start-all.ps1 -GpuMode pool     # this start only
.\install.ps1 -GpuMode split      # the installer asks when it finds several cards, and saves the answer
```

A service that's already running keeps its card, so run `.\stop-all.ps1` before switching modes.

## Small cards

What changes with the VRAM that's actually there:

- **Ollama's context:** 32k on 11 GB or more, 16k on 5.5–11 GB, 8k below that (from the smallest card Ollama runs
  on). Prestige asks for the same context.
- **llama.cpp:** `bin\llama-models.ini` is tuned by hand for one 12 GB card (how many expert layers sit in RAM, and so
  on). On a card outside 11–13.5 GB, or in a pool, `start-all.ps1` leaves those settings out of
  `data\runtime\llama-models.ini` and llama.cpp's `--fit` sizes the offload to the card. Under 10 GB the context is
  also capped at 16k so the VRAM goes to layers rather than cache.
- **The installer** picks Ollama models for the card Ollama will run on: the 9B fast chat and Gemma 4 12B from 10 GB,
  Qwen3-VL 8B for vision on 7.5–10 GB, and Qwen3.5 4B (which also sees pictures) under 7.5 GB. It also warns about
  packs that will run partly from RAM.

## Measured on an RTX 3060 12 GB + RTX 2060 6 GB

The 2060 sits in a PCIe x4 slot, which matters as soon as the cards have to talk to each other.

| Model | Where | Speed |
|---|---|---|
| Qwen3.5 2B (Ollama) | 2060, fully on the card | 80 tok/s |
| Qwen3.5 4B (Ollama) | 2060, fully on the card | 62 tok/s |
| Qwen3-VL 4B (Ollama, 16k) | 2060, 3.7 of 4.7 GB on the card | 33 tok/s |
| Qwen3.5 9B Uncensored (Ollama, 16k) | 2060, 3.6 of 6.5 GB on the card | 7 tok/s |
| Gemma 4 12B (Ollama) | 2060, mostly in RAM | 8 tok/s |
| Qwen3.5 9B Uncensored (Ollama) | 3060 | 48 tok/s |
| Qwen3.6 35B-A3B (llama.cpp, 12 GB presets) | 3060 | 23 tok/s in chat (30 tok/s in llama-bench) |
| Qwen3.6 35B-A3B (llama.cpp, pooled by `--fit`) | 3060 + 2060 | 18 tok/s |

So on this pair, `split` with the 4B models on the 2060 is the fast setup, and `pool` doesn't pay off for models that
already fit the 12 GB card: the MoE ends up waiting on the x4 link. Pool is for models that don't fit one card at all.
With a second card of 8 GB or more, the 9B and the voices fit on it too.

## Images and video with two cards

VRAM doesn't pool for one model: a diffusion model runs on one card. What can move are the parts around it, and with
two or more cards for ComfyUI (`"services": { "comfyui": "all" }`), the Workstation's own ComfyUI node
(`tools\comfy_nodes\workstation_gpus`, copied into ComfyUI on every start) loads them on the second card through
ComfyUI's own loaders, so every workflow benefits without changes:

| Part | Default | Why |
|---|---|---|
| LTX latent upscaler (1 GB) | second card | it would otherwise sit beside LTX-2.5's second pass on the main card |
| VAEs | main card (`comfyAux` opts in) | a card without bf16 (RTX 20-series) runs LTX's VAE in fp32 (2.8 GB) and a 5 s 768×512 decode ran out of memory on a 6 GB 2060 |
| Text encoders | main card (`comfyAux` opts in) | they run and unload before the diffusion model loads, so they don't add to its peak; ComfyUI's dynamic VRAM ran out of memory streaming LTX-2.5's 15 GB Gemma encoder onto a 6 GB card |

ComfyUI is on the big card alone by default: on the pair below, the extra room didn't make renders faster, and
giving ComfyUI the small card means Ollama's models there get unloaded before each render.

LTX-2.5 text to video, measured with `nvidia-smi` and ComfyUI's log. Its diffusion model is 15.7 GB, so ComfyUI always
streams part of it from system RAM; a longer clip leaves less of it on the card and takes longer, but doesn't fail:

| Size, length | One card: model on the 3060 / time | Upscaler on the 2060: model on the 3060 / time | 3060 peak |
|---|---|---|---|
| 768×512, 5 s (121 frames) | 8.2 GB / 229 s | 9.3 GB / 241 s | 11.9 GB |
| 768×512, 6 s (145 frames) | 8.0 GB / 246 s | 9.1 GB / 256 s | 11.9 GB |
| 768×512, 10 s (241 frames) | 7.0 GB / 321 s | 8.2 GB / 324 s | 12.0 GB |
| 1280×704, 10 s (241 frames) | 4.0 GB / 595 s | 5.1 GB / 589 s | 11.6 GB |

Every length Prestige offers (up to 10 s) stays within the 3060. Prestige's Studio estimates the same way, per card:
how much of the model stays on ComfyUI's main card, and what the second card holds; it warns only when less than 3 GB
would be left for the model.

Songs (ACE-Step 1.5, the `music` pack) run on ComfyUI's main card as well. They need only ~5.3 GB, so the 2060 looked
like a good home, but with all of ACE-Step loaded there its 1.7B language model wrote the audio codes at 1.7 s a token,
against ~60 tokens a second on the 3060: a 60 s song took 9 minutes instead of 26 s.

## data\gpu-settings.json

Optional. Every key can be left out ([example](gpu-settings.example.json)):

```json
{
  "mode": "split",
  "bigGpu": "3060",
  "smallGpu": "auto",
  "services": { "ollama": "big", "voice": "small" },
  "exclude": [],
  "ollamaContext": 16384,
  "llamaFit": "auto",
  "tensorSplit": "auto"
}
```

| Key | Values | Default |
|---|---|---|
| `mode` | `auto`, `single`, `split`, `pool` | `auto`: `split` with two or more cards, else `single` |
| `bigGpu`, `smallGpu` | a card's `nvidia-smi` index, its UUID, or part of its name (`"3060"`) | the biggest and the second-biggest card |
| `services` | per service (`ollama`, `openwebui`, `voice`, `llama`, `comfyui`): `"big"`, `"small"`, `"all"`, a card, or a list of cards | as the mode says |
| `exclude` | cards to leave alone, e.g. one kept for games or the display | none |
| `ollamaContext` | tokens | by the card's VRAM (above) |
| `llamaFit` | `auto`, `on`, `off` | `auto`: off on one 11–13.5 GB card, on everywhere else |
| `tensorSplit` | e.g. `"12,6"`, in the order of the llama.cpp cards (big card first) | `auto` (`--fit` decides). A hand-set split turns `--fit` off, so the ini's own offload settings apply |
| `comfyAux` | with two cards for ComfyUI: `auto`, `off`, or a list of `upscaler`, `vae`, `text_encoder` | `auto`: the upscaler (see above) |
| `comfyQuick` | `on`, `off` | `off`. `on` starts a second, small ComfyUI on the small card (port 8189) that Prestige uses for click to select (SAM 3.1), so a selection doesn't wait for a render on the big card. Measured on an RTX 2060 6 GB: 3 s a selection at 2.0 GB of VRAM (as fast as the 3060), and an 8 s video cut-out in 117 s at 3.0 GB. It takes ~2.4 GB of system RAM, which matters during InfiniteTalk renders (~22 GB) on a 32 GB PC |

For example, on a 12 + 6 GB pair, to keep the 9B fast chat and Gemma 4 12B on the big card and use the small one
only for llama.cpp's pool:

```json
{ "mode": "pool", "services": { "ollama": "big", "openwebui": "big" } }
```
