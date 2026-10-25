# Custom AI Workstation installer, by R.G. Studios. The Workstation is now part of Prestige (the engine\ folder of
# github.com/Mr5elfDe5truct/prestige) and Prestige's own Setup does all of this; this script is kept for scripted installs.
# Sets up the whole local AI stack on a Windows PC with an NVIDIA GPU: tools, llama.cpp, the Python
# environments, ComfyUI, the models you pick, shortcuts and (optionally) the Prestige desktop app.
# Safe to run again: anything already in place is skipped.
#
#   setup.cmd                                   double-click (runs this script)
#   .\install.ps1                               guided install into %USERPROFILE%\RG Studios\Workstation
#   .\install.ps1 -Root D:\AI\Workstation       somewhere else
#   .\install.ps1 -Yes -Packs fast,images       no questions, these model packs
#   .\install.ps1 -Packs none                   software only, no models
#   .\install.ps1 -GpuMode pool                 with several GPUs: split (default), pool or single
#   .\install.ps1 -Packs computer -Nex          computer use, with Nex-N2.5-mini for Prestige's Do it for me
# Without cloning first, from PowerShell:
#   irm https://raw.githubusercontent.com/Mr5elfDe5truct/prestige/main/engine/install.ps1 -OutFile "$env:TEMP\install.ps1"
#   powershell -ExecutionPolicy Bypass -File "$env:TEMP\install.ps1"
param(
    [string]$Root,
    [string[]]$Packs,
    [switch]$Yes,
    [switch]$NoPrestige,
    [switch]$NoTest,
    [switch]$NoShortcuts,     # leave the Desktop / Start Menu shortcuts alone
    [switch]$NoComfyDesktop,  # install ComfyUI into the workstation even if Comfy Desktop is present
    [switch]$NoGpuCheck,      # carry on without an NVIDIA GPU (for testing the installer, e.g. in Windows Sandbox)
    [switch]$Nex,             # with the computer pack: also get Nex-N2.5-mini without asking (asked otherwise)
    [ValidateSet("", "split", "pool", "single")][string]$GpuMode,   # with several GPUs (asked otherwise; docs\GPUS.md)
    [string]$Branch = "main"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest's progress bar is very slow in Windows PowerShell
$Repo = "Mr5elfDe5truct/prestige"   # the Workstation is its engine\ folder

# ---------- look and feel ----------
function Say($text, $color = "Gray") { Write-Host $text -ForegroundColor $color }
function Step($n, $text) { Write-Host ""; Write-Host "[$n] $text" -ForegroundColor Yellow }
function Ok($text) { Write-Host "    + $text" -ForegroundColor Green }
function Skip($text) { Write-Host "    = $text" -ForegroundColor DarkGray }
function Warn($text) { Write-Host "    ! $text" -ForegroundColor DarkYellow }
function Ask($question, $default) {
    if ($Yes) { return $default }
    $a = Read-Host "$question [$default]"
    if ([string]::IsNullOrWhiteSpace($a)) { $default } else { $a.Trim() }
}
function AskYesNo($question, [bool]$default) {
    if ($Yes) { return $default }
    $d = if ($default) { "Y/n" } else { "y/N" }
    $a = Read-Host "$question [$d]"
    if ([string]::IsNullOrWhiteSpace($a)) { return $default }
    return $a.Trim().ToLower().StartsWith("y")
}

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    foreach ($p in "$env:USERPROFILE\.local\bin", "$env:LOCALAPPDATA\Programs\Ollama") {
        if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) { $env:Path += ";$p" }
    }
}
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# winget comes with Windows 11 and recent Windows 10. Where it's missing (older Windows 10, Windows Sandbox,
# LTSC), install App Installer and its dependencies from Microsoft's winget-cli releases on GitHub.
function Ensure-Winget {
    if (Has winget.exe) { return }
    Say "    winget is missing; installing it from github.com/microsoft/winget-cli…"
    $rel = Invoke-RestMethod "https://api.github.com/repos/microsoft/winget-cli/releases/latest" -Headers @{ "User-Agent" = "rg-installer" }
    $tmp = Join-Path $env:TEMP "rg-winget"
    New-Item -ItemType Directory -Force $tmp | Out-Null
    foreach ($n in "DesktopAppInstaller_Dependencies.zip", "Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle") {
        $a = $rel.assets | Where-Object { $_.name -eq $n }
        if (-not $a) { throw "Couldn't find $n in the winget release. Install 'App Installer' from the Microsoft Store, then run this again." }
        Download $a.browser_download_url (Join-Path $tmp $n)
    }
    Expand-Archive (Join-Path $tmp "DesktopAppInstaller_Dependencies.zip") (Join-Path $tmp "deps") -Force
    $deps = @(Get-ChildItem (Join-Path $tmp "deps") -Recurse -Include *.appx, *.msix | Where-Object { $_.Directory.Name -eq "x64" })
    if (-not $deps) { throw "The winget dependencies download had no x64 packages. Install 'App Installer' from the Microsoft Store, then run this again." }
    foreach ($d in $deps) {
        try { Add-AppxPackage -Path $d.FullName -ErrorAction Stop; Ok $d.BaseName }
        catch { Warn "$($d.BaseName): $($_.Exception.Message.Split([char]10)[0])" }   # usually a newer version is already there
    }
    Add-AppxPackage -Path (Join-Path $tmp "Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle")
    $env:Path += ";$env:LOCALAPPDATA\Microsoft\WindowsApps"
    if (-not (Has winget.exe)) { throw "winget still isn't available. Install 'App Installer' from the Microsoft Store, then run this again." }
    Ok "winget $(winget.exe --version)"
}

function Install-Tool($id, $name, $cmd, $exists) {
    if (($cmd -and (Has $cmd)) -or ($exists -and (Test-Path $exists))) { Skip "$name already installed"; return }
    Ensure-Winget
    Say "    installing $name…"
    winget.exe install --id $id -e --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Null
    $code = $LASTEXITCODE
    Refresh-Path
    if ($cmd -and -not (Has $cmd)) {
        if ($code) { throw "Installing $name failed (winget exit code $code). Run this again, or install it yourself: winget install $id" }
        Warn "$name installed, but '$cmd' isn't on PATH yet; a new terminal may be needed"
    } elseif ($exists -and -not (Test-Path $exists)) {
        throw "Installing $name failed (winget exit code $code). Run this again, or install it yourself: winget install $id"
    } else { Ok "$name installed" }
}

# Resumable download with curl.exe (ships with Windows 10/11).
function Download($url, $dest) {
    if (Test-Path $dest) { Skip "$(Split-Path $dest -Leaf) already downloaded"; return }
    New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
    $part = "$dest.part"
    Say "    downloading $(Split-Path $dest -Leaf)…"
    & curl.exe -L --fail --retry 5 --retry-delay 3 -C - --progress-bar -o $part $url
    if ($LASTEXITCODE) { throw "Download failed: $url (run install.ps1 again to resume)" }
    Move-Item $part $dest -Force
    Ok (Split-Path $dest -Leaf)
}
function HF($repo, $path) { "https://huggingface.co/$repo/resolve/main/$path" }

# ---------- 1. this PC ----------
Write-Host ""
Write-Host "  Custom AI Workstation  ·  R.G. Studios" -ForegroundColor Red
Write-Host "  A local, private AI stack: chat, voice, vision, images and video." -ForegroundColor DarkGray
Refresh-Path

