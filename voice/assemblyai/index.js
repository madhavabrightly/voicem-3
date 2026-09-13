/**
 * AssemblyAI voice interface.
 *
 * AssemblyAI is the VOICE interface, not the computer-control system.
 * This module handles:
 *   - speech input (STT) via realtime microphone streaming
 *   - conversational turn detection
 *   - voice output (TTS)
 *   I/O only — all intelligence lives in the Agent Orchestrator.
 *
 * It is intentionally isolated: swapping speech providers touches only
 * this directory. The agent never imports assemblyai or the transcriber.
 */
import { AssemblyAITranscriber } from "./transcriber.js";

export { AssemblyAITranscriber, CONNECTION_PARAMS } from "./transcriber.js";

export class VoiceInterface {
  /**
   * @param {object} opts
   * @param {string} [opts.apiKey] AssemblyAI API key (defaults to ASSEMBLYAI_API_KEY env)
   * @param {string} [opts.baseUrl] AssemblyAI base URL (defaults to ASSEMBLYAI_BASE_URL env)
   * @param {Function} [opts.onTranscript] async (text) => voiceAgentResponse; proves the loop
   * @param {Function} [opts.onPartial] (text) => void; display-only interim transcripts
   * @param {Function} [opts.onError] (error) => void; stream/microphone failures
   * @param {Function} [opts.onAudio] (level) => void; microphone RMS level (0..1)
   * @param {Function} [opts.tts] async (text) => audioOut
   * @param {object} [opts.logger] console-like { log, error } (default console)
   * @param {object} [opts.connectionParams] realtime connection overrides
   * @param {object} [opts.transcriber] injectable transcriber (defaults to AssemblyAITranscriber)
   */
  constructor({
    apiKey = process.env.ASSEMBLYAI_API_KEY,
    baseUrl = process.env.ASSEMBLYAI_BASE_URL,
    onTranscript,
    onPartial,
    onError,
    onAudio,
    tts,
    logger = console,
    connectionParams = {},
    transcriber = null,
  } = {}) {
    this.apiKey = apiKey || null;
    this.baseUrl = (baseUrl || "https://api.assemblyai.com").replace(/\/+$/, "");
    this._onTranscript = onTranscript || (async () => "Done.");
    this._onPartial = onPartial || null;
    this._onError = onError || null;
    this._onAudio = onAudio || null;
    this.tts = tts || (async (text) => text);
    this.logger = logger;
    this.connectionParams = connectionParams;
    this.transcriber = transcriber;
    this._ownsTranscriber = false;
    this._wired = false;
    this.listening = false;
  }

  /** Register the callback invoked once per finalized user turn. */
  onTranscript(callback) {
    this._onTranscript = callback;
    return this;
  }

  /** Register the callback for interim (non-final) transcripts. */
  onPartial(callback) {
    this._onPartial = callback;
    return this;
  }

  /** Register the callback for transcriber/stream/microphone errors. */
  onError(callback) {
    this._onError = callback;
    return this;
  }

  /** Register the callback for microphone RMS levels (0..1) — drives the UI core. */
  onAudio(callback) {
    this._onAudio = callback;
    return this;
  }

  async start() {
    if (this.listening) return { ok: true, listening: true };
    if (!this.transcriber) {
      this.transcriber = new AssemblyAITranscriber({
        apiKey: this.apiKey,
        connectionParams: this.connectionParams,
        logger: this.logger,
      });
      this._ownsTranscriber = true;
    }
    // Wire listeners at most once per transcriber, so a retried start() can
    // never register a second "final" handler (which would double-execute).
    if (!this._wired) {
      if (this._onPartial) this.transcriber.on("partial", (text) => this._onPartial(text));
      this.transcriber.on("final", (text) => this._handleFinal(text));
      this.transcriber.on("error", (error) => this._handleError(error));
      this.transcriber.on("audio", (level) => {
        if (this._onAudio) this._onAudio(level);
      });
      this._wired = true;
    }
    try {
      await this.transcriber.start();
    } catch (err) {
      if (this._ownsTranscriber) this.transcriber = null;
      this._wired = false;
      throw err;
    }
    this.listening = true;
    return { ok: true, listening: true };
  }

  async stop() {
    this.listening = false;
    if (this.transcriber) {
      await this.transcriber.stop();
      if (this._ownsTranscriber) this.transcriber = null;
      this._wired = false;
    }
    return { ok: true, listening: false };
  }

  /** Only finalized, non-empty turns reach the agent, exactly once. */
  async _handleFinal(transcript) {
    const text = (transcript ?? "").trim();
    if (!text) return;
    try {
      await this.turn(text);
    } catch (err) {
      this._error(`[agent:error] Task execution failed: ${err?.message || err}`);
    }
  }

  /** Forward a transcriber/stream/microphone error to the onError callback. */
  _handleError(error) {
    if (!this._onError) return;
    try {
      this._onError(error);
    } catch (err) {
      this._error(`[voice:error] ${err?.message || err}`);
    }
  }

  _error(line) {
    (this.logger.error || this.logger.log).call(this.logger, line);
  }

  /**
   * Handles a recognized turn: forwards to the orchestrator driver and
   * plays the spoken response.
   * @param {string} transcript
   */
  async turn(transcript) {
    const text = await this._onTranscript(transcript);
    return this.tts(text);
  }
}

/**
 * Builds the voice<->agent bridge: given an orchestrator, wire a
 * finalized transcript to a full agent run and speak the result.
 */
export function createVoiceHandler(orchestrator, { tts, onPartial, onError, onUserTurn, logger = console, connectionParams } = {}) {
  return new VoiceInterface({
    logger,
    connectionParams,
    onPartial,
    onError,
    onTranscript: async (transcript) => {
      if (onUserTurn) onUserTurn(transcript);
      try {
        const result = await orchestrator.run(transcript);
        return result.spoken;
      } catch (err) {
        logger.error(`[agent:error] Task execution failed: ${err?.message || err}`);
        return "Sorry, something went wrong.";
      }
    },
    tts,
  });
}
