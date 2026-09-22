/**
 * P4 Tickets 307–355: Multi-Sensor Adapters, Merging, Normalization & Confidence
 *
 *  307–310: Windows OCR extraction (text, bboxes, confidence)
 *  311–318: PaddleOCR ONNX engine & mapping
 *  319–339: UI Automation extraction & specific control detection
 *  340–345: Vision fallback & visual object candidates
 *  346: Normalize coordinates
 *  347–352: Sensor merging, deduplication, overlap & label resolution
 *  353–355: Confidence calculation (semantic, element, screen)
 */

import { RealUiaSensor } from "../../backend/perception/uia_sensor.js";
import { PaddleOcrSensor } from "../../backend/perception/paddle_ocr_sensor.js";

/**
 * 346. Normalize coordinate candidates to standard screen pixel bounding box
 * and center coordinate point.
 */
export function normalizeCoordinates(bbox, screenBounds = { width: 1920, height: 1080 }) {
  if (!bbox) return { x: 0, y: 0, w: 0, h: 0, center: { x: 0, y: 0 } };
  const x = Math.max(0, Math.round(bbox.x ?? bbox.left ?? 0));
  const y = Math.max(0, Math.round(bbox.y ?? bbox.top ?? 0));
  const w = Math.max(0, Math.round(bbox.w ?? bbox.width ?? (bbox.right ? bbox.right - x : 0)));
  const h = Math.max(0, Math.round(bbox.h ?? bbox.height ?? (bbox.bottom ? bbox.bottom - y : 0)));
  const cx = Math.round(x + w / 2);
  const cy = Math.round(y + h / 2);
  return {
    bbox: { x, y, w, h },
    coordinates: { x: cx, y: cy },
    normalized: {
      x: screenBounds.width ? x / screenBounds.width : 0,
      y: screenBounds.height ? y / screenBounds.height : 0,
      w: screenBounds.width ? w / screenBounds.width : 0,
      h: screenBounds.height ? h / screenBounds.height : 0,
    },
  };
}

/**
 * 327–339. Classify control role to normalized UI type.
 */
export function classifyRoleType(role = "", label = "", automationId = "") {
  const r = String(role || "").toLowerCase();
  const text = `${label || ""} ${automationId || ""}`.toLowerCase();

  if (/search/i.test(text) || /search/i.test(r)) return "search_box";
  if (r.includes("button")) return "button"; // 327
  if (r.includes("edit") || r.includes("text") || r.includes("document")) return "input"; // 328
  if (r.includes("check")) return "checkbox"; // 329
  if (r.includes("list")) return "list"; // 330
  if (r.includes("menu")) return "menu"; // 331
  if (r.includes("tab")) return "tab"; // 332
  if (r.includes("link") || r.includes("hyperlink")) return "link"; // 333
  if (r.includes("window") || r.includes("pane")) return "window"; // 334
  if (r.includes("dialog") || r.includes("alert")) return "dialog"; // 335
  if (r.includes("navigation") || r.includes("toolbar")) return "navigation"; // 338

  return r || "element";
}

/**
 * 350. Remove duplicates by bounding box proximity and text similarity.
 */
export function deduplicateElements(elements = []) {
  const result = [];
  for (const el of elements) {
    const isDup = result.some((existing) => {
      const sameName = String(existing.name || "").trim().toLowerCase() === String(el.name || "").trim().toLowerCase();
      const dx = Math.abs((existing.coordinates?.x ?? 0) - (el.coordinates?.x ?? 0));
      const dy = Math.abs((existing.coordinates?.y ?? 0) - (el.coordinates?.y ?? 0));
      return sameName && dx < 15 && dy < 15;
    });
    if (!isDup) result.push(el);
  }
  return result;
}

/**
 * 351, 352. Resolve overlapping elements and conflicting labels.
 * Prioritizes structured UIA over OCR, and OCR over pure vision fallback.
 */
export function resolveOverlappingElements(elements = []) {
  const SENSOR_PRIORITY = { uia: 3, ocr: 2, paddle: 2, vision: 1, none: 0 };
  const sorted = [...elements].sort((a, b) => {
    const pA = SENSOR_PRIORITY[a.source] || 1;
    const pB = SENSOR_PRIORITY[b.source] || 1;
    return pB - pA;
  });

  const resolved = [];
  for (const el of sorted) {
    const overlapIndex = resolved.findIndex((existing) => {
      const b1 = existing.bbox;
      const b2 = el.bbox;
      if (!b1 || !b2) return false;
      const xOverlap = Math.max(0, Math.min(b1.x + b1.w, b2.x + b2.w) - Math.max(b1.x, b2.x));
      const yOverlap = Math.max(0, Math.min(b1.y + b1.h, b2.y + b2.h) - Math.max(b1.y, b2.y));
      const overlapArea = xOverlap * yOverlap;
      const minArea = Math.min(b1.w * b1.h, b2.w * b2.h);
      return minArea > 0 && overlapArea / minArea > 0.7;
    });

    if (overlapIndex === -1) {
      resolved.push(el);
    } else {
      // Overlap detected: merge metadata from lower priority sensor into higher priority
      const winner = resolved[overlapIndex];
      if (!winner.query && el.query) winner.query = el.query;
      if (winner.confidence < el.confidence) winner.confidence = el.confidence;
    }
  }
  return resolved;
}

