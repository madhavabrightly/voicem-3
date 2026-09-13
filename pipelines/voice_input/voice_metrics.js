import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { sanitizeLog } from "./assemblyai_resilience.js";

/**
 * VoiceMetricsCollector (Tickets 069–075, 098, 099)
 *
 * Responsibilities:
 * - 069. Record voice session ID.
 * - 070. Record voice start timestamp.
 * - 071. Record voice end timestamp.
 * - 072. Calculate voice latency.
 * - 073. Calculate transcription latency.
 * - 074. Emit voice metrics.
 * - 075. Log voice metrics.
 * - 098. Verify session cleanup.
 * - 099. Verify logs contain no secrets.
 */
export class VoiceMetricsCollector extends EventEmitter {
  constructor({ logger = console } = {}) {
    super();
    this.logger = logger;
    this.sessionId = null;
    this.startTime = null;
    this.endTime = null;
    this.speechStartTime = null;
    this.speechEndTime = null;
    this.transcriptionCompleteTime = null;
    this.firstPartialTime = null;
    this.turnCount = 0;
  }

  /**
   * 069. Record voice session ID.
   * 070. Record voice start timestamp.
   * @returns {string} Session ID
   */
  startSession() {
    this.sessionId = `vses_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    this.startTime = Date.now();
    this.endTime = null;
    this.speechStartTime = null;
    this.speechEndTime = null;
    this.transcriptionCompleteTime = null;
    this.firstPartialTime = null;
    this.turnCount = 0;

    this.emit("session_start", { sessionId: this.sessionId, startTime: this.startTime });
    return this.sessionId;
  }

  recordSpeechOnset(timestamp = Date.now()) {
    if (!this.speechStartTime) {
      this.speechStartTime = timestamp;
    }
  }

  recordSpeechCompletion(timestamp = Date.now()) {
    this.speechEndTime = timestamp;
  }

  recordFirstPartial(timestamp = Date.now()) {
    if (!this.firstPartialTime) {
      this.firstPartialTime = timestamp;
    }
  }

  recordFinalTranscript(timestamp = Date.now()) {
    this.transcriptionCompleteTime = timestamp;
    this.turnCount++;
  }

  /**
   * 071. Record voice end timestamp.
   * 072. Calculate voice latency.
   * 073. Calculate transcription latency.
   * 074. Emit voice metrics.
   * 075. Log voice metrics.
   */
  endSession() {
    this.endTime = Date.now();

    const voiceDuration = this.speechStartTime && this.speechEndTime ? this.speechEndTime - this.speechStartTime : null;

    // 073. Calculate transcription latency (from speech completion to final transcript)
    const transcriptionLatency =
      this.speechEndTime && this.transcriptionCompleteTime
        ? Math.max(0, this.transcriptionCompleteTime - this.speechEndTime)
        : null;

    const totalSessionDuration = this.startTime ? this.endTime - this.startTime : 0;

    const metrics = {
      sessionId: this.sessionId,
      startTime: this.startTime,
      endTime: this.endTime,
      totalDurationMs: totalSessionDuration,
      voiceDurationMs: voiceDuration,
      transcriptionLatencyMs: transcriptionLatency,
      turnCount: this.turnCount,
      hasFirstPartial: Boolean(this.firstPartialTime),
    };

    // 074. Emit voice metrics
    this.emit("metrics", metrics);

    // 075. Log voice metrics (sanitized: 099)
    const logLine = `[voice:metrics] Session ${this.sessionId}: duration=${totalSessionDuration}ms, transcription_latency=${transcriptionLatency ?? "n/a"}ms, turns=${this.turnCount}`;
    this.logger.log(sanitizeLog(logLine));

    return metrics;
  }

  /**
   * 098. Verify session cleanup.
   */
  cleanup() {
    this.sessionId = null;
    this.startTime = null;
    this.endTime = null;
    this.speechStartTime = null;
    this.speechEndTime = null;
    this.transcriptionCompleteTime = null;
    this.firstPartialTime = null;
    this.turnCount = 0;
    this.emit("cleaned");
  }
}
