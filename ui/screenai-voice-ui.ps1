# screenai-voice-ui.ps1 — Screen-AI floating voice overlay.
#
# A tiny, borderless, always-on-top WPF window whose centerpiece is a living
# voice core: a cluster of vertical bars driven by REAL microphone amplitude
# (sent from the Node bridge over stdin as JSON lines).
#
#   Node -> UI : {"type":"state","state":"listening","label":"Listening"}
#                {"type":"amplitude","value":0.42}
#                {"type":"transcript","text":"Open WhatsApp","final":false}
#   UI -> Node : {"type":"activate"} | {"type":"deactivate"} | {"type":"cancel"}
#                {"type":"retry"} | {"type":"ready"}
#
# Global hotkey: Ctrl+Space (polled via GetAsyncKeyState — no message hook).
# UI is presentation only: it never talks to AssemblyAI, OCR or Windows tools.

param([switch]$SelfTest)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

Add-Type -Namespace ScreenAi -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
'@

# ------------------------------------------------------------------ protocol
function Send-Message($obj) {
  try {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  } catch {
    # stdout closed; nothing we can do
  }
}

# -------------------------------------------------------------------- state
$BAR_COUNT = 11
$BAR_WIDTH = 8
$BAR_GAP = 8
$CANVAS_HEIGHT = 96

$script:State = "idle"
$script:Label = ""
$script:Transcript = ""
$script:TargetAmp = 0.0
$script:ShownAmp = 0.0
$script:Phase = 0.0
$script:StateClock = 0
$script:HotkeyDown = $false
$script:BarShapes = @()
$script:BarCurrent = New-Object 'double[]' $BAR_COUNT
$script:LastState = ""

$canvasWidth = $BAR_COUNT * $BAR_WIDTH + ($BAR_COUNT - 1) * $BAR_GAP

# ------------------------------------------------------------------ brushes
function New-GradientBrush([int]$a1, [int]$r1, [int]$g1, [int]$b1, [int]$a2, [int]$r2, [int]$g2, [int]$b2) {
  $brush = [System.Windows.Media.LinearGradientBrush]::new()
  $brush.StartPoint = [System.Windows.Point]::new(0.5, 0)
  $brush.EndPoint = [System.Windows.Point]::new(0.5, 1)
  $brush.GradientStops.Add([System.Windows.Media.GradientStop]::new([System.Windows.Media.Color]::FromArgb($a1, $r1, $g1, $b1), 0.0))
  $brush.GradientStops.Add([System.Windows.Media.GradientStop]::new([System.Windows.Media.Color]::FromArgb($a2, $r2, $g2, $b2), 1.0))
  return $brush
}

function Get-StateBrush {
  switch ($script:State) {
    "success" { return (New-GradientBrush 255 150 245 190 235 46 190 120) }
    "failure" { return (New-GradientBrush 255 255 160 140 235 210 70 60) }
    "processing" { return (New-GradientBrush 255 200 180 255 235 120 110 255) }
    "working" { return (New-GradientBrush 255 180 205 255 235 90 140 255) }
    "listening" { return (New-GradientBrush 255 190 245 255 235 60 170 240) }
    default { return (New-GradientBrush 200 130 190 220 150 60 110 160) }
  }
}

# ------------------------------------------------------------------- window
$window = [System.Windows.Window]::new()
$window.WindowStyle = [System.Windows.WindowStyle]::None
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.ResizeMode = [System.Windows.ResizeMode]::NoResize

$panel = [System.Windows.Controls.Border]::new()
$panel.CornerRadius = [System.Windows.CornerRadius]::new(24)
$panel.Background = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(216, 10, 14, 22))
$panel.BorderBrush = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(70, 120, 200, 255))
$panel.BorderThickness = [System.Windows.Thickness]::new(1)
$glow = [System.Windows.Media.Effects.DropShadowEffect]::new()
$glow.Color = [System.Windows.Media.Color]::FromArgb(255, 40, 180, 255)
$glow.BlurRadius = 28
$glow.ShadowDepth = 0
$glow.Opacity = 0.45
$panel.Effect = $glow
$window.Content = $panel

$inner = [System.Windows.Controls.StackPanel]::new()
$inner.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
$inner.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Center
$panel.Child = $inner

$barsCanvas = [System.Windows.Controls.Canvas]::new()
$barsCanvas.Width = $canvasWidth
$barsCanvas.Height = $CANVAS_HEIGHT
$barsCanvas.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Center
$inner.Children.Add($barsCanvas) | Out-Null

$statusText = [System.Windows.Controls.TextBlock]::new()
$statusText.FontFamily = [System.Windows.Media.FontFamily]::new("Segoe UI Semibold, Segoe UI")
$statusText.FontSize = 12
$statusText.Foreground = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(220, 190, 220, 255))
$statusText.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Center
$statusText.Margin = [System.Windows.Thickness]::new(0, 12, 0, 0)
$inner.Children.Add($statusText) | Out-Null

