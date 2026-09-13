/**
 * Voice UI bridge — the presentation layer's link to the EXISTING backend.
 *
 *   Floating WPF overlay  <-- JSON lines -->  VoiceUiBridge
 *                                                   |
 *                                            VoiceInterface
 *                                                   |
 *                                     AssemblyAITranscriber (mic)
 *                                                   |
 *                                        Agent Orchestrator (real)
 *
 * The UI never talks to OCR, Windows tools or AssemblyAI directly. It only
 * receives voice amplitude, transcript text and agent state, and returns
 * activation / cancellation intents.
 *
 * States: idle -> listening -> processing -> working -> success | failure -> idle
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLogger } from "../backend/core/logger.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_UI_SCRIPT = join(HERE, "..", "ui", "screenai-voice-ui.ps1");

export const UI_STATES = {
  IDLE: "idle",
  LISTENING: "listening",
  PROCESSING: "processing",
  WORKING: "working",
  SUCCESS: "success",
  FAILURE: "failure",
};

/** Human label for a planner step — real progress, not a fake animation. */
export function stepToLabel(step = {}) {
  const target = step?.target ? ` ${step.target}` : "";
  switch (step?.type) {
    case "open_app":
      return `Opening${target}...`;
    case "focus":
      return `Focusing${target}...`;
    case "find_element":
      return `Finding${target}...`;
    case "click":
      return `Clicking${target}...`;
    case "type": {
      const text = step?.args?.text;
      return text ? `Typing "${text}"...` : "Typing...";
    }
    case "press":
      return "Pressing key...";
    case "scroll":
      return "Scrolling...";
    case "read_screen":
      return "Reading screen...";
    case "wait":
      return "Waiting...";
    case "verify":
      return "Verifying...";
    default:
      return step?.type ? `${step.type}...` : "Working...";
  }
}

