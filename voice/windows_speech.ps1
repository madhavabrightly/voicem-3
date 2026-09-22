# windows_speech.ps1 — Windows local speech recognition & synthesis bridge.
#
# Provides 100% offline, zero-configuration voice control using the built-in
# Windows Speech Recognition (SAPI / System.Speech) engine and SpeechSynthesizer.
#
# Protocol (JSON lines on stdout/stdin):
#   Engine -> Node:
#     {"type":"ready","voices":["Microsoft David","Microsoft Zira"]}
#     {"type":"audio","level":0.35}
#     {"type":"partial","text":"open whats"}
#     {"type":"transcript","text":"open whatsapp and search for dad","final":true,"confidence":0.92}
#     {"type":"speak_done","text":"Done."}
#     {"type":"error","message":"..."}
#
#   Node -> Engine:
#     start
#     stop
#     speak <text>
#     exit

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Speech

$re = $null
$synth = $null

try {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
} catch {
  # Synth optional
}

function Emit-Json($obj) {
  try {
    $line = $obj | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
  } catch {
  }
}

try {
  $re = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $dictation = New-Object System.Speech.Recognition.DictationGrammar
  $dictation.Name = "Dictation"
  $re.LoadGrammar($dictation)
  $re.SetInputToDefaultAudioDevice()
} catch {
  Emit-Json @{ type = "error"; message = ("Failed to initialize Windows speech recognition: " + $_.Exception.Message) }
  exit 1
}

# Hook Speech Recognition Events
Register-ObjectEvent -InputObject $re -EventName "SpeechRecognized" -Action {
  $res = $Event.SourceEventArgs.Result
  if ($res -and -not [string]::IsNullOrWhiteSpace($res.Text)) {
    Emit-Json @{
      type = "transcript"
      text = $res.Text
      final = $true
      confidence = [double]$res.Confidence
    }
  }
} | Out-Null

Register-ObjectEvent -InputObject $re -EventName "SpeechHypothesized" -Action {
  $res = $Event.SourceEventArgs.Result
  if ($res -and -not [string]::IsNullOrWhiteSpace($res.Text)) {
    Emit-Json @{
      type = "partial"
      text = $res.Text
    }
  }
} | Out-Null

Register-ObjectEvent -InputObject $re -EventName "AudioLevelUpdated" -Action {
  $lvl = [double]($Event.SourceEventArgs.AudioLevel) / 100.0
  Emit-Json @{
    type = "audio"
    level = $lvl
  }
} | Out-Null

if ($synth) {
  Register-ObjectEvent -InputObject $synth -EventName "SpeakCompleted" -Action {
    Emit-Json @{ type = "speak_done" }
  } | Out-Null
}

$voiceNames = @()
if ($synth) {
  foreach ($v in $synth.GetInstalledVoices()) {
    if ($v.Enabled) { $voiceNames += $v.VoiceInfo.Name }
  }
}

Emit-Json @{ type = "ready"; voices = $voiceNames }

$isRecognizing = $false

# Main command loop
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq "exit") { break }

  $parts = $line.Trim() -split "\s+", 2
  $cmd = $parts[0].ToLowerInvariant()
  $arg = if ($parts.Length -gt 1) { $parts[1] } else { "" }

  try {
    switch ($cmd) {
      "start" {
        if (-not $isRecognizing) {
          $re.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
          $isRecognizing = $true
          Emit-Json @{ type = "state"; state = "listening" }
        }
      }
      "stop" {
        if ($isRecognizing) {
          $re.RecognizeAsyncCancel()
          $isRecognizing = $false
          Emit-Json @{ type = "state"; state = "idle" }
        }
      }
      "speak" {
        if ($synth -and -not [string]::IsNullOrWhiteSpace($arg)) {
          $synth.SpeakAsync($arg) | Out-Null
        }
      }
      default {
        # ignore unknown
      }
    }
  } catch {
    Emit-Json @{ type = "error"; message = $_.Exception.Message }
  }
}

if ($isRecognizing) {
  try { $re.RecognizeAsyncCancel() } catch {}
}
if ($re) {
  try { $re.Dispose() } catch {}
}
if ($synth) {
  try { $synth.Dispose() } catch {}
}
