# Builds, signs and publishes a Prestige release that installed copies pick up through auto-update.
#   .\scripts\release.ps1 -Notes "What changed"            build + publish the version in tauri.conf.json
#   .\scripts\release.ps1 -Notes "..." -Title "Prestige 0.8.0 · Updates itself"
#   .\scripts\release.ps1 -Notes "..." -NoPublish           build and write latest.json only
#   .\scripts\release.ps1 -NotesFile release-notes\0.50.0.md  notes from a file (quotes and line breaks are fine)
#
# Needs the updater signing key (made once with `npx tauri signer generate`), kept outside the repo:
#   %USERPROFILE%\RG Studios\keys\prestige-updater.key      private key (never commit or share it)
#   %USERPROFILE%\RG Studios\keys\prestige-updater.password its password
# Override the location with $env:PRESTIGE_KEYS.
param(
    [string]$Notes,
    [string]$NotesFile,
    [string]$Title,
    [switch]$NoPublish
)
$ErrorActionPreference = "Stop"
$Repo = "Mr5elfDe5truct/prestige"
$Root = Split-Path $PSScriptRoot -Parent
$Keys = if ($env:PRESTIGE_KEYS) { $env:PRESTIGE_KEYS } else { Join-Path $env:USERPROFILE "RG Studios\keys" }

if ($NotesFile) { $Notes = [IO.File]::ReadAllText((Resolve-Path $NotesFile)) }
if (-not $Notes) { throw "Give -Notes or -NotesFile" }
$conf = Get-Content (Join-Path $Root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$version = $conf.version
if (-not $Title) { $Title = "Prestige $version" }
Write-Host "Releasing Prestige $version"

# Sign the installer while building (Tauri reads these and writes a .sig next to the installer).
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content (Join-Path $Keys "prestige-updater.key") -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content (Join-Path $Keys "prestige-updater.password") -Raw).Trim()
Push-Location $Root
try {
    npm run tauri build
    if ($LASTEXITCODE) { throw "build failed" }
} finally {
    Pop-Location
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

$nsis = Join-Path $Root "src-tauri\target\release\bundle\nsis"
$exe = Join-Path $nsis "Prestige_${version}_x64-setup.exe"
$sig = "$exe.sig"
if (-not (Test-Path $sig)) { throw "No signature at $sig (is createUpdaterArtifacts on and the key set?)" }

# The update manifest Prestige reads from releases/latest/download/latest.json.
$manifest = [ordered]@{
    version   = $version
    notes     = $Notes
    pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = (Get-Content $sig -Raw).Trim()
            url       = "https://github.com/$Repo/releases/download/v$version/Prestige_${version}_x64-setup.exe"
        }
    }
}
$latest = Join-Path $nsis "latest.json"
# UTF-8 without a byte-order mark (Windows PowerShell adds one, which JSON parsers reject).
[IO.File]::WriteAllText($latest, ($manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
Write-Host "Wrote $latest"

# The Android app goes up with it (android\build.ps1 needs a JDK and the Android SDK; without them it's skipped).
$files = @($exe, $latest)
try {
    & (Join-Path $Root "android\build.ps1")
    $files += Join-Path $Root "android\build\Prestige-$version.apk"
} catch {
    Write-Warning "No Android app in this release: $_"
}

if ($NoPublish) { return }
# The notes go through a file: passed on the command line, quotes in them broke gh's arguments.
$notesTmp = Join-Path $env:TEMP "prestige-release-notes.md"
[IO.File]::WriteAllText($notesTmp, $Notes, (New-Object Text.UTF8Encoding $false))
gh release create "v$version" @files --repo $Repo --title $Title --notes-file $notesTmp --latest
if ($LASTEXITCODE) { throw "gh release failed" }
Write-Host "Published https://github.com/$Repo/releases/tag/v$version"
