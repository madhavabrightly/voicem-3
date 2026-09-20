/**
 * P4 Tickets 357, 369: Model Staleness & Environment Drift Tracking
 *
 *  357. Store screen timestamp.
 *  369. Compare previous screen / detect staleness.
 */

import { isIdentityCompatible } from "./identity.js";

export const DEFAULT_VALIDITY_WINDOW_MS = 3000;

export const SENSOR_VALIDITY_WINDOWS = {
  uia: 2500,
  ocr: 1500,
  vision: 3000,
  hybrid: 2000,
  default: 3000,
};

export class StalenessManager {
  /**
   * @param {object} [opts]
   * @param {number} [opts.validityWindowMs]
   * @param {object} [opts.sensorWindows]
   * @param {() => number} [opts.clock]
   */
  constructor({
    validityWindowMs = DEFAULT_VALIDITY_WINDOW_MS,
    sensorWindows = SENSOR_VALIDITY_WINDOWS,
    clock = () => Date.now(),
  } = {}) {
    this.validityWindowMs = validityWindowMs;
    this.sensorWindows = { ...SENSOR_VALIDITY_WINDOWS, ...sensorWindows };
    this.clock = clock;
  }

  /**
   * Returns validity window in ms for a model or sensor name.
   */
  getValidityWindow(modelOrSource) {
    if (!modelOrSource) return this.validityWindowMs;
    const src = typeof modelOrSource === "string" ? modelOrSource : modelOrSource.source;
    const key = String(src || "").toLowerCase();
    return this.sensorWindows[key] || this.validityWindowMs;
  }

  /**
   * Calculates the age of a ScreenModel in milliseconds.
   */
  getAge(model) {
    if (!model || !model.capturedAt) return Infinity;
    const now = typeof this.clock === "function" ? this.clock() : Date.now();
    return Math.max(0, now - model.capturedAt);
  }

  /**
   * Determines if a ScreenModel has exceeded its validity window.
   */
  isStale(model, maxAgeMs = null) {
    if (!model || !model.capturedAt) return true;
    const limit = maxAgeMs ?? this.getValidityWindow(model);
    return this.getAge(model) > limit;
  }

  /**
   * Staleness status: FRESH | STALE | EXPIRED
   */
  getStalenessStatus(model, maxAgeMs = null) {
    if (!model || !model.capturedAt) return "EXPIRED";
    const age = this.getAge(model);
    const limit = maxAgeMs ?? this.getValidityWindow(model);
    if (age > limit * 2) return "EXPIRED";
    if (age > limit) return "STALE";
    return "FRESH";
  }

  /**
   * Detects whether the current active environment has drifted away from the
   * environment recorded in the ScreenModel.
   *
   * @param {object} model ScreenModel
   * @param {object} currentEnvironment Fresh EnvironmentSnapshot
   * @returns {{ drifted: boolean, reason?: string, previous?: object, current?: object }}
   */
  detectEnvironmentDrift(model, currentEnvironment) {
    if (!model || !model.environment) {
      return { drifted: true, reason: "model_lacks_environment" };
    }
    if (!currentEnvironment) {
      return { drifted: false, reason: "no_current_environment" };
    }

    const prevHwnd = model.environment.hwnd;
    const currHwnd = currentEnvironment.hwnd;

    if (prevHwnd && currHwnd && prevHwnd !== "0x0" && currHwnd !== "0x0" && prevHwnd !== currHwnd) {
      return {
        drifted: true,
        reason: "window_hwnd_drift",
        previous: model.environment,
        current: currentEnvironment,
      };
    }

    const prevPid = model.environment.pid;
    const currPid = currentEnvironment.pid;
    if (prevPid && currPid && prevPid !== currPid) {
      return {
        drifted: true,
        reason: "process_pid_drift",
        previous: model.environment,
        current: currentEnvironment,
      };
    }

    // Tab / Document drift in same browser process
    if (model.environment.isBrowser || currentEnvironment.isBrowser) {
      const prevTab = model.selectedTab?.name || model.document || model.environment.title;
      const currTab = currentEnvironment.selectedTab?.name || currentEnvironment.title;
      if (prevTab && currTab && prevTab !== currTab) {
        return {
          drifted: true,
          reason: "browser_tab_drift",
          previous: model.environment,
          current: currentEnvironment,
        };
      }
    }

    return { drifted: false, reason: "consistent" };
  }

  /**
   * Re-perception trigger: evaluates staleness, drift, identity mismatch, or change.
   */
  shouldReperceive({ model, currentEnvironment = null, maxAgeMs = null, expectedTarget = null, compareResult = null } = {}) {
    if (!model) return true;
    if (this.isStale(model, maxAgeMs)) return true; // STALE -> re-perceive
    if (currentEnvironment) {
      const drift = this.detectEnvironmentDrift(model, currentEnvironment);
      if (drift.drifted) return true;
    }
    if (expectedTarget && model.identity) {
      const compat = isIdentityCompatible(model.identity, expectedTarget);
      if (!compat.compatible) return true; // IDENTITY_MISMATCH -> re-perceive
    }
    if (compareResult && (compareResult.status === "CHANGED" || compareResult.changes?.elementsChanged)) {
      return true; // CHANGED -> re-perceive
    }
    return false;
  }
}
