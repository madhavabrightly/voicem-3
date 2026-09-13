import { ScreenModel } from "./screen_model.js";

/**
 * OCR sensor — converts screen pixels / captures into text tokens.
 * Per spec, OCR is only ONE sensor. It reports text with a conservative
 * confidence; the semantic mapping (text -> element) is done here into a
 * ScreenModel, but a real integration (e.g. with a local OCR engine such
 * as tesseract) would feed the recognized strings in.
 */
export class OCR {
  constructor(detectFn = null) {
    this.name = "ocr";
    // injectable detector; defaults to a stub that finds nothing
    this.detectFn = detectFn || (async () => ({ text: "", confidence: 0 }));
  }

  canHandle() {
    return true;
  }

  async read(intent = {}) {
    const { text, confidence } = await this.detectFn();
    if (!text || confidence < 0.3) {
      // Below threshold: report nothing so the stack moves to vision.
      return new ScreenModel({ source: "ocr", confidence: 0 });
    }
    // Heuristic: turn recognized text lines into clickable elements.
    const elements = text
      .split("\n")
      .filter(Boolean)
      .map((name) => ({ type: "text", name, action: "click" }));
    const app = String(intent.application || "unknown");
    return new ScreenModel({
      application: app,
      screen: "ocr_detected",
      elements,
      source: "ocr",
      confidence,
    });
  }
}