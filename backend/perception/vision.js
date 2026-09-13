import { ScreenModel } from "./screen_model.js";

/**
 * Vision sensor — image analysis (OpenCV / plus a hosted vision model).
 * Highest-fidelity fallback after UIA and OCR. A real integration would
 * submit a screen capture to a vision model and parse the semantic result.
 */
export class Vision {
  constructor(analyzeFn = null) {
    this.name = "vision";
    // injectable analyzer: async (image) => ScreenModel-shaped object
    this.analyzeFn = analyzeFn;
  }

  canHandle() {
    return true;
  }

  async read(intent = {}) {
    if (this.analyzeFn) {
      const result = await this.analyzeFn(intent);
      const model = result instanceof ScreenModel ? result : new ScreenModel({ ...result, source: "vision" });
      return model;
    }
    return new ScreenModel({ source: "vision", confidence: 0 });
  }
}