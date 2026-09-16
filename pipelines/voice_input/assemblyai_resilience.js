import { EventEmitter } from "node:events";
import { AssemblyAI } from "assemblyai";

export const ConnectionState = {
  DISCONNECTED: "DISCONNECTED",
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  RECONNECTING: "RECONNECTING",
  ERROR: "ERROR",
  CLOSED: "CLOSED",
};

/** Realtime connection configuration (16 kHz mono PCM16). */
export const DEFAULT_CONNECTION_PARAMS = {
  sampleRate: 16000,
  speechModel: "universal-3-6-pro",
  mode: "balanced",
  formatTurns: true,
  connectTimeout: 10000,
};

/**
 * Sanitizes any text to redact API keys and sensitive tokens.
 * 040. Never log API key.
 * 099. Verify logs contain no secrets.
 */
export function sanitizeLog(text, apiKey = null) {
  if (typeof text !== "string") return text;
  let sanitized = text;
  if (apiKey && apiKey.length > 4) {
    sanitized = sanitized.replaceAll(apiKey, `***${apiKey.slice(-4)}`);
  }
  // Generic pattern for hex API keys (e.g. 32-char assemblyai keys)
  sanitized = sanitized.replace(/\b[0-9a-fA-F]{24,64}\b/g, "[REDACTED_KEY]");
  return sanitized;
}

/**
 * AssemblyAiResilienceManager (Tickets 017, 033–048, 082–084, 092)
 *
 * Responsibilities:
 * - 017. Forward PCM to AssemblyAI.
 * - 033. Handle AssemblyAI connection startup.
 * - 034. Handle AssemblyAI connection failure.
 * - 035. Handle AssemblyAI reconnect.
 * - 036. Bound reconnect attempts.
 * - 037. Handle AssemblyAI close event.
 * - 038. Handle AssemblyAI error event.
 * - 039. Validate AssemblyAI API key.
 * - 040. Never log API key.
 * - 041. Handle missing API key.
 * - 042. Handle invalid API key.
 * - 043. Handle network failure.
 * - 044. Handle authentication failure.
 * - 045. Handle rate limiting.
 * - 046. Handle server errors.
 * - 047. Track connection state.
 * - 048. Expose connection state to UI.
 * - 092. Verify no duplicate AssemblyAI stream.
 */
