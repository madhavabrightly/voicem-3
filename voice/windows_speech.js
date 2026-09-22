import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "windows_speech.ps1");

/**
 * WindowsVoiceInterface — Zero-configuration local speech recognition & TTS.
 *
 * Provides a drop-in implementation of the VoiceInterface contract using the
 * built-in Windows System.Speech runtime (offline, no API key required).
 *
 * Implements:
 *   - onTranscript(cb)   final recognized speech
 *   - onPartial(cb)      interim hypothesized speech
 *   - onAudio(cb)        normalized microphone level (0..1)
 *   - onError(cb)        microphone/engine errors
 *   - start()            start continuous listening
 *   - stop()             stop listening
 *   - speak(text)        text-to-speech output
 */
export class WindowsVoiceInterface {
  constructor({
    powershell = "powershell.exe",
    script = SCRIPT,
    logger = console,
  } = {}) {
    this.powershell = powershell;
    this.script = script;
    this.logger = logger;

    this.child = null;
    this.listening = false;
    this.ready = false;
    this._readyPromise = null;
    this._readyResolve = null;

    this._onTranscript = null;
    this._onPartial = null;
    this._onAudio = null;
    this._onError = null;
    this._buffer = "";
  }

  onTranscript(cb) {
    this._onTranscript = cb;
    return this;
  }

  onPartial(cb) {
    this._onPartial = cb;
    return this;
  }

  onAudio(cb) {
    this._onAudio = cb;
    return this;
  }

  onError(cb) {
    this._onError = cb;
    return this;
  }

  _spawn() {
    if (this.child) return;

    this._readyPromise = new Promise((resolve) => {
      this._readyResolve = resolve;
    });

    this.child = spawn(
      this.powershell,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.script],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }
    );

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    this.child.stdout.on("data", (chunk) => this._onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      const msg = chunk.trim();
      if (msg) this.logger.warn?.(`[windows-speech:stderr] ${msg}`);
    });

    this.child.on("error", (err) => {
      this.logger.error?.(`[windows-speech:error] Process error: ${err.message}`);
      this._onError?.(err);
    });

    this.child.on("exit", (code) => {
      this.child = null;
      this.listening = false;
      this.ready = false;
      if (code !== 0 && code !== null) {
        const err = new Error(`windows_speech exited with code ${code}`);
        this._onError?.(err);
      }
    });
  }

  _onData(chunk) {
    this._buffer += chunk;
    while (true) {
      const idx = this._buffer.indexOf("\n");
      if (idx === -1) break;
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        this._handleMessage(msg);
      } catch {
        // non-JSON output ignore
      }
    }
  }

  _handleMessage(msg) {
    switch (msg?.type) {
      case "ready":
        this.ready = true;
        if (this._readyResolve) {
          this._readyResolve();
          this._readyResolve = null;
        }
        break;

      case "audio":
        if (typeof msg.level === "number") {
          this._onAudio?.(msg.level);
        }
        break;

      case "partial":
        if (msg.text) {
          this._onPartial?.(msg.text);
        }
        break;

      case "transcript":
        if (msg.text) {
          this._onTranscript?.(msg.text);
        }
        break;

      case "error":
        this._onError?.(new Error(msg.message || "Windows speech error"));
        break;

      default:
        break;
    }
  }

  _send(cmd) {
    if (!this.child || !this.child.stdin.writable) return;
    this.child.stdin.write(cmd + "\n");
  }

  async start() {
    if (this.listening) return { ok: true, listening: true };
    this._spawn();
    if (!this.ready && this._readyPromise) {
      await Promise.race([
        this._readyPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Windows speech engine timeout")), 5000)),
      ]);
    }
    this._send("start");
    this.listening = true;
    return { ok: true, listening: true };
  }

  async stop() {
    if (!this.listening) return { ok: true, listening: false };
    this._send("stop");
    this.listening = false;
    return { ok: true, listening: false };
  }

  speak(text) {
    const clean = String(text || "").replace(/[\r\n]+/g, " ").trim();
    if (!clean) return;
    this._spawn();
    this._send(`speak ${clean}`);
  }

  async shutdown() {
    await this.stop();
    if (this.child) {
      this._send("exit");
      try {
        this.child.stdin.end();
      } catch {}
      this.child = null;
    }
  }
}
