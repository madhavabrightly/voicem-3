import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "uia_scan.ps1");

/**
 * UiaDriver — runs the Windows UI Automation scanner script and parses its
 * JSON output into element records. Mirrors the spawn pattern used by
 * WindowsDriver so the two bridges behave consistently.
 */
export class UiaDriver {
  constructor({ powershell = "powershell.exe", script = SCRIPT, timeoutMs = 25000 } = {}) {
    this.powershell = powershell;
    this.script = script;
    this.timeoutMs = timeoutMs;
  }

  /** @returns {Promise<{ok:boolean, elements?:Array, error?:string}>} */
  scan({ maxDepth = 8, maxElements = 2500 } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      const child = spawn(
        this.powershell,
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.script, "-MaxDepth", String(maxDepth), "-MaxElements", String(maxElements)],
        { windowsHide: true }
      );

      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        done({ ok: false, error: "uia scan timed out" });
      }, this.timeoutMs);

      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => done({ ok: false, error: e.message }));
      child.on("close", (code) => {
        if (code !== 0) return done({ ok: false, error: err.trim() || `uia_scan exited (code ${code})` });
        const text = out.trim();
        if (!text) return done({ ok: true, elements: [] });
        try {
          const parsed = JSON.parse(text);
          return done({ ok: true, elements: Array.isArray(parsed) ? parsed : [parsed] });
        } catch (e) {
          return done({ ok: false, error: `uia_scan parse error: ${e.message}` });
        }
      });
    });
  }
}
