/**
 * startup_classifier.js — Startup state analysis & recovery strategies.
 * Tickets 476–488.
 *
 * Responsibilities:
 *   - Build startup-state snapshot (476)
 *   - Compare startup snapshots (477)
 *   - Calculate startup stability (478)
 *   - Recover failed startup (488)
 *   - Retry controlled launch (489)
 */

import { hashStartupState } from "./app_session.js";

// ── ticket 476: build startup snapshot ──────────────────────────────────────

/**
 * Collect one startup snapshot: phase + dialogs + UIA readiness.
 * @param {import('./app_engine_driver.js').AppEngineDriver} driver
 * @param {string} hwnd
 * @returns {Promise<object>}
 */
export async function buildStartupSnapshot(driver, hwnd) {
  const [phaseResult, dialogResult, uiaResult] = await Promise.all([
    driver.detectStartupPhase(hwnd),
    driver.detectDialogs(hwnd),
    driver.detectUiaReady(hwnd),
  ]);

  const phase   = phaseResult.data?.phase ?? "unknown";
  const dialogs = dialogResult.data?.dialogs ?? [];
  const uiaOk   = uiaResult.data?.uiaAvailable ?? false;
  const uiaCnt  = uiaResult.data?.childCount   ?? 0;

  const snapshot = { hwnd, phase, dialogs, uiaAvailable: uiaOk, uiaChildCount: uiaCnt };
  const stateHash = hashStartupState(snapshot);

  return {
    ts:         Date.now(),
    hwnd,
    phase,
    dialogs,
    uiaAvailable: uiaOk,
    uiaChildCount: uiaCnt,
    stateHash,
    raw: { phaseResult, dialogResult, uiaResult },
  };
}

// ── ticket 477: compare startup snapshots ────────────────────────────────────

/**
 * Compare two snapshots and detect what changed.
 * @param {object} before
 * @param {object} after
 * @returns {object} diff object
 */
export function compareStartupSnapshots(before, after) {
  if (!before || !after) return { comparable: false };

  const phaseChanged    = before.phase  !== after.phase;
  const dialogsChanged  = before.dialogs.length !== after.dialogs.length;
  const uiaChanged      = before.uiaAvailable !== after.uiaAvailable;
  const uiaCntChanged   = before.uiaChildCount !== after.uiaChildCount;
  const hashChanged     = before.stateHash !== after.stateHash;

  return {
    comparable: true,
    elapsed:    after.ts - before.ts,
    changed:    hashChanged,
    phaseChanged,
    dialogsChanged,
    uiaChanged,
    uiaCntChanged,
    phaseBefore: before.phase,
    phaseAfter:  after.phase,
    dialogsBefore: before.dialogs.length,
    dialogsAfter:  after.dialogs.length,
    hashBefore:  before.stateHash,
    hashAfter:   after.stateHash,
  };
}

// ── ticket 478: calculate startup stability ──────────────────────────────────

/**
 * Determine whether startup state has stabilised across N snapshots.
 * "Stable" = last two hashes identical and phase is 'ready'.
 * @param {object[]} snapshots ordered oldest→newest
 * @returns {{ stable: boolean, phase: string, iterations: number, reason: string }}
 */
export function calculateStability(snapshots) {
  if (!snapshots || snapshots.length === 0) {
    return { stable: false, phase: "unknown", iterations: 0, reason: "no_snapshots" };
  }
  const last = snapshots[snapshots.length - 1];

  if (last.phase === "crash") {
    return { stable: false, phase: "crash", iterations: snapshots.length, reason: "crash_detected" };
  }
  if (last.dialogs?.length > 0) {
    return { stable: false, phase: "dialog", iterations: snapshots.length, reason: "dialog_blocking" };
  }
  if (last.phase === "ready") {
    // Confirm at least two consecutive matching hashes if we have them
    if (snapshots.length >= 2) {
      const prev = snapshots[snapshots.length - 2];
      if (prev.stateHash === last.stateHash) {
        return { stable: true, phase: "ready", iterations: snapshots.length, reason: "hash_stable" };
      }
    } else {
      // Single snapshot — accept if UIA available
      if (last.uiaAvailable && last.uiaChildCount > 0) {
        return { stable: true, phase: "ready", iterations: 1, reason: "uia_single_snapshot" };
      }
    }
  }
  return { stable: false, phase: last.phase, iterations: snapshots.length, reason: "still_loading" };
}