export class AssemblyAiResilienceManager extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey]
   * @param {object} [opts.connectionParams]
   * @param {number} [opts.maxReconnectAttempts=3]
   * @param {number} [opts.baseBackoffMs=500]
   * @param {object} [opts.clientFactory] Injectable AssemblyAI factory
   * @param {object} [opts.logger=console]
   */
  constructor({
    apiKey = process.env.ASSEMBLYAI_API_KEY,
    connectionParams = {},
    maxReconnectAttempts = 3,
    baseBackoffMs = 500,
    clientFactory = null,
    logger = console,
  } = {}) {
    super();
    this.apiKey = apiKey?.trim() || null;
    this.connectionParams = { ...DEFAULT_CONNECTION_PARAMS, ...connectionParams };
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.baseBackoffMs = baseBackoffMs;
    this.clientFactory = clientFactory;
    this.logger = logger;

    this.state = ConnectionState.DISCONNECTED;
    this.client = null;
    this.transcriber = null;
    this.reconnectAttempts = 0;
    this.sessionId = null;
    this._intentionallyClosed = false;
  }

  getState() {
    return this.state;
  }

  /**
   * 039. Validate AssemblyAI API key.
   * 041. Handle missing API key.
   * 042. Handle invalid API key.
   */
  validateApiKey() {
    if (!this.apiKey) {
      throw new Error("Missing AssemblyAI API key: ASSEMBLYAI_API_KEY is not configured");
    }
    // Check for obvious placeholders
    const lower = this.apiKey.toLowerCase();
    if (lower.includes("your_") || lower.includes("placeholder") || lower.includes("api_key_here")) {
      throw new Error("Invalid AssemblyAI API key: placeholder value detected");
    }
    // AssemblyAI keys are standard hex strings (typically 32 characters)
    if (this.apiKey.length < 20 || !/^[a-zA-Z0-9_-]+$/.test(this.apiKey)) {
      throw new Error("Invalid AssemblyAI API key: malformed key structure");
    }
    return true;
  }

  /**
   * 033. Handle AssemblyAI connection startup.
   * 092. Verify no duplicate AssemblyAI stream.
   */
  async connect() {
    // 092. Verify no duplicate AssemblyAI stream
    if (this.state === ConnectionState.CONNECTED && this.transcriber) {
      return this.transcriber;
    }

    this.validateApiKey();
    this._intentionallyClosed = false;
    this._setState(this.reconnectAttempts > 0 ? ConnectionState.RECONNECTING : ConnectionState.CONNECTING);

    try {
      // Tear down any stale stream before initializing
      if (this.transcriber) {
        await this._cleanupTranscriber();
      }

      this.client = this.clientFactory ? this.clientFactory(this.apiKey) : new AssemblyAI({ apiKey: this.apiKey });
      this.transcriber = this.client.streaming.transcriber(this.connectionParams);

      this._wireTranscriberEvents();

      // Connect with timeout guard
      await Promise.race([
        this.transcriber.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("AssemblyAI connection timeout")), 10000)
        ),
      ]);

      this._setState(ConnectionState.CONNECTED);
      this.reconnectAttempts = 0;
      this._log("[voice] AssemblyAI stream connected successfully");
      return this.transcriber;
    } catch (err) {
      // 034. Handle AssemblyAI connection failure
      return this._handleConnectionFailure(err);
    }
  }

  _wireTranscriberEvents() {
    if (!this.transcriber) return;

    this.transcriber.on("open", (event) => {
      this.sessionId = event?.id || null;
      this._log(`[voice] Session opened: ${this.sessionId ?? "unknown"}`);
      this.emit("open", event);
    });

    this.transcriber.on("turn", (event) => {
      this.emit("turn", event);
    });

    // 038. Handle AssemblyAI error event
    this.transcriber.on("error", (error) => {
      this._handleStreamError(error);
    });

    // 037. Handle AssemblyAI close event
    this.transcriber.on("close", (code, reason) => {
      this._setState(ConnectionState.CLOSED);
      this._log(`[voice] AssemblyAI connection closed (code: ${code}, reason: ${reason || "none"})`);
      this.emit("close", { code, reason });

      if (!this._intentionallyClosed) {
        // Unexpected disconnect -> trigger reconnect (035)
        this._attemptReconnect(new Error(`Unexpected close: ${code} ${reason}`));
      }
    });
  }

  /**
   * 017. Forward PCM to AssemblyAI.
   * @param {Buffer|Uint8Array} chunk
   */
  sendAudio(chunk) {
    if (this.state !== ConnectionState.CONNECTED || !this.transcriber) {
      return false;
    }
    try {
      this.transcriber.sendAudio(chunk);
      return true;
    } catch (err) {
      this._handleStreamError(err);
      return false;
    }
  }

  /**
   * 038. Handle AssemblyAI error event.
   * 043. Network failure.
   * 044. Authentication failure.
   * 045. Rate limiting.
   * 046. Server errors.
   */
  _handleStreamError(error) {
    const message = error?.message || String(error);
    this._logError(`[voice:error] AssemblyAI stream error: ${message}`);

    // Classify error type
    if (message.includes("401") || message.includes("authentication") || message.includes("Unauthorized")) {
      this._setState(ConnectionState.ERROR);
      this.emit("auth_error", error);
      return;
    }
    if (message.includes("429") || message.includes("rate limit")) {
      this.emit("rate_limit", error);
    }

    this.emit("error", error);

    if (!this._intentionallyClosed) {
      this._attemptReconnect(error);
    }
  }

  async _handleConnectionFailure(err) {
    const message = err?.message || String(err);
    this._logError(`[voice:error] AssemblyAI connection failed: ${message}`);
    this._setState(ConnectionState.ERROR);

    if (this._intentionallyClosed) throw err;

    return this._attemptReconnect(err);
  }

  /**
   * 035. Handle AssemblyAI reconnect.
   * 036. Bound reconnect attempts.
   */
  async _attemptReconnect(triggerError) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      const boundError = new Error(
        `AssemblyAI reconnect exceeded limit of ${this.maxReconnectAttempts} attempts: ${triggerError.message}`
      );
      this._setState(ConnectionState.ERROR);
      this.emit("reconnect_exhausted", boundError);
      throw boundError;
    }

    this.reconnectAttempts++;
    this._setState(ConnectionState.RECONNECTING);
    const delay = this.baseBackoffMs * Math.pow(2, this.reconnectAttempts - 1);

    this._log(`[voice] Reconnecting to AssemblyAI in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    this.emit("reconnecting", { attempt: this.reconnectAttempts, delay });

    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      return await this.connect();
    } catch (err) {
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        throw err;
      }
      return null;
    }
  }

  /**
   * 047. Track connection state.
   * 048. Expose connection state to UI.
   */
  _setState(newState) {
    const oldState = this.state;
    if (oldState === newState) return;
    this.state = newState;
    this.emit("connection_state", { oldState, newState, sessionId: this.sessionId });
  }

  async _cleanupTranscriber() {
    if (!this.transcriber) return;
    try {
      this.transcriber.removeAllListeners?.();
      await this.transcriber.close?.(true, 1000);
    } catch {
      // ignore
    }
    this.transcriber = null;
  }

  async close() {
    this._intentionallyClosed = true;
    await this._cleanupTranscriber();
    this.client = null;
    this._setState(ConnectionState.DISCONNECTED);
  }

  _log(msg) {
    // 040. Never log API key
    this.logger.log(sanitizeLog(msg, this.apiKey));
  }

  _logError(msg) {
    // 040. Never log API key
    (this.logger.error || this.logger.log).call(this.logger, sanitizeLog(msg, this.apiKey));
  }
}
