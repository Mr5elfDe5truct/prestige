# Which NVIDIA card each service runs on, and what fits on it. Dot-sourced by start-all.ps1 (and install.ps1 for its
# summary). The cards come from nvidia-smi; data\gpu-settings.json can override any choice (docs\GPUS.md).
#
# Modes:
#   single  every GPU service on one card (the biggest). The only mode with one card.
#   split   (default with two or more cards) the always-on small models on the second card: Ollama (fast chat, vision,
#           Live calls) and Open WebUI's embeddings; llama.cpp's big model and ComfyUI on the biggest card. The voice
#           server (Whisper + VoxCPM2, ~7 GB) joins the small card when it has 8 GB or more, else the big one.
#   pool    like split, but llama.cpp spreads its model over every card (--tensor-split) so a bigger model, or more of
#           an MoE's experts, fits in VRAM.
#
# Services are pinned with CUDA_VISIBLE_DEVICES set to the cards' UUIDs, so the pinning doesn't depend on CUDA's
# fastest-first numbering (nvidia-smi numbers cards by PCI bus, CUDA by speed, and the two disagree on mixed cards).

$GpuServices = "ollama", "openwebui", "voice", "llama", "comfyui"
$GpuServiceNames = @{ ollama = "Ollama"; openwebui = "Open WebUI"; voice = "voice server"; llama = "llama.cpp"; comfyui = "ComfyUI" }

function Get-NvidiaGpus {
    if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) { return @() }
    $lines = & nvidia-smi --query-gpu=index,uuid,name,memory.total --format=csv,noheader,nounits 2>$null
    if ($LASTEXITCODE) { return @() }
    @(foreach ($l in $lines) {
        $f = $l -split ",\s*"
        if ($f.Count -lt 4) { continue }
        [pscustomobject]@{
            Index = [int]$f[0]; Uuid = $f[1].Trim(); Name = ($f[2].Trim() -replace "^NVIDIA (GeForce )?", "")
            MiB = [int]$f[3]; GB = [math]::Round([int]$f[3] / 1024, 1)
        }
    })
}

# A card named in the settings: its nvidia-smi index, its UUID, or part of its name ("3060").
function Resolve-Gpu($gpus, $sel) {
    $s = "$sel".Trim()
    if (-not $s -or $s -eq "auto") { return $null }
    $g = if ($s -match '^\d{1,2}$') { $gpus | Where-Object { $_.Index -eq [int]$s } } else { $gpus | Where-Object { $_.Uuid -eq $s } }
    if ($g) { return $g | Select-Object -First 1 }
    $g = $null
    if ($g) { return $g }
    $gpus | Where-Object { $_.Name -like "*$s*" } | Select-Object -First 1
}

function Read-GpuSettings($Root) {
    $file = Join-Path $Root "data\gpu-settings.json"
    if (-not (Test-Path $file)) { return [pscustomobject]@{} }
    try { Get-Content -Raw $file | ConvertFrom-Json }
    catch { Write-Warning "data\gpu-settings.json isn't valid JSON, so it's ignored: $($_.Exception.Message)"; [pscustomobject]@{} }
}
function Get-Setting($s, $name, $default = "auto") {
    $v = $s.PSObject.Properties[$name]
    if ($v -and $null -ne $v.Value -and "$($v.Value)" -ne "") { $v.Value } else { $default }
}

