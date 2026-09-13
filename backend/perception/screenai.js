import { Perception } from "./index.js";
import { UIA } from "./uia.js";
import { OCR } from "./ocr.js";
import { Vision } from "./vision.js";

/**
 * Screen-AI facade: builds the perception stack in priority order and
 * exposes it behind the Perception interface.
 *
 *   priority: UIA -> OCR -> OpenCV/vision -> coordinate fallback
 *
 * Detectors are injected so tests/MVP can feed realistic world models
 * without a live Windows UI Automation or camera.
 */
export function createPerception({ uiaModel = null, ocrDetect = null, visionAnalyze = null, extraSensors = [] } = {}, config = {}) {
  const uia = uiaModel ? { name: "uia", canHandle: () => true, read: async () => uiaModel } : new UIA();
  const ocr = new OCR(ocrDetect);
  const vision = new Vision(visionAnalyze);

  // extraSensors lets callers (demos/tests) insert real sensors into the stack
  // without changing the default simulated behaviour.
  return new Perception([uia, ocr, ...extraSensors, vision], config);
}