import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import recordLpcm16 from "node-record-lpcm16";

export const MicState = {
  UNINITIALIZED: "UNINITIALIZED",
  READY: "READY",
  RECORDING: "RECORDING",
  STOPPED: "STOPPED",
  ERROR: "ERROR",
  RECOVERING: "RECOVERING",
};

/**
 * MicrophoneEngine (Tickets 005–012, 018–027, 076, 077, 085, 090, 091)
 *
 * Responsibilities:
 * - 005. Initialize microphone capture.
 * - 006. Verify microphone availability.
 * - 007. Select default input device.
 * - 008. Validate microphone sample rate.
 * - 009. Configure 16 kHz capture.
 * - 010. Configure mono capture.
 * - 011. Configure PCM16 audio.
 * - 012. Start PCM stream.
 * - 018. Detect microphone capture errors.
 * - 019. Detect microphone disconnect.
 * - 020. Recover microphone stream.
 * - 021. Stop microphone on Escape.
 * - 022. Stop microphone after final turn.
 * - 023. Prevent duplicate microphone streams.
 * - 024. Track microphone lifecycle.
 * - 025. Log microphone start.
 * - 026. Log microphone stop.
 * - 027. Log microphone errors.
 * - 091. Verify no orphan audio process.
 */
export class MicrophoneEngine extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.sampleRate=16000]
   * @param {number} [opts.channels=1]
   * @param {string} [opts.recorder="sox"]
   * @param {string} [opts.device="default"]
   * @param {object} [opts.recorderLib] injectable recording library (defaults to node-record-lpcm16)
   * @param {object} [opts.logger=console]
   */
  constructor({
    sampleRate = 16000,
    channels = 1,
    recorder = "sox",
    device = "default",
    recorderLib = recordLpcm16,
    logger = console,
  } = {}) {
    super();

    // 008. Validate microphone sample rate
    if (![8000, 16000, 24000, 32000, 44100, 48000].includes(sampleRate)) {
      throw new Error(`Invalid sample rate: ${sampleRate}. Must be a standard PCM rate.`);
    }

    // 009. Configure 16 kHz capture
    this.sampleRate = sampleRate;
    // 010. Configure mono capture
    this.channels = channels;
    // 007. Select default input device
    this.device = device;
    this.recorderType = recorder;
    this.recorderLib = recorderLib;
    this.logger = logger;

    // 024. Track microphone lifecycle
    this.state = MicState.UNINITIALIZED;
    this.activeRecording = null;
    this.audioStream = null;
    this.activeProcess = null;
    this.recoveryAttempts = 0;
    this.maxRecoveryAttempts = 3;

    this._boundDataHandler = null;
    this._boundErrorHandler = null;
  }

  getState() {
    return this.state;
  }

  isRecording() {
    return this.state === MicState.RECORDING;
  }

  /**
   * 006. Verify microphone availability.
   * Probes for the recording backend executable.
   * @returns {boolean}
   */
  isAvailable() {
    if (this.recorderType !== "sox") return true;
    try {
      const probe = spawnSync("sox", ["--version"], { stdio: "ignore" });
      return !probe.error && probe.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * 005. Initialize microphone capture.
   * 012. Start PCM stream.
   * 023. Prevent duplicate microphone streams.
   */
  start() {
    // 023. Prevent duplicate microphone streams
    if (this.state === MicState.RECORDING) {
      return this.audioStream;
    }

    if (!this.isAvailable()) {
      const err = new Error("Microphone unavailable: recording backend not found");
      this._handleError(err);
      throw err;
    }

    this.state = MicState.READY;

    try {
      // 011. Configure PCM16 audio (raw headerless 16-bit signed PCM)
      const recording = this.recorderLib.record({
        sampleRate: this.sampleRate,
        channels: this.channels,
        recorder: this.recorderType,
        device: this.device,
        audioType: "raw",
        endOnSilence: false,
      });

      this.activeRecording = recording;
      this.activeProcess = recording.process || null;
      this.audioStream = recording.stream();

      // Track child process lifecycle to prevent orphan audio processes (091)
      if (this.activeProcess) {
        this.activeProcess.on("error", (err) => {
          this._handleError(new Error(`Microphone process error: ${err.message}`));
        });
        this.activeProcess.on("exit", (code) => {
          if (this.state === MicState.RECORDING && code !== 0 && code !== null) {
            // 019. Detect microphone disconnect / drop
            this._handleDisconnect();
          }
        });
      }

      this._boundDataHandler = (chunk) => {
        if (this.state === MicState.RECORDING) {
          this.emit("data", chunk);
        }
      };

      this._boundErrorHandler = (err) => {
        // 018. Detect microphone capture errors
        this._handleError(err);
      };

      this.audioStream.on("data", this._boundDataHandler);
      this.audioStream.on("error", this._boundErrorHandler);

      this.state = MicState.RECORDING;
      this.recoveryAttempts = 0;

      // 025. Log microphone start
      this.logger.log(`[microphone] Started capture at ${this.sampleRate}Hz mono PCM16`);
      this.emit("started", { sampleRate: this.sampleRate, channels: this.channels });

      return this.audioStream;
    } catch (err) {
      this._handleError(err);
      throw err;
    }
  }

  /**
   * 021. Stop microphone on Escape.
   * 022. Stop microphone after final turn.
   * 026. Log microphone stop.
   * 091. Verify no orphan audio process.
   * @param {string} [reason="manual_stop"]
   */
  stop(reason = "manual_stop") {
    if (this.state === MicState.STOPPED || this.state === MicState.UNINITIALIZED) {
      return;
    }

    // 026. Log microphone stop
    this.logger.log(`[microphone] Stopping capture (${reason})`);

    // Clean up streams & listeners
    if (this.audioStream) {
      if (this._boundDataHandler) this.audioStream.removeListener("data", this._boundDataHandler);
      if (this._boundErrorHandler) this.audioStream.removeListener("error", this._boundErrorHandler);
      try {
        this.audioStream.destroy?.();
      } catch {
        // ignore
      }
      this.audioStream = null;
    }

    // 091. Verify no orphan audio process - kill child process explicitly
    if (this.activeRecording) {
      try {
        this.activeRecording.stop?.();
      } catch {
        // ignore
      }
      this.activeRecording = null;
    }

    if (this.activeProcess) {
      try {
        if (!this.activeProcess.killed) {
          this.activeProcess.kill("SIGTERM");
        }
      } catch {
        // ignore
      }
      this.activeProcess = null;
    }

    this.state = MicState.STOPPED;
    this.emit("stopped", { reason, timestamp: Date.now() });
  }

  /**
   * 020. Recover microphone stream on failure/disconnect.
   */
  async recover() {
    if (this.recoveryAttempts >= this.maxRecoveryAttempts) {
      const err = new Error(`Microphone recovery exceeded limit of ${this.maxRecoveryAttempts} attempts`);
      this._handleError(err);
      return false;
    }

    this.recoveryAttempts++;
    this.state = MicState.RECOVERING;
    this.logger.log(`[microphone] Recovering stream (attempt ${this.recoveryAttempts}/${this.maxRecoveryAttempts})...`);
    this.emit("recovering", { attempt: this.recoveryAttempts });

    this.stop("recovery_restart");

    // Short backoff
    await new Promise((resolve) => setTimeout(resolve, 300 * this.recoveryAttempts));

    try {
      this.start();
      this.logger.log("[microphone] Stream successfully recovered");
      this.emit("recovered");
      return true;
    } catch (err) {
      this._handleError(err);
      return false;
    }
  }

  _handleDisconnect() {
    this.logger.error("[microphone:error] Microphone disconnected or process exited unexpectedly");
    this.emit("disconnect", { timestamp: Date.now() });
    this.recover().catch(() => {});
  }

  _handleError(err) {
    this.state = MicState.ERROR;
    // 027. Log microphone errors
    const msg = err?.message || String(err);
    (this.logger.error || this.logger.log).call(this.logger, `[microphone:error] ${msg}`);
    this.emit("error", err);
  }
}