function Get-GpuPlan($Root, [string]$Mode = "") {
    $s = Read-GpuSettings $Root
    $notes = @()
    $all = Get-NvidiaGpus
    $skip = @(Get-Setting $s "exclude" @()) | ForEach-Object { Resolve-Gpu $all $_ } | Where-Object { $_ }
    $gpus = @($all | Where-Object { $skip.Index -notcontains $_.Index })
    if (-not $gpus) { return $null }

    $byVram = @($gpus | Sort-Object @{ Expression = "MiB"; Descending = $true }, Index)
    $big = Resolve-Gpu $gpus (Get-Setting $s "bigGpu")
    if (-not $big) { $big = $byVram[0] }
    $small = Resolve-Gpu $gpus (Get-Setting $s "smallGpu")
    if (-not $small -or $small.Index -eq $big.Index) { $small = $byVram | Where-Object { $_.Index -ne $big.Index } | Select-Object -First 1 }

    if (-not $Mode) { $Mode = Get-Setting $s "mode" }
    $Mode = $Mode.ToLower()
    if ($Mode -notin "auto", "single", "split", "pool") { $notes += "unknown GPU mode '$Mode', using auto"; $Mode = "auto" }
    if ($Mode -eq "auto") { $Mode = if ($small) { "split" } else { "single" } }
    if (-not $small -and $Mode -ne "single") { $notes += "$Mode needs two GPUs; using single"; $Mode = "single" }

    # Every card in the pool, the big one first: llama.cpp keeps its KV cache and scratch buffers on its first device.
    $pool = @($big) + @($byVram | Where-Object { $_.Index -ne $big.Index })
    $svc = [ordered]@{}
    foreach ($k in $GpuServices) { $svc[$k] = @($big) }
    if ($Mode -ne "single") {
        $svc.ollama = @($small); $svc.openwebui = @($small)
        $svc.voice = if ($small.GB -ge 7.5) { @($small) } else { @($big) }
        if ($Mode -eq "pool") { $svc.llama = $pool }
    }
    # Per-service overrides: "big", "small", "all", or a card (index, UUID or name), or a list of them.
    $over = Get-Setting $s "services" $null
    if ($over) {
        foreach ($p in $over.PSObject.Properties) {
            $k = $p.Name.ToLower()
            if ($GpuServices -notcontains $k) { $notes += "unknown service '$($p.Name)' in gpu-settings.json"; continue }
            $cards = @(foreach ($v in @($p.Value)) {
                switch ("$v".ToLower()) {
                    "big" { $big } "small" { if ($small) { $small } else { $big } } "all" { $pool }
                    default { $g = Resolve-Gpu $gpus $v; if ($g) { $g } else { $notes += "no GPU matches '$v' for $k" } }
                }
            })
            if ($cards) { $svc[$k] = @($cards | Sort-Object Index -Unique | Sort-Object @{ Expression = { $_.Index -ne $big.Index } }, @{ Expression = "MiB"; Descending = $true }) }
        }
    }

    # Ollama's context from the smallest card it runs on: 32k (q8 KV) fits beside a 7-9 GB model on 12 GB; smaller cards
    # get less so the model stays on the GPU. Prestige reads this too, since it asks for a context with every request.
    $ollamaGB = ($svc.ollama | Measure-Object GB -Minimum).Minimum
    $ctx = Get-Setting $s "ollamaContext"
    $ctx = if ("$ctx" -match '^\d+$') { [int]$ctx } elseif ($ollamaGB -ge 11) { 32768 } elseif ($ollamaGB -ge 5.5) { 16384 } else { 8192 }
    # Measured on a 6 GB RTX 2060: Qwen3.5 4B 62 tok/s and 2B 80 tok/s fully on the card; the 9B fast chat (6.5 GB at
    # 16k) and Gemma 4 12B fall back to the CPU for most layers and manage 7-8 tok/s.
    if ($ollamaGB -lt 7.5 -and $Mode -ne "single") {
        $notes += "Ollama's card has $ollamaGB GB: 4B models run fully on it, the 9B fast chat and Gemma 4 12B partly from RAM (slow). " +
                  "To keep those fast, set services.ollama to `"big`" in data\gpu-settings.json"
    }

    # llama.cpp: bin\llama-models.ini is tuned by hand for one 12 GB card (experts in RAM, layer counts). On any other
    # card, or a pool, those settings are dropped and llama.cpp's --fit sizes the offload to the VRAM actually there.
    # Pooled, --fit also chooses the tensor split across the cards from their free memory. A split set by hand turns
    # --fit off (llama.cpp's fit gives up when tensor-split is set), so the ini's own offload settings apply with it.
    $llamaGB = ($svc.llama | Measure-Object GB -Sum).Sum
    $fit = "$(Get-Setting $s "llamaFit")".ToLower()
    $fitOn = if ($fit -in "on", "true") { $true } elseif ($fit -in "off", "false") { $false } else { -not ($svc.llama.Count -eq 1 -and $llamaGB -ge 11 -and $llamaGB -le 13.5) }
    $split = $null
    if ($svc.llama.Count -gt 1 -and "$(Get-Setting $s "tensorSplit")" -ne "auto") {
        $split = "$(Get-Setting $s "tensorSplit")"
        if ($fitOn) { $notes += "tensorSplit is set, so llama.cpp uses the ini's offload settings instead of --fit"; $fitOn = $false }
    }

    # ComfyUI on two or more cards: the diffusion model and its latents stay on the first (big) one, and the VAEs and
    # LTX upscaler load on the second (tools\comfy_nodes\workstation_gpus). VRAM doesn't pool for one model, but these
    # parts can move. Text encoders stay on the big card by default: they run before the diffusion model loads, so they
    # don't add to its peak, and ComfyUI's dynamic VRAM ran out of memory streaming LTX-2.5's 15 GB Gemma encoder onto a
    # 6 GB second card. comfyAux: "auto" (vae,upscaler), "off", or a list such as "text_encoder,vae,upscaler".
    $aux = "$(Get-Setting $s "comfyAux")".ToLower() -replace "\s", ""
    $comfyAux = $null
    if ($svc.comfyui.Count -gt 1 -and $aux -notin "off", "false", "none") {
        $comfyAux = if ($aux -in "auto", "on", "true") { "upscaler" } else { $aux }
    }

    # comfyQuick "on": a second, small ComfyUI on the small card (port 8189) for quick jobs, Prestige's click to select
    # (SAM 3.1, ~2 GB while it runs, 3 s a selection), so they don't wait for a render on the big card. Off by default:
    # it takes ~2.4 GB of system RAM, which long renders (InfiniteTalk, ~22 GB) can use.
    $comfyQuick = $null
    if ("$(Get-Setting $s "comfyQuick")".ToLower() -in "on", "true" -and $small -and -not ($svc.comfyui.Index -contains $small.Index)) {
        $comfyQuick = $small
    }

    [pscustomobject]@{
        Mode = $Mode; Gpus = $gpus; Big = $big; Small = $small; Services = $svc; Notes = $notes
        OllamaContext = $ctx; LlamaFit = $fitOn; TensorSplit = $split; LlamaGB = $llamaGB; ComfyAux = $comfyAux; ComfyQuick = $comfyQuick
        # Several cards in the PC (even with some excluded): services get pinned.
        Multi = $all.Count -gt 1
    }
}

# Pins the next Start-Process to the plan's cards for this service. With one card (or no plan) nothing is set, so a
# single-GPU PC runs exactly as before.
function Set-ServiceGpus($Plan, $Service) {
    if (-not $Plan -or -not $Plan.Multi) { Remove-Item Env:CUDA_VISIBLE_DEVICES -ErrorAction SilentlyContinue; return }
    $env:CUDA_DEVICE_ORDER = "PCI_BUS_ID"
    $cards = if ($Service -eq "comfyquick") { @($Plan.ComfyQuick) } else { $Plan.Services[$Service] }
    $env:CUDA_VISIBLE_DEVICES = ($cards | ForEach-Object Uuid) -join ","
    # Ollama also finds the cards through Vulkan, which CUDA_VISIBLE_DEVICES doesn't hide: it would load onto the
    # other card that way, at a fraction of the speed. The cards are NVIDIA, so CUDA alone is right.
    if ($Service -eq "ollama") { $env:OLLAMA_VULKAN = "0" }
    # ComfyUI with a second card: its index in CUDA_VISIBLE_DEVICES (the big card is 0) for the workstation_gpus node.
    if ($Service -eq "comfyui") {
        if ($Plan.ComfyAux) { $env:WORKSTATION_COMFY_AUX_DEVICE = "1"; $env:WORKSTATION_COMFY_AUX_PARTS = $Plan.ComfyAux }
        else { Remove-Item Env:WORKSTATION_COMFY_AUX_DEVICE, Env:WORKSTATION_COMFY_AUX_PARTS -ErrorAction SilentlyContinue }
    }
}

# The runtime copy of bin\llama-models.ini for this plan (the tuned values stay as they are on a 12 GB card).
function Convert-LlamaIni($Text, $Plan) {
    if (-not $Plan -or -not ($Plan.LlamaFit -or $Plan.TensorSplit)) { return $Text }
    $lines = foreach ($l in ($Text -split "`r?`n")) {
        if ($Plan.LlamaFit) {
            if ($l -match '^\s*(n-gpu-layers|ngl|n-cpu-moe|cpu-moe)\s*=') { continue }
            # Small cards: cap the context so --fit spends the VRAM on layers rather than cache.
            if ($Plan.LlamaGB -lt 10 -and $l -match '^\s*(c|ctx-size)\s*=\s*(\d+)' -and [int]$Matches[2] -gt 16384) { $l = "$($Matches[1]) = 16384" }
        }
        $l
        if ($l -match '^\s*\[\*\]' -and $Plan.TensorSplit) { "tensor-split = $($Plan.TensorSplit)" }
    }
    ($lines -join "`r`n")
}

# data\runtime\gpu.json, for Prestige (meters per card, fit warnings against the right card) and the voice server.
function Save-GpuPlan($Plan, $Path) {
    $o = [ordered]@{ mode = "none"; gpus = @(); services = [ordered]@{}; ollamaContext = 32768; llamaFit = $false; tensorSplit = $null; comfyAux = @() }
    if ($Plan) {
        $o.mode = $Plan.Mode
        $o.gpus = @($Plan.Gpus | ForEach-Object { [ordered]@{ index = $_.Index; uuid = $_.Uuid; name = $_.Name; gb = $_.GB } })
        foreach ($k in $Plan.Services.Keys) { $o.services[$k] = @($Plan.Services[$k] | ForEach-Object Index) }
        $o.ollamaContext = $Plan.OllamaContext; $o.llamaFit = $Plan.LlamaFit; $o.tensorSplit = $Plan.TensorSplit
        # What ComfyUI loads on its second card (comfyui's second index), for Prestige's per-card estimates.
        $o.comfyAux = @(if ($Plan.ComfyAux) { $Plan.ComfyAux -split "," })
    }
    [IO.File]::WriteAllText($Path, ($o | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
}

function Format-GpuPlan($Plan) {
    if (-not $Plan) { return "  no NVIDIA GPU found (nvidia-smi)" }
    $out = @("  GPUs ($($Plan.Mode)):")
    foreach ($g in $Plan.Gpus) {
        $on = @($GpuServices | Where-Object { $Plan.Services[$_].Index -contains $g.Index } | ForEach-Object { $GpuServiceNames[$_] })
        $out += "    [$($g.Index)] $($g.Name) $($g.GB) GB: $(if ($on) { $on -join ', ' } else { 'not used' })"
    }
    $n = $Plan.Services.llama.Count
    $llama = if ($Plan.TensorSplit) { "pooled over $n cards, tensor split $($Plan.TensorSplit)" }
             elseif ($Plan.LlamaFit -and $n -gt 1) { "pooled over $n cards by --fit" }
             elseif ($Plan.LlamaFit) { "sized to the card by --fit" } else { "12 GB presets" }
    $out += "    Ollama context $([math]::Round($Plan.OllamaContext / 1024))k; llama.cpp $llama"
    if ($Plan.ComfyAux) {
        $c = $Plan.Services.comfyui
        $parts = ($Plan.ComfyAux -split "," | ForEach-Object { @{ text_encoder = "text encoders"; vae = "VAEs"; upscaler = "LTX upscaler" }[$_] }) -join ", "
        $out += "    ComfyUI: diffusion model on the $($c[0].Name); $parts on the $($c[1].Name)"
    }
    if ($Plan.ComfyQuick) { $out += "    Quick ComfyUI (click to select) on the $($Plan.ComfyQuick.Name), port 8189" }
    foreach ($n in $Plan.Notes) { $out += "    ! $n" }
    $out -join "`n"
}
