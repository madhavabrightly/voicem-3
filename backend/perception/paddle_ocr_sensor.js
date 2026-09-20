import { readFileSync } from "node:fs";
import { ScreenModel } from "./screen_model.js";
import { ocrLinesToModel } from "./real_ocr.js";
import { getPaddleOcr } from "./paddle_ocr/index.js";

/**
 * PaddleOcrSensor — a Perception sensor backed by the local PaddleOCR ONNX
 * engine. It captures the screen (or accepts an image buffer), recognizes
 * text boxes, and reuses the existing semantic mapping (`ocrLinesToModel`) so
 * the resulting ScreenModel is identical in shape to the Windows OCR sensor.
 *
 * Returns a zero-confidence model when models/screenshot are unavailable, so
 * the perception stack falls through to the next sensor.
 */
export class PaddleOcrSensor {
  /**
   * @param {object} opts
   * @param {Function} [opts.capture] async () => {path} | {buffer} | Buffer
   * @param {Function} [opts.foreground] async () => {title, proc} | null
   * @param {object}   [opts.ocr] PaddleOcr instance (defaults to shared engine)
   * @param {number}   [opts.minConfidence]
   */
  constructor({ capture = null, foreground = null, ocr = null, minConfidence = 0.3, minIntervalMs = 750 } = {}) {
    this.name = "paddle-ocr";
    this.capture = capture;
    this.foreground = foreground;
    this.ocr = ocr || getPaddleOcr();
    this.minConfidence = minConfidence;
    this.minIntervalMs = minIntervalMs;
    this._lastReadAt = 0;
    this._lastModel = null;
  }

  canHandle() {
    return true;
  }

  async read() {
    const empty = () => new ScreenModel({ source: "ocr", confidence: 0 });
    if (!this.ocr.isAvailable() || !this.capture) return empty();

    // Honour the caller's pacing: bursting full-screen ONNX inference (each
    // run is ~0.5-1 s of CPU) is pointless while a screen hash shows no
    // change or the previous frame was just analyzed.
    const now = Date.now();
    if (this._lastReadAt && now - this._lastReadAt < this.minIntervalMs) return this._lastModel || empty();
    this._lastReadAt = now;

    try {
      const shot = await this.capture();
      const buffer = Buffer.isBuffer(shot) ? shot : shot?.buffer || readFileSync(shot.path);
      const result = await this.ocr.recognize(buffer, { minConfidence: this.minConfidence });
      if (!result.lines.length) return empty();

      const lines = result.lines.map((l) => ({ text: l.text, x: l.x, y: l.y, w: l.w, h: l.h }));
      const fg = this.foreground ? await this.foreground().catch(() => null) : null;
      const bounds = shot && !Buffer.isBuffer(shot) && shot.width > 0
        ? { width: shot.width, height: shot.height }
        : { width: result.width, height: result.height };
      const model = ocrLinesToModel(lines, fg, bounds);
      this._lastModel = model;
      return model;
    } catch {
      return empty();
    }
  }
}
