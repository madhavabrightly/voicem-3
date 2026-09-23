# app_engine.ps1 — P5 Application Discovery & Launch Engine
# Tickets 401–449: process/window enumeration, executable resolution,
# Start Menu / Store / PATH / AppX lookup, deterministic launch,
# capture of newly created process/window, identity verification.
#
# Protocol: persistent JSON-lines agent, one command per stdin line,
# one Base64-framed JSON response per command (same framing as win-agent.ps1).
#
# Commands:
#   enum_apps                         → list all running top-level app processes
#   enum_windows [visible|hidden|minimized|all]  → list windows with metadata
#   resolve_app <name>                → resolve natural name → AppIdentity record
#   detect_running <name>             → is the app currently running?
#   detect_responsive <hwnd_hex>      → is the window responsive?
#   detect_hung <hwnd_hex>            → is the window hung?
#   resolve_launch_cmd <name>         → resolve launch command without launching
#   launch_app <name>                 → launch app, return pid+hwnd
#   capture_new_window <pid>          → wait for + capture newly created window
#   verify_app_identity <hwnd_hex> <name> → verify hwnd matches expected app
#   detect_elevation_required <path>  → does executable require elevation?
#   detect_missing_exe <path>         → does executable exist?
#   fg                                → foreground window info
#   exit

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ─────────────────────────────────────────── inline C# Win32 surface ───────
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class AppEngine {
    // ── Window enumeration ──────────────────────────────────────────────
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumWindowsProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint uCmd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int nCmd);
    [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg,
        IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rc);
    [DllImport("user32.dll")] public static extern long GetWindowLong(IntPtr h, int nIndex);

    // ── Process ─────────────────────────────────────────────────────────
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool QueryFullProcessImageName(
        IntPtr h, int flags, StringBuilder s, ref int n);

    // ── Shell / process launch ──────────────────────────────────────────
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr ShellExecute(
        IntPtr hwnd, string verb, string file, string args, string dir, int show);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] public static extern uint WaitForInputIdle(IntPtr hProc, uint ms);
    [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);

    public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb; public string Reserved,Desktop,Title;
        public int X,Y,XSize,YSize,XCountChars,YCountChars,FillAttr,Flags;
        public short ShowWindow,Reserved2; public IntPtr Reserved3,StdIn,StdOut,StdErr;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr Process,Thread; public uint PId,TId; }

    public const uint PROCESS_QUERY_LIMITED = 0x1000;
    public const uint PROCESS_SYNCHRONIZE   = 0x00100000;
    public const uint GW_OWNER = 4;
    public const int  GWL_EXSTYLE = -20;
    public const long WS_EX_APPWINDOW   = 0x00040000L;
    public const long WS_EX_TOOLWINDOW  = 0x00000080L;
    public const uint SMTO_ABORTIFHUNG  = 0x0002;
    public const uint WAIT_TIMEOUT      = 0x102;
    public const uint STILL_ACTIVE      = 259;

    // Resolve full path for a running process pid
    public static string GetProcessPath(uint pid) {
        var h = OpenProcess(PROCESS_QUERY_LIMITED, false, pid);
        if (h == IntPtr.Zero) return "";
        try {
            var sb = new StringBuilder(1024);
            int n = sb.Capacity;
            return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : "";
        } finally { CloseHandle(h); }
    }

    // Enumerate top-level visible application windows (401,402)
    public static List<WinInfo> EnumTopLevel(string filter) {
        var list = new List<WinInfo>();
        EnumWindows((h, _) => {
            if (filter == "hidden" && IsWindowVisible(h)) return true;
            if (filter == "minimized" && !IsIconic(h)) return true;
            if (filter != "all" && filter != "hidden" && !IsWindowVisible(h)) return true;

            var title = new StringBuilder(512);
            GetWindowText(h, title, 512);
            var cls = new StringBuilder(256);
            GetClassName(h, cls, 256);
            uint pid = 0; GetWindowThreadProcessId(h, out pid);

            // Skip untitled system windows and shell surfaces
            string t = title.ToString(); string c = cls.ToString();
            if (string.IsNullOrWhiteSpace(t) && filter != "hidden") return true;
            if (IsShellClass(c)) return true;

            bool isApp = IsAppWindow(h, c);
            if (!isApp && filter == "visible") return true;

            list.Add(new WinInfo {
                HWnd   = h.ToInt64(),
                Title  = t,
                Class  = c,
                Pid    = pid,
                Path   = GetProcessPath(pid),
                Visible   = IsWindowVisible(h),
                Minimized = IsIconic(h),
                Maximized = IsZoomed(h),
                IsShell   = IsShellClass(c)
            });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    static bool IsShellClass(string cls) {
        return cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd"
            || cls == "Shell_SecondaryTrayWnd" || cls == "DV2ControlHost"
            || cls == "MsgrIMEWindowClass" || cls == "SysShadow"
            || cls == "Button" || cls.StartsWith("TaskList");
    }

    static bool IsAppWindow(IntPtr h, string cls) {
        long ex = GetWindowLong(h, GWL_EXSTYLE);
        if ((ex & WS_EX_TOOLWINDOW) != 0) return false;
        IntPtr owner = GetWindow(h, GW_OWNER);
        if (owner != IntPtr.Zero) return false;
        return true;
    }

    public class WinInfo {
        public long HWnd; public string Title, Class, Path;
        public uint Pid; public bool Visible, Minimized, Maximized, IsShell;
    }

    // Responsiveness test (ticket 436, 461)
    public static bool IsResponsive(IntPtr h, int timeoutMs = 2000) {
        IntPtr res;
        var r = SendMessageTimeout(h, 0, IntPtr.Zero, IntPtr.Zero,
            SMTO_ABORTIFHUNG, (uint)timeoutMs, out res);
        return r != IntPtr.Zero;
    }
}
'@ -ErrorAction SilentlyContinue

# ─────────────────────────────────────────── helpers ────────────────────────

function Emit-Frame($obj) {
    $json  = $obj | ConvertTo-Json -Compress -Depth 10
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $b64   = [Convert]::ToBase64String($bytes)
    [Console]::Out.WriteLine($b64.Length)
    [Console]::Out.WriteLine($b64)
    [Console]::Out.Flush()
}

function Ok($kind, $data)   { Emit-Frame @{ ok=$true;  kind=$kind; data=$data } }
function Fail($kind, $msg)  { Emit-Frame @{ ok=$false; kind=$kind; error=$msg } }

function Parse-Hwnd([string]$s) {
    if ($s -match '^0x') { return [Convert]::ToInt64($s, 16) }
    return [long]::Parse($s)
}

# ─────────────────────────────────── application identity resolution ─────────
# Tickets 418–430: Build AppIdentity from running process/window

function Build-AppIdentity([AppEngine+WinInfo]$win) {
    $procName = ''
    $version  = ''
    $arch     = 'unknown'
    $publisher = ''
    if ($win.Path -and (Test-Path $win.Path -ErrorAction SilentlyContinue)) {
        try {
            $fi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($win.Path)
            $procName  = $fi.InternalName
            $version   = $fi.ProductVersion
            $publisher = $fi.CompanyName
            # PE header architecture (ticket 409)
            $bytes = [System.IO.File]::ReadAllBytes($win.Path)
            if ($bytes.Length -gt 0x40) {
                $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
                if ($peOffset + 6 -lt $bytes.Length) {
                    $machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
                    $arch = switch ($machine) { 0x8664 {'x64'} 0x014c {'x86'} 0xAA64 {'arm64'} default {'unknown'} }
                }
            }
        } catch {}
    }
    $stem = if ($win.Path) { [System.IO.Path]::GetFileNameWithoutExtension($win.Path) } else { '' }
    return @{
        hwnd      = ('0x{0:X}' -f $win.HWnd)
        pid       = $win.Pid
        title     = $win.Title
        class     = $win.Class
        path      = $win.Path
        stem      = $stem
        name      = if ($procName) { $procName } else { $stem }
        version   = $version
        arch      = $arch
        publisher = $publisher
        visible   = $win.Visible
        minimized = $win.Minimized
    }
}

# Ticket 419: Normalize app name
function Normalize-AppName([string]$name) {
    $n = $name.Trim().ToLowerInvariant()
    $n = $n -replace '[^a-z0-9\s]',''
    $n = $n -replace '\s+',' '
    return $n
}

# Tickets 420–428: Resolve known paths, Start Menu, PATH, AppX
function Resolve-AppPaths([string]$name) {
    $lower = Normalize-AppName $name
    $candidates = @()

    # 1. PATH-based executables (ticket 425)
    try {
        $found = Get-Command $name -ErrorAction SilentlyContinue
        if (-not $found) { $found = Get-Command "$name.exe" -ErrorAction SilentlyContinue }
        if ($found) { $candidates += @{ path=$found.Source; source='PATH'; score=0.9 } }
    } catch {}

    # 2. Known alias map (ticket 420, 421)
    $aliases = @{
        'notepad'      = @{ path='notepad.exe'; score=1.0 }
        'calculator'   = @{ path='calc.exe'; score=1.0 }
        'calc'         = @{ path='calc.exe'; score=1.0 }
        'paint'        = @{ path='mspaint.exe'; score=1.0 }
        'wordpad'      = @{ path='wordpad.exe'; score=1.0 }
        'explorer'     = @{ path='explorer.exe'; score=1.0 }
        'cmd'          = @{ path='cmd.exe'; score=1.0 }
        'powershell'   = @{ path='powershell.exe'; score=1.0 }
        'chrome'       = @{ path='chrome.exe'; score=0.95 }
        'edge'         = @{ path='msedge.exe'; score=0.95 }
        'firefox'      = @{ path='firefox.exe'; score=0.95 }
        'opera'        = @{ path='opera.exe'; score=0.9 }
        'vscode'       = @{ path='code.exe'; score=0.95 }
        'code'         = @{ path='code.exe'; score=0.95 }
        'word'         = @{ path='WINWORD.EXE'; score=0.9 }
        'excel'        = @{ path='EXCEL.EXE'; score=0.9 }
        'powerpoint'   = @{ path='POWERPNT.EXE'; score=0.9 }
        'outlook'      = @{ path='OUTLOOK.EXE'; score=0.9 }
        'teams'        = @{ path='Teams.exe'; score=0.9 }
        'whatsapp'     = @{ path='WhatsApp.exe'; source='store'; score=0.95; aumid='5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' }
        'spotify'      = @{ path='Spotify.exe'; source='store'; score=0.9 }
        'telegram'     = @{ path='Telegram.exe'; source='store'; score=0.9 }
        'discord'      = @{ path='Discord.exe'; score=0.9 }
        'slack'        = @{ path='slack.exe'; score=0.9 }
        'zoom'         = @{ path='Zoom.exe'; score=0.85 }
        'skype'        = @{ path='Skype.exe'; score=0.85 }
        'vlc'          = @{ path='vlc.exe'; score=0.85 }
        'winamp'       = @{ path='winamp.exe'; score=0.8 }
        'steam'        = @{ path='steam.exe'; score=0.85 }
    }
    if ($aliases.ContainsKey($lower)) {
        $a = $aliases[$lower]
        $candidates += @{ path=$a.path; source=if($a.source){'alias:'+$a.source}else{'alias'}; score=$a.score; aumid=$a.aumid }
    }

    # 3. Start Menu shortcuts (ticket 422)
    $startMenuDirs = @(
        [Environment]::GetFolderPath('CommonPrograms'),
        [Environment]::GetFolderPath('Programs')
    )
    foreach ($dir in $startMenuDirs) {
        if (-not $dir -or -not (Test-Path $dir)) { continue }
        Get-ChildItem -Recurse -Filter "*.lnk" -Path $dir -ErrorAction SilentlyContinue | ForEach-Object {
            $lnk = $_.FullName
            $stem = [System.IO.Path]::GetFileNameWithoutExtension($lnk)
            if ((Normalize-AppName $stem) -like "*$lower*") {
                $candidates += @{ path=$lnk; source='start_menu'; score=0.85; stem=$stem }
            }
        }
    }

    # 4. Desktop shortcuts (ticket 423)
    $desktopDirs = @(
        [Environment]::GetFolderPath('CommonDesktopDirectory'),
        [Environment]::GetFolderPath('Desktop')
    )
    foreach ($dir in $desktopDirs) {
        if (-not $dir -or -not (Test-Path $dir)) { continue }
        Get-ChildItem -Filter "*.lnk" -Path $dir -ErrorAction SilentlyContinue | ForEach-Object {
            $stem = [System.IO.Path]::GetFileNameWithoutExtension($_.FullName)
            if ((Normalize-AppName $stem) -like "*$lower*") {
                $candidates += @{ path=$_.FullName; source='desktop'; score=0.8; stem=$stem }
            }
        }
    }

    # 5. Windows App Execution Aliases (ticket 426)
    $aliasDir = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
    if (Test-Path $aliasDir) {
        Get-ChildItem -Filter "*.exe" -Path $aliasDir -ErrorAction SilentlyContinue | ForEach-Object {
            $stem = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
            if ((Normalize-AppName $stem) -like "*$lower*") {
                $candidates += @{ path=$_.FullName; source='app_execution_alias'; score=0.88; stem=$stem }
            }
        }
    }

    # 6. Registry App Paths (ticket 421)
    $regPaths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths'
    )
    foreach ($rp in $regPaths) {
        if (-not (Test-Path $rp)) { continue }
        Get-ChildItem $rp -ErrorAction SilentlyContinue | ForEach-Object {
            $keyName = $_.PSChildName
            if ((Normalize-AppName ([System.IO.Path]::GetFileNameWithoutExtension($keyName))) -like "*$lower*") {
                $val = (Get-ItemProperty $_.PSPath).'(default)' -replace '"',''
                if ($val -and (Test-Path $val -ErrorAction SilentlyContinue)) {
                    $candidates += @{ path=$val; source='registry_app_paths'; score=0.9; stem=[System.IO.Path]::GetFileNameWithoutExtension($val) }
                }
            }
        }
    }

    # Deduplicate by path, keep highest score
    $dedup = @{}
    foreach ($c in $candidates) {
        $key = ($c.path -replace '\\','/' ).ToLowerInvariant()
        if (-not $dedup.ContainsKey($key) -or $dedup[$key].score -lt $c.score) {
            $dedup[$key] = $c
        }
    }
    return ($dedup.Values | Sort-Object { $_.score } -Descending)
}

# ─────────────────────────────────── launch command resolution ───────────────
# Tickets 441–443

function Resolve-LaunchCommand([string]$name) {
    # Check running windows first (ticket 435)
    $wins = [AppEngine]::EnumTopLevel('visible')
    $lower = Normalize-AppName $name
    foreach ($w in $wins) {
        if ((Normalize-AppName $w.Title) -like "*$lower*" -or
            (Normalize-AppName $w.Class) -like "*$lower*" -or
            ($w.Path -and (Normalize-AppName ([System.IO.Path]::GetFileNameWithoutExtension($w.Path))) -like "*$lower*")) {
            return @{ found='running'; hwnd=('0x{0:X}' -f $w.HWnd); pid=$w.Pid; title=$w.Title; path=$w.Path }
        }
    }

    # Resolve from candidates
    $candidates = @(Resolve-AppPaths $name)
    if ($candidates.Count -eq 0) {
        return @{ found='none'; error="no launch command resolved for '$name'" }
    }
    $best = $candidates[0]

    # Resolve .lnk target
    $launchPath = $best.path
    $workDir    = ''
    $launchArgs = ''
    if ($launchPath -like '*.lnk') {
        try {
            $shell = New-Object -ComObject WScript.Shell
            $lnk   = $shell.CreateShortcut($launchPath)
            $launchPath = $lnk.TargetPath
            $workDir    = $lnk.WorkingDirectory
            $launchArgs = $lnk.Arguments
        } catch {}
    }

    # Resolve environment variables (ticket 444)
    $launchPath = [System.Environment]::ExpandEnvironmentVariables($launchPath)
    $workDir    = [System.Environment]::ExpandEnvironmentVariables($workDir)

    return @{
        found      = 'resolved'
        launchPath = $launchPath
        workDir    = $workDir
        args       = $launchArgs
        source     = $best.source
        score      = $best.score
        aumid      = $best.aumid
        allCount   = $candidates.Count
    }
}

# ─────────────────────────────────── launch ─────────────────────────────────
# Tickets 446–449

function Launch-App([string]$name) {
    $cmd = Resolve-LaunchCommand $name

    # Already running — focus it (ticket 435, 491–492)
    if ($cmd.found -eq 'running') {
        $h = [IntPtr][long]::Parse($cmd.hwnd.Replace('0x',''), 'HexNumber')
        if ([AppEngine+WinInfo] -and [AppEngine]::IsIconic($h)) {
            [AppEngine]::ShowWindow($h, 9) | Out-Null
        }
        [AppEngine]::SetForegroundWindow($h) | Out-Null
        Start-Sleep -Milliseconds 300
        return @{ ok=$true; action='focus_existing'; hwnd=$cmd.hwnd; pid=$cmd.pid; title=$cmd.title; path=$cmd.path }
    }

    if ($cmd.found -eq 'none') {
        return @{ ok=$false; error=$cmd.error }
    }

    $path   = $cmd.launchPath
    $wd     = $cmd.workDir
    $args   = $cmd.args
    $aumid  = $cmd.aumid

    # Missing executable check (ticket 440)
    if ($path -and -not ($path -like '*.exe') -and -not ($path -like 'http*') -and -not $aumid) {
        if (-not (Test-Path $path -ErrorAction SilentlyContinue)) {
            return @{ ok=$false; error="executable not found: $path" }
        }
    }

    try {
        # Store/AppX launch (ticket 427–428)
        if ($aumid) {
            $proc = Start-Process "shell:AppsFolder\$aumid" -PassThru -ErrorAction Stop
            Start-Sleep -Milliseconds 2000
            $pid2 = if ($proc) { $proc.Id } else { 0 }
            $win  = Wait-ForNewWindow -Pid $pid2 -NameHint $name -TimeoutMs 15000
            return @{ ok=$true; action='launch_store'; aumid=$aumid; pid=$pid2; hwnd=$win.hwnd; title=$win.title }
        }

        # Standard launch (ticket 446)
        $startArgs = @{ FilePath = $path; PassThru = $true; ErrorAction = 'Stop' }
        if ($wd) { $startArgs.WorkingDirectory = $wd }
        if ($args) { $startArgs.ArgumentList = $args }
        $proc = Start-Process @startArgs
        $pid2 = $proc.Id

        # Wait for input idle (ticket 447)
        $procH = [AppEngine]::OpenProcess(0x00100000 -bor 0x1000, $false, [uint32]$pid2)
        if ($procH -ne [IntPtr]::Zero) {
            [AppEngine]::WaitForInputIdle($procH, 8000) | Out-Null
            [AppEngine]::CloseHandle($procH) | Out-Null
        }

        # Capture new window (ticket 448)
        $win = Wait-ForNewWindow -Pid $pid2 -NameHint $name -TimeoutMs 12000
        return @{ ok=$true; action='launch'; path=$path; pid=$pid2; hwnd=$win.hwnd; title=$win.title }
    } catch {
        # AHK fallback signal — Node layer will check AHK availability
        return @{ ok=$false; error=$_.Exception.Message; ahk_fallback=$true; name=$name }
    }
}

# Wait for a new window belonging to pid (or any window whose title matches nameHint)
function Wait-ForNewWindow([int]$Pid, [string]$NameHint, [int]$TimeoutMs=10000) {
    $lower    = Normalize-AppName $NameHint
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 400
        $wins = [AppEngine]::EnumTopLevel('all')
        foreach ($w in $wins) {
            $matchPid   = ($Pid -gt 0 -and $w.Pid -eq $Pid)
            $matchTitle = ($w.Title -and (Normalize-AppName $w.Title) -like "*$lower*")
            $matchPath  = ($w.Path  -and (Normalize-AppName ([System.IO.Path]::GetFileNameWithoutExtension($w.Path))) -like "*$lower*")
            if ($matchPid -or $matchTitle -or $matchPath) {
                return @{ hwnd=('0x{0:X}' -f $w.HWnd); title=$w.Title; pid=$w.Pid }
            }
        }
    }
    return @{ hwnd='0x0'; title=''; pid=0 }
}

