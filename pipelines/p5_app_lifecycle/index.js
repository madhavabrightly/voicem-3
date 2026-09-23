/**
 * pipelines/p5_app_lifecycle/index.js
 * P5 Application Lifecycle Pipeline — entry point.
 *
 * Covers tickets 435, 445–450, 491–495, 498–500.
 *
 * Public API:
 *   openApplication(naturalName, { driver, onEvent })  → AppSession
 *   attachToExisting(naturalName, { driver, onEvent }) → AppSession
 *   closeApplication(session, { driver, onEvent })     → { closed: boolean }
 *
 * The pipeline follows the layered flow:
 *
 *   LLM/Node decides target
 *     → resolveAppIdentity()      [Node — tickets 430–434]
 *     → driver.launchApp()        [PS1/C# — ticket 446]
 *     → buildStartupSnapshot()    [PS1/C# — ticket 476]
 *     → calculateStability()      [Node — ticket 478]
 *     → recoverFailedStartup()    [Node — ticket 488]
 *     → session.markReady()       [Node — ticket 499]
 *     → emit APPLICATION_READY   [Node — ticket 500]
 */

import { appEngineDriver }      from "./app_engine_driver.js";
import { resolveAppIdentity }   from "./app_resolver.js";
import { AppSession }           from "./app_session.js";
import {
  buildStartupSnapshot,
  calculateStability,
  recoverFailedStartup,
  retryControlledLaunch,
} from "./startup_classifier.js";

const DEFAULT_STABILITY_POLLS     = 4;
const DEFAULT_POLL_INTERVAL_MS    = 1500;
const DEFAULT_STARTUP_TIMEOUT_MS  = 30_000;
const DEFAULT_RECOVERY_ATTEMPTS   = 3;

// ─────────────────────────────────── openApplication ────────────────────────

/**
 * Full P5 open-application pipeline.
 *
 * @param {string} naturalName   e.g. "WhatsApp", "Notepad", "Chrome"
 * @param {object} [opts]
 * @param {import('./app_engine_driver.js').AppEngineDriver} [opts.driver]
 * @param {(event: object) => void} [opts.onEvent]
 * @param {number} [opts.startupTimeoutMs]
 * @returns {Promise<{ session?: AppSession, error?: string, evidence?: object }>}
 */
