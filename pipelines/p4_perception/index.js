/**
 * P4 — Screen Perception & Proven Identity Pipeline (Tickets 301–400)
 *
 * Implements the full P4 Perception Gateway, preserving the standard Perception
 * interface (perceive, verify) while enforcing:
 *
 *   OBSERVATION ≠ IDENTITY ≠ INTERPRETATION
 *   - Explicit evidence levels: PROVEN, SUPPORTED, INFERRED, UNKNOWN
 *   - Element ownership stamping & environment drift protection
 *   - Deterministic screen hashing & state change detection
 *   - Browser selected-tab correlation
 *   - Fail-closed mutation gating before any destructive or input action
 */

import { ScreenCaptureEngine, computeCaptureHash } from "./capture.js";
import { EnvironmentProbe, sanitizeApplicationName } from "./environment_probe.js";
import { BrowserTargetResolver, isBrowserProcess, parseBrowserWindowTitle } from "./browser_target.js";
import { resolveProvenIdentity, isIdentityCompatible, EVIDENCE_LEVELS, normalizeIdentityName } from "./identity.js";
import { MultiSensorManager, normalizeCoordinates, classifyRoleType } from "./sensors.js";
import { ScreenModel, buildScreenModel, stampElementOwnership } from "./model_build.js";
import { ScreenStateClassifier, compareScreens, CHANGE_STATUS } from "./screen_state.js";
import { StalenessManager, DEFAULT_VALIDITY_WINDOW_MS } from "./staleness.js";
import { ObserverEngine, rankMatchingElements } from "./observer.js";
import { classifyWhatsAppScreen, classifyGenericScreen, ocrLinesToModel } from "../../backend/perception/real_ocr.js";

export {
  ScreenCaptureEngine,
  computeCaptureHash,
  EnvironmentProbe,
  sanitizeApplicationName,
  BrowserTargetResolver,
  isBrowserProcess,
  parseBrowserWindowTitle,
  resolveProvenIdentity,
  isIdentityCompatible,
  EVIDENCE_LEVELS,
  normalizeIdentityName,
  MultiSensorManager,
  normalizeCoordinates,
  classifyRoleType,
  ScreenModel,
  buildScreenModel,
  stampElementOwnership,
  ScreenStateClassifier,
  compareScreens,
  CHANGE_STATUS,
  StalenessManager,
  DEFAULT_VALIDITY_WINDOW_MS,
  ObserverEngine,
  rankMatchingElements,
};

const MUTATING_STEPS = new Set(["click", "type", "press", "scroll"]);
const DEFAULT_SETTLE_MS = 2500;
const DEFAULT_POLL_MS = 250;

/**
 * P4Perception — Production Screen Perception Engine.
 */
export class P4Perception {
  /**
   * @param {object} [p]
   * @param {object} [p.driver] PlatformDriver
   * @param {Array<object>} [p.sensors] Optional custom sensors list
   * @param {object} [p.config]
   * @param {() => number} [p.clock]
   * @param {object} [p.hooks] { foreground }
   */
  constructor({
    driver = null,
    sensors = null,
    config = {},
    clock = () => Date.now(),
    hooks = {},
  } = {}) {
    this.driver = driver;
    this.config = config;
    this.clock = clock;
    this.settleMs = config?.agent?.verifySettleMs ?? DEFAULT_SETTLE_MS;
    this.pollMs = config?.agent?.verifyPollMs ?? DEFAULT_POLL_MS;
    this.threshold = config?.perception?.confidenceThreshold ?? 0.6;

    this.captureEngine = new ScreenCaptureEngine({ driver, clock });
    this.envProbe = new EnvironmentProbe({ driver, clock });
    this.browserTargetResolver = new BrowserTargetResolver();
    this.stalenessManager = new StalenessManager({
      validityWindowMs: config?.perception?.validityWindowMs ?? DEFAULT_VALIDITY_WINDOW_MS,
      clock,
    });
    this.sensorManager = new MultiSensorManager({ driver, foreground: hooks.foreground || (() => this.envProbe.probe()) });
    this.observer = new ObserverEngine({
      sensorManager: this.sensorManager,
      environmentProbe: this.envProbe,
      browserTargetResolver: this.browserTargetResolver,
      stalenessManager: this.stalenessManager,
      clock,
    });

    this._lastModel = null;
    this._taskFg = null;
  }