# ─────────────────────────────────── identity verification ───────────────────
# Ticket 449

function Verify-AppIdentity([long]$hwndL, [string]$expectedName) {
    $h    = [IntPtr]$hwndL
    $tSB  = New-Object System.Text.StringBuilder 512
    [AppEngine]::GetWindowText($h, $tSB, 512) | Out-Null
    $cSB  = New-Object System.Text.StringBuilder 256
    [AppEngine]::GetClassName($h, $cSB, 256) | Out-Null
    $pid  = [uint32]0
    [AppEngine]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null
    $path = [AppEngine]::GetProcessPath($pid)
    $stem = if ($path) { [System.IO.Path]::GetFileNameWithoutExtension($path) } else { '' }
    $lower = Normalize-AppName $expectedName
    $match = (Normalize-AppName $tSB.ToString()) -like "*$lower*" -or
             (Normalize-AppName $stem) -like "*$lower*"
    return @{
        ok        = $match
        hwnd      = ('0x{0:X}' -f $hwndL)
        title     = $tSB.ToString()
        class     = $cSB.ToString()
        stem      = $stem
        path      = $path
        expected  = $expectedName
        matched   = $match
    }
}

# ─────────────────────────────────── elevation / missing ────────────────────
# Tickets 438–440

function Detect-ElevationRequired([string]$path) {
    # Heuristic: check manifest or known elevation markers
    $requiresElevation = $false
    try {
        if (Test-Path $path) {
            $content = [System.IO.File]::ReadAllText($path) -replace '[^\x20-\x7E]',''
            # very rough: presence of requireAdministrator in embedded manifest
            if ($content -like '*requireAdministrator*') { $requiresElevation = $true }
        }
    } catch {}
    return @{ ok=$true; path=$path; requiresElevation=$requiresElevation }
}

