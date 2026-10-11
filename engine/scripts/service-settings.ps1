# The services' own settings: data\service-settings.json, which Prestige's Workstation settings screen writes (it stays
# on this PC). Dot-sourced by start-all.ps1. Every key is optional; a missing or bad file means the defaults below,
# which are how the Workstation ran before the file existed. See docs\SETTINGS.md.

$ServiceDefaults = [ordered]@{
    ollamaKeepAlive      = "5m"     # how long an idle Ollama model stays loaded ("5m", "30m", "-1" forever, "0" unload at once)
    ollamaFlashAttention = "on"     # on, off
    ollamaKvCache        = "q8_0"   # f16, q8_0, q4_0
    llamaIdleSeconds     = 180      # llama.cpp unloads its model after this long idle (0: never)
    llamaModelsMax       = 1        # llama.cpp models loaded at once
    comfyui              = "on"     # on, off: the headless ComfyUI (images, video, songs, 3D)
    openWebUI            = "on"     # on, off: Open WebUI (Prestige's shared memory uses it)
    theme                = "dragon" # Open WebUI's default theme: dragon, neon, glass, hud, off
}

function Read-ServiceSettings($Root) {
    $s = [ordered]@{}
    foreach ($k in $ServiceDefaults.Keys) { $s[$k] = $ServiceDefaults[$k] }
    $file = Join-Path $Root "data\service-settings.json"
    if (-not (Test-Path $file)) { return $s }
    try { $j = Get-Content -Raw $file | ConvertFrom-Json }
    catch { Write-Warning "data\service-settings.json isn't valid JSON, so it's ignored: $($_.Exception.Message)"; return $s }
    foreach ($p in $j.PSObject.Properties) {
        if (-not $s.Contains($p.Name)) { Write-Warning "unknown setting '$($p.Name)' in data\service-settings.json"; continue }
        if ($null -eq $p.Value -or "$($p.Value)" -eq "") { continue }
        $v = "$($p.Value)".Trim()
        $ok = switch ($p.Name) {
            "ollamaKeepAlive" { $v -match '^-?\d+(\.\d+)?[smh]?$' }
            "ollamaKvCache" { $v -in "f16", "q8_0", "q4_0" }
            "llamaIdleSeconds" { $v -match '^\d+$' }
            "llamaModelsMax" { $v -match '^[1-9]$' }
            "theme" { $v -in "dragon", "neon", "glass", "hud", "off" }
            default { $v -in "on", "off", "true", "false" }
        }
        if (-not $ok) { Write-Warning "data\service-settings.json: '$v' isn't a valid $($p.Name), using $($s[$p.Name])"; continue }
        $s[$p.Name] = switch ($v) { "true" { "on" } "false" { "off" } default { $v } }
    }
    $s
}
