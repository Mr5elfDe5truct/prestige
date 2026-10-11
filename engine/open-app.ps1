# Opens Open WebUI as its own app window (no tabs or address bar), starting the workstation first if needed.
# Closing the window shuts the workstation down (runs stop-all.ps1).
#   .\open-app.ps1               start services if they're down, then open the window
#   .\open-app.ps1 -NoStart      just open the window (start-all.ps1 uses this)
#   .\open-app.ps1 -KeepRunning  leave the services running when the window closes
param([switch]$NoStart, [switch]$KeepRunning, [switch]$Watch)

$Root = $PSScriptRoot
$Url = "http://localhost:8080"
# Separate browser profile so the app gets its own taskbar entry and doesn't mix with normal browsing.
$AppProfile = Join-Path $Root "data\app-profile"

function Test-Port($port) {
    [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# The app window's main browser process: the one using our profile that isn't a helper (--type=renderer, gpu, crashpad...).
function Get-AppWindow {
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
        Where-Object { $_.CommandLine -like "*$AppProfile*" -and $_.CommandLine -notlike "*--type=*" }
}

if ($Watch) {
    # Runs hidden in the background: once the window is gone, stop everything. One watcher at a time.
    $mutex = New-Object System.Threading.Mutex($false, "Local\CustomAI-AppWatcher")
    if (-not $mutex.WaitOne(0)) { return }
    for ($i = 0; $i -lt 30 -and -not (Get-AppWindow); $i++) { Start-Sleep 1 }   # give the window time to appear
    while (Get-AppWindow) { Start-Sleep 3 }
    & "$Root\stop-all.ps1"
    return
}

if (-not $NoStart -and -not (Test-Port 8080)) {
    & "$Root\start-all.ps1" -NoBrowser
}

$browser = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($browser) {
    New-Item -ItemType Directory -Force $AppProfile | Out-Null
    Start-Process -FilePath $browser -ArgumentList "--app=$Url", "--user-data-dir=`"$AppProfile`"", "--no-first-run", "--no-default-browser-check", "--window-size=1280,900"
    if (-not $KeepRunning) {
        Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-Watch"
    }
} else {
    Start-Process $Url   # no Chrome or Edge found: fall back to the default browser
}
