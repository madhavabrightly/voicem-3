import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_SCRIPT = join(__dirname, "win-agent.ps1");

/**
 * Real Windows PlatformDriver.
 *
 * Spawns one persistent PowerShell (pwsh) subprocess running win-agent.ps1
 * and talks JSON-lines over stdio. All real computer control happens there:
 *   - window discovery / focus / app launch
 *   - full-screen capture
 *   - Windows.Media.Ocr (Windows OCR engine)
 *   - SendKeys input + Win32 mouse events
 *
 * Method signatures match the PlatformDriver abstraction exactly, so the
 * ToolBox / Orchestrator / Perception layers are unchanged.
 */
export class WindowsDriver {
  constructor({ pwsh = "powershell.exe", script = AGENT_SCRIPT, captureDir = null } = {}) {
    this.pwsh = pwsh;
    this.script = script;
    this.child = null;
    this.buf = "";
    this.pending = [];
    this._seq = 0;
    this.captureDir =
      captureDir ?? join(tmpdir(), "voice-agent-win");
    mkdirSync(this.captureDir, { recursive: true });
  }

  // ------------------------------------------------------------ lifecycle
  start() {
    if (this.child) return this;
    this.child = spawn(this.pwsh, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: false,
    });
    if (!this.child.pid) {
      const e = new Error(`failed to spawn ${this.pwsh}`);
      this.child = null;
      throw e;
    }
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (d) => this._onData(d));
    this.child.stderr.on("data", (d) => {
      if (this.pending.length) this.pending[0].stderr += d;
    });
    this.child.on("error", (err) => {
      for (const p of this.pending.splice(0)) p.reject(err);
    });
    this.child.on("exit", (code) => {
      const err = new Error(`win-agent exited (code ${code})`);
      for (const p of this.pending.splice(0)) p.reject(err);
    });
    return this;
  }

  _onData(d) {
    this.buf += d;
    // Base64 length-prefixed framing: "<b64len>\n<b64payload>"
    while (true) {
      const nl = this.buf.indexOf("\n");
      if (nl === -1) return;
      const lenStr = this.buf.slice(0, nl).trim();
      const len = parseInt(lenStr, 10);
      if (!Number.isFinite(len)) {
        this.buf = this.buf.slice(nl + 1);
        continue;
      }
      if (this.buf.length < nl + 1 + len) return; // wait for full frame
      const b64 = this.buf.slice(nl + 1, nl + 1 + len);
      this.buf = this.buf.slice(nl + 1 + len);
      const p = this.pending.shift();
      if (!p) continue;
      let obj = null;
      try {
        const json = Buffer.from(b64, "base64").toString("utf8");
        obj = JSON.parse(json);
      } catch {
        obj = { ok: false, kind: "parse_error", error: b64.slice(0, 300) };
      }
      if (obj.ok) p.resolve(obj);
      else p.reject(new Error(obj.error || "win-agent command failed"));
    }
  }

  _send(cmd, arg = "") {
    if (!this.child) this.start();
    const line = arg ? `${cmd} ${arg}` : cmd;
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject, stderr: "" });
      this.child.stdin.write(line + "\n");
    });
  }

  async _cmd(cmd, arg = "") {
    try {
      const res = await this._send(cmd, arg);
      return { success: true, ...res };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  stop() {
    if (!this.child) return;
    try {
      this.child.stdin.end();
    } catch {}
    // give it a moment to flush, then kill if needed
    const c = this.child;
    this.child = null;
    setTimeout(() => c.kill(), 150).unref();
  }

  // ------------------------------------------------------------ PlatformDriver interface
  async launch(appName) {
    return this._cmd("launch", appName);
  }

  async focus(appName) {
    return this._cmd("focus", appName);
  }

  async click(x, y) {
    const r = await this._cmd("click", `${x} ${y}`);
    if (!r.success) return r;
    return { success: true, x, y };
  }

  async typeText(text) {
    const r = await this._cmd("type", text);
    if (!r.success) return r;
    return { success: true, text };
  }

  async pressKey(key) {
    const r = await this._cmd("press", key);
    if (!r.success) return r;
    return { success: true, key };
  }

  async scroll(direction) {
    const r = await this._cmd("scroll", direction);
    if (!r.success) return r;
    return { success: true, direction };
  }

  /** foreground() -> { success, data: {title, proc, pid, class} } */
  async foreground() {
    const r = await this._cmd("fg");
    if (!r.success) return null;
    return r.data || null;
  }

  /** capture() -> { success, path, width, height } (PNG on disk) */
  async capture() {
    const r = await this._cmd("capture");
    if (!r.success) return r;
    const d = r.data || {};
    return { success: true, path: d.path, width: d.width, height: d.height };
  }

  /** ocr() -> { success, lines:[{text,x,y,w,h,words}], capturePath, width, height } */
  async ocr() {
    const r = await this._cmd("ocr");
    if (!r.success) return r;
    const d = r.data || {};
    return {
      success: true,
      lines: d.lines || [],
      capturePath: d.capturePath || "",
      width: d.width || 0,
      height: d.height || 0,
    };
  }
}
