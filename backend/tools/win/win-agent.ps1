# win-agent.ps1 — Real Windows control bridge for the Voice Agent.
#
# Long-running JSON-line agent. Spawn once (persistent), then send one
# command per line; each command emits one JSON result line, then a
# blank line. All real work (UIA, screen capture, OCR, input synthesis,
# app launch/focus) happens here so the Node driver stays thin.
#
#   Commands:
#     launch <name>              Launch/focus an app by friendly name
#     focus <name>               Bring the app's window to the foreground
#     dump [maxDepth]            UIA tree of foreground window (debug)
#     capture                    Save full-screen PNG to $state.capturePath
#     ocr                        OCR the full screen -> JSON lines w/ bboxes + conf
#     click <x> <y>              Move + click at physical pixel coords
#     type <text>                Type text via SendKeys (XML-escaped)
#     press <key>                Send one key (escape/enter/tab/ctrl+a/...)
#     scroll <dir> [amount]      Mouse wheel scroll
#     state                      Echo current state paths
#     exit                       Stop this agent
#
# Everything is emitted as JSON on stdout; only the final line of each
# command result matters to the reader.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---------------------------------------------------------------- state
$state = @{
  captureDir  = Join-Path $env:TEMP 'voice-agent-win'
  capturePath = ''
  lastOcr     = @()
}

New-Item -ItemType Directory -Force -Path $state.captureDir | Out-Null

# ------------------------------------------------------------ Win32 API
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinAgentNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
'@

$MOUSEEVENTF_LEFTDOWN = 0x02
$MOUSEEVENTF_LEFTUP   = 0x04
$MOUSEEVENTF_WHEEL    = 0x0800

# ------------------------------------------------------------ helpers
function Get-ForegroundInfo {
  $h = [WinAgentNative]::GetForegroundWindow()
  $p = 0
  [void][WinAgentNative]::GetWindowThreadProcessId($h, [ref]$p)
  $t = New-Object System.Text.StringBuilder 512
  [void][WinAgentNative]::GetWindowText($h, $t, 512)
  $c = New-Object System.Text.StringBuilder 256
  [void][WinAgentNative]::GetClassName($h, $c, 256)
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  return @{
    hwnd = ('0x{0:X}' -f $h.ToInt64()); pid = $p
    title = $t.ToString(); class = $c.ToString()
    proc = if ($proc) { $proc.ProcessName } else { '' }
  }
}

function Get-WindowsByTitlePattern([string]$pattern) {
  $script:winMatches = New-Object System.Collections.ArrayList
  $script:winPattern = $pattern
  $cb = {
    param($hw, $lp)
    if ([WinAgentNative]::IsWindowVisible($hw)) {
      $p = 0
      [void][WinAgentNative]::GetWindowThreadProcessId($hw, [ref]$p)
      $t = New-Object System.Text.StringBuilder 512
      [void][WinAgentNative]::GetWindowText($hw, $t, 512)
      $title = $t.ToString()
      if ($title -and $title -match $script:winPattern) {
        [void]$script:winMatches.Add((New-Object psobject -Property @{ Hwnd = $hw.ToInt64(); Title = $title; Pid = $p }))
      }
    }
    return $true
  }
  [void][WinAgentNative]::EnumWindows($cb, [IntPtr]::Zero)
  # NoEnumerate keeps the collection intact (empty or single) so .Count works.
  Write-Output -NoEnumerate $script:winMatches
}

# SetForegroundWindow from a background process is flaky (foreground lock):
# it can report success while the window only flashes in the taskbar.
# Verify the foreground ACTUALLY changed, retrying briefly, so callers get
# the truth instead of an optimistic "ok".
function Set-ForegroundVerified([long]$hwndLong, [int]$attempts = 4) {
  $h = [IntPtr]$hwndLong
  for ($i = 0; $i -lt $attempts; $i++) {
    if ([WinAgentNative]::IsIconic($h)) { [void][WinAgentNative]::ShowWindow($h, 9) }
    [void][WinAgentNative]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 350
    if ([WinAgentNative]::GetForegroundWindow() -eq $h) { return $true }
  }
  return ([WinAgentNative]::GetForegroundWindow() -eq $h)
}