Step 1 "Checking this PC"
if (-not [Environment]::Is64BitOperatingSystem) { throw "A 64-bit Windows is required." }
$os = (Get-CimInstance Win32_OperatingSystem).Caption
Ok $os
$ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
Ok "$ramGB GB RAM"
$cudaMajor = 0; $vramGB = 0; $ollamaGB = 0; $gpus = @()
if (Has nvidia-smi) {
    $gpus = @(& nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader,nounits | ForEach-Object {
        $f = $_ -split ",\s*"
        [pscustomobject]@{ Index = [int]$f[0]; Name = ($f[1].Trim() -replace "^NVIDIA (GeForce )?", ""); GB = [math]::Round([double]$f[2] / 1024, 1) }
    } | Sort-Object @{ Expression = "GB"; Descending = $true }, Index)
    $cv = [regex]::Match((& nvidia-smi | Out-String), "CUDA (?:UMD )?Version:\s*([\d.]+)").Groups[1].Value
    $cudaMajor = if ($cv) { [int]($cv.Split(".")[0]) } else { 12 }
    foreach ($g in $gpus) { Ok "$($g.Name), $($g.GB) GB VRAM" }
    Ok "driver supports CUDA $cv"
    # The biggest card runs llama.cpp's big model and ComfyUI. With two or more, Ollama (chat, vision, Live calls) runs
    # on the second card in split and pool modes, so its models are picked to fit that card (docs\GPUS.md).
    $vramGB = $gpus[0].GB
    $ollamaGB = $vramGB
    if ($gpus.Count -gt 1) {
        if (-not $GpuMode) {
            Say "    split: chat, vision and Live models on the $($gpus[1].Name), the big model and images on the $($gpus[0].Name)" DarkGray
            Say "    pool:  like split, but the big model spreads over every card    single: only the $($gpus[0].Name)" DarkGray
            $GpuMode = (Ask "Several GPUs: split, pool or single?" "split").ToLower()
        }
        if ($GpuMode -notin "split", "pool", "single") { Warn "Unknown GPU mode '$GpuMode', using split"; $GpuMode = "split" }
        if ($GpuMode -ne "single") { $ollamaGB = $gpus[1].GB }
        Ok "GPU mode: $GpuMode"
    }
    if ($vramGB -lt 8) { Warn "Less than 8 GB of VRAM: stick to the small models" }
} else {
    Warn "No NVIDIA GPU found (nvidia-smi is missing). The stack needs an NVIDIA GPU with a recent driver."
    if (-not $NoGpuCheck -and -not (AskYesNo "Continue anyway?" $false)) { exit 1 }
    $cudaMajor = 12
}
$cudaTag = if ($cudaMajor -ge 13) { "13.4" } else { "12.4" }      # llama.cpp build
$torchIndex = if ($cudaMajor -ge 13) { "cu130" } else { "cu128" }  # PyTorch build for ComfyUI

# ---------- 2. where ----------
Step 2 "Choosing the install folder"
$here = $PSScriptRoot
$runningFromClone = $here -and (Test-Path (Join-Path $here "start-all.ps1"))
if (-not $Root) {
    $default = if ($runningFromClone) { $here } else { Join-Path $env:USERPROFILE "RG Studios\Workstation" }
    $Root = Ask "Install the Workstation in" $default
}
$Root = [IO.Path]::GetFullPath($Root)
Ok $Root
if ($Root -like "$env:ProgramFiles*") { Warn "Program Files isn't a good place: the services write logs, data and models into this folder." }

# ---------- 3. which models ----------
# Ollama's models are picked for the card it runs on, so they stay on the GPU: the 9B fast chat needs ~6.5 GB with its
# context and Gemma 4 12B ~9 GB; on a 6 GB card both fall back to the CPU (7-8 tok/s) while Qwen3.5 4B, which also
# sees pictures, runs fully on it (~60 tok/s). Qwen3-VL 8B is the vision model for 8-10 GB cards.
$OllamaPicks = @{
    fast   = if ($ollamaGB -ge 7.5 -or -not $gpus) { "hf.co/LEONW24/Qwen3.5-9B-Uncensored:Q4_K_M" } else { "qwen3.5:4b" }
    vision = if ($ollamaGB -ge 10 -or -not $gpus) { "gemma4:12b" } elseif ($ollamaGB -ge 7.5) { "qwen3-vl:8b" } else { "qwen3.5:4b" }
}
$fastText = if ($OllamaPicks.fast -like "*9B*") { @{ GB = 6.7; Text = "Fast chat      Qwen3.5 9B Uncensored (Ollama) - fits fully on an 8-12 GB GPU" } }
            else { @{ GB = 3.4; Text = "Fast chat      Qwen3.5 4B (Ollama) - picked for the $ollamaGB GB card, where the 9B would run from RAM" } }
