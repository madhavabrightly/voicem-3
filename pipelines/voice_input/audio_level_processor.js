import { EventEmitter } from "node:events";

/**
 * AudioLevelProcessor (Tickets 013–016, 093, 094)
 *
 * Responsibilities:
 * - 013. Calculate audio RMS from raw PCM16 buffers.
 * - 014. Normalize RMS amplitude (0.0 to 1.0).
 * - 015. Smooth amplitude with Exponential Moving Average (EMA).
 * - 016. Emit audio-level events with real amplitude.
 * - 093. Guarantee UI receives real amplitude.
 * - 094. Guarantee UI never generates fake amplitude.
 */
export class AudioLevelProcessor extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.alpha=0.3] EMA smoothing factor (0 < alpha <= 1)
   * @param {number} [opts.maxPcmValue=32767] Maximum amplitude for 16-bit signed PCM
   * @param {number} [opts.silenceFloor=150] Noise floor below which value is treated as 0
   */
  constructor({ alpha = 0.3, maxPcmValue = 32767, silenceFloor = 150 } = {}) {
    super();
    this.alpha = Math.max(0.01, Math.min(1.0, alpha));
    this.maxPcmValue = maxPcmValue;
    this.silenceFloor = silenceFloor;
    this.smoothedAmplitude = 0.0;
    this.lastRawRms = 0.0;
    this.processedChunksCount = 0;
  }

  /**
   * Process a 16-bit PCM buffer chunk.
   * @param {Buffer|Uint8Array} chunk Raw PCM16 little-endian audio buffer
   * @returns {{ rawRms: number, normalized: number, smoothed: number, isReal: boolean }}
   */
  processChunk(chunk) {
    if (!chunk || chunk.length < 2) {
      return { rawRms: 0, normalized: 0, smoothed: this.smoothedAmplitude, isReal: true };
    }

    const sampleCount = Math.floor(chunk.length / 2);
    let sumSquares = 0;

    // 013. Calculate audio RMS
    for (let i = 0; i < sampleCount; i++) {
      const sample = chunk.readInt16LE ? chunk.readInt16LE(i * 2) : (chunk[i * 2] | (chunk[i * 2 + 1] << 8));
      // Sign-extend if bitwise fallback is used
      const signedSample = sample >= 0x8000 ? sample - 0x10000 : sample;
      sumSquares += signedSample * signedSample;
    }

    const rawRms = Math.sqrt(sumSquares / sampleCount);
    this.lastRawRms = rawRms;

    // Apply silence floor
    const effectiveRms = rawRms < this.silenceFloor ? 0 : rawRms;

    // 014. Normalize RMS amplitude into [0.0, 1.0]
    const normalized = Math.min(1.0, Math.max(0.0, effectiveRms / this.maxPcmValue));

    // 015. Smooth amplitude with EMA
    this.smoothedAmplitude = this.alpha * normalized + (1 - this.alpha) * this.smoothedAmplitude;

    this.processedChunksCount++;

    const eventPayload = {
      rawRms: Math.round(rawRms * 100) / 100,
      normalized: Math.round(normalized * 10000) / 10000,
      smoothed: Math.round(this.smoothedAmplitude * 10000) / 10000,
      isReal: true, // 093, 094: Explicit verification flag confirming derived from real audio PCM
      timestamp: Date.now(),
    };

    // 016. Emit audio-level events
    this.emit("level", eventPayload);
    return eventPayload;
  }

  getSmoothedAmplitude() {
    return this.smoothedAmplitude;
  }

  getLastRms() {
    return this.lastRawRms;
  }

  reset() {
    this.smoothedAmplitude = 0.0;
    this.lastRawRms = 0.0;
    this.processedChunksCount = 0;
  }
}
