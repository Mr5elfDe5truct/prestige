# Computer-use mode: the AI sees your screen and controls mouse + keyboard through UI-TARS Desktop.
# The UI-TARS model is served by the same llama.cpp router as Qwen (start-all.ps1 must be running);
# it loads on the first request and swaps Qwen out of the GPU.
# Prestige has computer use built in ("/do" and a task, with each step approved in a panel); this is the alternative.
$Root = $PSScriptRoot
if (-not (Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue)) {
    & "$Root\start-all.ps1"
}
Start-Process "$Root\apps\ui-tars-desktop\UI-TARS.exe"
Write-Host @"
UI-TARS Desktop is open. First time only, open its Settings and set:
  VLM Provider:  Hugging Face for UI-TARS-1.5
  VLM Base URL:  http://127.0.0.1:8081/v1
  VLM API Key:   none
  VLM Model:     ui-tars-1.5-7b
Then choose 'Local Computer' and type a task. Press the stop button (or close the app) to stop it.
"@