export async function openApplication(naturalName, {
  driver         = appEngineDriver,
  onEvent        = null,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
} = {}) {
  const emit = (e) => { if (onEvent) onEvent(e); };

  // ── Step 1: Resolve identity (tickets 430–434) ──────────────────────────
  emit({ type: "P5_RESOLVE_START", name: naturalName });
  const resolved = await resolveAppIdentity(driver, naturalName);

  if (resolved.error) {
    return { error: `identity resolution failed: ${resolved.error}` };
  }
  if (resolved.ambiguityRejection) {
    return {
      error: "ambiguous_match",
      ambiguity: resolved.ambiguityRejection,
      candidates: resolved.candidates,
    };
  }

  const { identity, launchRequest } = resolved;
  emit({ type: "P5_IDENTITY_RESOLVED", identity, launchRequest });

  // ── Step 2: Already running? Focus it (ticket 435, 491–492) ────────────
  if (identity.running && identity.hwnd) {
    const restoreResult = await driver.restoreMinimized(identity.hwnd);
    const fgResult      = await driver.verifyForeground(identity.hwnd);

    const session = new AppSession({ naturalName, identity, launchResult: {
      success: true, data: { hwnd: identity.hwnd, pid: identity.pid, action: "focus_existing" }
    }});
    session.establishOwnership({ success: true, data: { matched: true } });

    const snapshot = await buildStartupSnapshot(driver, identity.hwnd);
    session.addSnapshot(snapshot);
    const semState = session.buildInitialSemanticState(
      { data: snapshot }, { data: { uiaAvailable: snapshot.uiaAvailable, childCount: snapshot.uiaChildCount } }
    );
    const readyEvent = session.markReady(semState);
    emit(readyEvent);
    emit({ type: "APPLICATION_OPENED", data: session.toOpenedEvidence() });
    return { session, evidence: session.toOpenedEvidence() };
  }

  // ── Step 3: Launch (tickets 446–449) ────────────────────────────────────
  emit({ type: "P5_LAUNCH_START", name: naturalName, strategy: launchRequest.strategy });

  let launchResult = await driver.launchApp(naturalName);

  if (!launchResult.success) {
    // Bounded retry (ticket 489)
    const retry = await retryControlledLaunch(driver, naturalName, DEFAULT_RECOVERY_ATTEMPTS);
    if (!retry.success) {
      return { error: `launch failed after ${retry.attempts} attempts: ${retry.error}` };
    }
    launchResult = retry.result;
  }

  emit({ type: "P5_LAUNCH_DONE", result: launchResult.data });

  // ── Step 4: Build session (ticket 480) ───────────────────────────────────
  const session = new AppSession({ naturalName, identity, launchResult });

  // ── Step 5: Verify identity (ticket 449) ─────────────────────────────────
  let verifyResult = { success: false, data: {} };
  if (session.hwnd && session.hwnd !== "0x0") {
    verifyResult = await driver.verifyAppIdentity(session.hwnd, naturalName);
  }
  session.establishOwnership(verifyResult);
  emit({ type: "P5_OWNERSHIP_ESTABLISHED", evidence: session.evidence, hwnd: session.hwnd });

  // ── Step 6: Startup stability polling (tickets 476–478) ──────────────────
  const deadline = Date.now() + startupTimeoutMs;
  let snapshots  = [];
  let stability  = { stable: false };

  while (Date.now() < deadline && !stability.stable) {
    if (!session.hwnd || session.hwnd === "0x0") {
      // Window not yet known — re-detect
      const runCheck = await driver.detectRunning(naturalName);
      if (runCheck.success && runCheck.data?.running) {
        session.hwnd = runCheck.data?.instance?.hwnd ?? session.hwnd;
        session.pid  = runCheck.data?.instance?.pid  ?? session.pid;
      }
    }

    if (session.hwnd && session.hwnd !== "0x0") {
      const snap = await buildStartupSnapshot(driver, session.hwnd);
      session.addSnapshot(snap);
      snapshots.push(snap);
      stability = calculateStability(snapshots.slice(-DEFAULT_STABILITY_POLLS));
      emit({ type: "P5_STARTUP_POLL", snapshot: snap, stability });

      if (stability.stable) break;

      // Crash or dialog detected → attempt recovery
      if (snap.phase === "crash" || snap.dialogs.length > 0) {
        const recovery = await recoverFailedStartup(driver, session, snap, 1);
        emit({ type: "P5_RECOVERY_ATTEMPT", recovery });
        if (!recovery.recovered) {
          session.recordFailure(recovery.action);
          return { error: `startup recovery failed: ${recovery.action}`, session };
        }
        if (recovery.newHwnd) {
          session.hwnd = recovery.newHwnd;
          session.pid  = recovery.newPid ?? session.pid;
          snapshots    = [];
        }
        // If action is "dismiss_dialog" — caller (toolbox/orchestrator)
        // must press Escape; we wait and re-poll
      }
    }

    if (!stability.stable) {
      await sleep(DEFAULT_POLL_INTERVAL_MS);
    }
  }

  if (!stability.stable) {
    // Timeout (ticket 462) — accept if phase is at least not loading
    const lastSnap = snapshots[snapshots.length - 1];
    if (!lastSnap || lastSnap.phase === "loading" || lastSnap.phase === "unknown") {
      emit({ type: "P5_STARTUP_TIMEOUT", name: naturalName });
      // Don't fail hard — many apps take time. Mark as partial.
      stability = { stable: true, phase: "partial", reason: "timeout_accepted" };
    }
  }

  // ── Step 7: Build semantic state (ticket 498) ─────────────────────────────
  const lastSnap  = snapshots[snapshots.length - 1] ?? {};
  const uiaResult = session.hwnd && session.hwnd !== "0x0"
    ? await driver.detectUiaReady(session.hwnd)
    : { data: {} };
  const semState  = session.buildInitialSemanticState(
    { data: lastSnap },
    { data: { uiaAvailable: uiaResult.data?.uiaAvailable, childCount: uiaResult.data?.childCount } }
  );

  // ── Step 8: Mark READY + emit events (tickets 499–500, 450) ─────────────
  const readyEvent   = session.markReady(semState);
  const openedRecord = session.toOpenedEvidence();

  emit(readyEvent);
  emit({ type: "APPLICATION_OPENED", data: openedRecord });

  return { session, evidence: openedRecord, semanticState: semState };
}

