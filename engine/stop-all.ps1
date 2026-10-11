# Stops everything start-all.ps1 launched and closes the Open WebUI app window. Comfy Desktop is left alone.
param([switch]$KeepOllama)

$Root = $PSScriptRoot
# Close the Open WebUI app window first. It's a Chrome/Edge process (not under $Root), so find it by its profile folder.
$appProcs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
    Where-Object { $_.CommandLine -like "*$Root\data\app-profile*" }
if ($appProcs) {
    Write-Host "  closing the Open WebUI window"
    $appProcs | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
        Where-Object MainWindowHandle -ne 0 | ForEach-Object { $_.CloseMainWindow() | Out-Null }
    Start-Sleep 2
    $appProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($Root, 'OrdinalIgnoreCase') } | ForEach-Object {
    Write-Host "  stopping $($_.Name) ($($_.Id))"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
# Headless ComfyUI runs from Comfy Desktop's folder, so find it by its port (8188, and 8189 for the quick one) instead.
Get-NetTCPConnection -LocalPort 8188, 8189 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  stopping ComfyUI ($($_.OwningProcess))"
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
}
if (-not $KeepOllama) {
    Get-Process ollama -ErrorAction SilentlyContinue | Stop-Process -Force
    # Ollama's model runner is a separate llama-server.exe that outlives "ollama serve" and keeps its VRAM.
    Get-Process llama-server -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -like "$env:LOCALAPPDATA\Programs\Ollama\*" } | Stop-Process -Force
}
Write-Host "Stopped."