$visionText = switch ($OllamaPicks.vision) {
    "gemma4:12b"  { @{ GB = 8.0; Text = "Vision         Gemma 4 12B (Ollama) - pictures, the webcam, tools" } }
    "qwen3-vl:8b" { @{ GB = 6.1; Text = "Vision         Qwen3-VL 8B (Ollama) - pictures, the webcam, tools; fits the $ollamaGB GB card" } }
    default       { @{ GB = 3.4; Text = "Vision         Qwen3.5 4B (Ollama) - pictures and the webcam; fits the $ollamaGB GB card" } }
}
$PackInfo = [ordered]@{
    fast     = $fastText
    vision   = $visionText
    main     = @{ GB = 22.1; Text = "Main           Qwen3.6 35B Heretic (llama.cpp) - best quality; needs 32 GB RAM" }
    deep     = @{ GB = 10.9; Text = "Deep           Qwen3.8 27B Uncensored (llama.cpp) - strongest reasoning, ~30 tok/s on 12 GB" }
    voice    = @{ GB = 18.1; Text = "Voice          Whisper turbo + VoxCPM2 voices and cloning + Qwen3.5 2B/4B for Live calls (GPU, 8 GB+)" }
    images   = @{ GB = 41.9; Text = "Images         Qwen-Image-2.1 int8 (+ 8-step Turbo and Lightning) and Z-Image-Turbo (ComfyUI) - text to image and editing" }
    video    = @{ GB = 60.3; Text = "Video          LTX-2.5 + Wan 2.2 (ComfyUI) - text/image to video with sound" }
    computer = @{ GB = 6.9;  Text = "Computer use   UI-TARS 1.5 7B (llama.cpp) - drives the mouse and keyboard; asks about Nex-N2.5-mini (+21.6 GB)" }
    music    = @{ GB = 14.8; Text = "Music          ACE-Step 1.5 turbo + base (ComfyUI) - songs with vocals, the song editor and stems" }
    "music-xl" = @{ GB = 10.0; Text = "Music XL       ACE-Step 1.5 XL turbo (ComfyUI) - Prestige's High quality songs; ~11 GB of VRAM" }
    transcribe = @{ GB = 1.0; Text = "Transcribe     Phonon-2 + Nemotron 3 Diarization - recordings to text with who said what" }
    "3d"     = @{ GB = 9.3;  Text = "Picture to 3D  Pixal3D (ComfyUI, int8) - a picture to a textured 3D model (.glb)" }
    talk     = @{ GB = 17.4; Text = "Talking        InfiniteTalk on Wan 2.1 14B (ComfyUI, GGUF) - a face and a voice to a lip-synced video" }
    select   = @{ GB = 2.2;  Text = "Select         SAM 3.1 + BiRefNet (ComfyUI) - click or name to select, cut-outs, background removal" }
    upscale  = @{ GB = 12.3; Text = "Upscale        SeedVR2 7B + 3B (ComfyUI, int8) - sharpen pictures to 1080p or 4K, videos to 1080p" }
    moss     = @{ GB = 14.9; Text = "MOSS-Image     MOSS-Image (ComfyUI 0.42+, int8, 8 steps) - a second picture model for text, layouts and edits" }
    kromoss  = @{ GB = 6.6;  Text = "Kromoss        Kromoss for MOSS-Image - more natural people (needs moss)" }
    world    = @{ GB = 26.7; Text = "World          Hy-Nomas world model (ComfyUI) - explore a world a segment at a time; decoder non-commercial" }
}
Step 3 "Choosing models"
if (-not $Packs) {
    $defaults = @("fast", "images")
    if ($ramGB -ge 32) { $defaults += "main" }
    if ($vramGB -ge 8) { $defaults += "voice" }
    if ($Yes) { $Packs = $defaults } else {
        $i = 1
        foreach ($k in $PackInfo.Keys) {
            $mark = if ($defaults -contains $k) { "*" } else { " " }
            Say ("   {0}{1}. {2,-9} {3,5:N1} GB  {4}" -f $mark, $i, $k, $PackInfo[$k].GB, $PackInfo[$k].Text.Substring(15))
            $i++
        }
        Say "   (* = suggested for this PC)  Type numbers or names separated by commas, 'all', or 'none'." DarkGray
        $a = Ask "Model packs" ($defaults -join ",")
        $keys = @($PackInfo.Keys)
        $Packs = @(foreach ($t in ($a -split "[,\s]+" | Where-Object { $_ })) {
            if ($t -eq "all") { $keys } elseif ($t -eq "none") { } elseif ($t -match "^\d+$") { $keys[[int]$t - 1] } else { $t.ToLower() }
        })
    }
}
# -Packs fast,images arrives as one string when run with -File (setup.cmd), so split it here too.
$Packs = @(foreach ($t in ($Packs -split "[,\s]+" | Where-Object { $_ })) { if ($t -eq "all") { @($PackInfo.Keys) } else { $t.ToLower() } })
$Packs = @($Packs | Where-Object { $_ -and $_ -ne "none" } | Select-Object -Unique)
foreach ($p in $Packs) { if (-not $PackInfo.Contains($p)) { throw "Unknown model pack '$p'. Choose from: $($PackInfo.Keys -join ', '), all, none" } }
if ($Packs -contains "main" -and $ramGB -lt 32) { Warn "The main model wants 32 GB of RAM; with $ramGB GB it may not load." }
if ($gpus) {
    # llama.cpp sizes its offload to the card (--fit) and ComfyUI moves what doesn't fit to RAM, so these still run, slower.
    if ($Packs -contains "deep" -and $vramGB -lt 11) { Warn "The deep model fits whole on 12 GB; on $vramGB GB part of it runs from RAM (a few tok/s)." }
    if ($Packs -contains "voice" -and $vramGB -lt 8) { Warn "VoxCPM2 voices need ~7 GB of VRAM; on $vramGB GB stick to the Kokoro voices." }
    if (($Packs -contains "images" -or $Packs -contains "video") -and $vramGB -lt 10) { Warn "Images and video are tuned for 12 GB; on $vramGB GB they render, but slower." }
    if ($Packs -contains "music" -and $vramGB -lt 6) { Warn "ACE-Step songs peak at about 5.3 GB of VRAM; on $vramGB GB part of it runs from RAM (slow)." }
    if ($Packs -contains "music-xl" -and $vramGB -lt 12) { Warn "ACE-Step XL peaks at about 11 GB of VRAM; on $vramGB GB part of it runs from RAM (slow)." }
}
$needGB = 12 + ($Packs | ForEach-Object { $PackInfo[$_].GB } | Measure-Object -Sum).Sum   # ~12 GB for software
$drive = Get-PSDrive ((Split-Path $Root -Qualifier).TrimEnd(":"))
$freeGB = [math]::Round($drive.Free / 1GB)
Ok ("Packs: " + $(if ($Packs) { $Packs -join ", " } else { "none (software only)" }) + " · about $([math]::Round($needGB)) GB needed, $freeGB GB free on $($drive.Name):")
if ($freeGB -lt $needGB) {
    Warn "Not enough free space for everything you picked."
    if (-not (AskYesNo "Continue anyway?" $false)) { exit 1 }
}
if (-not $Yes -and -not (AskYesNo "Ready to install?" $true)) { exit 0 }

# ---------- 4. tools ----------
Step 4 "Installing tools (winget)"
# llama.cpp, PyTorch and ComfyUI need the Visual C++ runtime, which a clean Windows may not have.
Install-Tool "Microsoft.VCRedist.2015+.x64" "Visual C++ runtime" $null "$env:windir\System32\vcruntime140_1.dll"
Install-Tool "Git.Git" "Git" "git"
Install-Tool "astral-sh.uv" "uv (Python environments)" "uv"
Install-Tool "OpenJS.NodeJS.LTS" "Node.js (tool servers)" "node"
Install-Tool "Gyan.FFmpeg" "FFmpeg (audio and video)" "ffmpeg"
Install-Tool "Ollama.Ollama" "Ollama" "ollama"
Install-Tool "eSpeak-NG.eSpeak-NG" "eSpeak NG (voice)" $null "$env:ProgramFiles\eSpeak NG\libespeak-ng.dll"

