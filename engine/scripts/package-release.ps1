# Builds the Workstation installer download (dist\Workstation-Setup-<version>.zip) and, with -Publish, tags the
# release and uploads it to GitHub. The zip's install.ps1 clones this tag, so a release always installs the
# files it was tested with.
#
#   .\scripts\package-release.ps1 -Version 1.0.0                          build the zip only
#   .\scripts\package-release.ps1 -Version 1.0.0 -Publish -Notes "..."    tag, push and publish the release
param(
    [Parameter(Mandatory)][string]$Version,
    [switch]$Publish,
    [string]$Notes = ""
)
$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot
$Tag = "v$Version"
$Repo = "Mr5elfDe5truct/custom-ai-workstation"

$dist = Join-Path $Root "dist"
$stage = Join-Path $dist "Workstation-Setup"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null

# install.ps1 with the default branch pinned to this release's tag (keeps the UTF-8 BOM PowerShell 5.1 needs).
$src = [IO.File]::ReadAllText((Join-Path $Root "install.ps1"))
$pinned = $src.Replace('[string]$Branch = "main"', "[string]`$Branch = `"$Tag`"")
if ($pinned -eq $src) { throw "Couldn't pin the branch in install.ps1" }
[IO.File]::WriteAllText((Join-Path $stage "install.ps1"), $pinned, (New-Object Text.UTF8Encoding $true))
Copy-Item (Join-Path $Root "setup.cmd") $stage

$readme = @"
Custom AI Workstation $Version, by R.G. Studios

Double-click setup.cmd to install. It asks where to install (default: your user folder\RG Studios\Workstation)
and which model packs to download, then sets everything up and checks that it starts.

Needs: Windows 10/11 64-bit, an NVIDIA GPU with a current driver, about 40 GB free for the suggested packs.
More: https://github.com/$Repo
"@
[IO.File]::WriteAllText((Join-Path $stage "READ ME.txt"), $readme.Replace("`n", "`r`n"))

$zip = Join-Path $dist "Workstation-Setup-$Version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$stage\*" -DestinationPath $zip
Remove-Item $stage -Recurse -Force
Write-Host "Built $zip"

if ($Publish) {
    Push-Location $Root
    try {
        if (git status --porcelain --untracked-files=no -- install.ps1 setup.cmd start-all.ps1) { throw "Commit the installer changes first." }
        git tag -a $Tag -m "Custom AI Workstation $Version"
        git push origin $Tag
        if (-not $Notes) { $Notes = "Custom AI Workstation $Version. Download Workstation-Setup-$Version.zip, unzip it and double-click setup.cmd." }
        gh release create $Tag $zip --repo $Repo --title "Custom AI Workstation $Version" --notes $Notes
        if ($LASTEXITCODE) { throw "gh release create failed" }
    } finally { Pop-Location }
}
