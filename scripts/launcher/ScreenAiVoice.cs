// ScreenAiVoice.cs — Screen-AI Voice launcher (bootstrapper only).
//
// This executable contains NO application intelligence. It resolves the app
// root, finds the Node runtime, starts the EXISTING production entry
// (voice/start.js), captures logs, reports startup failures, and guarantees
// that only the processes it started are cleaned up (Windows Job Object).
//
// Compiled with the in-box .NET Framework csc.exe -> no runtime to install.
//
//   ScreenAI-Voice.exe              normal launch (real app, no console)
//   ScreenAI-Voice.exe --simulate   development: scripted transcript, real agent
//   ScreenAI-Voice.exe --debug      run through a visible console
//   ScreenAI-Voice.exe --no-dialog  never show dialogs (automation)

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Launcher
{
    private const string MutexName = "Local\\ScreenAI-Voice-Launcher";
    private const string ReadyMarker = "SCREENAI_READY";
    private const string FatalPrefix = "SCREENAI_FATAL:";
    private const string WarnPrefix = "SCREENAI_WARN:";
    private const int ReadyTimeoutMs = 30000;

    private const uint MB_OK = 0x0;
    private const uint MB_ICONERROR = 0x10;
    private const uint MB_ICONWARNING = 0x30;
    private const uint MB_TOPMOST = 0x40000;
    private const uint MB_SETFOREGROUND = 0x10000;

    private static readonly object LogLock = new object();
    private static StreamWriter _log;
    private static string _logPath = "";
    private static string _fatal;
    private static readonly List<string> _warnings = new List<string>();
    private static readonly ManualResetEvent ReadyEvent = new ManualResetEvent(false);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);

    // ------------------------------------------------------------ job object
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;

        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(info, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)length))
            {
                CloseHandle(job);
                return IntPtr.Zero;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return job;
    }

    // ------------------------------------------------------------------ main
    [STAThread]
    private static int Main(string[] args)
    {
        bool debug = Has(args, "--debug");
        bool noDialog = Has(args, "--no-dialog") || debug;

        bool createdNew;
        using (Mutex mutex = new Mutex(true, MutexName, out createdNew))
        {
            if (!createdNew)
            {
                ShowDialog("Screen-AI Voice Agent", "Screen-AI Voice is already running.", MB_ICONWARNING | MB_TOPMOST, noDialog);
                return 0;
            }

            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            string appRoot = ResolveAppRoot(exeDir);
            if (appRoot == null)
            {
                ShowDialog(
                    "Screen-AI Voice Agent",
                    "Could not find the Screen-AI application next to this launcher.\r\n\r\n" +
                    "Expected voice\\start.js in one of:\r\n" +
                    "  " + Path.Combine(exeDir, "app") + "\r\n" +
                    "  " + exeDir,
                    MB_ICONERROR | MB_TOPMOST,
                    noDialog);
                return 1;
            }

            OpenLog(appRoot);
            Log("launcher start; exe dir = " + exeDir);
            Log("app root = " + appRoot);

            string nodePath = FindNode(exeDir);
            if (nodePath == null)
            {
                string message =
                    "Node.js 18 or newer was not found.\r\n\r\n" +
                    "Install Node.js (https://nodejs.org) and make sure 'node' is on PATH,\r\n" +
                    "or place node.exe in the launcher's runtime folder.";
                Log("FATAL: node runtime not found");
                ShowDialog("Screen-AI Voice Agent", message, MB_ICONERROR | MB_TOPMOST, noDialog);
                CloseLog();
                return 1;
            }
            Log("node = " + nodePath);

            string startJs = Path.Combine(appRoot, "voice", "start.js");
            List<string> passThrough = new List<string>();
            if (Has(args, "--simulate")) passThrough.Add("--simulate");
            if (Has(args, "--local")) passThrough.Add("--local");
            if (Has(args, "--offline")) passThrough.Add("--offline");

            int exitCode = debug
                ? RunDebug(appRoot, nodePath, startJs, passThrough)
                : RunNormal(appRoot, nodePath, startJs, passThrough, noDialog);

            Log("launcher exit code = " + exitCode);
            CloseLog();
            return exitCode;
        }
    }

    // --------------------------------------------------------------- running
    private static int RunNormal(string appRoot, string nodePath, string startJs, List<string> passThrough, bool noDialog)
    {
        IntPtr job = CreateKillOnCloseJob();
        Process child = null;
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = nodePath;
            psi.Arguments = Quote(startJs) + (passThrough.Count > 0 ? " " + string.Join(" ", passThrough.ToArray()) : "");
            psi.WorkingDirectory = appRoot;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            child = new Process();
            child.StartInfo = psi;
            child.OutputDataReceived += OnOutput;
            child.ErrorDataReceived += OnOutput;
            child.Start();

            if (job != IntPtr.Zero) AssignProcessToJobObject(job, child.Handle);
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();

            Log("started pid " + child.Id + " : " + psi.Arguments);
            bool ready = WaitForReady(child, ReadyTimeoutMs);

            if (!ready && child.HasExited)
            {
                string message = _fatal;
                if (message == null)
                {
                    message = "Screen-AI Voice stopped during startup (exit code " + child.ExitCode + ").";
                }
                Log("startup failed: " + message);
                ShowStartupError(message, noDialog);
                return 1;
            }

            if (!ready)
            {
                Log("warning: ready signal not observed within " + ReadyTimeoutMs + " ms; continuing");
            }
            else
            {
                Log("app reported ready");
            }

            if (_warnings.Count > 0 && !noDialog)
            {
                ShowDialog("Screen-AI Voice Agent", string.Join("\r\n", _warnings.ToArray()), MB_ICONWARNING | MB_TOPMOST, false);
            }

            child.WaitForExit();
            Log("child exited with code " + child.ExitCode);
            return child.ExitCode;
        }
        catch (Exception ex)
        {
            Log("FATAL: " + ex.Message);
            ShowDialog(
                "Screen-AI Voice Agent",
                "Screen-AI Voice could not start.\r\n\r\n" + ex.Message + "\r\n\r\nLog: " + _logPath,
                MB_ICONERROR | MB_TOPMOST,
                noDialog);
            return 1;
        }
        finally
        {
            // Closing the job terminates ONLY the processes this launcher started.
            if (job != IntPtr.Zero) CloseHandle(job);
            if (child != null)
            {
                try { if (!child.HasExited) child.Kill(); } catch { }
                child.Dispose();
            }
        }
    }

    private static bool WaitForReady(Process child, int timeoutMs)
    {
        Stopwatch watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < timeoutMs)
        {
            if (ReadyEvent.WaitOne(100)) return true;
            if (child.HasExited) return false;
            if (_fatal != null) return false;
        }
        return ReadyEvent.WaitOne(0);
    }

    private static int RunDebug(string appRoot, string nodePath, string startJs, List<string> passThrough)
    {
        Log("debug mode: launching with a visible console");
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = "cmd.exe";
        psi.Arguments = "/k \"" + Quote(nodePath) + " " + Quote(startJs) + (passThrough.Count > 0 ? " " + string.Join(" ", passThrough.ToArray()) : "") + "\"";
        psi.WorkingDirectory = appRoot;
        psi.UseShellExecute = true;

        Process child = Process.Start(psi);
        child.WaitForExit();
        return child.ExitCode;
    }

    private static void OnOutput(object sender, DataReceivedEventArgs e)
    {
        if (e == null || e.Data == null) return;
        string line = e.Data;
        Log(line);
        if (line.IndexOf(ReadyMarker, StringComparison.Ordinal) >= 0) ReadyEvent.Set();
        if (line.StartsWith(FatalPrefix, StringComparison.Ordinal))
        {
            _fatal = line.Substring(FatalPrefix.Length).Trim();
        }
        else if (line.StartsWith(WarnPrefix, StringComparison.Ordinal))
        {
            _warnings.Add(line.Substring(WarnPrefix.Length).Trim());
        }
    }

    // ------------------------------------------------------------- helpers
    private static bool Has(string[] args, string flag)
    {
        for (int i = 0; i < args.Length; i++)
        {
            if (string.Equals(args[i], flag, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static string Quote(string value)
    {
        return "\"" + value + "\"";
    }

    private static string ResolveAppRoot(string baseDir)
    {
        string[] candidates = new string[]
        {
            Path.Combine(baseDir, "app"),
            baseDir,
            Path.GetFullPath(Path.Combine(baseDir, ".."))
        };
        for (int i = 0; i < candidates.Length; i++)
        {
            string entry = Path.Combine(candidates[i], "voice", "start.js");
            if (File.Exists(entry)) return Path.GetFullPath(candidates[i]);
        }
        return null;
    }

    private static string FindNode(string exeDir)
    {
        string bundled = Path.Combine(exeDir, "runtime", "node.exe");
        if (File.Exists(bundled)) return bundled;

        string path = Environment.GetEnvironmentVariable("PATH");
        if (path != null)
        {
            string[] parts = path.Split(';');
            for (int i = 0; i < parts.Length; i++)
            {
                string dir = parts[i].Trim();
                if (dir.Length == 0) continue;
                try
                {
                    string candidate = Path.Combine(dir, "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }
        }
        return null;
    }

    private static void OpenLog(string appRoot)
    {
        string logDir = Path.Combine(appRoot, "logs");
        try
        {
            Directory.CreateDirectory(logDir);
            _logPath = Path.Combine(logDir, "screenai-voice.log");
            _log = new StreamWriter(new FileStream(_logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite));
            _log.AutoFlush = true;
        }
        catch
        {
            string fallback = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ScreenAI-Voice", "logs");
            Directory.CreateDirectory(fallback);
            _logPath = Path.Combine(fallback, "screenai-voice.log");
            _log = new StreamWriter(new FileStream(_logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite));
            _log.AutoFlush = true;
        }
        _log.WriteLine();
        _log.WriteLine("===== Screen-AI Voice " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " =====");
    }

    private static void Log(string line)
    {
        lock (LogLock)
        {
            if (_log == null) return;
            try { _log.WriteLine(DateTime.Now.ToString("HH:mm:ss.fff") + "  " + line); } catch { }
        }
    }

    private static void CloseLog()
    {
        lock (LogLock)
        {
            try { if (_log != null) _log.Flush(); } catch { }
            try { if (_log != null) _log.Dispose(); } catch { }
            _log = null;
        }
    }

    private static void ShowStartupError(string message, bool noDialog)
    {
        string text;
        if (message.IndexOf("ASSEMBLYAI_API_KEY", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            text =
                "Screen-AI Voice Agent\r\n\r\n" +
                "ASSEMBLYAI_API_KEY is not configured.\r\n\r\n" +
                "Set the API key and restart Screen-AI Voice.";
        }
        else
        {
            text =
                "Screen-AI Voice Agent\r\n\r\n" +
                message + "\r\n\r\n" +
                "See the log for details:\r\n" + _logPath;
        }
        ShowDialog("Screen-AI Voice Agent", text, MB_ICONERROR | MB_TOPMOST | MB_SETFOREGROUND, noDialog);
    }

    private static void ShowDialog(string caption, string text, uint type, bool suppressed)
    {
        if (suppressed) return;
        try { MessageBox(IntPtr.Zero, text, caption, type | MB_SETFOREGROUND); } catch { }
    }
}
