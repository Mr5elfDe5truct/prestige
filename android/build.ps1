# Builds Prestige for Android (a signed APK to install on the phone) without Gradle: javac, d8, aapt2, zipalign and
# apksigner from the Android SDK. Prestige by R.G. Studios · developed by Ryan B. Gyles.
#
#   powershell -ExecutionPolicy Bypass -File android\build.ps1
#
# Needs a JDK (17 or newer) and the Android SDK with platforms;android-35 and build-tools;35.0.0. The SDK is found at
# ANDROID_HOME, ANDROID_SDK_ROOT, %LOCALAPPDATA%\Android\Sdk or %USERPROFILE%\Android\Sdk (an SDK installed from inside a
# packaged app such as Claude lands in that app's private copy of AppData, which other programs can't see, so keep it in
# the last one). The signing key is made on the first build in %USERPROFILE%\.prestige (keep a copy: updates to the app
# must be signed with the same key).
param(
    [string]$Sdk = $(
        $found = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, "$env:LOCALAPPDATA\Android\Sdk", "$env:USERPROFILE\Android\Sdk") |
            Where-Object { $_ -and (Test-Path "$_\platforms\android-35\android.jar") } | Select-Object -First 1
        if ($found) { $found } else { "$env:LOCALAPPDATA\Android\Sdk" }
    ),
    [string]$Jdk = $env:JAVA_HOME,
    [string]$KeyDir = "$env:USERPROFILE\.prestige"
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$root = Split-Path $here
$version = (Get-Content "$root\package.json" -Raw | ConvertFrom-Json).version
$parts = $version.Split(".")
$code = [int]$parts[0] * 10000 + [int]$parts[1] * 100 + [int]$parts[2]

if (-not $Jdk) {
    $Jdk = Get-ChildItem "$env:LOCALAPPDATA\Programs\Java" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Jdk -or -not (Test-Path "$Jdk\bin\javac.exe")) { throw "No JDK found. Set JAVA_HOME or pass -Jdk." }
$bt = Get-ChildItem "$Sdk\build-tools" -Directory -ErrorAction SilentlyContinue | Sort-Object { [version]($_.Name -replace '-.*', '') } -Descending | Select-Object -First 1 -ExpandProperty FullName
$jar = "$Sdk\platforms\android-35\android.jar"
if (-not $bt -or -not (Test-Path $jar)) {
    throw "The Android SDK isn't complete at $Sdk (needs platforms;android-35 and build-tools). Set ANDROID_HOME, pass -Sdk, or put it in $env:USERPROFILE\Android\Sdk."
}
$env:JAVA_HOME = $Jdk
$env:PATH = "$Jdk\bin;$env:PATH"

$out = "$here\build"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force "$out\classes", "$out\dex" | Out-Null

function Run($exe, [string[]]$a) {
    & $exe @a
    if ($LASTEXITCODE -ne 0) { throw "$(Split-Path $exe -Leaf) failed ($LASTEXITCODE)" }
}

Write-Host "Prestige $version for Android (version code $code)"
# Resources and the manifest.
Run "$bt\aapt2.exe" @("compile", "--dir", "$here\res", "-o", "$out\res.zip")
Run "$bt\aapt2.exe" @("link", "-o", "$out\unsigned.apk", "-I", $jar, "--manifest", "$here\AndroidManifest.xml", "-A", "$here\assets",
    "--min-sdk-version", "29", "--target-sdk-version", "34", "--version-code", "$code", "--version-name", $version, "$out\res.zip")
# Code.
$src = Get-ChildItem "$here\src" -Recurse -Filter *.java | ForEach-Object FullName
Run "$Jdk\bin\javac.exe" (@("-source", "11", "-target", "11", "-Xlint:-options", "-encoding", "UTF-8", "-classpath", $jar, "-d", "$out\classes") + $src)
$classes = Get-ChildItem "$out\classes" -Recurse -Filter *.class | ForEach-Object FullName
Run "$bt\d8.bat" (@("--release", "--min-api", "29", "--lib", $jar, "--output", "$out\dex") + $classes)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$out\unsigned.apk", "Update")
[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$out\dex\classes.dex", "classes.dex") | Out-Null
$zip.Dispose()
Run "$bt\zipalign.exe" @("-p", "-f", "4", "$out\unsigned.apk", "$out\aligned.apk")

# The signing key: made once, then reused so the phone accepts updates.
$ks = "$KeyDir\prestige-android.jks"
$passFile = "$KeyDir\prestige-android.pass"
if (-not (Test-Path $ks)) {
    New-Item -ItemType Directory -Force $KeyDir | Out-Null
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $pw = [Convert]::ToBase64String($bytes) -replace '[+/=]', 'x'
    Set-Content -Path $passFile -Value $pw -NoNewline -Encoding ascii
    Run "$Jdk\bin\keytool.exe" @("-genkeypair", "-keystore", $ks, "-alias", "prestige", "-keyalg", "RSA", "-keysize", "4096", "-validity", "36500",
        "-dname", "CN=Ryan B. Gyles, O=R.G. Studios", "-storepass", $pw, "-keypass", $pw)
    Write-Host "Made a signing key: $ks (password in $passFile). Back both up."
}
$apk = "$out\Prestige-$version.apk"
Run "$bt\apksigner.bat" @("sign", "--ks", $ks, "--ks-key-alias", "prestige", "--ks-pass", "file:$passFile", "--out", $apk, "$out\aligned.apk")
Run "$bt\apksigner.bat" @("verify", $apk)
Write-Host "Built $apk"
