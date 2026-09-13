import { ScreenModel } from "./screen_model.js";

/**
 * UI Automation sensor — structured UI tree, the highest-priority sensor.
 * On Windows this would wrap the Windows UI Automation API.
 *
 * For the MVP this is a stub that returns an empty model (no structured
 * UI available / not connected). The interface is determinist and returns
 * a ScreenModel either way so callers never special-case a sensor.
 */
export class UIA {
  constructor() {
    this.name = "uia";
  }

  canHandle() {
    return true; // tries to read structured UI for every intent
  }

  async read() {
    // Real implementation would call into the Windows UIA COM API.
    return new ScreenModel({
      source: "uia",
      confidence: 0, // nothing discovered -> below threshold -> stack falls through to OCR
      elements: [],
    });
  }
}

export class UIAStub extends UIA {
  constructor(sampleModel = null) {
    super();
    this.sampleModel = sampleModel;
  }

  async read() {
    if (this.sampleModel) return this.sampleModel;
    return super.read();
  }
}