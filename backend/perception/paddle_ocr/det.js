/**
 * PP-OCR DB text-region detector (pre/post-processing only).
 *
 * The model emits a per-pixel text probability map. PaddleOCR's reference
 * post-process uses OpenCV contours + rotated min-area rects + Vatti-clip
 * unclip. To stay dependency-free in Node we use a simplified, documented
 * equivalent that is adequate for horizontal UI text:
 *
 *   threshold -> connected components -> axis-aligned box -> area/perimeter unclip
 *
 * Boxes are returned in ORIGINAL image coordinates.
 */
import { resizeRgba, toCHW } from "./image.js";

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];

/** Resize so both sides are multiples of 32 and the longest side <= limit. */
export function detPreprocess(image, { limitSide = 960, multiple = 32 } = {}) {
  const ratio = Math.min(1, limitSide / Math.max(image.width, image.height));
  const rw = Math.max(multiple, Math.round((image.width * ratio) / multiple) * multiple);
  const rh = Math.max(multiple, Math.round((image.height * ratio) / multiple) * multiple);
  const resized = resizeRgba(image, rw, rh);
  const data = toCHW(resized, { scale: 1 / 255, mean: DET_MEAN, std: DET_STD, order: "bgr" });
  return { data, rw, rh, scaleX: image.width / rw, scaleY: image.height / rh };
}

/**
 * Probability map -> text boxes in original image coordinates.
 * @param {Float32Array} prob  length rw*rh
 */
export function postprocessDet(prob, rw, rh, { scaleX = 1, scaleY = 1, thresh = 0.3, unclipRatio = 1.6, minSize = 3 } = {}) {
  const mask = new Uint8Array(rw * rh);
  for (let i = 0; i < mask.length; i++) mask[i] = prob[i] > thresh ? 1 : 0;

  const seen = new Int32Array(rw * rh).fill(-1);
  const boxes = [];
  const queue = new Int32Array(rw * rh);

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start] !== -1) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;

    let minX = rw;
    let minY = rh;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    let scoreSum = 0;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % rw;
      const y = (idx - x) / rw;
      count++;
      scoreSum += prob[idx];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      // 8-connectivity
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= rh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= rw) continue;
          const n = ny * rw + nx;
          if (mask[n] && seen[n] === -1) {
            seen[n] = 1;
            queue[tail++] = n;
          }
        }
      }
    }

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (w < minSize || h < minSize) continue;

    // Unclip: expand by area * ratio / perimeter (PaddleOCR's distance heuristic).
    const d = (w * h * unclipRatio) / (2 * (w + h));
    const x1 = minX - d;
    const y1 = minY - d;
    const x2 = maxX + 1 + d;
    const y2 = maxY + 1 + d;

    boxes.push({
      x: clamp(x1 * scaleX, 0, Infinity),
      y: clamp(y1 * scaleY, 0, Infinity),
      w: (x2 - x1) * scaleX,
      h: (y2 - y1) * scaleY,
      score: count ? scoreSum / count : 0,
    });
  }

  return groupIntoLines(boxes);
}

/** Merge boxes that share a text line (strong vertical overlap, small horizontal gap). */
export function groupIntoLines(boxes, { gapFactor = 1.4 } = {}) {
  const sorted = boxes.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];

  for (const box of sorted) {
    let placed = false;
    for (const line of lines) {
      const overlap = verticalOverlap(line, box);
      const minH = Math.min(line.y2 - line.y1, box.h);
      const gap = box.x - line.x2;
      if (overlap / Math.max(1, minH) > 0.5 && gap < box.h * gapFactor) {
        line.x1 = Math.min(line.x1, box.x);
        line.y1 = Math.min(line.y1, box.y);
        line.x2 = Math.max(line.x2, box.x + box.w);
        line.y2 = Math.max(line.y2, box.y + box.h);
        placed = true;
        break;
      }
    }
    if (!placed) {
      lines.push({
        x1: box.x,
        y1: box.y,
        x2: box.x + box.w,
        y2: box.y + box.h,
        score: box.score,
      });
    }
  }

  return lines.map((l) => ({
    x: Math.round(l.x1),
    y: Math.round(l.y1),
    w: Math.round(l.x2 - l.x1),
    h: Math.round(l.y2 - l.y1),
    score: l.score,
  }));
}

function verticalOverlap(a, b) {
  const top = Math.max(a.y1, b.y);
  const bottom = Math.min(a.y2, b.y + b.h);
  return bottom - top;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