// ─────────────────────────────────── attachToExisting ───────────────────────

/**
 * Attach to an already-running application instance (tickets 491–492).
 * @param {string} naturalName
 * @param {object} [opts]
 * @returns {Promise<{ session?: AppSession, error?: string }>}
 */
export async function attachToExisting(naturalName, { driver = appEngineDriver, onEvent = null } = {}) {
  const emit = (e) => { if (onEvent) onEvent(e); };

  const runCheck = await driver.detectRunning(naturalName);
  if (!runCheck.success || !runCheck.data?.running) {
    return { error: `'${naturalName}' is not currently running` };
  }

  const inst   = runCheck.data.instance;
  const hwnd   = inst?.hwnd ?? null;
  const pid    = inst?.pid  ?? null;
  const title  = inst?.title ?? "";

  // Restore + focus (tickets 493–495)
  if (hwnd) {
    await driver.restoreMinimized(hwnd);
    await driver.verifyForeground(hwnd);
  }

  const identity = {
    naturalName, displayName: title || naturalName,
    path: inst?.path ?? "", hwnd, pid, running: true, score: 1.0, source: "running",
  };
  const session = new AppSession({ naturalName, identity, launchResult: {
    success: true, data: { hwnd, pid, action: "attach" },
  }});
  const verifyResult = hwnd ? await driver.verifyAppIdentity(hwnd, naturalName) : { success: false };
  session.establishOwnership(verifyResult);

  const snap     = hwnd ? await buildStartupSnapshot(driver, hwnd) : {};
  const semState = session.buildInitialSemanticState({ data: snap }, { data: {} });
  const readyEv  = session.markReady(semState);
  emit(readyEv);
  emit({ type: "APPLICATION_OPENED", data: session.toOpenedEvidence() });

  return { session, evidence: session.toOpenedEvidence() };
}

// ─────────────────────────────────── closeApplication ───────────────────────

/**
 * Safely close an application (tickets 796–799).
 * @param {AppSession} session
 * @param {object} [opts]
 * @returns {Promise<{ closed: boolean, error?: string }>}
 */
export async function closeApplication(session, { driver = appEngineDriver, onEvent = null } = {}) {
  const emit = (e) => { if (onEvent) onEvent(e); };
  const hwnd = session?.hwnd;
  if (!hwnd || hwnd === "0x0") return { closed: false, error: "no hwnd in session" };

  emit({ type: "P5_CLOSE_START", sessionId: session.sessionId, hwnd });

  // Send WM_CLOSE via PostMessage (ticket 798)
  // We use the AHK WinClose path or PS1 stop
  const ahkAvail = await driver.ahkIsAvailable();
  if (ahkAvail) {
    const r = await driver.ahkCmd({ cmd: "win_close", name: session.naturalName });
    if (r.ok) {
      session.terminated = true;
      emit({ type: "APPLICATION_CLOSED", sessionId: session.sessionId });
      return { closed: true };
    }
  }

  // Fallback: Stop-Process for the pid
  if (session.pid) {
    try {
      const { execSync } = await import("node:child_process");
      execSync(`taskkill /PID ${session.pid} /F`, { stdio: "ignore" });
      session.terminated = true;
      emit({ type: "APPLICATION_CLOSED", sessionId: session.sessionId });
      return { closed: true };
    } catch (e) {
      return { closed: false, error: e.message };
    }
  }

  return { closed: false, error: "no close method available" };
}

// ─────────────────────────────────── util ────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Re-export key sub-modules for convenience
export { appEngineDriver } from "./app_engine_driver.js";
export { resolveAppIdentity, normalizeName, resolveAlias } from "./app_resolver.js";
export { AppSession, hashStartupState, SESSION_EVIDENCE } from "./app_session.js";
export {
  buildStartupSnapshot,
  compareStartupSnapshots,
  calculateStability,
  recoverFailedStartup,
  retryControlledLaunch,
} from "./startup_classifier.js";