function Send-Json($obj) {
  $obj | ConvertTo-Json -Compress -Depth 8
}

function Emit($kind, [hashtable]$data, [bool]$ok = $true, [string]$error = '') {
  $o = @{ ok = $ok; kind = $kind }
  if ($data) { $o.data = $data }
  if ($error) { $o.error = $error }
  $json = Send-Json $o
  # Base64 frames are pure ASCII -> immune to console encoding mangling.
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $b64 = [Convert]::ToBase64String($bytes)
  Write-Output $b64.Length
  Write-Output $b64
}

# ------------------------------------------------------------ commands
function Invoke-Launch([string]$name) {
  $probe = Get-ForegroundInfo
  $lower = $name.ToLowerInvariant()

  # 1) Already-focused window whose title contains the name.
  if ($probe.title -match [regex]::Escape($name) -or $probe.title.ToLowerInvariant().Contains($lower)) {
    return @{ ok = $true; action = 'focus'; detail = 'already foreground'; fg = $probe }
  }

  # 2) Existing visible window title contains the name -> focus it (verified).
  $windows = Get-WindowsByTitlePattern ('(?i)' + [regex]::Escape($name))
  if ($windows.Count -gt 0) {
    $w = $windows | Select-Object -First 1
    if (Set-ForegroundVerified $w.Hwnd) {
      return @{ ok = $true; action = 'focus'; detail = 'focused existing window'; window = $w }
    }
    return @{ ok = $false; error = "window '$($w.Title)' found but could not be brought to the foreground" }
  }

  # 3) Map friendly name -> protocol/URL and launch.
  $target = $null
  switch -Regex ($lower) {
    'whatsapp' { $target = 'https://web.whatsapp.com/' }
    'opera'    { $target = 'opera' }
    'edge'     { $target = 'msedge' }
    'chrome'   { $target = 'chrome' }
    'notepad'  { $target = 'notepad.exe' }
    'calculator' { $target = 'calc.exe' }
    'vscode|code' { $target = 'code' }
    default    { $target = $name }
  }

  if ($target -like 'https://*') {
    Start-Process $target
    # Wait for a WhatsApp-ish window to appear, then focus it.
    $deadline = (Get-Date).AddSeconds(20)
    $found = $null
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 500
      $found = Get-WindowsByTitlePattern '(?i)whatsapp' | Select-Object -First 1
      if ($found) { break }
    }
    if ($found) {
      if (Set-ForegroundVerified $found.Hwnd) {
        return @{ ok = $true; action = 'launch'; detail = 'launched web whatsapp and focused'; window = $found }
      }
      return @{ ok = $false; error = 'WhatsApp window appeared but could not be brought to the foreground' }
    }
    return @{ ok = $false; error = "launched $target but no WhatsApp window appeared" }
  }

  # Executable / protocol launch.
  Start-Process $target -ErrorAction Stop
  Start-Sleep -Milliseconds 1500
  $probe2 = Get-ForegroundInfo
  return @{ ok = $true; action = 'launch'; detail = "launched $target"; fg = $probe2 }
}

function Invoke-Focus([string]$name) {
  $windows = Get-WindowsByTitlePattern ('(?i)' + [regex]::Escape($name))
  if ($windows.Count -eq 0) { return @{ ok = $false; error = "no window matching '$name'" } }
  $w = $windows | Select-Object -First 1
  if (-not (Set-ForegroundVerified $w.Hwnd)) {
    return @{ ok = $false; error = "window '$($w.Title)' found but could not be brought to the foreground" }
  }
  return @{ ok = $true; detail = 'focused'; window = $w }
}

function Invoke-Capture {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  $path = Join-Path $state.captureDir ("cap_{0}.png" -f (Get-Date -Format 'HHmmssfff'))
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $state.capturePath = $path
  return @{ ok = $true; path = $path; width = $b.Width; height = $b.Height }
}

