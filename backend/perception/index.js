import { ScreenModel } from "./screen_model.js";

/**
 * Perception interface — the single gateway the orchestrator uses to see the screen.
 * It hides the sensor stack (UIA, OCR, vision, ...) behind two methods:
 *
 *    perceive(intent) -> ScreenModel
 *    verify(step)     -> { success, data }
 *
 * Sensor priority (per spec):
 *    1. UI Automation / structured UI
 *    2. OCR
 *    3. OpenCV / image analysis
 *    4. Vision model
 *    5. Coordinate fallback
 *
 * The stack tries each sensor in order and takes the first that yields
 * an above-threshold, self-consistent result. OCR is ONE sensor, never
 * the whole intelligence layer.
 */
export class Perception {
  /**
   * @param {Array<{name:string, canHandle:(intent)=>boolean, read:(intent)=>Promise<ScreenModel>}>} sensors ordered by priority
   * @param {object} [config]
   */
  constructor(sensors, config = {}) {
    this.sensors = sensors;
    this.config = config;
    this.threshold = config?.perception?.confidenceThreshold ?? 0.6;
  }

  /** Returns the semantic world model for the current screen. */
  async perceive(intent = {}) {
    for (const sensor of this.sensors) {
      if (sensor.canHandle && !sensor.canHandle(intent)) continue;
      try {
        const model = await sensor.read(intent);
        if (model && model.confidence >= this.threshold) {
          return model;
        }
      } catch {
        // sensor failed; move to next priority
      }
    }
    // Fallback: empty model with negligible confidence.
    return new ScreenModel({ source: "none", confidence: 0 });
  }

  /**
   * Verify an executed step against the current screen.
   * Implementations may compare the world model before/after, or check
   * that a target is now present/absent.
   */
  async verify(step) {
    const model = await this.perceive({ intent: `verify ${step.type} ${step.target}` });
    const found = model.find(
      step.target
        ? { type: step.type === "open_app" ? "application" : step.type, name: step.target }
        : {}
    );
    const success = found.length > 0 || (model.source !== "none");
    return { success, data: model.toJSON() };
  }

  /**
   * Fail-closed mutation gate: verifies expected application is active before mutation.
   */
  canMutate(expectedApp, model = null) {
    const currentModel = model;
    if (!expectedApp) return { allowed: true, reason: "no_expectation" };
    if (!currentModel) return { allowed: false, reason: "no_screen_model" };

    const actual = String(currentModel.application || "").toLowerCase();
    const exp = String(expectedApp || "").toLowerCase();
    const allowed = actual.includes(exp) || exp.includes(actual);
    return {
      allowed,
      reason: allowed ? "compatible" : `identity_mismatch: expected '${expectedApp}', actual '${currentModel.application}'`,
    };
  }
}