/** Default channel: spawn the PowerShell WPF overlay and talk JSON lines. */
export class StdioUiChannel {
  constructor({ script = DEFAULT_UI_SCRIPT, powershell = "powershell.exe" } = {}) {
    this.child = spawn(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this._handlers = [];
    this._buffer = "";
    this.exited = false;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this._onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) process.stderr.write(`[ui:stderr] ${text}\n`);
    });
    this.child.on("exit", () => {
      this.exited = true;
    });
    this.child.on("error", () => {
      this.exited = true;
    });
  }

  _onData(chunk) {
    this._buffer += chunk;
    let index;
    while ((index = this._buffer.indexOf("\n")) >= 0) {
      const line = this._buffer.slice(0, index).trim();
      this._buffer = this._buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      for (const handler of this._handlers) {
        try {
          handler(message);
        } catch {
          // UI message handlers never break the bridge
        }
      }
    }
  }

  onMessage(callback) {
    this._handlers.push(callback);
    return this;
  }

  send(message) {
    if (this.child?.stdin?.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close() {
    try {
      this.child.stdin.end();
    } catch {
      // already closed
    }
    try {
      this.child.kill();
    } catch {
      // already gone
    }
  }
}

export class VoiceUiBridge {
  /**
   * @param {object} opts
   * @param {object} opts.orchestrator existing agent orchestrator (run(goal))
   * @param {object} opts.voice        VoiceInterface-shaped: start/stop/onAudio/onPartial/onTranscript/onError
   * @param {object} [opts.ui]         injectable UI channel ({send,onMessage,close}); default spawns WPF
   * @param {object} [opts.logger]     console-like {log,error}
   * @param {number} [opts.amplitudeGain]  mic gain applied before smoothing
   * @param {number} [opts.smoothing]      EMA factor (0..1)
   * @param {number} [opts.throttleMs]     amplitude send interval
   * @param {number} [opts.successHoldMs]  how long success stays before collapsing
   */
  constructor({
    orchestrator,
    voice,
    ui = null,
    logger = console,
    onReady = null,
    onQuit = null,
    amplitudeGain = 3,
    smoothing = 0.35,
    throttleMs = 33,
    successHoldMs = 1400,
  } = {}) {
    this.onReady = onReady;
    this.onQuit = onQuit;
    this.orchestrator = orchestrator;
    this.voice = voice;
    this.ui = ui || new StdioUiChannel();
    this.logger = logger;
    this.amplitudeGain = amplitudeGain;
    this.smoothing = smoothing;
    this.throttleMs = throttleMs;
    this.successHoldMs = successHoldMs;

    this.state = UI_STATES.IDLE;
    this.amplitude = 0;
    this.lastCommand = null;
    this._active = false;
    this._lastAmpSent = 0;
    this._timers = new Set();
    this._unsubscribeLogger = null;
  }

  /** Spawn/bind the UI, wire the voice callbacks, show idle. */
  start() {
    this.ui.onMessage((message) => this._onUiMessage(message));

    this.voice.onPartial?.((text) => this._sendTranscript(text, false));
    this.voice.onAudio?.((level) => this._onAudio(level));
    this.voice.onError?.((error) => this._onVoiceError(error));
    this.voice.onTranscript?.(async (transcript) => {
      const text = String(transcript ?? "").trim();
      if (!text) return "";
      this._sendTranscript(text, true);
      const result = await this._runAgent(text);
      return result?.spoken ?? "";
    });

    // Subscribe to REAL agent progress (step events) for the working animation.
    this._unsubscribeLogger = getLogger().on((entry) => {
      if (!this._active) return;
      if (entry.stage === "decision" && entry.event === "step_start") {
        this._setState(UI_STATES.WORKING, stepToLabel(entry.data));
      }
    });

    this._setState(UI_STATES.IDLE, "");
    return this;
  }

  /** Global hotkey pressed / core clicked. */
  async activate() {
    if (this.state !== UI_STATES.IDLE && this.state !== UI_STATES.FAILURE) return;
    this._setState(UI_STATES.LISTENING, "Connecting...");
    try {
      await this.voice.start();
      this._setState(UI_STATES.LISTENING, "Listening");
    } catch (error) {
      const message = String(error?.message || error);
      const label = /microphone/i.test(message) ? "Microphone unavailable" : "Couldn't connect";
      this._setState(UI_STATES.FAILURE, label);
      this.logger.error?.(`[ui:error] ${message}`);
    }
  }

  /** Escape / hotkey again / dismiss. */
  async cancel() {
    await this._stopVoice();
    this._setState(UI_STATES.IDLE, "");
  }

  /** Retry the last command after a failure. */
  async retry() {
    if (this.state !== UI_STATES.FAILURE || !this.lastCommand) return;
    await this._runAgent(this.lastCommand);
  }

  async stop() {
    await this._stopVoice();
    if (this._unsubscribeLogger) this._unsubscribeLogger();
    this._unsubscribeLogger = null;
    for (const timer of this._timers) clearTimeout(timer);
    this._timers.clear();
    try {
      this.ui.close();
    } catch {
      // already closed
    }
  }

  // ---------------------------------------------------------------- internals
  async _onUiMessage(message) {
    switch (message?.type) {
      case "activate":
        await this.activate();
        break;
      case "deactivate":
      case "cancel":
        await this.cancel();
        break;
      case "retry":
        await this.retry();
        break;
      case "ready":
        this._setState(this.state, this.state === UI_STATES.IDLE ? "" : undefined);
        if (this.onReady) this.onReady();
        break;
      case "quit":
        if (this.onQuit) this.onQuit();
        break;
      default:
        break;
    }
  }

  async _runAgent(transcript) {
    this.lastCommand = transcript;
    this._setState(UI_STATES.PROCESSING, "Understanding...");
    this._active = true;
    let result = null;
    try {
      result = await this.orchestrator.run(transcript);
    } catch (error) {
      this.logger.error?.(`[agent:error] Task execution failed: ${error?.message || error}`);
    } finally {
      this._active = false;
    }

    const ok = Boolean(result?.final?.success);
    if (ok) {
      this._setState(UI_STATES.SUCCESS, "Done");
      this._timers.add(
        setTimeout(async () => {
          await this._stopVoice();
          if (this.state === UI_STATES.SUCCESS) this._setState(UI_STATES.IDLE, "");
        }, this.successHoldMs)
      );
    } else {
      this._setState(UI_STATES.FAILURE, result ? "Couldn't verify" : "Task failed");
    }
    return result;
  }

  async _stopVoice() {
    try {
      await this.voice.stop?.();
    } catch {
      // already stopped
    }
    this.amplitude = 0;
    this._sendAmplitude(0);
  }

  _onAudio(level) {
    const target = Math.min(1, Math.max(0, Number(level) * this.amplitudeGain));
    this.amplitude += (target - this.amplitude) * this.smoothing;
    const now = Date.now();
    if (now - this._lastAmpSent >= this.throttleMs) {
      this._lastAmpSent = now;
      this._sendAmplitude(this.amplitude);
    }
  }

  _onVoiceError(error) {
    this.logger.error?.(`[voice:error] ${error?.message || error}`);
    if (this.state === UI_STATES.IDLE) return;
    const label = /microphone/i.test(String(error?.message || "")) ? "Microphone unavailable" : "Voice error";
    this._setState(UI_STATES.FAILURE, label);
  }

  _setState(state, label) {
    this.state = state;
    this.ui.send({ type: "state", state, ...(label === undefined ? {} : { label }) });
  }

  _sendTranscript(text, final) {
    this.ui.send({ type: "transcript", text: text ?? "", final: Boolean(final) });
  }

  _sendAmplitude(value) {
    this.ui.send({ type: "amplitude", value: Math.round(value * 1000) / 1000 });
  }
}
