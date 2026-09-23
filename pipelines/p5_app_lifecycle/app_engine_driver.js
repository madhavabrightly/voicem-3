/**
 * app_engine_driver.js — Node.js driver for the two native P5 agents.
 *
 * Spawns app_engine.ps1 and startup_probe.ps1 as persistent subprocesses,
 * talks JSON-lines over stdio using the same Base64-framed protocol as the
 * existing WindowsDriver / win-agent.ps1 pair.
 *
 * Exposes clean async methods for the Node semantic layer.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = join(__dirname, "../../native/app_engine");

const APP_ENGINE_PS1  = join(NATIVE_DIR, "app_engine.ps1");
const STARTUP_PROBE_PS1 = join(NATIVE_DIR, "startup_probe.ps1");
const AHK_SCRIPT      = join(NATIVE_DIR, "ahk_fallback.ahk");

/**
 * Thin wrapper around a persistent PowerShell subprocess using the
 * Base64-framed JSON-lines protocol.
 */
class PsAgent {
  constructor(scriptPath, label) {
    this._script  = scriptPath;
    this._label   = label;
    this._child   = null;
    this._buf     = "";
    this._pending = [];
  }

  _start() {
    if (this._child) return;
    this._child = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this._script,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!this._child.pid) {
      this._child = null;
      throw new Error(`[${this._label}] failed to spawn PowerShell`);
    }
    this._child.stdout.setEncoding("utf8");
    this._child.stderr.setEncoding("utf8");
    this._child.stdout.on("data", (d) => this._onData(d));
    this._child.stderr.on("data", (d) => {
      if (this._pending.length) this._pending[0].stderr += d;
    });
    this._child.on("error", (err) => {
      for (const p of this._pending.splice(0)) p.reject(err);
    });
    this._child.on("exit", (code) => {
      const err = new Error(`[${this._label}] exited (code ${code})`);
      for (const p of this._pending.splice(0)) p.reject(err);
      this._child = null;
    });
  }

  _onData(d) {
    this._buf += d;
    while (true) {
      const nl = this._buf.indexOf("\n");
      if (nl === -1) return;
      const lenStr = this._buf.slice(0, nl).trim();
      const len    = parseInt(lenStr, 10);
      if (!Number.isFinite(len)) { this._buf = this._buf.slice(nl + 1); continue; }
      if (this._buf.length < nl + 1 + len) return;
      const b64    = this._buf.slice(nl + 1, nl + 1 + len);
      this._buf    = this._buf.slice(nl + 1 + len);
      const p      = this._pending.shift();
      if (!p) continue;
      let obj;
      try {
        obj = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      } catch {
        obj = { ok: false, kind: "parse_error", error: b64.slice(0, 300) };
      }
      if (obj.ok) p.resolve(obj);
      else p.reject(new Error(obj.error || `${this._label} command failed`));
    }
  }

  send(cmdLine) {
    if (!this._child) this._start();
    return new Promise((resolve, reject) => {
      this._pending.push({ resolve, reject, stderr: "" });
      this._child.stdin.write(cmdLine + "\n");
    });
  }

  async cmd(cmdLine) {
    try {
      const res = await this.send(cmdLine);
      return { success: true, ...res };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  stop() {
    if (!this._child) return;
    try { this._child.stdin.write("exit\n"); } catch {}
    const c = this._child; this._child = null;
    setTimeout(() => { try { c.kill(); } catch {} }, 200).unref();
  }
}

// ─────────────────────────────────── AHK fallback ───────────────────────────

class AhkAgent {
  constructor() {
    this._available = null; // null=unchecked, false=unavailable, true=available
    this._child = null;
    this._pending = [];
    this._buf = "";
  }

  async isAvailable() {
    if (this._available !== null) return this._available;
    // Try to find AutoHotkey.exe
    const candidates = [
      "AutoHotkey.exe",
      "AutoHotkeyU64.exe",
      process.env.AHK_PATH,
    ].filter(Boolean);
    for (const c of candidates) {
      try {
        const { execSync } = await import("node:child_process");
        execSync(`where ${c}`, { stdio: "ignore" });
        this._available = true;
        this._ahkExe = c;
        return true;
      } catch {}
    }
    this._available = false;
    return false;
  }

  async _start() {
    if (this._child) return;
    if (!await this.isAvailable()) throw new Error("AHK not installed");
    this._child = spawn(this._ahkExe, [AHK_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this._child.stdout.setEncoding("utf8");
    this._child.stdout.on("data", (d) => {
      this._buf += d;
      const nl = this._buf.indexOf("\n");
      if (nl === -1) return;
      const line = this._buf.slice(0, nl).trim();
      this._buf  = this._buf.slice(nl + 1);
      const p = this._pending.shift();
      if (!p) return;
      try { p.resolve(JSON.parse(line)); } catch { p.resolve({ ok: false, error: line }); }
    });
    this._child.on("exit", () => { this._child = null; });
  }

  async cmd(obj) {
    if (!await this.isAvailable()) return { ok: false, error: "AHK not installed" };
    await this._start();
    return new Promise((resolve, reject) => {
      this._pending.push({ resolve, reject });
      this._child.stdin.write(JSON.stringify(obj) + "\n");
    });
  }

  stop() {
    if (this._child) { try { this._child.kill(); } catch {} this._child = null; }
  }
}

// ─────────────────────────────────── AppEngineDriver ────────────────────────

export class AppEngineDriver {
  constructor() {
    this._app     = new PsAgent(APP_ENGINE_PS1,    "app_engine");
    this._probe   = new PsAgent(STARTUP_PROBE_PS1, "startup_probe");
    this._ahk     = new AhkAgent();
  }

  // ── discovery (tickets 401–413) ─────────────────────────────────────────
  async enumApps()                { return this._app.cmd("enum_apps"); }
  async enumWindows(filter = "visible") { return this._app.cmd(`enum_windows ${filter}`); }

  // ── identity resolution (tickets 418–430) ───────────────────────────────
  async resolveApp(name)          { return this._app.cmd(`resolve_app ${name}`); }

  // ── running / responsive / hung (tickets 435–437) ───────────────────────
  async detectRunning(name)       { return this._app.cmd(`detect_running ${name}`); }
  async detectResponsive(hwnd)    { return this._app.cmd(`detect_responsive ${hwnd}`); }
  async detectHung(hwnd)          { return this._app.cmd(`detect_hung ${hwnd}`); }

  // ── launch command resolution (tickets 441–444) ─────────────────────────
  async resolveLaunchCmd(name)    { return this._app.cmd(`resolve_launch_cmd ${name}`); }

  // ── deterministic launch (tickets 446–449) ──────────────────────────────
  async launchApp(name) {
    const r = await this._app.cmd(`launch_app ${name}`);
    // AHK fallback path (ticket 446 fallback)
    if (!r.success && r.data?.ahk_fallback) {
      const ahkOk = await this._ahk.isAvailable();
      if (ahkOk) {
        const ar = await this._ahk.cmd({ cmd: "win_exists", name });
        if (ar.ok && ar.running) {
          const fa = await this._ahk.cmd({ cmd: "win_activate", name });
          if (fa.ok) return { success: true, action: "ahk_activate", hwnd: fa.hwnd };
        }
        const fr = await this._ahk.cmd({ cmd: "run_app", name });
        if (fr.ok) {
          const fw = await this._ahk.cmd({ cmd: "win_wait", name, timeout: 12000 });
          return { success: fw.ok, action: "ahk_launch", hwnd: fw.hwnd, error: fw.ok ? undefined : "AHK win_wait timed out" };
        }
      }
    }
    return r;
  }

  // ── capture new window (ticket 448) ─────────────────────────────────────
  async captureNewWindow(pid)     { return this._app.cmd(`capture_new_window ${pid}`); }

  // ── verify identity (ticket 449) ────────────────────────────────────────
  async verifyAppIdentity(hwnd, name) { return this._app.cmd(`verify_app_identity ${hwnd} ${name}`); }

  // ── elevation / missing (tickets 438, 440) ──────────────────────────────
  async detectElevationRequired(path) { return this._app.cmd(`detect_elevation_required ${path}`); }
  async detectMissingExe(path)    { return this._app.cmd(`detect_missing_exe ${path}`); }

  // ── foreground info ──────────────────────────────────────────────────────
  async foreground()              { return this._app.cmd("fg"); }

  // ── startup phase (tickets 451–463) ─────────────────────────────────────
  async detectStartupPhase(hwnd)  { return this._probe.cmd(`detect_startup_phase ${hwnd}`); }
  async detectUiaReady(hwnd)      { return this._probe.cmd(`detect_uia_ready ${hwnd}`); }
  async pollResponsive(hwnd, ms = 10000) { return this._probe.cmd(`poll_responsive ${hwnd} ${ms}`); }

  // ── dialog detection (tickets 465–475) ──────────────────────────────────
  async detectDialogs(hwnd)       { return this._probe.cmd(`detect_dialogs ${hwnd}`); }
  async classifyDialog(hwnd)      { return this._probe.cmd(`classify_dialog ${hwnd}`); }

  // ── foreground management (tickets 481–495) ─────────────────────────────
  async verifyForeground(hwnd)    { return this._probe.cmd(`verify_foreground ${hwnd}`); }
  async restoreMinimized(hwnd)    { return this._probe.cmd(`restore_minimized ${hwnd}`); }

  // ── UIA snapshot (ticket 484) ────────────────────────────────────────────
  async uiaSnapshot(hwnd, depth = 3) { return this._probe.cmd(`uia_snapshot ${hwnd} ${depth}`); }

  // ── post-launch capture (ticket 496) ────────────────────────────────────
  async capturePostLaunch(hwnd)   { return this._probe.cmd(`capture_post_launch ${hwnd}`); }

  // ── AHK helpers (direct, for when PS1 methods succeed but AHK preferred) ─
  async ahkIsAvailable()         { return this._ahk.isAvailable(); }
  async ahkCmd(obj)              { return this._ahk.cmd(obj); }

  stop() {
    this._app.stop();
    this._probe.stop();
    this._ahk.stop();
  }
}

// Singleton for convenience — import and reuse across the pipeline
export const appEngineDriver = new AppEngineDriver();
