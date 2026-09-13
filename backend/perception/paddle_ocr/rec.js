/**
 * PP-OCR recognition pre/post-processing.
 *
 * Text regions are cropped, resized to a fixed height (PP-OCRv5 uses 48),
 * normalised to [-1, 1], and decoded with greedy CTC over the character
 * dictionary (class 0 = blank).
 */
import { cropRgba, resizeRgba, toCHW } from "./image.js";

export const REC_HEIGHT = 48;
const REC_MEAN = [0.5, 0.5, 0.5];
const REC_STD = [0.5, 0.5, 0.5];

/** Crop + resize a text region to a CHW tensor value buffer. */
export function recPreprocess(image, box, { height = REC_HEIGHT, maxWidth = 320 } = {}) {
  const crop = cropRgba(image, box.x, box.y, box.w, box.h);
  const ratio = height / Math.max(1, crop.height);
  const rw = Math.max(8, Math.min(maxWidth, Math.round(crop.width * ratio)));
  const resized = resizeRgba(crop, rw, height);
  const data = toCHW(resized, { scale: 1 / 255, mean: REC_MEAN, std: REC_STD, order: "bgr" });
  return { data, width: rw, height };
}

/**
 * Greedy CTC decode.
 * @param {Float32Array} logits  length T*C, row-major [T][C] (probabilities)
 * @returns {{ text: string, confidence: number }}
 */
export function ctcDecode(logits, T, C, dict) {
  let text = "";
  let confSum = 0;
  let confCount = 0;
  let prev = -1;

  for (let t = 0; t < T; t++) {
    let best = 0;
    let bestP = logits[t * C];
    for (let c = 1; c < C; c++) {
      const p = logits[t * C + c];
      if (p > bestP) {
        bestP = p;
        best = c;
      }
    }
    if (best !== prev) {
      const ch = dict.charAt(best);
      if (ch !== null) {
        text += ch;
        confSum += bestP;
        confCount++;
      }
    }
    prev = best;
  }

  return { text, confidence: confCount ? confSum / confCount : 0 };
}
