import { EventEmitter } from "node:events";

/**
 * UI and Pipeline States for Voice Interaction
 */
export const VoiceUiState = {
  IDLE: "IDLE",
  LISTENING: "LISTENING",
  PROCESSING: "PROCESSING",
  WORKING: "WORKING",
  SUCCESS: "SUCCESS",
  FAILURE: "FAILURE",
  CANCELLED: "CANCELLED",
};

/**
 * HotkeyController (Tickets 001–004, 057, 068, 081, 087, 088)
 *
 * Responsibilities:
 * - 001. Detect Ctrl+Space activation.
 * - 002. Detect Escape cancellation.
 * - 003. Prevent duplicate activation.
 * - 004. Transition UI IDLE -> LISTENING.
 * - 057. Clear transcript on new activation.
 * - 068. Return UI to idle.
 * - Guard against rapid/repeated activations (087, 088).
 */
export class HotkeyController extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.debounceMs=200] Minimum ms between activations
   * @param {object} [opts.logger=console]
   */
  constructor({ debounceMs = 200, logger = console } = {}) {
    super();
    this.debounceMs = debounceMs;
    this.logger = logger;
    this.state = VoiceUiState.IDLE;
    this.lastActivationTime = 0;
    this._destroyed = false;
  }

  getState() {
    return this.state;
  }

  isListening() {
    return this.state === VoiceUiState.LISTENING;
  }

  isActive() {
    return this.state === VoiceUiState.LISTENING ||
      this.state === VoiceUiState.PROCESSING ||
      this.state === VoiceUiState.WORKING;
  }

  /**
   * 001. Detect Ctrl+Space activation.
   * 003. Prevent duplicate activation.
   * 004. Transition UI IDLE -> LISTENING.
   * 057. Clear transcript on new activation.
   * 087/088. Debounce rapid activations.
   *
   * @returns {boolean} true if activation succeeded; false if duplicate or ignored
   */
  handleActivation() {
    if (this._destroyed) return false;

    const now = Date.now();
    if (now - this.lastActivationTime < this.debounceMs) {
      // Rapid activation suppressed (087)
      return false;
    }

    // 003. Prevent duplicate activation if already listening or actively working
    if (this.isActive()) {
      return false;
    }

    this.lastActivationTime = now;
    this._transition(VoiceUiState.LISTENING, { reason: "ctrl_space_pressed" });

    // 057. Clear transcript on new activation
    this.emit("clear_transcript");
    this.emit("activated", { timestamp: now });
    return true;
  }

  /**
   * 002. Detect Escape cancellation.
   * 068. Return UI to idle.
   * 081. Test cancellation.
   *
   * @returns {boolean} true if an active session was cancelled
   */
  handleCancellation() {
    if (this._destroyed) return false;

    if (!this.isActive()) {
      return false;
    }

    this._transition(VoiceUiState.CANCELLED, { reason: "escape_pressed" });
    this.emit("cancelled", { timestamp: Date.now() });

    // 068. Return UI to idle
    this.returnToIdle();
    return true;
  }

  /**
   * 068. Return UI to idle.
   */
  returnToIdle() {
    if (this.state !== VoiceUiState.IDLE) {
      this._transition(VoiceUiState.IDLE, { reason: "session_reset" });
    }
  }

  transitionTo(newState, meta = {}) {
    this._transition(newState, meta);
  }

  _transition(newState, meta = {}) {
    const oldState = this.state;
    if (oldState === newState) return;

    this.state = newState;
    this.emit("state_change", { oldState, newState, ...meta });
  }

  destroy() {
    this._destroyed = true;
    this.removeAllListeners();
  }
}
