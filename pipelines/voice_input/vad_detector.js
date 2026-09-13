import { EventEmitter } from "node:events";

/**
 * VadDetector (Tickets 028–032, 086)
 *
 * Responsibilities:
 * - 028. Detect silence.
 * - 029. Track silence duration.
 * - 030. Detect speech onset.
 * - 031. Track speech duration.
 * - 032. Detect speech completion.
 * - 086. Test silence handling.
 */
export class VadDetector extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.speechThreshold=0.015] Normalized amplitude threshold for speech
   * @param {number} [opts.silenceDurationToCompleteMs=1200] Continuous silence after speech to declare turn complete
   * @param {number} [opts.minSpeechDurationMs=250] Minimum active speech time before silence completion can trigger
   */
  constructor({
    speechThreshold = 0.015,
    silenceDurationToCompleteMs = 1200,
    minSpeechDurationMs = 250,
  } = {}) {
    super();
    this.speechThreshold = speechThreshold;
    this.silenceDurationToCompleteMs = silenceDurationToCompleteMs;
    this.minSpeechDurationMs = minSpeechDurationMs;

    this.isSpeaking = false;
    this.speechStartTime = null;
    this.speechDurationMs = 0;

    this.silenceStartTime = null;
    this.silenceDurationMs = 0;

    this.hasSpokenInTurn = false;
  }

  /**
   * Process a level reading.
   * @param {object} levelInfo
   * @param {number} levelInfo.normalized Normalized amplitude (0.0 - 1.0)
   * @param {number} [levelInfo.timestamp]
   * @returns {{ isSpeaking: boolean, silenceDurationMs: number, speechDurationMs: number, completed: boolean }}
   */
  processLevel({ normalized, timestamp = Date.now() }) {
    const isAboveThreshold = normalized >= this.speechThreshold;

    if (isAboveThreshold) {
      // Audio detected as speech
      this.silenceStartTime = null;
      this.silenceDurationMs = 0;

      if (!this.isSpeaking) {
        // 030. Detect speech onset
        this.isSpeaking = true;
        this.speechStartTime = timestamp;
        this.hasSpokenInTurn = true;
        this.emit("speech_onset", { timestamp });
      }

      // 031. Track speech duration
      this.speechDurationMs = timestamp - this.speechStartTime;
      this.emit("speech", { durationMs: this.speechDurationMs, normalized });

      return {
        isSpeaking: true,
        silenceDurationMs: 0,
        speechDurationMs: this.speechDurationMs,
        completed: false,
      };
    } else {
      // 028. Detect silence
      if (this.silenceStartTime === null) {
        this.silenceStartTime = timestamp;
      }

      // 029. Track silence duration
      this.silenceDurationMs = timestamp - this.silenceStartTime;

      if (this.isSpeaking) {
        // Speech paused or finished
        this.isSpeaking = false;
      }

      let completed = false;
      // 032. Detect speech completion
      if (
        this.hasSpokenInTurn &&
        this.speechDurationMs >= this.minSpeechDurationMs &&
        this.silenceDurationMs >= this.silenceDurationToCompleteMs
      ) {
        completed = true;
        this.emit("speech_complete", {
          speechDurationMs: this.speechDurationMs,
          silenceDurationMs: this.silenceDurationMs,
          timestamp,
        });
        // Reset turn so we don't continuously fire completion
        this.hasSpokenInTurn = false;
      }

      this.emit("silence", { durationMs: this.silenceDurationMs, normalized });

      return {
        isSpeaking: false,
        silenceDurationMs: this.silenceDurationMs,
        speechDurationMs: this.speechDurationMs,
        completed,
      };
    }
  }

  reset() {
    this.isSpeaking = false;
    this.speechStartTime = null;
    this.speechDurationMs = 0;
    this.silenceStartTime = null;
    this.silenceDurationMs = 0;
    this.hasSpokenInTurn = false;
  }
}