function Invoke-Ocr {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  $null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.RandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
  $null = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]

  $cap = Invoke-Capture
  if (-not $cap.ok) { return $cap }

  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1

  function Await($op, $resultType) {
    $m = $asTask.MakeGenericMethod($resultType)
    $task = $m.Invoke($null, @($op))
    $task.Wait()
    return $task.Result
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($cap.path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'en-US'))
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) { return @{ ok = $false; error = 'no OCR engine available' } }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($line in $result.Lines) {
    $words = @()
    $minX = [int]::MaxValue; $minY = [int]::MaxValue
    $maxR = 0; $maxB = 0
    $lineConfSum = 0.0
    foreach ($w in $line.Words) {
      $wr = $w.BoundingRect
      $wx = [int]$wr.X; $wy = [int]$wr.Y; $ww = [int]$wr.Width; $wh = [int]$wr.Height
      
      $text = $w.Text
      $conf = 0.8
      $area = $ww * $wh
      if ($area -lt 100 -or $area -gt 10000) { $conf = 0.6 }
      elseif ($text.Length -eq 1) { $conf = 0.7 }
      elseif ($text -match '^[a-zA-Z]+$') { $conf = 0.9 }
      elseif ($text -match '^[a-zA-Z0-9]+$') { $conf = 0.8 }
      
      if ($conf -lt 0.5) { $conf = 0.5 }
      if ($conf -gt 0.95) { $conf = 0.95 }
      $lineConfSum += $conf

      $words += @{ text = $text; x = $wx; y = $wy; w = $ww; h = $wh; confidence = $conf }
      if ($wx -lt $minX) { $minX = $wx }
      if ($wy -lt $minY) { $minY = $wy }
      if (($wx + $ww) -gt $maxR) { $maxR = $wx + $ww }
      if (($wy + $wh) -gt $maxB) { $maxB = $wy + $wh }
    }
    $lText = if ($null -ne $line.Text) { $line.Text } else { ($line.Words | ForEach-Object { $_.Text }) -join ' ' }
    $lineConf = if ($words.Count -gt 0) { $lineConfSum / $words.Count } else { 0.5 }
    if ($words.Count -gt 0) {
      $lines += @{
        text = $lText
        x = $minX; y = $minY; w = ($maxR - $minX); h = ($maxB - $minY)
        words = $words
        confidence = $lineConf
      }
    }
  }
  $state.lastOcr = $lines
  return @{ ok = $true; lines = $lines; capturePath = $cap.path; width = $cap.width; height = $cap.height }
}

function Invoke-Click([int]$x, [int]$y) {
  [void][WinAgentNative]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 60
  [WinAgentNative]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [WinAgentNative]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  return @{ ok = $true; x = $x; y = $y }
}

function Invoke-DoubleClick([int]$x, [int]$y) {
  Invoke-Click $x $y | Out-Null
  Start-Sleep -Milliseconds 80
  Invoke-Click $x $y | Out-Null
  return @{ ok = $true; x = $x; y = $y; double = $true }
}

