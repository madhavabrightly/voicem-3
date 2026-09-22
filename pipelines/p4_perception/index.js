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

import { ScreenCaptureEngine, computeCaptureHash, computeSemanticStateHash } from "./capture.js";
import { EnvironmentProbe, sanitizeApplicationName } from "./environment_probe.js";
import { BrowserTargetResolver, isBrowserProcess, parseBrowserWindowTitle } from "./browser_target.js";
import {
  resolveProvenIdentity,
  isIdentityCompatible,
  isNonAppWebDocument,
  EVIDENCE_LEVELS,
  IDENTITY_REASON_CODES,
  normalizeIdentityName,
} from "./identity.js";
import { MultiSensorManager, normalizeCoordinates, classifyRoleType } from "./sensors.js";
import { ScreenModel, buildScreenModel, stampElementOwnership } from "./model_build.js";
import { ScreenStateClassifier, compareScreens, CHANGE_STATUS } from "./screen_state.js";
import { StalenessManager, DEFAULT_VALIDITY_WINDOW_MS, SENSOR_VALIDITY_WINDOWS } from "./staleness.js";
import { ObserverEngine, rankMatchingElements } from "./observer.js";
import { classifyWhatsAppScreen, classifyGenericScreen, ocrLinesToModel } from "../../backend/perception/real_ocr.js";

