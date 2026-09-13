import { EventEmitter } from "node:events";
import { HotkeyController, VoiceUiState } from "./hotkey_controller.js";
import { MicrophoneEngine, MicState } from "./microphone_engine.js";
import { AudioLevelProcessor } from "./audio_level_processor.js";
import { VadDetector } from "./vad_detector.js";
import { AssemblyAiResilienceManager, ConnectionState } from "./assemblyai_resilience.js";
import { TranscriptProcessor } from "./transcript_processor.js";
import { VoiceMetricsCollector } from "./voice_metrics.js";

/**
 * VoiceInputPipeline (Master Orchestration for Tickets 001–100)
 *
 * Fully integrated P1 Pipeline for voice capture, amplitude processing,
 * AssemblyAI realtime transcription, turn management, and metrics.
 */
export class VoiceInputPipeline extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey] AssemblyAI API key
   * @param {object} [opts.connectionParams] Custom realtime streaming overrides
   * @param {Function} [opts.onFinalTranscript] async (text) => Promise<any>
   * @param {Function} [opts.onPartialTranscript] (text) => void
   * @param {Function} [opts.onAudioLevel] ({ normalized, smoothed, isReal }) => void
   * @param {object} [opts.logger=console]
   * @param {object} [opts.components] Dependency-injection overrides for testing
   */
  constructor({
    apiKey = process.env.ASSEMBLYAI_API_KEY,
    connectionParams = {},
    onFinalTranscript = null,
    onPartialTranscript = null,
    onAudioLevel = null,
    logger = console,
    components = {},
  } = {}) {
    super();
    this.logger = logger;
    this.apiKey = apiKey;
    this.onFinalTranscript = onFinalTranscript;
    this.onPartialTranscript = onPartialTranscript;
    this.onAudioLevel = onAudioLevel;

    // Sub-components (supporting dependency injection for testing: 076–090)
    this.hotkey = components.hotkey || new HotkeyController({ logger });
    this.audioLevel = components.audioLevel || new AudioLevelProcessor();
    this.vad = components.vad || new VadDetector();
    this.transcript = components.transcript || new TranscriptProcessor({ logger });
    this.metrics = components.metrics || new VoiceMetricsCollector({ logger });
    this.assemblyAi =
      components.assemblyAi ||
      new AssemblyAiResilienceManager({
        apiKey,
        connectionParams,
        logger,
        clientFactory: components.clientFactory,
      });
    this.mic =
      components.mic ||
      new MicrophoneEngine({
        logger,
        recorder: components.recorder || "sox",
        recorderLib: components.recorderLib,
      });

    this.isRunning = false;
    this.cancelled = false;
    this._wired = false;
    this._wireInternalEvents();
  }

  _wireInternalEvents() {
    if (this._wired) return;
    this._wired = true;

    // 001, 004, 057: Hotkey Activation
    this.hotkey.on("activated", () => {
      this.cancelled = false;
      this.metrics.startSession();
      this.transcript.clearForNewActivation();
      this.emit("activated", { state: this.hotkey.getState() });
    });

    // 002, 021, 068, 097: Hotkey Cancellation
    this.hotkey.on("cancelled", () => {
      this.cancelled = true;
      // 021. Stop microphone on Escape
      this.mic.stop("cancellation_escape");
      this.emit("cancelled");
      this.logger.log("[voice] Session cancelled by Escape hotkey");
    });

    // 016, 093, 094: Audio Level
    this.audioLevel.on("level", (levelData) => {
      if (this.onAudioLevel) {
        this.onAudioLevel(levelData);
      }
      this.emit("audio_level", levelData);

      // Feed into VAD (028-032)
      this.vad.processLevel(levelData);
    });

    // 030: Speech onset
    this.vad.on("speech_onset", (data) => {
      this.metrics.recordSpeechOnset(data.timestamp);
      this.emit("speech_onset", data);
    });

    // 032: Speech complete
    this.vad.on("speech_complete", (data) => {
      this.metrics.recordSpeechCompletion(data.timestamp);
      this.emit("speech_complete", data);
    });

    // 018: Microphone capture errors
    this.mic.on("error", (err) => {
      this.emit("mic_error", err);
      // 066. Stop voice session on failure
      this._handleFailure(err, "microphone_error");
    });

    // AssemblyAI connection states
    this.assemblyAi.on("connection_state", (stateData) => {
      this.emit("connection_state", stateData);
    });

    this.assemblyAi.on("turn", (turnEvent) => {
      this._handleAssemblyAiTurn(turnEvent);
    });

    this.assemblyAi.on("error", (err) => {
      this.emit("assemblyai_error", err);
    });

    // 049, 055, 056: Partial transcript events
    this.transcript.on("partial", (partialData) => {
      this.metrics.recordFirstPartial(partialData.timestamp);
      if (this.onPartialTranscript) {
        this.onPartialTranscript(partialData.text);
      }
      this.emit("partial_transcript", partialData);
    });

    // 050, 096: Final transcript events
    this.transcript.on("final", async (finalData) => {
      this.metrics.recordFinalTranscript(finalData.timestamp);
      this.emit("final_transcript", finalData);

      // 097: Ensure cancellation prevents execution
      if (this.cancelled) {
        this.logger.log(`[voice] Ignored final transcript "${finalData.text}" due to cancellation`);
        return;
      }

      // 022: Stop microphone after final turn
      this.mic.stop("final_turn_completed");

      // 096: Execute downstream callback EXACTLY ONCE
      if (this.onFinalTranscript) {
        try {
          this.hotkey.transitionTo(VoiceUiState.WORKING, { reason: "executing_task" });
          await this.onFinalTranscript(finalData.text);
          this.hotkey.transitionTo(VoiceUiState.SUCCESS, { reason: "task_complete" });
        } catch (execErr) {
          this.hotkey.transitionTo(VoiceUiState.FAILURE, { reason: "task_error" });
          this.logger.error(`[voice:error] Downstream task execution failed: ${execErr?.message || execErr}`);
        } finally {
          // 068. Return UI to idle
          this.hotkey.returnToIdle();
        }
      }
    });

    this.transcript.on("transcription_failure", (failData) => {
      this._handleFailure(new Error(`Transcription failed: ${failData.reason}`), "transcription_failure");
    });
  }

  _handleAssemblyAiTurn(turnEvent) {
    if (this.cancelled) return;
    this.transcript.processTurnEvent(turnEvent);
  }

  /**
   * 001. Trigger Ctrl+Space activation programmatically or via key listener.
   */
  triggerActivation() {
    return this.hotkey.handleActivation();
  }

  /**
   * 002. Trigger Escape cancellation programmatically or via key listener.
   */
  triggerCancellation() {
    return this.hotkey.handleCancellation();
  }

  /**
   * Feed a PCM buffer directly (useful for tests or alternate streaming sources: 076–090).
   * @param {Buffer} chunk
   */
  handleAudioChunk(chunk) {
    if (!chunk || this.cancelled) return;
    // 013-016: Compute real amplitude
    this.audioLevel.processChunk(chunk);
    // 017: Send to AssemblyAI
    this.assemblyAi.sendAudio(chunk);
  }

  /**
   * 005, 012, 033: Start the full voice input pipeline.
   */
  async start() {
    if (this.isRunning) return { ok: true, state: this.getState() };

    this.cancelled = false;
    this.metrics.startSession();

    // 033. Connect AssemblyAI streaming transcriber
    await this.assemblyAi.connect();

    // 005, 012: Start microphone capture stream
    const audioStream = this.mic.start();

    // Wire live stream chunks into amplitude processor and AssemblyAI
    audioStream.on("data", (chunk) => {
      this.handleAudioChunk(chunk);
    });

    this.isRunning = true;
    this.hotkey.transitionTo(VoiceUiState.LISTENING, { reason: "pipeline_started" });
    this.emit("started", { sessionId: this.metrics.sessionId });

    return { ok: true, sessionId: this.metrics.sessionId };
  }

  /**
   * 026, 037, 068, 071, 090, 098: Stop the pipeline and clean up all resources.
   */
  async stop(reason = "normal_stop") {
    this.isRunning = false;

    // 077, 091: Stop microphone and eliminate orphan processes
    this.mic.stop(reason);

    // 037: Close AssemblyAI connection
    await this.assemblyAi.close();

    // 071-075: Calculate metrics
    const finalMetrics = this.metrics.endSession();

    // 067, 098: Reset voice state
    this.audioLevel.reset();
    this.vad.reset();
    this.transcript.reset();

    // 068: Return UI to idle
    this.hotkey.returnToIdle();

    this.emit("stopped", { reason, metrics: finalMetrics });
    return { ok: true, metrics: finalMetrics };
  }

  _handleFailure(err, source) {
    this.logger.error(`[voice:error] Failure in ${source}: ${err.message}`);
    this.emit("failure", { error: err, source });
    // 066. Stop voice session on failure
    // 067. Reset voice state
    // 068. Return UI to idle
    this.hotkey.transitionTo(VoiceUiState.FAILURE, { error: err.message });
    this.stop("error_failure").catch(() => {});
  }

  getState() {
    return {
      uiState: this.hotkey.getState(),
      micState: this.mic.getState(),
      connectionState: this.assemblyAi.getState(),
      isRunning: this.isRunning,
      smoothedAmplitude: this.audioLevel.getSmoothedAmplitude(),
      currentPartial: this.transcript.getCurrentPartial(),
      lastFinal: this.transcript.getLastFinal(),
      sessionId: this.metrics.sessionId,
    };
  }
}
