/**
 * AssemblyAI realtime transcriber.
 *
 * Single responsibility:
 *   microphone -> AssemblyAI realtime streaming -> transcript events
 *
 * This module knows NOTHING about the agent, planning, perception, tools,
 * Windows automation or screen state. It only turns live microphone PCM into
 * partial/final transcript events. Everything else lives above it, behind the
 * existing VoiceInterface.
 *
 * Events:
 *   open(event)   session established
 *   partial(text) interim transcript (display only — never a command)
 *   final(text)   completed user turn (safe to hand to the agent, once)
 *   error(error)  stream/microphone failure
 *   close(info)   connection closed
 */
import { spawnSync } from "node:child_process";
import { AssemblyAI } from "assemblyai";
import recordLpcm16 from "node-record-lpcm16";

/** Realtime connection configuration (16 kHz mono PCM16). */
export const CONNECTION_PARAMS = {
  sampleRate: 16000,
  speechModel: "universal-3-6-pro",
  mode: "balanced",
  formatTurns: true,
};

export class AssemblyAITranscriber {
  /**
   * @param {object} opts
   * @param {string} [opts.apiKey] defaults to ASSEMBLYAI_API_KEY env var
   * @param {object} [opts.connectionParams] overrides for CONNECTION_PARAMS
   * @param {object} [opts.logger] console-like { log, error } (default console)
   * @param {string} [opts.recorder] node-record-lpcm16 recorder (default "sox")
   */
  constructor({ apiKey = process.env.ASSEMBLYAI_API_KEY, connectionParams = {}, logger = console, recorder = "sox" } = {}) {
    this.apiKey = apiKey || null;
    this.connectionParams = { ...CONNECTION_PARAMS, ...connectionParams };
    this.logger = logger;
    this.recorder = recorder;

    this.client = null;
    this.transcriber = null;
    this.recording = null;
    this.audioStream = null;

    this._listeners = new Map();
    this._finalizedTurns = new Set();
    this._started = false;
  }

  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(callback);
    return this;
  }

  _emit(event, payload) {
    for (const cb of this._listeners.get(event) || []) {
      try {
        cb(payload);
      } catch (err) {
        this._logError(`[voice:error] ${err?.message || err}`);
      }
    }
  }

  _log(line) {
    this.logger.log(line);
  }

  _logError(line) {
    (this.logger.error || this.logger.log).call(this.logger, line);
  }

  async start() {
    if (this._started) return;
    if (!this.apiKey) throw new Error("ASSEMBLYAI_API_KEY is not configured");
    if (!this._recorderAvailable()) throw new Error("Microphone unavailable");

    this.client = new AssemblyAI({ apiKey: this.apiKey });
    this.transcriber = this.client.streaming.transcriber(this.connectionParams);

    this.transcriber.on("open", (event) => {
      this._log(`[voice] Session opened: ${event?.id ?? "unknown"}`);
      this._emit("open", event);
    });
    this.transcriber.on("turn", (event) => this._handleTurn(event));
    this.transcriber.on("error", (error) => {
      this._logError("[voice:error] AssemblyAI stream error");
      this._emit("error", error);
    });
    this.transcriber.on("close", (code, reason) => {
      this._log("[voice] AssemblyAI connection closed");
      this._emit("close", { code, reason });
    });

    try {
      await this.transcriber.connect();
    } catch {
      throw new Error("AssemblyAI connection failed");
    }

    this._startMicrophone();
    this._started = true;
  }

  /** Probes for the SoX binary so a missing recorder is a clean error, not ENOENT. */
  _recorderAvailable() {
    if (this.recorder !== "sox") return true;
    const probe = spawnSync("sox", ["--version"], { stdio: "ignore" });
    return !probe.error;
  }

  _startMicrophone() {
    const recording = recordLpcm16.record({
      sampleRate: this.connectionParams.sampleRate,
      channels: 1,
      recorder: this.recorder,
      audioType: "raw", // headerless PCM16 — streamed straight to AssemblyAI
      endOnSilence: false,
    });
    this.recording = recording;
    this.audioStream = recording.stream();

    this.audioStream.on("data", (chunk) => {
      if (this.transcriber) this.transcriber.sendAudio(chunk);
    });
    this.audioStream.on("error", (error) => {
      this._logError("[voice:error] Microphone unavailable");
      this._emit("error", error);
    });
    // node-record-lpcm16 spawns SoX; guard the child so a spawn failure is handled.
    if (recording.process) {
      recording.process.on("error", (error) => {
        this._logError("[voice:error] Microphone unavailable");
        this._emit("error", error);
      });
    }
  }

  _handleTurn(event) {
    const text = (event?.transcript ?? "").trim();
    const isFinal = event?.end_of_turn === true;

    if (!isFinal) {
      if (text) {
        this._log(`[voice] partial: ${text}`);
        this._emit("partial", text);
      }
      return;
    }

    // A final turn must execute downstream exactly once. AssemblyAI may repeat
    // the completed turn; key on turn_order so only the first is emitted.
    const turnOrder = event?.turn_order;
    if (turnOrder !== undefined) {
      if (this._finalizedTurns.has(turnOrder)) return;
      this._finalizedTurns.add(turnOrder);
    }

    if (!text) return; // ignore empty / whitespace-only finals

    this._log(`[voice] final: ${text}`);
    this._emit("final", text);
  }

  async stop() {
    if (this.recording) {
      try {
        this.recording.stop();
      } catch {
        // already stopped
      }
      this.recording = null;
    }
    if (this.audioStream) {
      this.audioStream.removeAllListeners("data");
      this.audioStream.removeAllListeners("error");
      this.audioStream = null;
    }
    if (this.transcriber) {
      try {
        await this.transcriber.close(true, 3000);
      } catch {
        // connection already gone
      }
      this.transcriber = null;
    }
    this.client = null;
    this._started = false;
  }
}