$transcriptText = [System.Windows.Controls.TextBlock]::new()
$transcriptText.FontFamily = [System.Windows.Media.FontFamily]::new("Segoe UI")
$transcriptText.FontSize = 12
$transcriptText.TextWrapping = [System.Windows.TextWrapping]::Wrap
$transcriptText.TextAlignment = [System.Windows.TextAlignment]::Center
$transcriptText.MaxWidth = 268
$transcriptText.Foreground = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(190, 205, 225, 255))
$transcriptText.Margin = [System.Windows.Thickness]::new(0, 6, 0, 0)
$inner.Children.Add($transcriptText) | Out-Null

$brush = Get-StateBrush
for ($i = 0; $i -lt $BAR_COUNT; $i++) {
  $rect = [System.Windows.Shapes.Rectangle]::new()
  $rect.Width = $BAR_WIDTH
  $rect.RadiusX = 4
  $rect.RadiusY = 4
  $rect.Fill = $brush
  $rect.Height = 6
  [System.Windows.Controls.Canvas]::SetLeft($rect, $i * ($BAR_WIDTH + $BAR_GAP))
  [System.Windows.Controls.Canvas]::SetTop($rect, ($CANVAS_HEIGHT - 6) / 2)
  $barsCanvas.Children.Add($rect) | Out-Null
  $script:BarShapes += $rect
}

function Set-WindowMode([string]$state) {
  $work = [System.Windows.SystemParameters]::WorkArea
  if ($state -eq "idle" -or $state -eq "") {
    $window.Width = 200
    $window.Height = 118
  } elseif ($state -eq "success" -or $state -eq "failure") {
    $window.Width = 300
    $window.Height = 178
  } else {
    $window.Width = 300
    $window.Height = 198
  }
  $window.Left = [Math]::Max(0, ($work.Width - $window.Width) / 2)
  $window.Top = [Math]::Max(0, $work.Height - $window.Height - 92)

  $showText = $state -ne "idle"
  $statusText.Visibility = if ($showText) { [System.Windows.Visibility]::Visible } else { [System.Windows.Visibility]::Collapsed }
  $transcriptText.Visibility = if ($showText -and $script:Transcript) { [System.Windows.Visibility]::Visible } else { [System.Windows.Visibility]::Collapsed }
}

function Update-Visuals {
  if ($script:State -ne $script:LastState) {
    $script:LastState = $script:State
    $script:StateClock = 0
    $brush = Get-StateBrush
    foreach ($rect in $script:BarShapes) { $rect.Fill = $brush }
    Set-WindowMode $script:State
  }
  $statusText.Text = $script:Label
  $transcriptText.Text = $script:Transcript
  $showTranscript = $script:State -ne "idle" -and $script:Transcript.Length -gt 0
  $transcriptText.Visibility = if ($showTranscript) { [System.Windows.Visibility]::Visible } else { [System.Windows.Visibility]::Collapsed }
}

# --------------------------------------------------------------- animation
function Get-BarTarget([int]$index) {
  $mid = ($BAR_COUNT - 1) / 2.0
  $edge = 0.34 + 0.66 * (1.0 - [Math]::Abs($index - $mid) / $mid)   # center-weighted envelope
  $i = [double]$index
  $phase = $script:Phase
  $amp = $script:ShownAmp

  switch ($script:State) {
    "listening" {
      # Audio-reactive: the louder the voice, the taller and livelier the core.
      $wobble = 0.72 + 0.28 * [Math]::Sin($phase * 1.9 + $i * 0.55)
      return 6 + $amp * 82 * $edge * $wobble
    }
    "processing" {
      # Calm intelligent wave flowing through the core.
      return 10 + 34 * $edge * (0.5 + 0.5 * [Math]::Sin($phase * 1.1 + $i * 0.7))
    }
    "working" {
      # Faster travelling rhythm: "Screen-AI is working".
      return 12 + 52 * $edge * (0.5 + 0.5 * [Math]::Sin($phase * 2.4 + $i * 0.9))
    }
    "success" {
      $decay = [Math]::Exp(-$script:StateClock / 26.0)
      return 8 + 86 * $edge * $decay * (0.7 + 0.3 * [Math]::Cos($i * 0.9))
    }
    "failure" {
      $jitter = 0.35 + 0.65 * [Math]::Abs([Math]::Sin($phase * 3.1 + $i * 1.3))
      return 8 + 40 * $edge * $jitter
    }
    default {
      # idle: tiny calm breathing
      return 5 + 5 * $edge * (0.5 + 0.5 * [Math]::Sin($phase * 0.55 + $i * 0.8))
    }
  }
}

