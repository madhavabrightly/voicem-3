/**
 * P4 Tickets 357, 369: Model Staleness & Environment Drift Tracking
 *
 *  357. Store screen timestamp.
 *  369. Compare previous screen / detect staleness.
 */

export const DEFAULT_VALIDITY_WINDOW_MS = 3000;

export class StalenessManager {
  /**
   * @param {object} [opts]
   * @param {number} [opts.validityWindowMs]
   * @param {() => number} [opts.clock]
   */
  constructor({ validityWindowMs = DEFAULT_VALIDITY_WINDOW_MS, clock = () => Date.now() } = {}) {
    this.validityWindowMs = validityWindowMs;
    this.clock = clock;
  }

  /**
   * Calculates the age of a ScreenModel in milliseconds.
   */
  getAge(model) {
    if (!model || !model.capturedAt) return Infinity;
    const now = this.clock();
    return Math.max(0, now - model.capturedAt);
  }

  /**
   * Determines if a ScreenModel has exceeded its validity window.
   */
  isStale(model, maxAgeMs = null) {
    const limit = maxAgeMs ?? this.validityWindowMs;
    return this.getAge(model) > limit;
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

    return { drifted: false, reason: "consistent" };
  }

  /**
   * Re-perception trigger: returns true if the model is stale OR environment has drifted.
   */
  shouldReperceive({ model, currentEnvironment = null, maxAgeMs = null } = {}) {
    if (!model) return true;
    if (this.isStale(model, maxAgeMs)) return true;
    if (currentEnvironment) {
      const drift = this.detectEnvironmentDrift(model, currentEnvironment);
      if (drift.drifted) return true;
    }
    return false;
  }
}
