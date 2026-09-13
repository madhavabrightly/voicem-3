/**
 * PaddleOCR ONNX engine (det + rec) — the "real OCR" extracted from Screen-AI.
 *
 *   PNG buffer
 *     -> DB text-region detector (ocr_det_v3.onnx)
 *     -> per-region CTC recognizer (ocr_rec_english.onnx)
 *     -> [{ text, x, y, w, h, confidence }]
 *
 * Isolated from the agent: this module knows nothing about planning, tools or
 * Windows automation. It only turns pixels into text boxes.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";
import { OcrDict } from "./dict.js";
import { decodePng } from "./image.js";
import { detPreprocess, postprocessDet } from "./det.js";
import { recPreprocess, ctcDecode, REC_HEIGHT } from "./rec.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL_DIR = join(HERE, "..", "models");

export class PaddleOcr {
  constructor({ modelDir = process.env.VOICE_AGENT_OCR_MODEL_DIR || DEFAULT_MODEL_DIR, recHeight = REC_HEIGHT } = {}) {
    this.modelDir = modelDir;
    this.recHeight = recHeight;
    this.det = null;
    this.rec = null;
    this.dict = null;
    this._checkedClasses = false;
  }

  /** True when all three model artifacts are present on disk. */
  isAvailable() {
    return (
      existsSync(join(this.modelDir, "ocr_det_v3.onnx")) &&
      existsSync(join(this.modelDir, "ocr_rec_english.onnx")) &&
      existsSync(join(this.modelDir, "ocr_rec_dict.txt"))
    );
  }

  async load() {
    if (this.det && this.rec) return this;
    if (!this.isAvailable()) throw new Error(`OCR models not found in ${this.modelDir}`);
    this.dict = OcrDict.load(join(this.modelDir, "ocr_rec_dict.txt"));
    this.det = await ort.InferenceSession.create(join(this.modelDir, "ocr_det_v3.onnx"));
    this.rec = await ort.InferenceSession.create(join(this.modelDir, "ocr_rec_english.onnx"));
    return this;
  }

  /**
   * @param {Buffer} pngBuffer
   * @returns {Promise<{width:number,height:number,lines:Array<{text,x,y,w,h,confidence}>}>}
   */
  async recognize(pngBuffer, opts = {}) {
    await this.load();
    const image = decodePng(pngBuffer);
    const boxes = await this._detect(image, opts);
    const lines = [];

    for (const box of boxes) {
      const { text, confidence } = await this._recognizeBox(image, box, opts);
      const trimmed = text.trim();
      if (!trimmed) continue;
      if (confidence < (opts.minConfidence ?? 0.3)) continue;
      lines.push({ text: trimmed, x: box.x, y: box.y, w: box.w, h: box.h, confidence });
    }

    return { width: image.width, height: image.height, lines };
  }

  async _detect(image, opts) {
    const pre = detPreprocess(image, { limitSide: opts.detLimitSide ?? 960 });
    const tensor = new ort.Tensor("float32", pre.data, [1, 3, pre.rh, pre.rw]);
    const out = await this.det.run({ [this.det.inputNames[0]]: tensor });
    const result = out[this.det.outputNames[0]];
    const dims = result.dims;
    const h = dims[dims.length - 2];
    const w = dims[dims.length - 1];
    return postprocessDet(result.data, w, h, {
      scaleX: pre.scaleX,
      scaleY: pre.scaleY,
      thresh: opts.detThreshold ?? 0.3,
    });
  }

  async _recognizeBox(image, box, opts) {
    const pre = recPreprocess(image, box, { height: this.recHeight });
    const tensor = new ort.Tensor("float32", pre.data, [1, 3, pre.height, pre.width]);
    const out = await this.rec.run({ [this.rec.inputNames[0]]: tensor });
    const result = out[this.rec.outputNames[0]];
    const dims = result.dims;
    const classes = dims[dims.length - 1];
    const steps = dims[dims.length - 2];

    if (!this._checkedClasses) {
      this._checkedClasses = true;
      if (classes !== this.dict.classes) {
        // Loud, but non-fatal: decode still clamps unknown indices to a space.
        console.warn(
          `[ocr] recognizer has ${classes} classes but dictionary implies ${this.dict.classes}; decoding may be off.`
        );
      }
    }

    void opts;
    return ctcDecode(result.data, steps, classes, this.dict);
  }
}

let shared = null;

/** Lazy process-wide engine (sessions are expensive to create). */
export function getPaddleOcr(opts) {
  if (!shared) shared = new PaddleOcr(opts);
  return shared;
}

export { REC_HEIGHT };
