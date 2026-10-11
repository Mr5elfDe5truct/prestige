# Settings

Everything below can be changed from **Prestige → Settings → Workstation settings**, which writes these files. They
live in `data\` and stay on this PC. Every key is optional, so a missing file means the defaults. A service picks up a
change the next time it starts (Prestige offers to restart the services after a save).

| File | What it holds | Details |
|---|---|---|
| `data\gpu-settings.json` | which card each service runs on, Ollama's context, llama.cpp's offload | [GPUS.md](GPUS.md) |
| `data\service-settings.json` | how the services run, and which ones start | below |
| `bin\llama-models.ini` | each llama.cpp model's file and settings (context, experts in RAM, KV cache, ...) | comments in the file |

## data\service-settings.json

```json
{
  "ollamaKeepAlive": "5m",
  "ollamaFlashAttention": "on",
  "ollamaKvCache": "q8_0",
  "llamaIdleSeconds": 180,
  "llamaModelsMax": 1,
  "comfyui": "on",
  "openWebUI": "on",
  "theme": "dragon"
}
```

| Key | Values | Default |
|---|---|---|
| `ollamaKeepAlive` | how long an idle Ollama model stays loaded: `"5m"`, `"30m"`, `"1h"`, `"-1"` (until unloaded), `"0"` (unload at once) | `5m` |
| `ollamaFlashAttention` | `on`, `off` | `on` |
| `ollamaKvCache` | `f16`, `q8_0`, `q4_0`. Smaller caches fit more context; a quantised cache needs flash attention | `q8_0` |
| `llamaIdleSeconds` | llama.cpp unloads its model after this many idle seconds, so ComfyUI gets the GPU back; `0` keeps it loaded | `180` |
| `llamaModelsMax` | llama.cpp models loaded at once (1 to 9). More than one only makes sense with the VRAM for both | `1` |
| `comfyui` | `on`, `off`: the headless ComfyUI (images, video, songs, 3D). Same as `-NoComfy` | `on` |
| `openWebUI` | `on`, `off`. Off saves about 1 GB of RAM, but Prestige's shared memory is kept in Open WebUI and pauses while it's off | `on` |
| `theme` | Open WebUI's default theme: `dragon`, `neon`, `glass`, `hud`, `off`. `-Theme` wins for one start | `dragon` |

`start-all.ps1`'s switches (`-NoComfy`, `-Theme`, `-GpuMode`) still work and win over the files for that one start.

## How Prestige starts the services

`start-all.ps1 -Manifest` does everything a start does except starting: it works out the GPU plan, writes the config
files in `data\runtime`, and writes `data\runtime\services.json`, which lists each service's program, command line,
folder, environment and log files. Prestige runs that, then starts, stops and restarts each service from the list
itself (System screen → Services). `start-all.ps1` on its own still starts everything, and `stop-all.ps1` still stops
everything, so the Workstation works without Prestige too.