/**
 * 353–355. Confidence calculators.
 */
export function calculateElementConfidence(element) {
  let base = element.confidence ?? 0.8;
  if (element.source === "uia") base = Math.max(base, 0.9);
  if (element.role && element.role !== "element") base += 0.05;
  if (element.bbox && element.bbox.w > 10 && element.bbox.h > 10) base += 0.05;
  return Math.min(1.0, Math.max(0.1, base));
}

export function calculateScreenConfidence(elements = [], sensorSource = "unknown") {
  if (!elements || elements.length === 0) return 0;
  const avg = elements.reduce((acc, e) => acc + (e.confidence ?? 0.5), 0) / elements.length;
  let sourceBoost = 0;
  if (sensorSource === "uia") sourceBoost = 0.15;
  if (sensorSource === "ocr") sourceBoost = 0.1;
  return Math.min(1.0, Number((avg + sourceBoost).toFixed(2)));
}

export class MultiSensorManager {
  /**
   * @param {object} p
   * @param {object} [p.driver]
   * @param {object} [p.foreground]
   * @param {object} [p.uiaDriver]
   */
  constructor({ driver = null, foreground = null, uiaDriver = null } = {}) {
    this.driver = driver;
    this.foreground = foreground;
    this.uiaSensor = uiaDriver
      ? new RealUiaSensor({ driver: uiaDriver, foreground })
      : driver && typeof driver.scan === "function"
      ? new RealUiaSensor({ driver, foreground })
      : null;
    this.paddleOcrSensor = new PaddleOcrSensor({
      capture: driver && typeof driver.capture === "function" ? driver.capture.bind(driver) : null,
      foreground
    });
  }

  /**
   * 347–349. Run sensors and merge results according to priority.
   */
  async scan({ intent = {}, preferredMethod = null } = {}) {
    const rawElements = [];
    let primarySource = "unknown";

    // 1. UIA Scan (319–339)
    if (this.uiaSensor && (preferredMethod === "uia" || !preferredMethod)) {
      try {
        const uiaModel = await this.uiaSensor.read(intent);
        if (uiaModel && uiaModel.elements && uiaModel.elements.length > 0) {
          primarySource = "uia";
          for (const el of uiaModel.elements) {
            rawElements.push({
              ...el,
              source: "uia",
              confidence: calculateElementConfidence({ ...el, source: "uia" }),
            });
          }
        }
      } catch {
        // UIA unavailable or timed out, fallback to OCR
      }
    } else if (this.driver && typeof this.driver.findUiaElements === "function") {
      try {
        const els = await this.driver.findUiaElements();
        if (els && els.length > 0) {
          primarySource = "uia";
          for (const el of els) {
            rawElements.push({
              ...el,
              source: "uia",
              confidence: calculateElementConfidence({ ...el, source: "uia" }),
            });
          }
        }
      } catch {
        // Driver findUiaElements failed
      }
    }

    // 2. OCR Scan (307–318, 395) with bounded retry
    let ocrHandled = false;
    if (this.driver && typeof this.driver.ocr === "function") {
      let ocrRes = null;
      for (let ocrAttempt = 1; ocrAttempt <= 2; ocrAttempt++) {
        try {
          ocrRes = await this.driver.ocr();
          if (ocrRes?.success) break;
        } catch {
          if (ocrAttempt >= 2) break;
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      if (ocrRes?.success && ocrRes.lines?.length > 0) {
        ocrHandled = true;
        if (primarySource === "unknown") primarySource = "ocr";
        for (const line of ocrRes.lines) {
          const norm = normalizeCoordinates(line);
          rawElements.push({
            type: "text",
            name: line.text,
            role: "text",
            bbox: norm.bbox,
            coordinates: norm.coordinates,
            confidence: line.confidence !== undefined ? line.confidence : 0.8,
            source: "ocr",
            words: line.words || [],
          });
        }
      }
    }

    if (!ocrHandled && this.paddleOcrSensor) {
      try {
        const paddleModel = await this.paddleOcrSensor.read();
        if (paddleModel && paddleModel.elements && paddleModel.elements.length > 0) {
          if (primarySource === "unknown") primarySource = "paddle";
          for (const el of paddleModel.elements) {
            rawElements.push({
              ...el,
              source: "paddle",
              confidence: calculateElementConfidence({ ...el, source: "paddle" }),
            });
          }
        }
      } catch {
        // Paddle fail
      }
    }

    // 3. Deduplicate, resolve overlaps, and calculate confidence (350–355)
    const deduped = deduplicateElements(rawElements);
    const resolved = resolveOverlappingElements(deduped);
    const screenConfidence = calculateScreenConfidence(resolved, primarySource);

    return {
      elements: resolved,
      source: primarySource,
      confidence: screenConfidence,
    };
  }
}