// ── ticket 488: recover failed startup ───────────────────────────────────────
// ── ticket 489: retry controlled launch ──────────────────────────────────────

const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_BACKOFF_MS   = [1000, 2000, 4000];

/**
 * Recover from a failed startup:
 *   attempt 1: dismiss any dialog (Escape), re-poll
 *   attempt 2: re-launch via driver
 *   attempt 3: fail permanently
 *
 * @param {import('./app_engine_driver.js').AppEngineDriver} driver
 * @param {AppSession} session
 * @param {object} lastSnapshot
 * @param {number} attempt  1-indexed
 * @returns {Promise<{ recovered: boolean, action: string, newHwnd?: string, error?: string }>}
 */
export async function recoverFailedStartup(driver, session, lastSnapshot, attempt = 1) {
  if (attempt > MAX_RECOVERY_ATTEMPTS) {
    return { recovered: false, action: "max_retries_exceeded", error: "startup recovery exhausted" };
  }

  const backoff = RECOVERY_BACKOFF_MS[attempt - 1] ?? 4000;
  await sleep(backoff);

  const phase   = lastSnapshot?.phase ?? "unknown";
  const dialogs = lastSnapshot?.dialogs ?? [];

  // Strategy 1: dialog blocking — dismiss it (attempt 1)
  if (dialogs.length > 0 && attempt === 1) {
    const dlg    = dialogs[0];
    const hwnd   = dlg.hwnd;
    const kind   = dlg.kind;
    // Safe dialogs: dismiss with Escape / close
    if (["first_run", "update", "license", "informational"].includes(kind)) {
      // We return a signal; the Node orchestrator will call keyboard.press('escape')
      return { recovered: true, action: "dismiss_dialog", dialogHwnd: hwnd, dialogKind: kind };
    }
    if (kind === "authentication" || kind === "account_select") {
      return { recovered: false, action: "auth_dialog_requires_user", dialogKind: kind };
    }
    if (kind === "crash_wer") {
      return { recovered: false, action: "crash_detected", dialogKind: kind };
    }
  }

  // Strategy 2: re-poll foreground (attempt 1–2 for loading state)
  if (phase === "loading" && attempt <= 2) {
    const fresh = await buildStartupSnapshot(driver, session.hwnd);
    const stab  = calculateStability([lastSnapshot, fresh]);
    if (stab.stable) {
      return { recovered: true, action: "loading_resolved", newSnapshot: fresh };
    }
    return { recovered: false, action: "still_loading", nextAttempt: attempt + 1, snapshot: fresh };
  }

  // Strategy 3: re-launch
  if (attempt === 2 || phase === "crash") {
    const relaunch = await driver.launchApp(session.naturalName);
    if (relaunch.success) {
      return {
        recovered: true,
        action:    "relaunched",
        newHwnd:   relaunch.data?.hwnd,
        newPid:    relaunch.data?.pid,
      };
    }
    return { recovered: false, action: "relaunch_failed", error: relaunch.error };
  }

  return { recovered: false, action: "unknown_phase", phase };
}

// ── ticket 489: retry controlled launch ──────────────────────────────────────

/**
 * Retry a launch with bounded retries + exponential backoff.
 * @param {import('./app_engine_driver.js').AppEngineDriver} driver
 * @param {string} naturalName
 * @param {number} maxAttempts
 * @returns {Promise<{ success: boolean, result?: object, attempts: number, error?: string }>}
 */
export async function retryControlledLaunch(driver, naturalName, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await driver.launchApp(naturalName);
    if (r.success) return { success: true, result: r, attempts: attempt };
    if (attempt < maxAttempts) {
      await sleep(RECOVERY_BACKOFF_MS[attempt - 1] ?? 2000);
    }
  }
  return { success: false, attempts: maxAttempts, error: `launch failed after ${maxAttempts} attempts` };
}

// ─────────────────────────────────── util ────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