function Detect-MissingExe([string]$path) {
    $exists = Test-Path $path -ErrorAction SilentlyContinue
    return @{ ok=$true; path=$path; missing=(-not $exists) }
}

# ─────────────────────────────────── foreground info ────────────────────────

function Get-ForegroundInfo {
    $h = [AppEngine]::GetForegroundWindow()
    $tSB = New-Object System.Text.StringBuilder 512
    [AppEngine]::GetWindowText($h, $tSB, 512) | Out-Null
    $cSB = New-Object System.Text.StringBuilder 256
    [AppEngine]::GetClassName($h, $cSB, 256) | Out-Null
    $pid = [uint32]0
    [AppEngine]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null
    $path = [AppEngine]::GetProcessPath($pid)
    $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
    return @{
        hwnd  = ('0x{0:X}' -f $h.ToInt64())
        pid   = $pid
        title = $tSB.ToString()
        class = $cSB.ToString()
        proc  = if ($proc) { $proc.ProcessName } else { '' }
        path  = $path
    }
}

# ─────────────────────────────────── main command loop ──────────────────────

while ($true) {
    try { $line = [Console]::In.ReadLine() } catch { break }
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '' ) { continue }
    if ($line -eq 'exit') { break }

    $parts = $line -split '\s+', 2
    $cmd   = $parts[0].ToLowerInvariant()
    $arg   = if ($parts.Count -gt 1) { $parts[1] } else { '' }

    try {
        switch ($cmd) {

            # ── 401–404: enumerate windows
            'enum_windows' {
                $filter = if ($arg) { $arg.ToLowerInvariant() } else { 'visible' }
                $wins   = [AppEngine]::EnumTopLevel($filter)
                $records = @($wins | ForEach-Object { Build-AppIdentity $_ })
                Ok 'enum_windows' @{ windows=$records; count=$records.Count; filter=$filter }
            }

            # ── 411: running app inventory
            'enum_apps' {
                $wins   = [AppEngine]::EnumTopLevel('visible')
                $records = @($wins | ForEach-Object { Build-AppIdentity $_ })
                Ok 'enum_apps' @{ apps=$records; count=$records.Count }
            }

            # ── 418–430: resolve identity from name
            'resolve_app' {
                if (-not $arg) { Fail 'resolve_app' 'usage: resolve_app <name>'; break }
                # Check running first
                $running = [AppEngine]::EnumTopLevel('visible')
                $lower   = Normalize-AppName $arg
                $matched = @()
                foreach ($w in $running) {
                    $titleN = Normalize-AppName $w.Title
                    $stemN  = if ($w.Path) { Normalize-AppName ([System.IO.Path]::GetFileNameWithoutExtension($w.Path)) } else { '' }
                    $score  = 0.0
                    if ($titleN -like "*$lower*") { $score = 0.9 }
                    if ($stemN  -eq $lower)       { $score = 1.0 }
                    if ($stemN  -like "*$lower*" -and $score -lt 0.85) { $score = 0.85 }
                    if ($score -gt 0) {
                        $id = Build-AppIdentity $w
                        $id.score   = $score
                        $id.running = $true
                        $matched   += $id
                    }
                }
                # Path candidates
                $pathCands = @(Resolve-AppPaths $arg)
                foreach ($c in $pathCands) {
                    $matched += @{ path=$c.path; source=$c.source; score=$c.score; running=$false; aumid=$c.aumid }
                }
                $sorted = @($matched | Sort-Object { $_.score } -Descending)
                Ok 'resolve_app' @{ name=$arg; candidates=$sorted; count=$sorted.Count }
            }

            # ── 435: detect running
            'detect_running' {
                if (-not $arg) { Fail 'detect_running' 'usage: detect_running <name>'; break }
                $wins   = [AppEngine]::EnumTopLevel('all')
                $lower  = Normalize-AppName $arg
                $found  = @($wins | Where-Object {
                    (Normalize-AppName $_.Title) -like "*$lower*" -or
                    ($_.Path -and (Normalize-AppName ([System.IO.Path]::GetFileNameWithoutExtension($_.Path))) -like "*$lower*")
                })
                $isRunning = $found.Count -gt 0
                $first = if ($isRunning) { Build-AppIdentity $found[0] } else { $null }
                Ok 'detect_running' @{ name=$arg; running=$isRunning; count=$found.Count; instance=$first }
            }

            # ── 436: detect responsive
            'detect_responsive' {
                if (-not $arg) { Fail 'detect_responsive' 'usage: detect_responsive <hwnd>'; break }
                $hwndL = Parse-Hwnd $arg
                $h     = [IntPtr]$hwndL
                $resp  = [AppEngine]::IsResponsive($h, 2000)
                Ok 'detect_responsive' @{ hwnd=$arg; responsive=$resp }
            }

            # ── 437: detect hung
            'detect_hung' {
                if (-not $arg) { Fail 'detect_hung' 'usage: detect_hung <hwnd>'; break }
                $hwndL = Parse-Hwnd $arg
                $h     = [IntPtr]$hwndL
                $hung  = [AppEngine]::IsHungAppWindow($h)
                Ok 'detect_hung' @{ hwnd=$arg; hung=$hung }
            }

            # ── 441–443: resolve launch command only
            'resolve_launch_cmd' {
                if (-not $arg) { Fail 'resolve_launch_cmd' 'usage: resolve_launch_cmd <name>'; break }
                $cmd2 = Resolve-LaunchCommand $arg
                Ok 'resolve_launch_cmd' $cmd2
            }

            # ── 446–449: full launch pipeline
            'launch_app' {
                if (-not $arg) { Fail 'launch_app' 'usage: launch_app <name>'; break }
                $result = Launch-App $arg
                if ($result.ok) { Ok 'launch_app' $result }
                else            { Fail 'launch_app' $result.error }
            }

            # ── 448: capture new window by pid
            'capture_new_window' {
                if (-not $arg) { Fail 'capture_new_window' 'usage: capture_new_window <pid>'; break }
                $pidInt = [int]$arg
                $win    = Wait-ForNewWindow -Pid $pidInt -NameHint '' -TimeoutMs 8000
                Ok 'capture_new_window' $win
            }

            # ── 449: verify app identity
            'verify_app_identity' {
                $vparts = $arg -split '\s+', 2
                if ($vparts.Count -lt 2) { Fail 'verify_app_identity' 'usage: verify_app_identity <hwnd> <name>'; break }
                $hwndL = Parse-Hwnd $vparts[0]
                $result = Verify-AppIdentity $hwndL $vparts[1]
                if ($result.ok -and $result.matched) { Ok 'verify_app_identity' $result }
                else { Fail 'verify_app_identity' "identity mismatch: expected '$($vparts[1])' got '$($result.title)'" }
            }

            # ── 438: elevation check
            'detect_elevation_required' {
                $result = Detect-ElevationRequired $arg
                Ok 'detect_elevation_required' $result
            }

            # ── 440: missing exe
            'detect_missing_exe' {
                $result = Detect-MissingExe $arg
                Ok 'detect_missing_exe' $result
            }

            # ── foreground info
            'fg' {
                Ok 'fg' (Get-ForegroundInfo)
            }

            default {
                Fail 'unknown' "unknown command: $cmd"
            }
        }
    } catch {
        Fail 'error' $_.Exception.Message
    }
}