function Update-Frame {
  $script:Phase += 0.075
  $script:StateClock++
  $script:ShownAmp += ($script:TargetAmp - $script:ShownAmp) * 0.30

  for ($i = 0; $i -lt $BAR_COUNT; $i++) {
    $target = Get-BarTarget $i
    $script:BarCurrent[$i] += ($target - $script:BarCurrent[$i]) * 0.32
    $h = [Math]::Max(4, $script:BarCurrent[$i])
    $rect = $script:BarShapes[$i]
    $rect.Height = $h
    [System.Windows.Controls.Canvas]::SetTop($rect, ($CANVAS_HEIGHT - $h) / 2)
  }
}

# ------------------------------------------------------------ input handling
$window.Add_MouseLeftButtonDown({
  if ($script:State -eq "idle") { Send-Message @{ type = "activate" } } else { Send-Message @{ type = "deactivate" } }
})

$window.Add_KeyDown({
  param($sender, $e)
  if ($e.Key -eq [System.Windows.Input.Key]::Escape) { Send-Message @{ type = "cancel" } }
})

# Minimal quit affordance: right-click the core -> Quit (the overlay has no
# window chrome, so this is the only clean way for the user to stop the app).
$menu = [System.Windows.Controls.ContextMenu]::new()
$menuItem = [System.Windows.Controls.MenuItem]::new()
$menuItem.Header = "Quit Screen-AI"
$menuItem.Add_Click({ Send-Message @{ type = "quit" } })
$menu.Items.Add($menuItem) | Out-Null
$window.ContextMenu = $menu

# --------------------------------------------------------------- stdin reader
# Shared with the UI timer; only started in normal (non-self-test) operation,
# because a blocking stdin read would otherwise keep a short test run alive.
$sync = [hashtable]::Synchronized(@{})
$sync.Queue = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
$sync.Running = $true
$reader = $null
if (-not $SelfTest) {
  $reader = [PowerShell]::Create()
  $null = $reader.AddScript({
      param($s)
      while ($s.Running) {
        $line = $null
        try { $line = [Console]::In.ReadLine() } catch { break }
        if ($null -eq $line) { $s.Running = $false; break }
        if ($line.Trim().Length -gt 0) { $s.Queue.Enqueue($line) }
      }
    }).AddArgument($sync)
  $null = $reader.BeginInvoke()
}

function Handle-Line([string]$line) {
  try { $msg = $line | ConvertFrom-Json } catch { return }
  switch ($msg.type) {
    "state" {
      $script:State = [string]$msg.state
      if ($null -ne $msg.PSObject.Properties["label"] -and $null -ne $msg.label) { $script:Label = [string]$msg.label }
      Update-Visuals
    }
    "amplitude" { $script:TargetAmp = [Math]::Min(1.0, [Math]::Max(0.0, [double]$msg.value)) }
    "transcript" {
      $script:Transcript = [string]$msg.text
      if ($msg.final) { $script:StateClock = 0 }
      Update-Visuals
    }
    default { }
  }
}

# ----------------------------------------------------------------- main loop
$timer = [System.Windows.Threading.DispatcherTimer]::new()
$timer.Interval = [TimeSpan]::FromMilliseconds(16)

$timer.Add_Tick({
    $line = $null
    while ($sync.Queue.TryDequeue([ref]$line)) {
      Handle-Line $line
      $line = $null
    }

    # Global hotkey Ctrl+Space
    $ctrl = ([ScreenAi.Native]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0
    $space = ([ScreenAi.Native]::GetAsyncKeyState(0x20) -band 0x8000) -ne 0
    $combo = $ctrl -and $space
    if ($combo -and -not $script:HotkeyDown) {
      if ($script:State -eq "idle") { Send-Message @{ type = "activate" } } else { Send-Message @{ type = "deactivate" } }
    }
    $script:HotkeyDown = $combo

    Update-Frame
  })

Set-WindowMode "idle"
Update-Visuals
$window.Show()
$timer.Start()

if ($SelfTest) {
  # Drive a few frames with synthetic amplitude, then shut the dispatcher down.
  $script:TargetAmp = 0.8
  $shutdown = [System.Windows.Threading.DispatcherTimer]::new()
  $shutdown.Interval = [TimeSpan]::FromMilliseconds(900)
  $shutdown.Add_Tick({ $shutdown.Stop(); $window.Dispatcher.InvokeShutdown() })
  $shutdown.Start()
} else {
  Send-Message @{ type = "ready" }
}

[System.Windows.Threading.Dispatcher]::Run()

$sync.Running = $false
if ($null -ne $reader) {
  try { $reader.Stop() } catch { }
}
exit 0