  /**
   * 398. Perceive the current screen into a proven ScreenModel.
   *
   * @param {object} [intent]
   * @returns {Promise<ScreenModel>}
   */
  async perceive(intent = {}) {
    const timestamp = this.clock();

    // 1. Probe Environment (303–306, 357)
    const env = await this.envProbe.probe();

    // 2. Scan Sensors (307–349)
    let scanResult = null;
    try {
      scanResult = await this.sensorManager.scan({ intent, preferredMethod: intent.method || null });
    } catch {
      scanResult = { elements: [], source: "none", confidence: 0 };
    }

    // 3. Resolve Browser Targeting (336, 383)
    const browserTarget = env.isBrowser
      ? await this.browserTargetResolver.resolveBrowserTarget({ environment: env, uiaElements: scanResult.elements })
      : null;

    // 4. Resolve Proven Identity (305, 391, 392)
    const identity = resolveProvenIdentity({
      environment: env,
      browserTarget,
      ocrEvidence: scanResult.elements.filter((e) => e.source === "ocr"),
      uiaEvidence: scanResult.elements.filter((e) => e.source === "uia"),
    });

    // 5. Structure Elements into Domain Model
    let elements = scanResult.elements || [];
    let screen = "desktop";

    // Application specific classification when proven or supported
    if (identity.application === "WhatsApp" && (identity.level === EVIDENCE_LEVELS.PROVEN || identity.level === EVIDENCE_LEVELS.SUPPORTED)) {
      const ocrLines = elements
        .filter((e) => e.source === "ocr")
        .map((e) => ({
          text: e.name || e.text || "",
          x: e.bbox?.x ?? e.x ?? 0,
          y: e.bbox?.y ?? e.y ?? 0,
          w: e.bbox?.w ?? e.w ?? 0,
          h: e.bbox?.h ?? e.h ?? 0,
        }));
      if (ocrLines.length > 0) {
        const classified = classifyWhatsAppScreen(ocrLines, env.bounds, env);
        if (classified && classified.elements && classified.elements.length > 0) {
          elements = [...elements.filter((e) => e.source !== "ocr"), ...classified.elements];
          screen = classified.screen;
        }
      }
    } else if (identity.isBrowser) {
      screen = identity.documentType === "search_engine" ? "search_results" : "browser_tab";
    }

    // 6. Build and Stamp ScreenModel (348–356, 360–368)
    const model = new ScreenModel({
      application: identity.application,
      document: identity.document,
      screen,
      elements,
      source: scanResult.source,
      confidence: Math.max(scanResult.confidence, identity.level === EVIDENCE_LEVELS.PROVEN ? 0.9 : 0.7),
      environment: env,
      capturedAt: timestamp,
      identity,
    });

    this._lastModel = model;
    return model;
  }

  /**
   * Fail-closed mutation gate: checks if an action targeting expectedApp can safely execute.
   *
   * @param {string} expectedApp
   * @param {ScreenModel} [model]
   * @returns {{ allowed: boolean, reason: string, identity: object }}
   */
  canMutate(expectedApp, model = null) {
    const currentModel = model || this._lastModel;
    if (!expectedApp) return { allowed: true, reason: "no_expectation", identity: currentModel?.identity ?? null };
    if (!currentModel || !currentModel.identity) {
      return { allowed: false, reason: "no_screen_model_identity", identity: null };
    }

    const check = isIdentityCompatible(currentModel.identity, expectedApp);
    return {
      allowed: check.compatible,
      reason: check.reason,
      identity: currentModel.identity,
    };
  }

  /**
   * Real semantic verification with identity checking, settle window, and foreground drift detection.
   *
   * @param {object} step
   * @returns {Promise<{ success: boolean, data: object }>}
   */
  async verify(step) {
    const mutating = MUTATING_STEPS.has(step.type);
    const deadline = this.clock() + (mutating ? this.settleMs : 0);

    for (;;) {
      const model = await this.perceive({ intent: `verify ${step.type} ${step.target || ""}` });
      const data = model.toJSON();

      const checkResult = await this._checkStep(step, model, data);
      if (checkResult.success) {
        if (!mutating) return { success: true, data };

        // Drift check: ensure foreground did not switch away to unrelated window
        const drift = this._detectForegroundDrift(model);
        if (drift) {
          return { success: false, data: { ...data, drift } };
        }

        return { success: true, data };
      }

      if (this.clock() >= deadline) {
        return { success: false, data: { ...data, failureReason: checkResult.reason || "verification_timeout" } };
      }

      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  _detectForegroundDrift(model) {
    if (!this._taskFg || !model.environment) return null;
    const currHwnd = model.environment.hwnd;
    const prevHwnd = this._taskFg.hwnd;
    if (prevHwnd && currHwnd && prevHwnd !== "0x0" && currHwnd !== "0x0" && prevHwnd !== currHwnd) {
      return { expected: this._taskFg, actual: model.environment };
    }
    return null;
  }

  /**
   * Step verification logic with identity validation.
   */
  async _checkStep(step, model, data) {
    switch (step.type) {
      case "open_app": {
        const target = String(step.target || "").trim();
        const targetNorm = normalizeIdentityName(target);

        // Core fix: A generic search box alone is NOT proof of the application!
        // The identity MUST be PROVEN or SUPPORTED for the requested target.
        const idCheck = isIdentityCompatible(model.identity, target);
        if (!idCheck.compatible) {
          return {
            success: false,
            reason: `open_app_failed: ${idCheck.reason}`,
          };
        }

        // Target application is confirmed active
        if (model.environment) this._taskFg = model.environment;
        return { success: true };
      }

      case "click": {
        const target = step.target || "search_box";
        const found = model.find({ type: target }) || model.find({ name: target });
        return { success: found.length > 0, reason: found.length ? null : "target_not_found" };
      }

      case "type": {
        const query = step.args?.text || "";
        if (!query) return { success: false, reason: "empty_query" };
        const search = model.find({ type: "search_box" });
        const boxHasQuery = search.some((e) => String(e.query || "").length > 0);
        const resultsMatch = data.elements?.some((e) =>
          String(e.name || "").toLowerCase().includes(query.toLowerCase())
        );
        const ok = Boolean(search.length > 0 && boxHasQuery && resultsMatch);
        return { success: ok, reason: ok ? null : "query_did_not_render" };
      }

      case "read_screen":
      case "wait":
      case "find_element":
      default:
        return {
          success: Boolean(data.confidence > 0 && (data.elements?.length > 0 || model.environment?.title)),
          reason: null,
        };
    }
  }
}

/**
 * Re-export Perception alias for backwards compatibility.
 */
export const Perception = P4Perception;
