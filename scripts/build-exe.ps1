<#
.SYNOPSIS
  Build the ScreenAI-Voice.exe launcher and a portable dist folder.

.DESCRIPTION
  Compiles scripts/launcher/ScreenAiVoice.cs with the in-box .NET Framework
  csc.exe (no runtime to install) and copies the existing application into
  dist/app so the launcher can boot it without depending on the current
  working directory.

  Layout produced:
    dist/
      ScreenAI-Voice.exe      (launcher / process manager)
      app/                    (the existing Node + WPF application)
      runtime/node.exe        (only with -BundleNode)
      README.txt

.EXAMPLE
  npm run build:exe
  powershell -ExecutionPolicy Bypass -File scripts/build-exe.ps1 -BundleNode
#>
param(
  [string]$OutputDir = "dist",
  [switch]$BundleNode,
  [switch]$IncludeEnv,
  [switch]$SkipAppCopy
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root $OutputDir
$exePath = Join-Path $outDir "ScreenAI-Voice.exe"
$source = Join-Path $PSScriptRoot "launcher\ScreenAiVoice.cs"

if (-not (Test-Path $source)) { throw "Launcher source not found: $source" }
if (-not (Test-Path (Join-Path $root "voice\start.js"))) { throw "voice\start.js not found - run from the project checkout." }
if (-not (Test-Path (Join-Path $root "node_modules"))) { throw "node_modules missing - run 'npm install' first." }

# --- 1. compile the launcher ------------------------------------------------
$cscCandidates = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw "csc.exe not found (.NET Framework 4.x). Windows 10/11 ships it." }

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Write-Host "[build] compiling launcher with $csc"
& $csc /nologo /target:winexe /platform:x64 /optimize+ /out:$exePath $source
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
if (-not (Test-Path $exePath)) { throw "ScreenAI-Voice.exe was not produced" }
Write-Host "[build] exe -> $exePath"

# --- 2. portable application folder ----------------------------------------
if (-not $SkipAppCopy) {
  $appDir = Join-Path $outDir "app"
  Write-Host "[build] copying application -> $appDir"
  # Exclude only the SPECIFIC top-level directories (full paths). A bare name
  # like "dist" would also strip node_modules\<pkg>\dist and break packages
  # such as assemblyai and onnxruntime-node.
  $roboArgs = @(
    $root, $appDir, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1",
    "/XD", (Join-Path $root ".git"), (Join-Path $root ".github"), $outDir,
    (Join-Path $root "logs"), (Join-Path $root "tests")
  )
  if (-not $IncludeEnv) { $roboArgs += @("/XF", (Join-Path $root "env\.env")) }
  robocopy @roboArgs | Out-Null
  $roboCode = $LASTEXITCODE
  $global:LASTEXITCODE = 0
  if ($roboCode -ge 8) { throw "robocopy failed with exit code $roboCode" }

  # Never ship a real .env (secrets) - enforce even if robocopy missed it.
  if (-not $IncludeEnv) {
    $envFile = Join-Path $appDir "env\.env"
    if (Test-Path $envFile) { Remove-Item $envFile -Force }
    if (Test-Path $envFile) { throw "refusing to ship env\.env in dist" }
  }

  $required = @(
    "voice\start.js", "ui\screenai-voice-ui.ps1", "backend\real_agent.js",
    "voice\windows_speech.js", "voice\windows_speech.ps1", "backend\perception\vision\vision_sensor.js",
    "node_modules\assemblyai\dist", "node_modules\onnxruntime-node\dist", "node_modules\pngjs"
  )
  foreach ($rel in $required) {
    if (-not (Test-Path (Join-Path $appDir $rel))) { throw "app copy incomplete: $rel missing" }
  }
  Write-Host "[build] app copied (robocopy $roboCode)"
  if (-not $IncludeEnv) {
    Write-Host "[build] env\.env NOT copied (secrets stay out of dist). Set ASSEMBLYAI_API_KEY as an env var, or create app\env\.env."
  }
}

# --- 3. optional bundled Node runtime --------------------------------------
$runtimeDir = Join-Path $outDir "runtime"
if ($BundleNode) {
  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
  $node = (Get-Command node -ErrorAction Stop).Source
  Copy-Item $node (Join-Path $runtimeDir "node.exe") -Force
  Write-Host "[build] bundled node runtime -> runtime\node.exe"
} else {
  Write-Host "[build] node NOT bundled - the launcher uses node.exe from PATH"
}

# --- 3b. bundle SoX audio recorder (portable) -------------------------------
$soxCandidates = @(
  (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\ChrisBagwell.SoX_Microsoft.Winget.Source_8wekyb3d8bbwe\sox-14.4.2"),
  "C:\Program Files (x86)\sox-14-4-2",
  "C:\Program Files\sox-14-4-2"
)
$soxSrc = $soxCandidates | Where-Object { Test-Path (Join-Path $_ "sox.exe") } | Select-Object -First 1
if ($soxSrc) {
  $soxDest = Join-Path $runtimeDir "sox"
  New-Item -ItemType Directory -Force -Path $soxDest | Out-Null
  Copy-Item (Join-Path $soxSrc "*") $soxDest -Recurse -Force
  if (-not $SkipAppCopy) {
    $appSoxDest = Join-Path $appDir "runtime\sox"
    New-Item -ItemType Directory -Force -Path $appSoxDest | Out-Null
    Copy-Item (Join-Path $soxSrc "*") $appSoxDest -Recurse -Force
  }
  Write-Host "[build] bundled SoX audio utility -> runtime\sox"
} else {
  Write-Host "[build] SoX source directory not found - SoX will rely on PATH"
}

# --- 4. portable README -----------------------------------------------------
$readme = @"
Screen-AI Voice - portable build
================================

Run:  double-click ScreenAI-Voice.exe
Hotkey: Press Ctrl+Space to activate the floating voice core.

Voice Modes:
  1. Offline / Local Mode (Default - zero configuration):
     Uses the built-in Windows Speech Recognition engine and SpeechSynthesizer.
     Works immediately out-of-the-box with NO API key, zero cost, and no internet.

  2. Cloud Streaming Mode (AssemblyAI):
     Add ASSEMBLYAI_API_KEY in app\env\.env or as a system environment variable.
     Provides ultra-accurate streaming transcription and conversational AI.

Layout:
  ScreenAI-Voice.exe    launcher (process manager; no application logic)
  app\                  the Screen-AI application (Node + WPF UI + Perception + Tools)
  runtime\node.exe      bundled Node.js runtime (with -BundleNode)
  runtime\sox\          bundled SoX audio capture utility
  logs\                 created on first run (screenai-voice.log)

Requirements:
  - Windows 10/11 x64
  - Node.js 18+ on PATH (unless bundled with -BundleNode)
  - Microphone connected and enabled

Flags:
  ScreenAI-Voice.exe --debug       run with a visible console window for logs
  ScreenAI-Voice.exe --simulate    development test: scripted transcript (real agent)

Uninstall:
  Stop the app (right-click the floating core -> Quit), then delete this folder.
  Nothing is written to the registry; the only local state is logs\ and app\env\.env.
"@
Set-Content -Path (Join-Path $outDir "README.txt") -Value $readme -Encoding UTF8

Write-Host "[build] done: $outDir"
