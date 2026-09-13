/**
 * AssemblyAI realtime transcriber.
 *
 * Single responsibility:
 *   microphone -> AssemblyAI realtime streaming -> transcript events
 *
 * This module is wired to the P1 Voice Input Pipeline (Tickets 001–100),
 * providing 16kHz PCM capture, real RMS amplitude, VAD silence tracking,
 * resilience, and turn deduplication.
 *
 * Events:
 *   open(event)       session established
 *   partial(text)     interim transcript (display only — never a command)
 *   final(text)       completed user turn (safe to hand to the agent, once)
 *   level(data)       real-time audio amplitude (RMS + EMA)
 *   audio(level)      microphone RMS level (0..1) — drives the floating UI voice core
 *   error(error)      stream/microphone failure
 *   close(info)       connection closed
 */
import {
  VoiceInputPipeline,
  DEFAULT_CONNECTION_PARAMS,
} from "../../pipelines/voice_input/index.js";

/** Realtime connection configuration (16 kHz mono PCM16). */
export const CONNECTION_PARAMS = {
  sampleRate: 16000,
  speechModel: process.env.ASSEMBLYAI_SPEECH_MODEL || "universal-3-6-pro",
  mode: "balanced",
  formatTurns: true,
  maxConnectionRetries: 2,
  connectionRetryDelay: 500,
  ...DEFAULT_CONNECTION_PARAMS,
};

/**
 * Normalised RMS level (0..1) of a mono 16-bit little-endian PCM buffer.
 * The floating UI's voice core is driven from the SAME audio chunks that are
 * streamed to AssemblyAI — never a second, competing microphone capture.
 */
export function pcm16Level(buffer) {
  const samples = Math.floor(buffer.length / 2);
  if (samples <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = buffer.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

export class AssemblyAITranscriber {
  /**
   * @param {object} opts
   * @param {string} [opts.apiKey] defaults to ASSEMBLYAI_API_KEY env var
   * @param {object} [opts.connectionParams] overrides for CONNECTION_PARAMS
   * @param {object} [opts.logger] console-like { log, error } (default console)
   * @param {string} [opts.recorder] node-record-lpcm16 recorder (default "sox")
   * @param {object} [opts.pipeline] injectable VoiceInputPipeline
   */
  constructor({
    apiKey = process.env.ASSEMBLYAI_API_KEY,
    connectionParams = {},
    logger = console,
    recorder = "sox",
    pipeline = null,
  } = {}) {
    this.apiKey = apiKey || null;
    this.connectionParams = { ...CONNECTION_PARAMS, ...connectionParams };
    this.logger = logger;
    this.recorder = recorder;

    this.client = null;
    this.transcriber = null;
    this.recording = null;
    this.audioStream = null;

    this._listeners = new Map();
    this._started = false;

    // Wire to the P1 Voice Input Pipeline
    this.pipeline =
      pipeline ||
      new VoiceInputPipeline({
        apiKey: this.apiKey,
        connectionParams: this.connectionParams,
        logger: this.logger,
        components: {
          recorder: this.recorder,
        },
      });

    this._wirePipelineEvents();
  }

  _wirePipelineEvents() {
    this.pipeline.assemblyAi.on("open", (evt) => {
      this._emit("open", evt);
    });

    this.pipeline.on("partial_transcript", (p) => {
      this._emit("partial", p.text);
    });

    this.pipeline.on("final_transcript", (f) => {
      this._emit("final", f.text);
    });

    this.pipeline.on("audio_level", (levelData) => {
      this._emit("level", levelData);
      this._emit("amplitude", levelData);
      // Normalized float 0..1 for UI voice core
      this._emit("audio", levelData.smoothed);
    });

    this.pipeline.on("speech_complete", (data) => {
      this._emit("speech_complete", data);
    });

    this.pipeline.on("mic_error", (err) => {
      this._emit("error", err);
    });

    this.pipeline.on("assemblyai_error", (err) => {
      this._emit("error", err);
    });

    this.pipeline.assemblyAi.on("close", (info) => {
      this._emit("close", info);
    });
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
        (this.logger.error || this.logger.log).call(this.logger, `[voice:error] ${err?.message || err}`);
      }
    }
  }

  async start() {
    if (this._started) return;

    await this.pipeline.start();

    // Mirror instances for backward compatibility
    this.transcriber = this.pipeline.assemblyAi.transcriber;
    this.client = this.pipeline.assemblyAi.client;
    this.recording = this.pipeline.mic.activeRecording;
    this.audioStream = this.pipeline.mic.audioStream;
    this._started = true;
  }

  /**
   * Directly process a turn event (used by test harnesses and streaming bridge).
   * @param {object} event AssemblyAI turn object
   */
  _handleTurn(event) {
    this.pipeline._handleAssemblyAiTurn(event);
  }

  async stop() {
    if (!this._started) return;
    await this.pipeline.stop();
    this.transcriber = null;
    this.client = null;
    this.recording = null;
    this.audioStream = null;
    this._started = false;
  }
}