# ---------- 5. the workstation files ----------
Step 5 "Getting the Workstation"
if (Test-Path (Join-Path $Root "start-all.ps1")) {
    Skip "already here"
} else {
    if ((Test-Path $Root) -and (Get-ChildItem $Root -Force | Select-Object -First 1)) { throw "$Root exists and isn't empty. Pick another folder." }
    New-Item -ItemType Directory -Force $Root | Out-Null
    # Only engine\ of the Prestige repo is the Workstation.
    $tmp = Join-Path $env:TEMP "prestige-engine-$PID"
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    git clone --depth 1 --filter=blob:none --sparse --branch $Branch "https://github.com/$Repo.git" $tmp -q
    if ($LASTEXITCODE) { throw "git clone failed" }
    git -C $tmp sparse-checkout set engine
    if ($LASTEXITCODE) { throw "git sparse-checkout failed" }
    Copy-Item -Recurse -Force (Join-Path $tmp "engine\*") $Root
    Remove-Item -Recurse -Force $tmp
    Ok "copied from $Repo"
}
Set-Location $Root
# Prestige looks for the Workstation in %USERPROFILE%\RG Studios\Workstation, then in the folder named here.
$rg = Join-Path $env:USERPROFILE "RG Studios"
New-Item -ItemType Directory -Force $rg | Out-Null
[IO.File]::WriteAllText((Join-Path $rg "workstation-folder.txt"), $Root)
foreach ($d in "apps", "bin", "envs", "logs", "data", "models\gguf", "models\ollama", "models\comfy") {
    New-Item -ItemType Directory -Force (Join-Path $Root $d) | Out-Null
}
# The GPU mode picked above goes in data\gpu-settings.json, which start-all.ps1 reads (other settings there are kept).
if ($gpus.Count -gt 1) {
    $gs = Join-Path $Root "data\gpu-settings.json"
    $cfg = if (Test-Path $gs) { Get-Content -Raw $gs | ConvertFrom-Json } else { [pscustomobject]@{} }
    $cfg | Add-Member -NotePropertyName mode -NotePropertyValue $GpuMode -Force
    [IO.File]::WriteAllText($gs, ($cfg | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
    Ok "GPU mode $GpuMode saved to data\gpu-settings.json"
}

# ---------- 6. llama.cpp ----------
Step 6 "llama.cpp (CUDA $cudaTag build)"
$llama = Join-Path $Root "bin\llama.cpp"
if (Test-Path "$llama\llama-server.exe") { Skip "already installed" } else {
    $rels = Invoke-RestMethod "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30" -Headers @{ "User-Agent" = "rg-installer" }
    $rel = $rels | Where-Object { $_.assets.name -match "^llama-b\d+-bin-win-cuda-$([regex]::Escape($cudaTag))-x64\.zip$" } | Select-Object -First 1
    if (-not $rel) { throw "Couldn't find a llama.cpp Windows CUDA $cudaTag build on GitHub." }
    $tmp = Join-Path $env:TEMP "rg-llama"; New-Item -ItemType Directory -Force $tmp | Out-Null
    foreach ($a in $rel.assets | Where-Object { $_.name -match "^(llama-b\d+|cudart-llama)-bin-win-cuda-$([regex]::Escape($cudaTag))-x64\.zip$" }) {
        $zip = Join-Path $tmp $a.name
        Download $a.browser_download_url $zip
        Expand-Archive $zip -DestinationPath $llama -Force
    }
    if (-not (Test-Path "$llama\llama-server.exe")) { throw "llama.cpp didn't unpack as expected." }
    Ok "llama.cpp $($rel.tag_name)"
}

# ---------- 7. Python environments ----------
Step 7 "Python environments (pinned to the tested versions)"
& uv python install 3.11 3.12 | Out-Null
function New-Env($name, $python, $req, [string[]]$extra) {
    $envDir = Join-Path $Root "envs\$name"
    if (Test-Path "$envDir\Scripts\python.exe") { Skip "$name already set up"; return }
    & uv venv $envDir --python $python -q
    Push-Location $Root   # relative paths: uv splits --override values on spaces, as in "RG Studios"
    & uv pip install -p $envDir -r "requirements\$req" @extra -q
    $code = $LASTEXITCODE
    Pop-Location
    if ($code) { throw "Installing the $name environment failed" }
    Ok $name
}
New-Env "open-webui" "3.11" "open-webui.txt"
New-Env "tools" "3.12" "tools.txt"

# Kokoro text-to-speech: the FastAPI server at the tested commit, its environment and voice model.
$kokoro = Join-Path $Root "apps\Kokoro-FastAPI"
if (-not (Test-Path "$kokoro\api")) {
    git clone https://github.com/remsky/Kokoro-FastAPI.git $kokoro -q
    git -C $kokoro checkout -q b4ef64b1ce60682debda4fe0a066259e284eb1b4
    Ok "Kokoro-FastAPI"
}
New-Env "kokoro" "3.12" "kokoro.txt" @("--override", "requirements\kokoro-overrides.txt", "--extra-index-url", "https://download.pytorch.org/whl/cpu", "--index-strategy", "unsafe-best-match")
& uv pip install -p (Join-Path $Root "envs\kokoro") --no-deps -e $kokoro -q
$voiceModel = "$kokoro\api\src\models\v1_0"
Download (HF "hexgrad/Kokoro-82M" "kokoro-v1_0.pth") "$voiceModel\kokoro-v1_0.pth"
Download (HF "hexgrad/Kokoro-82M" "config.json") "$voiceModel\config.json"

# Voice server (voice pack): Whisper large-v3-turbo and VoxCPM2 on the GPU. PyTorch for CUDA 12.8 first (it runs on
# CUDA 12 and 13 drivers, and CTranslate2's Whisper loads the cuBLAS 12 it ships), then the pinned packages.
if ($Packs -contains "voice") {
    $voiceEnv = Join-Path $Root "envs\voice"
    if (Test-Path "$voiceEnv\Scripts\python.exe") { Skip "voice already set up" } else {
        & uv venv $voiceEnv --python 3.12 -q
        Say "    installing PyTorch for CUDA (cu128), about 3 GB…"
        & uv pip install -p $voiceEnv torch torchaudio --index-url "https://download.pytorch.org/whl/cu128" -q
        Push-Location $Root
        & uv pip install -p $voiceEnv -r "requirements\voice.txt" -q
        $code = $LASTEXITCODE
        Pop-Location
        if ($code) { throw "Installing the voice environment failed" }
        Ok "voice"
    }
}

# Transcribe (transcribe pack): Phonon-2 speech recognition on the CPU (FermionResearch's package, in its own env) and
# Nemotron 3 Diarization for who-spoke-when in NVIDIA's NeMo-Speech.cpp (CUDA build). tools\transcribe.py runs them.
if ($Packs -contains "transcribe") {
    $trEnv = Join-Path $Root "envs\transcribe"
    if (Test-Path "$trEnv\Scripts\fermion.exe") { Skip "transcribe environment already set up" } else {
        & uv venv $trEnv --python 3.12 -q
        Push-Location $Root
        & uv pip install -p $trEnv -r "requirements\transcribe.txt" -q
        $code = $LASTEXITCODE
        Pop-Location
        if ($code) { throw "Installing the transcribe environment failed" }
        Ok "transcribe environment (Phonon-2)"
    }
    $ns = Join-Path $Root "bin\nemo-speech"
    if (Get-ChildItem "$ns\*\bin\nemo-speech.exe" -ErrorAction SilentlyContinue) { Skip "NeMo-Speech.cpp already there" } else {
        $ver = "0.2.0"
        $name = "nemo-speech-$ver-windows-x86_64-cuda.zip"
        $zip = Join-Path $env:TEMP $name
        Download "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v$ver/$name" $zip
        $want = (& curl.exe -L -s "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v$ver/$name.sha256").Split(" ")[0].Trim()
        if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $want) { Remove-Item $zip; throw "NeMo-Speech.cpp's download didn't match its checksum; run install.ps1 again" }
        Expand-Archive $zip $ns -Force
        Remove-Item $zip
        Ok "NeMo-Speech.cpp $ver"
    }
}

# ---------- 8. ComfyUI ----------
Step 8 "ComfyUI (images and video)"
# With several Comfy Desktop installs, use the one that has the GGUF nodes, then the most recently used (same as start-all.ps1).
$desk = Get-ChildItem "$env:LOCALAPPDATA\Comfy-Desktop\ComfyUI-Installs" -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path "$($_.FullName)\ComfyUI\.venv\Scripts\python.exe" } |
    Sort-Object @{ Expression = { Test-Path "$($_.FullName)\ComfyUI\custom_nodes\ComfyUI-GGUF" }; Descending = $true },
                @{ Expression = { (Get-Item "$($_.FullName)\ComfyUI\custom_nodes").LastWriteTime }; Descending = $true } |
    Select-Object -First 1
