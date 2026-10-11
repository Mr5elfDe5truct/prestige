# Applies the tools added or removed in Prestige's tool store (data\mcpo-extra.json) to the running tool server.
#   .\update-tools.ps1
# Rewrites data\runtime\mcpo-config.json; mcpo (started with --hot-reload) reloads it by itself. An mcpo started by an
# older start-all.ps1, without --hot-reload, is restarted with it. When the tool server isn't running, the next
# start-all.ps1 picks the tools up.
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Runtime = Join-Path $Root "data\runtime"
$Logs = Join-Path $Root "logs"
. "$Root\scripts\tool-config.ps1"
Write-ToolConfig $Root $Runtime
Write-Host "Wrote $Runtime\mcpo-config.json"

$conn = Get-NetTCPConnection -LocalPort 8200 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) { Write-Host "The tool server isn't running; start-all.ps1 will use the new tools."; return }
$proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)"
if ($proc.CommandLine -match "--hot-reload") { Write-Host "The tool server reloads the tools by itself."; return }

Write-Host "Restarting the tool server with hot reload..."
Stop-Process -Id $conn.OwningProcess -Force
for ($i = 0; $i -lt 20 -and (Get-NetTCPConnection -LocalPort 8200 -State Listen -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 }
New-Item -ItemType Directory -Force $Logs | Out-Null
Start-Process -FilePath "$Root\envs\tools\Scripts\mcpo.exe" -ArgumentList (Get-McpoArgs $Runtime) -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput "$Logs\mcpo.log" -RedirectStandardError "$Logs\mcpo.err.log"
Write-Host "Started the tool server (port 8200)."