export {
  ScreenCaptureEngine,
  computeCaptureHash,
  computeSemanticStateHash,
  EnvironmentProbe,
  sanitizeApplicationName,
  BrowserTargetResolver,
  isBrowserProcess,
  parseBrowserWindowTitle,
  resolveProvenIdentity,
  isIdentityCompatible,
  isNonAppWebDocument,
  EVIDENCE_LEVELS,
  IDENTITY_REASON_CODES,
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
  SENSOR_VALIDITY_WINDOWS,
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
    uiaDriver = null,
    sensors = null,
    config = {},
    clock = () => Date.now(),
    hooks = {},
  } = {}) {
    this.driver = driver;
    this.uiaDriver = uiaDriver;
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
    this.sensorManager = new MultiSensorManager({ driver, uiaDriver, foreground: hooks.foreground || (() => this.envProbe.probe()) });
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
          // Strip stale ownership from classified elements — classifyWhatsAppScreen
          // creates an internal ScreenModel that auto-stamps with empty environment.
          // The final ScreenModel below will re-stamp with the real env (hwnd, pid).
          const stripped = classified.elements.map((e) => {
            const { ownership, ...rest } = e;
            return rest;
          });
          elements = [...elements.filter((e) => e.source !== "ocr"), ...stripped];
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
      selectedTab: identity.selectedTab || browserTarget?.activeTab || null,
      clock: this.clock,
    });

    this._lastModel = model;
    return model;
  }

  /**
   * Fail-closed mutation gate: checks if an action targeting expectedApp can safely execute.
   *
   * Before every identity-sensitive mutation:
   * 1. Obtain current perception
   * 2. Compare expected identity
   * 3. Verify target ownership
   * 4. Verify freshness
   * 5. Verify focus
   * 6. Only then allow mutation
   *
   * @param {string|object} expectedAppOrSpec
   * @param {ScreenModel} [model]
   * @returns {{ allowed: boolean, code: string, reason: string, failedField?: string, identity: object, recoveryHandoff?: object }}
   */
  canMutate(expectedAppOrSpec, model = null) {
    const currentModel = model || this._lastModel;
    const expSpec =
      typeof expectedAppOrSpec === "string"
        ? { application: expectedAppOrSpec }
        : { ...(expectedAppOrSpec || {}) };

    if (!expectedAppOrSpec) {
      return {
        allowed: true,
        code: IDENTITY_REASON_CODES.IDENTITY_PROVEN,
        reason: "no_expectation",
        identity: currentModel?.identity ?? null,
      };
    }

    // 1. Obtain current perception
    if (!currentModel || !currentModel.identity) {
      return {
        allowed: false,
        code: IDENTITY_REASON_CODES.IDENTITY_UNKNOWN,
        reason: "no_screen_model_identity",
        failedField: "identity",
        identity: null,
        recoveryHandoff: {
          expectedIdentity: expSpec,
          actualIdentity: null,
          mismatchReason: "no_screen_model_identity",
          candidateTargets: [],
          requiredEvidence: "screen_perception",
          reperceiveRequest: { intent: "recover missing perception", suggestedMethod: "uia" },
        },
      };
    }

    // 2. Compare expected identity
    const check = isIdentityCompatible(currentModel.identity, expSpec);
    if (!check.compatible) {
      return {
        allowed: false,
        code: check.code,
        reason: check.reason,
        failedField: check.failedField || "identity",
        identity: currentModel.identity,
        recoveryHandoff: {
          expectedIdentity: expSpec,
          actualIdentity: currentModel.identity,
          mismatchReason: check.reason,
          candidateTargets: (currentModel.elements || []).slice(0, 5),
          requiredEvidence: check.failedField || "application_identity",
          reperceiveRequest: {
            intent: `recover identity mismatch for ${expSpec.application || expSpec.expectedApplication || "target"}`,
            suggestedMethod: "uia",
          },
        },
      };
    }

    // 3. Verify target ownership
    if (expSpec.targetElement && expSpec.targetElement.ownership) {
      const elHwnd = expSpec.targetElement.ownership.hwnd;
      if (elHwnd && currentModel.hwnd && elHwnd !== "0x0" && currentModel.hwnd !== "0x0" && elHwnd !== currentModel.hwnd) {
        return {
          allowed: false,
          code: IDENTITY_REASON_CODES.IDENTITY_MISMATCH,
          reason: `target_ownership_drift: element bound to hwnd ${elHwnd} but active window is ${currentModel.hwnd}`,
          failedField: "ownership",
          identity: currentModel.identity,
          recoveryHandoff: {
            expectedIdentity: expSpec,
            actualIdentity: currentModel.identity,
            mismatchReason: `ownership_drift_hwnd_${elHwnd}`,
            candidateTargets: currentModel.find({ type: expSpec.targetElement.type, name: expSpec.targetElement.name }),
            requiredEvidence: "element_ownership",
            reperceiveRequest: { intent: "re-locate target element", suggestedMethod: "uia" },
          },
        };
      }
    }

    // 4. Verify freshness
    if (this.stalenessManager.isStale(currentModel)) {
      return {
        allowed: false,
        code: IDENTITY_REASON_CODES.IDENTITY_STALE,
        reason: `identity_stale: screen model age ${this.stalenessManager.getAge(currentModel)}ms exceeds validity window`,
        failedField: "stalenessStatus",
        identity: currentModel.identity,
        recoveryHandoff: {
          expectedIdentity: expSpec,
          actualIdentity: currentModel.identity,
          mismatchReason: "screen_model_stale",
          candidateTargets: (currentModel.elements || []).slice(0, 5),
          requiredEvidence: "fresh_perception",
          reperceiveRequest: { intent: "refresh stale model", suggestedMethod: currentModel.source || "uia" },
        },
      };
    }

    // 5. Verify focus
    if (
      this._taskFg &&
      currentModel.hwnd &&
      this._taskFg.hwnd !== "0x0" &&
      currentModel.hwnd !== "0x0" &&
      this._taskFg.hwnd !== currentModel.hwnd
    ) {
      return {
        allowed: false,
        code: IDENTITY_REASON_CODES.IDENTITY_MISMATCH,
        reason: `foreground_focus_lost: expected focus on ${this._taskFg.hwnd}, actual active window is ${currentModel.hwnd}`,
        failedField: "focus",
        identity: currentModel.identity,
        recoveryHandoff: {
          expectedIdentity: expSpec,
          actualIdentity: currentModel.identity,
          mismatchReason: "foreground_focus_lost",
          candidateTargets: [],
          requiredEvidence: "window_focus",
          reperceiveRequest: { intent: "restore window focus", suggestedMethod: "foreground" },
        },
      };
    }

    // 6. Only then allow mutation
    return {
      allowed: true,
      code:
        currentModel.identity.level === EVIDENCE_LEVELS.PROVEN
          ? IDENTITY_REASON_CODES.IDENTITY_PROVEN
          : IDENTITY_REASON_CODES.IDENTITY_SUPPORTED,
      reason: "identity_freshness_and_focus_verified",
      failedField: null,
      identity: currentModel.identity,
      model: currentModel,
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

        // 1. Strict identity compatibility verification
        const idCheck = isIdentityCompatible(model.identity, target);
        if (!idCheck.compatible) {
          return {
            success: false,
            reason: `open_app_failed: ${idCheck.reason}`,
          };
        }

        // 2. Only store task foreground snapshot AFTER proven/supported verification passes
        if (model.environment && model.environment.hwnd && model.environment.hwnd !== "0x0") {
          this._taskFg = {
            ...model.environment,
            application: model.application,
            document: model.document,
            identity: model.identity,
          };
        }
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
