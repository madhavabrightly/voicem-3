/**
 * Minimal image helpers for the PaddleOCR ONNX engine.
 *
 * Pure JS (pngjs) so the only native dependency is onnxruntime-node.
 * Images are RGBA Uint8Array buffers, decoded from PNG screenshots.
 */
import { PNG } from "pngjs";

/** Decode a PNG buffer -> { width, height, data: RGBA Uint8Array }. */
export function decodePng(buffer) {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

/** Bilinear resize of an RGBA image. */
export function resizeRgba(src, dstW, dstH) {
  const { data: sd, width: sw, height: sh } = src;
  const out = new Uint8Array(dstW * dstH * 4);
  const xRatio = dstW > 1 ? (sw - 1) / (dstW - 1) : 0;
  const yRatio = dstH > 1 ? (sh - 1) / (dstH - 1) : 0;

  for (let y = 0; y < dstH; y++) {
    const sy = y * yRatio;
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, sh - 1);
    const fy = sy - y0;
    for (let x = 0; x < dstW; x++) {
      const sx = x * xRatio;
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, sw - 1);
      const fx = sx - x0;
      const i00 = (y0 * sw + x0) * 4;
      const i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const o = (y * dstW + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] * (1 - fx) + sd[i01 + c] * fx;
        const bot = sd[i10 + c] * (1 - fx) + sd[i11 + c] * fx;
        out[o + c] = Math.round(top * (1 - fy) + bot * fy);
      }
      out[o + 3] = 255;
    }
  }
  return { width: dstW, height: dstH, data: out };
}

/** Crop an axis-aligned region out of an RGBA image (clamped to bounds). */
export function cropRgba(src, x, y, w, h) {
  const x0 = Math.max(0, Math.min(src.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(src.height - 1, Math.floor(y)));
  const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor(x + w)));
  const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor(y + h)));
  const cw = x1 - x0;
  const ch = y1 - y0;
  const out = new Uint8Array(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const s = ((y0 + row) * src.width + x0) * 4;
    out.set(src.data.subarray(s, s + cw * 4), row * cw * 4);
  }
  return { width: cw, height: ch, data: out };
}

/**
 * RGBA image -> normalized CHW Float32 tensor values.
 *
 * PaddleOCR's reference pipeline reads images with OpenCV (BGR) and applies
 * ImageNet-style mean/std, hence `order: "bgr"` is the default.
 */
export function toCHW(img, { scale = 1, mean = [0, 0, 0], std = [1, 1, 1], order = "bgr" } = {}) {
  const { width, height, data } = img;
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const srcC = order === "bgr" ? 2 - c : c;
        out[c * plane + y * width + x] = (data[p + srcC] * scale - mean[c]) / std[c];
      }
    }
  }
  return out;
}