function Invoke-RightClick([int]$x, [int]$y) {
  [void][WinAgentNative]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 60
  [WinAgentNative]::mouse_event($MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [WinAgentNative]::mouse_event($MOUSEEVENTF_RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 100
  return @{ ok = $true; x = $x; y = $y; right = $true }
}

function Invoke-Type([string]$text) {
  $wshell = New-Object -ComObject WScript.Shell
  $escaped = $text -replace '([+^%~(){}[\]])', '{$1}'
  $wshell.SendKeys($escaped)
  return @{ ok = $true; text = $text }
}

function Invoke-Press([string]$key) {
  $wshell = New-Object -ComObject WScript.Shell
  $map = @{
    'enter'    = '{ENTER}'; 'return' = '{ENTER}'; 'escape' = '{ESC}'; 'esc' = '{ESC}'
    'tab'      = '{TAB}'; 'backspace' = '{BACKSPACE}'; 'delete' = '{DELETE}'; 'del' = '{DELETE}'
    'up'       = '{UP}'; 'down' = '{DOWN}'; 'left' = '{LEFT}'; 'right' = '{RIGHT}'
    'home'     = '{HOME}'; 'end' = '{END}'; 'space' = ' '
    'ctrl+a'   = '^a'; 'ctrl+c' = '^c'; 'ctrl+v' = '^v'; 'ctrl+f' = '^f'; 'ctrl+s' = '^s'
    'ctrl+w'   = '^w'; 'ctrl+t' = '^t'; 'ctrl+z' = '^z'; 'ctrl+y' = '^y'
    'ctrl+shift+t' = '^+t'
    'alt+f4'   = '%{F4}'; 'f4' = '{F4}'; 'f5' = '{F5}'; 'f11' = '{F11}'; 'f12' = '{F12}'
    'alt+tab'  = '%{TAB}'
  }
  $k = $key.ToLowerInvariant().Trim()
  if ($map.ContainsKey($k)) {
    $wshell.SendKeys($map[$k])
  } elseif ($k -match '^ctrl\+(.+)$') {
    $wshell.SendKeys('^' + $Matches[1])
  } elseif ($k -match '^alt\+(.+)$') {
    $wshell.SendKeys('%' + $Matches[1])
  } elseif ($k -match '^shift\+(.+)$') {
    $wshell.SendKeys('+' + $Matches[1])
  } else {
    $wshell.SendKeys('{' + $key.ToUpperInvariant() + '}')
  }
  return @{ ok = $true; key = $key }
}

function Invoke-Scroll([string]$dir, [int]$amount) {
  $clicks = if ($amount -gt 0) { $amount } else { 3 }
  $delta = if ($dir -eq 'up') { 120 } else { -120 }
  for ($i = 0; $i -lt $clicks; $i++) {
    [WinAgentNative]::mouse_event($MOUSEEVENTF_WHEEL, 0, 0, [uint32]$delta, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
  }
  return @{ ok = $true; direction = $dir; amount = $clicks }
}

# ------------------------------------------------------------- main loop
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'exit') { break }
  $parts = $line -split ' ', 2
  $cmd = $parts[0].ToLowerInvariant()
  $arg = if ($parts.Count -gt 1) { $parts[1] } else { '' }

  try {
    switch ($cmd) {
      'launch' { Emit 'launch' (Invoke-Launch $arg) }
      'focus'  { Emit 'focus' (Invoke-Focus $arg) }
      'fg'     { Emit 'fg' (Get-ForegroundInfo) }
      'dump'   { Emit 'dump' @{ note = 'dump unsupported in this agent build' } }
      'capture' { Emit 'capture' (Invoke-Capture) }
      'ocr'    { Emit 'ocr' (Invoke-Ocr) }
      'click'  {
        $xy = $arg -split '\s+'
        if ($xy.Count -lt 2) { Emit 'click' $null $false 'usage: click <x> <y>' }
        else { Emit 'click' (Invoke-Click ([int]$xy[0]) ([int]$xy[1])) }
      }
      'double_click' {
        $xy = $arg -split '\s+'
        if ($xy.Count -lt 2) { Emit 'double_click' $null $false 'usage: double_click <x> <y>' }
        else { Emit 'double_click' (Invoke-DoubleClick ([int]$xy[0]) ([int]$xy[1])) }
      }
      'right_click' {
        $xy = $arg -split '\s+'
        if ($xy.Count -lt 2) { Emit 'right_click' $null $false 'usage: right_click <x> <y>' }
        else { Emit 'right_click' (Invoke-RightClick ([int]$xy[0]) ([int]$xy[1])) }
      }
      'type'   { Emit 'type' (Invoke-Type $arg) }
      'press'  { Emit 'press' (Invoke-Press $arg) }
      'scroll' {
        $d = $arg -split '\s+'
        $dir = if ($d.Count -gt 0) { $d[0] } else { 'down' }
        $amt = if ($d.Count -gt 1) { [int]$d[1] } else { 3 }
        Emit 'scroll' (Invoke-Scroll $dir $amt)
      }
      'state'  { Emit 'state' @{ capturePath = $state.capturePath; captureDir = $state.captureDir; lastOcrCount = $state.lastOcr.Count } }
      default  { Emit 'unknown' $null $false "unknown command: $cmd" }
    }
  } catch {
    Emit 'error' $null $false $_.Exception.Message
  }
}