$comfy = Join-Path $Root "apps\ComfyUI"
if ($desk -and -not $NoComfyDesktop -and -not (Test-Path "$comfy\main.py")) {
    Skip "using your Comfy Desktop install ($($desk.Name))"
    $nodes = "$($desk.FullName)\ComfyUI\custom_nodes"; $comfyPy = "$($desk.FullName)\ComfyUI\.venv\Scripts\python.exe"
    # Qwen-Image-2.1's int8 files and LTX-2.5 need ComfyUI 0.38 or newer (tested on 0.42.5).
    $ver = (Select-String -Path "$($desk.FullName)\ComfyUI\comfyui_version.py" -Pattern '(\d+)\.(\d+)\.\d+' -ErrorAction SilentlyContinue).Matches
    if ($ver -and [version]$ver[0].Value -lt [version]"0.38.0") {
        Warn "Comfy Desktop has ComfyUI $($ver[0].Value); update it in Comfy Desktop for Qwen-Image-2.1 and LTX-2.5"
    } elseif ($ver -and $Packs -contains "moss" -and [version]$ver[0].Value -lt [version]"0.42.0") {
        Warn "Comfy Desktop has ComfyUI $($ver[0].Value); MOSS-Image needs 0.42 or newer, so update it in Comfy Desktop"
    }
} else {
    if (-not (Test-Path "$comfy\main.py")) {
        git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git $comfy -q
        Ok "ComfyUI"
    }
    $comfyEnv = Join-Path $Root "envs\comfyui"
    if (-not (Test-Path "$comfyEnv\Scripts\python.exe")) {
        & uv venv $comfyEnv --python 3.12 -q
        Say "    installing PyTorch for CUDA ($torchIndex), about 3 GB…"
        & uv pip install -p $comfyEnv torch torchvision torchaudio --index-url "https://download.pytorch.org/whl/$torchIndex" -q
        & uv pip install -p $comfyEnv -r "$comfy\requirements.txt" -q
        if ($LASTEXITCODE) { throw "Installing ComfyUI's environment failed" }
        Ok "ComfyUI environment"
    } else { Skip "ComfyUI environment already set up" }
    $nodes = "$comfy\custom_nodes"; $comfyPy = "$comfyEnv\Scripts\python.exe"
}
# Custom nodes the workflows use: GGUF model loaders, KJNodes (VAELoaderKJ) and ausboss's ComfyUI-AusBoss (MIT; Tiled
# Upscale for Prestige's Redraw at 4 / 8 MP). leejet's ComfyUI-GGUF is city96's plus Qwen-Image-2.1 and the Qwen3-VL
# text encoder's mmproj.
foreach ($n in @(@{ Name = "ComfyUI-GGUF"; Url = "https://github.com/leejet/ComfyUI-GGUF.git" },
                 @{ Name = "ComfyUI-KJNodes"; Url = "https://github.com/kijai/ComfyUI-KJNodes.git" },
                 @{ Name = "ComfyUI-AusBoss"; Url = "https://github.com/ausboss/ComfyUI-AusBoss.git" })) {
    $dir = Join-Path $nodes $n.Name
    if ((Test-Path "$dir\.git") -and ((git -C $dir remote get-url origin) -match "city96")) {
        git -C $dir remote set-url origin $n.Url
        git -C $dir pull -q --ff-only
        if ($LASTEXITCODE) { Warn "couldn't switch $($n.Name) to leejet's version, which Qwen-Image-2.1 needs" }
        else { Ok "$($n.Name) switched to leejet's version (adds Qwen-Image-2.1)" }
        continue
    }
    if (Test-Path $dir) { Skip "$($n.Name) already there"; continue }
    git clone --depth 1 $n.Url $dir -q
    if (Test-Path "$dir\requirements.txt") {
        $venv = Split-Path (Split-Path $comfyPy)
        & uv pip install -p $venv -r "$dir\requirements.txt" -q
    }
    Ok $n.Name
}
# SageAttention 2.2 for Prestige's Faster video (Workstation Sage Attention): triton-windows for the environment's
# PyTorch (2.10 takes Triton 3.6, 2.11 3.7, 2.12 3.8) and woct0rdho's Windows wheel for its CUDA. Only where it runs:
# an NVIDIA card of compute 8.0 or newer (RTX 30-series and up). Without it, Faster video simply does nothing.
$cc = (& nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>$null | ForEach-Object { [double]$_ } | Measure-Object -Maximum).Maximum
& $comfyPy -c "import sageattention" 2>$null
if ($LASTEXITCODE -eq 0) { Skip "SageAttention already installed" }
elseif ($cc -ge 8.0) {
    $tv = & $comfyPy -c "import torch; print(torch.__version__)" 2>$null
    if ($tv -match '^2\.(\d+)\.\d+\+cu(128|130)' -and [int]$Matches[1] -ge 10) {
        $minor = [int]$Matches[1]; $cu = $Matches[2]
        $venv = Split-Path (Split-Path $comfyPy)
        & uv pip install -p $venv "triton-windows>=3.$($minor - 4),<3.$($minor - 3)" `
            "https://github.com/woct0rdho/SageAttention/releases/download/v2.2.0-windows.post6/sageattention-2.2.0+cu${cu}torch2.10.0andhigher.post6-cp310-abi3-win_amd64.whl" -q
        if ($LASTEXITCODE) { Warn "couldn't install SageAttention; Faster video will do nothing" } else { Ok "SageAttention 2.2 (Faster video)" }
    } else { Skip "SageAttention needs PyTorch 2.10+ with CUDA 12.8 or 13.0 (ComfyUI has $tv)" }
} else { Skip "SageAttention needs an RTX 30-series card or newer" }

# ---------- 9. models ----------
Step 9 "Models"
$gguf = Join-Path $Root "models\gguf"
$comfyModels = Join-Path $Root "models\comfy"
$pulls = @($Packs | Where-Object { $OllamaPicks.ContainsKey($_) } | ForEach-Object { $OllamaPicks[$_] })
# Prestige's Live calls: small vision models that fit on the GPU beside Whisper (and the 2B beside VoxCPM2).
if ($Packs -contains "voice") { $pulls += @("qwen3.5:2b", "qwen3.5:4b") }
# Prestige's Knowledge (chat with your files): a small embedding model (0.6 GB) that reads documents on this PC.
if ($Packs) { $pulls += "qwen3-embedding:0.6b" }
$pulls = @($pulls | Select-Object -Unique)
if ($pulls) {
    # Pull into the workstation's own model store, using a temporary Ollama server pointed at it.
    $env:OLLAMA_MODELS = Join-Path $Root "models\ollama"
    if (Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue) {
        Say "    stopping the Ollama tray app so the models go into the workstation folder…"
        Get-Process "ollama app", ollama -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep 2
    }
    $ollamaExe = (Get-Command ollama -ErrorAction SilentlyContinue).Source
    if (-not $ollamaExe) { $ollamaExe = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" }
    $srv = Start-Process $ollamaExe "serve" -WindowStyle Hidden -PassThru
    Start-Sleep 4
    foreach ($m in $pulls) { Say "    ollama pull $m"; & $ollamaExe pull $m; if ($LASTEXITCODE) { Warn "couldn't pull $m" } else { Ok $m } }
    Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
}
if ($Packs -contains "main") {
    Download (HF "Youssofal/Qwen3.6-35B-A3B-Abliterated-Heretic-GGUF" "Qwen3.6-35B-A3B-Abliterated-Heretic-Q4_K_M/Qwen3.6-35B-A3B-Abliterated-Heretic-Q4_K_M.gguf") "$gguf\qwen3.6-35b-a3b-heretic-Q4_K_M.gguf"
    Download (HF "Youssofal/Qwen3.6-35B-A3B-Abliterated-Heretic-GGUF" "mmproj-Qwen3.6-35B-A3B-Abliterated-Heretic.gguf") "$gguf\qwen3.6-35b-a3b-heretic-mmproj.gguf"
}
if ($Packs -contains "deep") {
    # Q2_K_P is the largest quant that fits a 12 GB card whole (bigger ones run at 5-8 tok/s with layers in RAM).
    $q38 = "HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF"
    Download (HF $q38 "Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q2_K_P.gguf") "$gguf\Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q2_K_P.gguf"
    Download (HF $q38 "mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf") "$gguf\mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf"
}
if ($Packs -contains "voice") {
    # VoxCPM2 text-to-speech (Whisper turbo downloads itself into models\whisper on first use).
    foreach ($f in "config.json", "special_tokens_map.json", "tokenization_voxcpm2.py", "tokenizer.json", "tokenizer_config.json", "audiovae.pth", "model.safetensors") {
        Download (HF "openbmb/VoxCPM2" $f) (Join-Path $Root "models\tts\VoxCPM2\$f")
    }
}
if ($Packs -contains "computer") {
    Download (HF "Mungert/UI-TARS-1.5-7B-GGUF" "UI-TARS-1.5-7B-q5_k_m.gguf") "$gguf\UI-TARS-1.5-7B-q5_k_m.gguf"
    Download (HF "Mungert/UI-TARS-1.5-7B-GGUF" "UI-TARS-1.5-7B-f16.mmproj") "$gguf\UI-TARS-1.5-7B-f16.mmproj"
    Say "    For the computer-use app itself, install UI-TARS Desktop into apps\ui-tars-desktop: https://github.com/bytedance/UI-TARS-desktop/releases" DarkGray
    # Optional: Nex-N2.5-mini, the model Prestige's "Do it for me" (/do) prefers. A 35B-A3B trained for computer use,
    # run like Qwen3.6 35B with expert layers in RAM; ~10 s a step on an RTX 3060 + 2060.
    $nexFile = "$gguf\nex-agi_Nex-N2.5-mini-Q4_K_M.gguf"
    if ((Test-Path $nexFile) -or $Nex -or (AskYesNo "    Also get Nex-N2.5-mini (21.6 GB, needs 32 GB RAM) for Prestige's Do it for me?" $false)) {
        Download (HF "bartowski/nex-agi_Nex-N2.5-mini-GGUF" "nex-agi_Nex-N2.5-mini-Q4_K_M.gguf") $nexFile
        Download (HF "bartowski/nex-agi_Nex-N2.5-mini-GGUF" "mmproj-nex-agi_Nex-N2.5-mini-f16.gguf") "$gguf\mmproj-nex-agi_Nex-N2.5-mini-f16.gguf"
        # Registered with the llama.cpp router the way Prestige's model catalog adds models.
        $ini = Join-Path $Root "bin\llama-models.ini"
        if ((Test-Path $ini) -and -not (Select-String -Path $ini -Pattern '^\[nex-n2\.5-mini\]' -Quiet)) {
            Add-Content -Path $ini -Value @"

; Nex-N2.5-mini (bartowski/nex-agi_Nex-N2.5-mini-GGUF), a 35B-A3B computer-use model; experts in RAM like Qwen3.6 35B.
[nex-n2.5-mini]
model = {ROOT}\models\gguf\nex-agi_Nex-N2.5-mini-Q4_K_M.gguf
mmproj = {ROOT}\models\gguf\mmproj-nex-agi_Nex-N2.5-mini-f16.gguf
n-cpu-moe = 25
c = 32768
"@
            Ok "Nex-N2.5-mini added to bin\llama-models.ini"
        }
    }
}
if ($Packs -contains "transcribe") {
    # Nemotron 3 Diarization (102 MB, up to 8 speakers) for NeMo-Speech.cpp; Phonon-2 (160 MB) fetches itself into the
    # Hugging Face cache, here on a second of silence so the first transcription doesn't wait for it.
    Download (HF "nvidia/Nemotron-3-Diarization" "Nemotron-3-Diarization.q8_0.gguf") (Join-Path $Root "models\speech\Nemotron-3-Diarization.q8_0.gguf")
    $quiet = Join-Path $env:TEMP "phonon-warmup.wav"
    & ffmpeg -hide_banner -v error -y -f lavfi -i "anullsrc=r=16000:cl=mono" -t 1 $quiet
    $env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
    & (Join-Path $Root "envs\transcribe\Scripts\fermion.exe") transcribe phonon-2 $quiet 2>$null | Out-Null
    if ($LASTEXITCODE) { Warn "couldn't fetch Phonon-2 now; it downloads on the first transcription" } else { Ok "Phonon-2" }
    Remove-Item $quiet -ErrorAction SilentlyContinue
}
if ($Packs -contains "3d") {
    # Pixal3D (TencentARC, MIT) for workflows\pixal3d-image-to-3d.api.json, run by ComfyUI's own nodes (0.38 or newer):
    # the int8 model (peaks at ~5.2 GB VRAM), its DINOv3 image encoder, the TRELLIS.2 shape and texture VAEs, MoGe for
    # the camera's field of view and BiRefNet to cut out the subject.
    foreach ($f in @(@("Comfy-Org/Pixal3D", "diffusion_models/pixal3d_int8_convrot.safetensors"),
                     @("Comfy-Org/Pixal3D", "clip_vision/dino_v3_L_naf_fp32.safetensors"),
                     @("Comfy-Org/Pixal3D", "vae/trellis_2_shape_vae_bf16.safetensors"),
                     @("Comfy-Org/Pixal3D", "vae/trellis_2_texture_vae_bf16.safetensors"),
                     @("Comfy-Org/MoGe", "geometry_estimation/moge_2_vitl_normal_fp16.safetensors"),
                     @("Comfy-Org/BiRefNet", "background_removal/birefnet.safetensors"))) {
        Download (HF $f[0] $f[1]) (Join-Path $comfyModels ($f[1] -replace "/", "\"))
    }
}
if ($Packs -contains "talk") {
    # InfiniteTalk (MeiGen, Apache-2.0) for workflows\infinitetalk-talking.api.json, run by ComfyUI's own nodes (0.38 or
    # newer): Wan 2.1 I2V 14B 480p in GGUF Q4_K_M with the lightx2v step-distill LoRA (4 steps, no CFG), InfiniteTalk's
    # audio patch and the wav2vec2 speech encoder. The Wan text encoder and VAE are the video pack's (fetched here too
    # when it isn't installed).
    foreach ($f in @(@("city96/Wan2.1-I2V-14B-480P-gguf", "wan2.1-i2v-14b-480p-Q4_K_M.gguf", "unet"),
                     @("Kijai/WanVideo_comfy", "Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors", "loras"),
                     @("Comfy-Org/Wan_2.1_ComfyUI_repackaged", "split_files/model_patches/wan2.1_infiniteTalk_single_fp16.safetensors", "model_patches"),
                     @("Kijai/wav2vec2_safetensors", "wav2vec2-chinese-base_fp16.safetensors", "audio_encoders"),
                     @("Comfy-Org/Wan_2.1_ComfyUI_repackaged", "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", "text_encoders"),
                     @("Comfy-Org/Wan_2.1_ComfyUI_repackaged", "split_files/vae/wan_2.1_vae.safetensors", "vae"))) {
        Download (HF $f[0] $f[1]) (Join-Path $comfyModels "$($f[2])\$(Split-Path $f[1] -Leaf)")
    }
}
if ($Packs -contains "select") {
    # SAM 3.1 (Meta) for workflows\sam3-select.api.json and sam3-video-cutout.api.json, and BiRefNet (also in the 3d pack)
    # for cutout.api.json's Remove background. ComfyUI 0.38 runs both natively.
    foreach ($f in @(@("Comfy-Org/sam3.1", "checkpoints/sam3.1_multiplex_fp16.safetensors"),
                     @("Comfy-Org/BiRefNet", "background_removal/birefnet.safetensors"))) {
        Download (HF $f[0] $f[1]) (Join-Path $comfyModels ($f[1] -replace "/", "\"))
    }
}
if ($Packs -contains "moss") {
    # MOSS-Image (OpenMOSS, Apache-2.0) for workflows\moss-image-turbo.api.json: int8 DiT, Qwen3.5-9B text encoder
    # (w4a8) and FLUX.2's small VAE from Comfy-Org, and lodestones' 8-step DMD LoRA, each in a moss\ folder.
    foreach ($f in "diffusion_models/moss_image_sft_int8_convrot.safetensors", "text_encoders/qwen3.5_9b_w4a8_gptq.safetensors",
                   "vae/flux2-vae_small.safetensors") {
        $folder, $name = $f -split "/"
        Download (HF "Comfy-Org/MOSS-Image" $f) "$comfyModels\$folder\moss\$name"
    }
    Download (HF "lodestones/MOSS-Image-SFT-8-steps-dmd" "lora.safetensors") "$comfyModels\loras\moss\moss-image-sft-8-steps-dmd-lora.safetensors"
    # chinoll's Moss-Image-Edit LoRA (GPL-3.0, rank 64) in ComfyUI's key names, for Prestige's MOSS-Image edits
    # (Edit with: MOSS-Image). Its node, Text Encode MOSS-Image Edit, is in ComfyUI newer than 0.42.5.
    Download (HF "PedroMarinhoDev/Moss-Image-Edit-ComfyUI" "moss_image_edit_lora_bf16.safetensors") "$comfyModels\loras\moss\moss-image-edit-lora-bf16.safetensors"
    # Transparent pictures: paralaif's MOSS-Image Alpha LoRA (a proof of concept for non-commercial research and evaluation
    # only) and trmz's RGBA FLUX.2 VAE (Apache-2.0) that decodes its latents with an alpha channel.
    Download (HF "paralaif/MOSS-Image-Alpha-LoRA" "moss_alpha_v1.safetensors") "$comfyModels\loras\moss\moss-alpha-v1.safetensors"
    Download (HF "trmz/flux2-klein-alpha" "vae/diffusion_pytorch_model.safetensors") "$comfyModels\vae\moss\flux2-klein-alpha-rgba-vae.safetensors"
}
if ($Packs -contains "world") {
    # Tencent's Hy-Nomas world model (DiT Apache-2.0, int8) for Prestige's /world, through PedroMarinhoDev's
    # ComfyUI-Hy-Nomas nodes (GPL-3.0, nothing to pip install). Its PixelUMM decoder (which also holds the encoder for
    # starting from a picture) is under NVIDIA's One-Way Noncommercial License: research and evaluation only. The text
    # encoder is Qwen-Image's Qwen2.5-VL 7B.
    $dir = Join-Path $nodes "ComfyUI-Hy-Nomas"
    if (Test-Path $dir) { Skip "ComfyUI-Hy-Nomas already there" } else { git clone --depth 1 https://github.com/PedroMarinhoDev/ComfyUI-Hy-Nomas $dir -q; Ok "ComfyUI-Hy-Nomas" }
    foreach ($f in @(@("PedroMarinhoDev/Hy-Nomas-ComfyUI", "hy_nomas_distil_int8.safetensors", "diffusion_models"),
                     @("PedroMarinhoDev/Hy-Nomas-ComfyUI", "hy_nomas_pixelumm_fp8.safetensors", "vae"),
                     @("Comfy-Org/Qwen-Image_ComfyUI", "split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors", "text_encoders"))) {
        Download (HF $f[0] $f[1]) (Join-Path $comfyModels "$($f[2])\hy-nomas\$(Split-Path $f[1] -Leaf)")
    }
}
if ($Packs -contains "kromoss") {
    Download (HF "lodestones/Kromoss" "diffusion_models/kromoss_int8_convrot.safetensors") "$comfyModels\diffusion_models\moss\kromoss_int8_convrot.safetensors"
    Download (HF "lodestones/Kromoss" "8-steps-dmd2-lora.safetensors") "$comfyModels\loras\moss\kromoss-8-steps-dmd2-lora.safetensors"
}
if ($Packs -contains "upscale") {
    # SeedVR2 (ByteDance, Apache-2.0) for workflows\seedvr2-upscale-image.api.json (the 7B) and -video.api.json (the
    # 3B), run by ComfyUI's own nodes (0.38 or newer, with its faster SeedVR2), in tiles so 4K fits a 12 GB card.
    foreach ($f in "diffusion_models/seedvr2_7b_int8_convrot.safetensors", "diffusion_models/seedvr2_3b_int8_convrot.safetensors",
                   "vae/seedvr2_ema_vae_fp16.safetensors") {
        Download (HF "Comfy-Org/SeedVR2" $f) (Join-Path $comfyModels ($f -replace "/", "\"))
    }
}
if ($Packs -contains "images") {
    # Qwen-Image-2.1: Comfy-Org's int8 convrot DiT and Qwen's 8-step Turbo (2.5x the Q4_K_M GGUFs' speed on an RTX 3060),
    # abenzerps' uncensored LoRA that Prestige puts on both, the Qwen3-VL-8B text encoder (GGUF plus its vision mmproj)
    # and the VAE. Prestige still runs the older GGUFs (qwen-image-2.1-UC-Q4_K_M, the Viggle turbo) where they're installed instead.
    foreach ($f in "qwen_image_2.1_int8_convrot.safetensors", "qwen_image_2.1_turbo_int8_convrot.safetensors") {
        Download (HF "Comfy-Org/Qwen-Image-2.1" "diffusion_models/$f") "$comfyModels\diffusion_models\qwen-image\$f"
    }
    Download (HF "abenzerps/Qwen-Image-2.1-Uncensored-Quantized" "qwen-image-2.1-uncensored-lora.safetensors") "$comfyModels\loras\qwen-image\qwen-image-2.1-uncensored-lora.safetensors"
    Download (HF "unsloth/Qwen3-VL-8B-Instruct-GGUF" "Qwen3-VL-8B-Instruct-UD-Q4_K_XL.gguf") "$comfyModels\text_encoders\Qwen3-VL-8B-Instruct-UD-Q4_K_XL.gguf"
    Download (HF "unsloth/Qwen3-VL-8B-Instruct-GGUF" "mmproj-F16.gguf") "$comfyModels\text_encoders\Qwen3-VL-8B-Instruct-mmproj-F16.gguf"
    Download (HF "Comfy-Org/Qwen-Image-2.1" "vae/qwen_image_2.1_vae_bf16.safetensors") "$comfyModels\vae\qwen_image_2.1_vae_bf16.safetensors"
    # lightx2v's Lightning LoRA: Fast edits, Paint to change, Restore photo and Reference in 4 steps.
    Download (HF "lightx2v/Qwen-Image-2.1-Lightning" "pytorch_lora_weights.safetensors") "$comfyModels\loras\qwen-image-2.1-lightning-4step.safetensors"
    Download (HF "Comfy-Org/z_image_turbo" "split_files/diffusion_models/z_image_turbo_bf16.safetensors") "$comfyModels\diffusion_models\z_image_turbo_bf16.safetensors"
    Download (HF "Comfy-Org/z_image_turbo" "split_files/text_encoders/qwen_3_4b.safetensors") "$comfyModels\text_encoders\qwen_3_4b.safetensors"
    Download (HF "Comfy-Org/z_image_turbo" "split_files/vae/ae.safetensors") "$comfyModels\vae\ae.safetensors"
}
if ($Packs -contains "video") {
    $v = @(
        @("jayn7/WAN2.2-I2V_A14B-DISTILL-LIGHTX2V-4STEP-GGUF", "high_noise_260412/wan2.2_i2v_A14b_high_noise_lightx2v_4step_720p_260412-Q4_K_M.gguf", "unet"),
        @("jayn7/WAN2.2-I2V_A14B-DISTILL-LIGHTX2V-4STEP-GGUF", "low_noise_260412/wan2.2_i2v_A14b_low_noise_lightx2v_4step_720p_260412-Q4_K_M.gguf", "unet"),
        @("Comfy-Org/Wan_2.1_ComfyUI_repackaged", "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", "text_encoders"),
        @("Comfy-Org/Wan_2.1_ComfyUI_repackaged", "split_files/vae/wan_2.1_vae.safetensors", "vae"),
        # LTX-2.5 distilled: the Q4_K_M DiT, then the Gemma 4 12B text encoder, VAEs and x2 upscaler from
        # comfyicu's ungated copy of Lightricks/LTX-2.5 (the original needs a Hugging Face login).
        @("Abiray/LTX-2.5-Distilled-GGUF", "LTX-2.5-Distilled-Q4_K_M.gguf", "unet"),
        @("comfyicu/LTX-2.5", "text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", "text_encoders"),
        @("comfyicu/LTX-2.5", "vae/ltx-2.5-video-vae-bf16.safetensors", "vae"),
        @("comfyicu/LTX-2.5", "vae/ltx-2.5-audio-vae-bf16.safetensors", "vae"),
        @("comfyicu/LTX-2.5", "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors", "latent_upscale_models")
    )
    foreach ($f in $v) { Download (HF $f[0] $f[1]) (Join-Path $comfyModels "$($f[2])\$(Split-Path $f[1] -Leaf)") }
}
if ($Packs -contains "music") {
    # ACE-Step 1.5 turbo for workflows\ace-step-15-song.api.json: the diffusion model, its Qwen 0.6B text encoder and
    # 1.7B language model (writes the audio codes), and its VAE. ComfyUI 0.37 or newer runs it natively. The base model
    # takes stems out of a song for Prestige's song editor (tools\comfy_nodes\workstation_music).
    $ace = "Comfy-Org/ace_step_1.5_ComfyUI_files"
    foreach ($f in @(@("diffusion_models", "acestep_v1.5_turbo.safetensors"), @("diffusion_models", "acestep_v1.5_base.safetensors"),
                     @("text_encoders", "qwen_0.6b_ace15.safetensors"),
                     @("text_encoders", "qwen_1.7b_ace15.safetensors"), @("vae", "ace_1.5_vae.safetensors"))) {
        Download (HF $ace "split_files/$($f[0])/$($f[1])") (Join-Path $comfyModels "$($f[0])\$($f[1])")
    }
}
if ($Packs -contains "music-xl") {
    # ACE-Step 1.5 XL turbo (4B), Prestige's High quality songs; it uses the music pack's text encoders and VAE.
    foreach ($f in @(@("diffusion_models", "acestep_v1.5_xl_turbo_bf16.safetensors"), @("text_encoders", "qwen_0.6b_ace15.safetensors"),
                     @("text_encoders", "qwen_1.7b_ace15.safetensors"), @("vae", "ace_1.5_vae.safetensors"))) {
        Download (HF "Comfy-Org/ace_step_1.5_ComfyUI_files" "split_files/$($f[0])/$($f[1])") (Join-Path $comfyModels "$($f[0])\$($f[1])")
    }
}
if (-not $Packs) { Skip "no model packs picked (add them later with: .\install.ps1 -Packs fast,images)" }

# ---------- 10. shortcuts and Prestige ----------
Step 10 "Shortcuts and the Prestige app"
if ($NoShortcuts) { Skip "shortcuts left as they are" } else {
    & (Join-Path $Root "install-shortcut.ps1") | Out-Null
    Ok "Custom AI shortcuts (Desktop and Start Menu)"
}
$prestigeInstalled = Test-Path "$env:ProgramFiles\RG Studios\Prestige\prestige.exe"
if ($prestigeInstalled) { Skip "Prestige already installed" }
elseif (-not $NoPrestige -and (AskYesNo "Install Prestige, the desktop app for the Workstation?" $true)) {
    $rel = Invoke-RestMethod "https://api.github.com/repos/Mr5elfDe5truct/prestige/releases/latest" -Headers @{ "User-Agent" = "rg-installer" }
    $asset = $rel.assets | Where-Object { $_.name -like "*_x64-setup.exe" } | Select-Object -First 1
    $exe = Join-Path $env:TEMP $asset.name
    Download $asset.browser_download_url $exe
    Say "    running the Prestige installer (Windows will ask for permission)…"
    Start-Process $exe -Wait
    Ok "Prestige $($rel.tag_name)"
}

# ---------- 11. smoke test ----------
if (-not $NoTest) {
    Step 11 "Starting everything once to check it works"
    $up = { param($port) [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
    & (Join-Path $Root "start-all.ps1") -NoBrowser | Out-Null
    $checks = [ordered]@{ "Ollama" = 11434; "llama.cpp" = 8081; "Open WebUI" = 8080; "ComfyUI" = 8188; "Kokoro voice" = 8880; "Tool server" = 8200 }
    if (Test-Path (Join-Path $Root "envs\voice\Scripts\python.exe")) { $checks["Voice server"] = 8890 }
    $deadline = (Get-Date).AddMinutes(4)
    do { Start-Sleep 3; $missing = @($checks.Keys | Where-Object { -not (& $up $checks[$_]) }) } while ($missing -and (Get-Date) -lt $deadline)
    foreach ($k in $checks.Keys) { if (& $up $checks[$k]) { Ok "$k (:$($checks[$k]))" } else { Warn "$k didn't start; see $Root\logs" } }
    . (Join-Path $Root "scripts\gpu-config.ps1")
    Say (Format-GpuPlan (Get-GpuPlan $Root))
    & (Join-Path $Root "stop-all.ps1") | Out-Null
    Ok "stopped again"
}

Write-Host ""
Write-Host "  Done. The Workstation is in $Root" -ForegroundColor Green
Write-Host "  Open Prestige (or the 'Custom AI' shortcut) to start it; closing the window stops it." -ForegroundColor Gray
if ($Root -ne (Join-Path $env:USERPROFILE "RG Studios\Workstation")) {
    Write-Host "  An up-to-date Prestige finds it on its own; on an older one, set Settings > Workstation folder to $Root." -ForegroundColor Yellow
}
Write-Host "  Add model packs any time: .\install.ps1 -Packs vision,video" -ForegroundColor Gray
Write-Host ""
