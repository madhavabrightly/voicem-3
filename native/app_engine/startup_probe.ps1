# startup_probe.ps1 — P5 Application Startup & Readiness Engine
# Tickets 451–496: startup phase detection, UIA availability,
# dialog detection, responsiveness polling, foreground transition.
#
# Protocol: persistent JSON-lines agent (same Base64-framed protocol as app_engine.ps1)
#
# Commands:
#   detect_startup_phase <hwnd_hex>   → startup phase: loading|ready|dialog|crash|unknown
#   detect_uia_ready <hwnd_hex>       → is UIA automation tree available?
#   poll_responsive <hwnd_hex> [ms]   → poll for responsiveness up to timeout
#   detect_dialogs <hwnd_hex>         → enumerate modal/dialog windows
#   classify_dialog <hwnd_hex>        → classify dialog intent
#   verify_foreground <hwnd_hex>      → is hwnd the current foreground?
#   restore_minimized <hwnd_hex>      → restore + bring to foreground
#   capture_post_launch <hwnd_hex>    → capture screen region of window
#   uia_snapshot <hwnd_hex> [depth]   → UIA tree snapshot
#   exit

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ─────────────────────────────────────────── inline C# ──────────────────────
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class StartupProbe {

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int nCmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumChildProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg,
        IntPtr wParam, IntPtr lParam, uint flags, uint timeoutMs, out IntPtr result);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rc);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int nIndex);

    [DllImport("kernel32.dll")] public static extern uint WaitForInputIdle(IntPtr hProc, uint ms);
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

    public delegate bool EnumChildProc(IntPtr h, IntPtr lp);
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }

    public const uint SMTO_ABORTIFHUNG = 0x0002;
    public const int  GWL_STYLE        = -16;
    public const int  GWL_EXSTYLE      = -20;
    public const long WS_POPUP         = unchecked((long)0x80000000L);
    public const long WS_EX_DLGMODALFRAME = 0x00000001L;

    // Enumerate owned child/popup windows (for dialog detection)
    public static List<WinDesc> GetOwnedWindows(IntPtr owner, uint targetPid) {
        var list = new List<WinDesc>();
        EnumWindows((h, _) => {
            uint pid = 0; GetWindowThreadProcessId(h, out pid);
            if (pid != targetPid) return true;
            if (h == owner) return true;
            if (!IsWindowVisible(h)) return true;
            var t = new StringBuilder(256); GetWindowText(h, t, 256);
            var c = new StringBuilder(128); GetClassName(h, c, 128);
            list.Add(new WinDesc { HWnd=h.ToInt64(), Title=t.ToString(), Class=c.ToString() });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    // Enumerate direct child controls of hwnd
    public static List<WinDesc> GetChildWindows(IntPtr h) {
        var list = new List<WinDesc>();
        EnumChildWindows(h, (ch, _) => {
            var t = new StringBuilder(256); GetWindowText(ch, t, 256);
            var c = new StringBuilder(128); GetClassName(ch, c, 128);
            list.Add(new WinDesc { HWnd=ch.ToInt64(), Title=t.ToString(), Class=c.ToString() });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public class WinDesc { public long HWnd; public string Title, Class; }
}
'@ -ErrorAction SilentlyContinue

# ─────────────────────────────────── UIA (COM) ──────────────────────────────
# Load UIAutomationClient via reflection (ticket 460)
$uiaType = $null
try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
    $uiaType = [System.Windows.Automation.AutomationElement]
} catch {}

# ─────────────────────────────────── helpers ────────────────────────────────

function Emit-Frame($obj) {
    $json  = $obj | ConvertTo-Json -Compress -Depth 12
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $b64   = [Convert]::ToBase64String($bytes)
    [Console]::Out.WriteLine($b64.Length)
    [Console]::Out.WriteLine($b64)
    [Console]::Out.Flush()
}

function Ok($kind, $data)  { Emit-Frame @{ ok=$true;  kind=$kind; data=$data } }
function Fail($kind, $msg) { Emit-Frame @{ ok=$false; kind=$kind; error=$msg } }

function Parse-Hwnd([string]$s) {
    if ($s -match '^0x') { return [Convert]::ToInt64($s, 16) }
    return [long]::Parse($s)
}

function Hwnd-Str([long]$l) { '0x{0:X}' -f $l }

# Get window title
function Get-WinTitle([IntPtr]$h) {
    $sb = New-Object System.Text.StringBuilder 512
    [StartupProbe]::GetWindowText($h, $sb, 512) | Out-Null
    return $sb.ToString()
}

# Get window class
function Get-WinClass([IntPtr]$h) {
    $sb = New-Object System.Text.StringBuilder 256
    [StartupProbe]::GetClassName($h, $sb, 256) | Out-Null
    return $sb.ToString()
}

# ─────────────────────────────────── startup phase detection ────────────────
# Tickets 451–463

# Loading indicator class names (ticket 456)
$LOADING_CLASSES = @('SplashScreen','AdobeSplash','Static','msctls_progress32','ProgressBar')
$SPLASH_CLASSES  = @('SplashScreen','splash','#32770')

function Detect-StartupPhase([long]$hwndL) {
    $h   = [IntPtr]$hwndL
    $pid = [uint32]0
    [StartupProbe]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null
    $title = Get-WinTitle $h
    $class = Get-WinClass $h

    # Crash detection (ticket 464): WER dialog
    $owned = @([StartupProbe]::GetOwnedWindows($h, $pid))
    foreach ($w in $owned) {
        if ($w.Class -eq '#32770' -and ($w.Title -like '*stopped working*' -or $w.Title -like '*Problem*')) {
            return @{ phase='crash'; hwnd=Hwnd-Str($hwndL); wer_dialog=$w.Title }
        }
    }

    # Dialog interruption (ticket 458, 475)
    $dialogs = @(Detect-Dialogs $hwndL)
    if ($dialogs.Count -gt 0) {
        return @{ phase='dialog'; hwnd=Hwnd-Str($hwndL); dialogs=$dialogs }
    }

    # Responsive check (ticket 461)
    $respResult = [IntPtr]::Zero
    $r = [StartupProbe]::SendMessageTimeout($h, 0, [IntPtr]::Zero, [IntPtr]::Zero, 0x0002, 3000, [ref]$respResult)
    if ($r -eq [IntPtr]::Zero) {
        return @{ phase='loading'; hwnd=Hwnd-Str($hwndL); reason='not_responsive' }
    }

    # Child window scan for loading indicators (ticket 456, 459)
    $children = @([StartupProbe]::GetChildWindows($h))
    $hasProgress = $children | Where-Object { $_.Class -in $LOADING_CLASSES -and $_.Class -eq 'msctls_progress32' }
    $hasSplash   = $children | Where-Object { $_.Class -in $SPLASH_CLASSES }
    if ($hasSplash -or ($title -like '*loading*') -or ($title -like '*starting*') -or ($title -like '*initializing*')) {
        return @{ phase='loading'; hwnd=Hwnd-Str($hwndL); reason='splash_or_title' }
    }

    # Detect first interactive controls (ticket 455)
    $interactiveClasses = @('Edit','Button','ComboBox','ListBox','RICHEDIT','Chrome_WidgetWin','Qt5QWindowIcon')
    $hasInteractive = $children | Where-Object { $_.Class -in $interactiveClasses }
    if ($hasInteractive) {
        return @{ phase='ready'; hwnd=Hwnd-Str($hwndL); childCount=$children.Count }
    }

    # UIA check (ticket 460, 484)
    if ($uiaType) {
        try {
            $elem = [System.Windows.Automation.AutomationElement]::FromHandle($h)
            if ($elem -ne $null) {
                $condition = [System.Windows.Automation.Condition]::TrueCondition
                $kids = $elem.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
                if ($kids.Count -gt 0) {
                    return @{ phase='ready'; hwnd=Hwnd-Str($hwndL); uiaChildren=$kids.Count }
                }
            }
        } catch {}
    }

    if ($children.Count -gt 2) {
        return @{ phase='ready'; hwnd=Hwnd-Str($hwndL); childCount=$children.Count }
    }

    return @{ phase='unknown'; hwnd=Hwnd-Str($hwndL); childCount=$children.Count }
}

# ─────────────────────────────────── UIA readiness ──────────────────────────
# Ticket 460

function Detect-UiaReady([long]$hwndL) {
    $h    = [IntPtr]$hwndL
    $avail = $false
    $childCount = 0
    if ($uiaType) {
        try {
            $elem = [System.Windows.Automation.AutomationElement]::FromHandle($h)
            if ($elem -ne $null) {
                $avail = $true
                $condition = [System.Windows.Automation.Condition]::TrueCondition
                $kids = $elem.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
                $childCount = $kids.Count
            }
        } catch {}
    }
    return @{ hwnd=Hwnd-Str($hwndL); uiaAvailable=$avail; childCount=$childCount }
}

# ─────────────────────────────────── dialog detection ───────────────────────
# Tickets 465–475, 571

$WER_TITLES     = @('*stopped working*','*has encountered a problem*','*Windows Error*','*Problem*')
$UAC_CLASSES    = @('Credential Dialog Xaml Host','#32770')
$UAC_TITLES     = @('*User Account Control*','*wants to make changes*','*administrator permission*')
$FIRSTRUN_TITLES = @('*welcome*','*get started*','*first time*','*setup*','*onboarding*')
$UPDATE_TITLES  = @('*update available*','*new version*','*upgrade*')
$LICENSE_TITLES = @('*license*','*terms*','*EULA*','*agreement*')
$AUTH_TITLES    = @('*sign in*','*log in*','*login*','*authenticate*','*password*')
$ACCT_TITLES    = @('*account*','*choose account*','*pick an account*','*profile*')

function Detect-Dialogs([long]$hwndL) {
    $h   = [IntPtr]$hwndL
    $pid = [uint32]0
    [StartupProbe]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null
    $owned = @([StartupProbe]::GetOwnedWindows($h, $pid))
    $dialogs = @()
    foreach ($w in $owned) {
        $t = $w.Title; $c = $w.Class
        $kind = 'unknown'
        if ($WER_TITLES | Where-Object { $t -like $_ }) { $kind = 'crash_wer' }
        elseif (($UAC_CLASSES -contains $c) -or ($UAC_TITLES | Where-Object { $t -like $_ })) { $kind = 'elevation_uac' }
        elseif ($FIRSTRUN_TITLES | Where-Object { $t -like $_ }) { $kind = 'first_run' }
        elseif ($UPDATE_TITLES | Where-Object { $t -like $_ }) { $kind = 'update' }
        elseif ($LICENSE_TITLES | Where-Object { $t -like $_ }) { $kind = 'license' }
        elseif ($AUTH_TITLES | Where-Object { $t -like $_ }) { $kind = 'authentication' }
        elseif ($ACCT_TITLES | Where-Object { $t -like $_ }) { $kind = 'account_select' }
        elseif ($c -eq '#32770') { $kind = 'modal' }

        if ($kind -ne 'unknown' -or $c -eq '#32770') {
            $dialogs += @{ hwnd=Hwnd-Str($w.HWnd); title=$t; class=$c; kind=$kind }
        }
    }
    return $dialogs
}

function Classify-Dialog([long]$hwndL) {
    $h     = [IntPtr]$hwndL
    $title = Get-WinTitle $h
    $class = Get-WinClass $h
    $children = @([StartupProbe]::GetChildWindows($h))
    $buttons = @($children | Where-Object { $_.Class -eq 'Button' } | Select-Object -ExpandProperty Title)
    $hasOkOnly = $buttons.Count -eq 1 -and $buttons[0] -in @('OK','&OK','Close','&Close')
    $hasYesNo  = ($buttons | Where-Object { $_ -in @('Yes','&Yes','No','&No') }).Count -ge 2
    $hasCancel = $buttons | Where-Object { $_ -in @('Cancel','&Cancel','Abort','&Abort') }
    $kind = 'unknown'
    if ($WER_TITLES  | Where-Object { $title -like $_ }) { $kind = 'crash_wer' }
    elseif ($UAC_TITLES | Where-Object { $title -like $_ }) { $kind = 'elevation_uac' }
    elseif ($AUTH_TITLES | Where-Object { $title -like $_ }) { $kind = 'authentication' }
    elseif ($UPDATE_TITLES | Where-Object { $title -like $_ }) { $kind = 'update' }
    elseif ($LICENSE_TITLES | Where-Object { $title -like $_ }) { $kind = 'license' }
    elseif ($hasYesNo) { $kind = 'confirmation' }
    elseif ($hasOkOnly) { $kind = 'informational' }
    return @{
        hwnd=Hwnd-Str($hwndL); title=$title; class=$class; kind=$kind
        buttons=$buttons; hasOkOnly=$hasOkOnly; hasYesNo=$hasYesNo; hasCancel=[bool]$hasCancel
    }
}

# ─────────────────────────────────── foreground verification ────────────────
# Tickets 481–483, 493–495

function Verify-Foreground([long]$hwndL) {
    $h    = [IntPtr]$hwndL
    $fg   = [StartupProbe]::GetForegroundWindow()
    $isFg = ($fg -eq $h)
    return @{ hwnd=Hwnd-Str($hwndL); isForeground=$isFg; fgHwnd=('0x{0:X}' -f $fg.ToInt64()) }
}

function Restore-Minimized([long]$hwndL) {
    $h = [IntPtr]$hwndL
    if ([StartupProbe]::IsIconic($h)) {
        [StartupProbe]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
        Start-Sleep -Milliseconds 250
    }
    [StartupProbe]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 350
    $fg  = [StartupProbe]::GetForegroundWindow()
    $ok  = ($fg -eq $h)
    # retry once with ALT key trick (ticket 495)
    if (-not $ok) {
        $wsh = New-Object -ComObject WScript.Shell
        $wsh.SendKeys('%')
        Start-Sleep -Milliseconds 100
        [StartupProbe]::SetForegroundWindow($h) | Out-Null
        Start-Sleep -Milliseconds 350
        $fg = [StartupProbe]::GetForegroundWindow()
        $ok = ($fg -eq $h)
    }
    return @{ hwnd=Hwnd-Str($hwndL); restored=$ok; fgHwnd=('0x{0:X}' -f $fg.ToInt64()) }
}

# ─────────────────────────────────── UIA tree snapshot ──────────────────────
# Ticket 484, 501

function Get-UiaSnapshot([long]$hwndL, [int]$depth=3) {
    $h = [IntPtr]$hwndL
    if (-not $uiaType) { return @{ hwnd=Hwnd-Str($hwndL); error='UIA not available'; elements=@() } }
    try {
        $elem = [System.Windows.Automation.AutomationElement]::FromHandle($h)
        if ($null -eq $elem) { return @{ hwnd=Hwnd-Str($hwndL); error='element null'; elements=@() } }
        function Snapshot-Elem($e, $d) {
            $name  = try { $e.Current.Name } catch { '' }
            $role  = try { $e.Current.ControlType.ProgrammaticName -replace 'ControlType\.',''; } catch { '' }
            $aid   = try { $e.Current.AutomationId } catch { '' }
            $cls   = try { $e.Current.ClassName } catch { '' }
            $node  = @{ name=$name; role=$role; automationId=$aid; class=$cls; children=@() }
            if ($d -gt 0) {
                try {
                    $condition = [System.Windows.Automation.Condition]::TrueCondition
                    $kids = $e.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
                    foreach ($k in $kids) { $node.children += Snapshot-Elem $k ($d-1) }
                } catch {}
            }
            return $node
        }
        $tree = Snapshot-Elem $elem $depth
        return @{ hwnd=Hwnd-Str($hwndL); depth=$depth; tree=$tree }
    } catch {
        return @{ hwnd=Hwnd-Str($hwndL); error=$_.Exception.Message; elements=@() }
    }
}

# ─────────────────────────────────── poll responsive ────────────────────────
# Ticket 461–462

function Poll-Responsive([long]$hwndL, [int]$timeoutMs=10000) {
    $h       = [IntPtr]$hwndL
    $deadline = [DateTime]::Now.AddMilliseconds($timeoutMs)
    while ([DateTime]::Now -lt $deadline) {
        $res = [IntPtr]::Zero
        $r   = [StartupProbe]::SendMessageTimeout($h, 0, [IntPtr]::Zero, [IntPtr]::Zero, 0x0002, 1500, [ref]$res)
        if ($r -ne [IntPtr]::Zero) {
            return @{ hwnd=Hwnd-Str($hwndL); responsive=$true; elapsedMs=($timeoutMs - [int]([DateTime]$deadline - [DateTime]::Now).TotalMilliseconds) }
        }
        Start-Sleep -Milliseconds 500
    }
    return @{ hwnd=Hwnd-Str($hwndL); responsive=$false; timedOut=$true }
}

# ─────────────────────────────────── capture post-launch ────────────────────
# Ticket 496: delegate to System.Drawing (same approach as win-agent.ps1)

function Capture-PostLaunch([long]$hwndL) {
    try {
        Add-Type -AssemblyName System.Drawing
        Add-Type -AssemblyName System.Windows.Forms
        $rc = New-Object StartupProbe+RECT
        [StartupProbe]::GetWindowRect([IntPtr]$hwndL, [ref]$rc) | Out-Null
        $w = $rc.R - $rc.L; $h = $rc.B - $rc.T
        if ($w -le 0 -or $h -le 0) { return @{ ok=$false; error='zero rect' } }
        $bmp  = New-Object System.Drawing.Bitmap $w, $h
        $g    = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($rc.L, $rc.T, 0, 0, (New-Object System.Drawing.Size $w, $h))
        $g.Dispose()
        $dir  = Join-Path $env:TEMP 'voice-agent-win'
        [System.IO.Directory]::CreateDirectory($dir) | Out-Null
        $path = Join-Path $dir ("postlaunch_{0}.png" -f (Get-Date -Format 'HHmmssfff'))
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        return @{ ok=$true; path=$path; x=$rc.L; y=$rc.T; width=$w; height=$h }
    } catch {
        return @{ ok=$false; error=$_.Exception.Message }
    }
}

# ─────────────────────────────────── main loop ──────────────────────────────

while ($true) {
    try { $line = [Console]::In.ReadLine() } catch { break }
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }
    if ($line -eq 'exit') { break }

    $parts = $line -split '\s+', 2
    $cmd   = $parts[0].ToLowerInvariant()
    $arg   = if ($parts.Count -gt 1) { $parts[1] } else { '' }

    try {
        switch ($cmd) {

            # 451–463
            'detect_startup_phase' {
                if (-not $arg) { Fail 'detect_startup_phase' 'usage: detect_startup_phase <hwnd>'; break }
                Ok 'detect_startup_phase' (Detect-StartupPhase (Parse-Hwnd $arg))
            }

            # 460
            'detect_uia_ready' {
                if (-not $arg) { Fail 'detect_uia_ready' 'usage: detect_uia_ready <hwnd>'; break }
                Ok 'detect_uia_ready' (Detect-UiaReady (Parse-Hwnd $arg))
            }

            # 461–462
            'poll_responsive' {
                $pparts = $arg -split '\s+', 2
                $hwndL  = Parse-Hwnd $pparts[0]
                $ms     = if ($pparts.Count -gt 1) { [int]$pparts[1] } else { 10000 }
                Ok 'poll_responsive' (Poll-Responsive $hwndL $ms)
            }

            # 465–475
            'detect_dialogs' {
                if (-not $arg) { Fail 'detect_dialogs' 'usage: detect_dialogs <hwnd>'; break }
                $dialogs = @(Detect-Dialogs (Parse-Hwnd $arg))
                Ok 'detect_dialogs' @{ hwnd=$arg; dialogs=$dialogs; count=$dialogs.Count }
            }

            # dialog classification
            'classify_dialog' {
                if (-not $arg) { Fail 'classify_dialog' 'usage: classify_dialog <hwnd>'; break }
                Ok 'classify_dialog' (Classify-Dialog (Parse-Hwnd $arg))
            }

            # 481
            'verify_foreground' {
                if (-not $arg) { Fail 'verify_foreground' 'usage: verify_foreground <hwnd>'; break }
                Ok 'verify_foreground' (Verify-Foreground (Parse-Hwnd $arg))
            }

            # 493–495
            'restore_minimized' {
                if (-not $arg) { Fail 'restore_minimized' 'usage: restore_minimized <hwnd>'; break }
                Ok 'restore_minimized' (Restore-Minimized (Parse-Hwnd $arg))
            }

            # 484
            'uia_snapshot' {
                $uparts = $arg -split '\s+', 2
                $hwndL  = Parse-Hwnd $uparts[0]
                $depth  = if ($uparts.Count -gt 1) { [int]$uparts[1] } else { 3 }
                Ok 'uia_snapshot' (Get-UiaSnapshot $hwndL $depth)
            }

            # 496
            'capture_post_launch' {
                if (-not $arg) { Fail 'capture_post_launch' 'usage: capture_post_launch <hwnd>'; break }
                $result = Capture-PostLaunch (Parse-Hwnd $arg)
                if ($result.ok) { Ok 'capture_post_launch' $result }
                else { Fail 'capture_post_launch' $result.error }
            }

            default { Fail 'unknown' "unknown command: $cmd" }
        }
    } catch {
        Fail 'error' $_.Exception.Message
    }
}
