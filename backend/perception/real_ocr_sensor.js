import { ocrLinesToModel } from "./real_ocr.js";

/**
 * RealOcrSensor — Perception-interface sensor backed by the live Windows
 * OCR bridge. Replaces the stub OCR in the perception stack when running
 * against the real desktop.
 */
export class RealOcrSensor {
  /**
   * @param {object} driver WindowsDriver instance (provides ocr() + foreground())
   */
  constructor(driver) {
    this.name = "ocr";
    this.driver = driver;
  }

  canHandle() {
    return true;
  }

  async read() {
    try {
      const ocr = await this.driver.ocr();
      if (!ocr.success || !ocr.lines?.length) {
        return { source: "ocr", confidence: 0, elements: [], application: "unknown", screen: "unknown" };
      }
      const fg = await this.driver.foreground().catch(() => null);
      const model = ocrLinesToModel(ocr.lines, fg);
      return model;
    } catch {
      return { source: "ocr", confidence: 0, elements: [], application: "unknown", screen: "unknown" };
    }
  }
}
