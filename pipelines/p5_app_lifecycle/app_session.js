/**
 * app_session.js — Application session identity and ownership tracking.
 * Tickets 479–480, 485–488, 498–500.
 *
 * Responsibilities:
 *   - Establish application ownership (479)
 *   - Establish application session identity (480)
 *   - Verify expected application state (485)
 *   - Reject wrong application (486)
 *   - Reject stale startup state (487)
 *   - Recover failed startup (488)
 *   - Build initial semantic application state (498)
 *   - Mark application READY (499)
 *   - Emit APPLICATION_READY event (500)
 */

import { createHash } from "node:crypto";

/** Evidence levels (ticket 499 — mirrors P4 EVIDENCE_LEVELS) */
export const SESSION_EVIDENCE = {
  PROVEN:    "PROVEN",    // HWND + PID + exe match
  SUPPORTED: "SUPPORTED", // title or class match
  INFERRED:  "INFERRED",  // name heuristic only
  UNKNOWN:   "UNKNOWN",
};

let _sessionCounter = 0;

/**
 * Build a deterministic session ID.
 * @param {string} name
 * @param {number} pid
 * @returns {string}
 */
function makeSessionId(name, pid) {
  const raw = `${name}:${pid}:${Date.now()}:${++_sessionCounter}`;
  return "sess_" + createHash("sha1").update(raw).digest("hex").slice(0, 12);
}

/**
 * Hash startup state for comparison (ticket 477, 489).
 * @param {object} snapshot
 * @returns {string}
 */
export function hashStartupState(snapshot) {
  const stable = {
    phase:  snapshot?.phase ?? "unknown",
    hwnd:   snapshot?.hwnd  ?? "0x0",
    dialogs: (snapshot?.dialogs ?? []).length,
    uia:    snapshot?.uiaAvailable ?? false,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}

// ─────────────────────────────────── AppSession ─────────────────────────────

export class AppSession {
  /**
   * @param {object} p
   * @param {string} p.naturalName
   * @param {import('./app_resolver.js').AppIdentity} p.identity
   * @param {object} p.launchResult  raw result from driver.launchApp()
   */
  constructor({ naturalName, identity, launchResult }) {
    this.sessionId    = makeSessionId(naturalName, launchResult?.data?.pid ?? 0);
    this.naturalName  = naturalName;
    this.identity     = identity;
    this.hwnd         = launchResult?.data?.hwnd ?? null;
    this.pid          = launchResult?.data?.pid  ?? null;
    this.launchAction = launchResult?.data?.action ?? "unknown";
    this.startedAt    = Date.now();
    this.startupSnapshots = [];
    this.evidence     = SESSION_EVIDENCE.UNKNOWN;
    this.ready        = false;
    this.readyAt      = null;
    this.terminated   = false;
    this._events      = [];
  }

  // ── ticket 479: establish application ownership ──────────────────────────
  establishOwnership(verifyResult) {
    // verifyResult from driver.verifyAppIdentity()
    if (verifyResult?.success && verifyResult?.data?.matched) {
      this.evidence = SESSION_EVIDENCE.PROVEN;
    } else if (verifyResult?.data?.title?.toLowerCase().includes(this.naturalName.toLowerCase())) {
      this.evidence = SESSION_EVIDENCE.SUPPORTED;
    } else {
      this.evidence = SESSION_EVIDENCE.INFERRED;
    }
    this._emit("OWNERSHIP_ESTABLISHED", { sessionId: this.sessionId, evidence: this.evidence });
    return this;
  }

  // ── ticket 485: verify expected application state ────────────────────────
  verifyExpectedState(snapshot) {
    if (!snapshot) return { verified: false, reason: "null snapshot" };
    const phase = snapshot.data?.phase ?? snapshot.phase ?? "unknown";
    if (phase === "crash")   return { verified: false, reason: "crash_detected" };
    if (phase === "unknown") return { verified: false, reason: "unknown_phase" };
    return { verified: true, phase, evidence: this.evidence };
  }

  // ── ticket 486: reject wrong application ─────────────────────────────────
  rejectWrongApp(actualTitle) {
    const n = this.naturalName.toLowerCase();
    if (!actualTitle || !actualTitle.toLowerCase().includes(n)) {
      this._emit("WRONG_APP_REJECTED", {
        sessionId:    this.sessionId,
        expected:     this.naturalName,
        actualTitle,
      });
      return { rejected: true, reason: `title '${actualTitle}' does not match '${this.naturalName}'` };
    }
    return { rejected: false };
  }

  // ── ticket 487: reject stale startup state ───────────────────────────────
  rejectStaleStartup(maxAgeMs = 30_000) {
    const age = Date.now() - this.startedAt;
    if (age > maxAgeMs) {
      this._emit("STALE_STARTUP_REJECTED", { sessionId: this.sessionId, ageMs: age, maxAgeMs });
      return { stale: true, ageMs: age };
    }
    return { stale: false, ageMs: age };
  }

  // ── ticket 498: build initial semantic application state ─────────────────
  buildInitialSemanticState(startupSnapshot, uiaSnapshot) {
    const phase    = startupSnapshot?.data?.phase ?? "unknown";
    const dialogs  = startupSnapshot?.data?.dialogs ?? [];
    const uiaOk    = uiaSnapshot?.data?.uiaAvailable ?? false;
    const children = uiaSnapshot?.data?.childCount   ?? 0;
    return {
      sessionId:  this.sessionId,
      naturalName: this.naturalName,
      hwnd:       this.hwnd,
      pid:        this.pid,
      phase,
      dialogs,
      uiaAvailable: uiaOk,
      uiaChildCount: children,
      evidence:   this.evidence,
      startedAt:  new Date(this.startedAt).toISOString(),
      capturedAt: new Date().toISOString(),
    };
  }

  // ── ticket 499: mark application READY ───────────────────────────────────
  markReady(semanticState) {
    this.ready   = true;
    this.readyAt = Date.now();
    const event  = this._emit("APPLICATION_READY", {
      sessionId:   this.sessionId,
      naturalName: this.naturalName,
      hwnd:        this.hwnd,
      pid:         this.pid,
      evidence:    this.evidence,
      readyAt:     new Date(this.readyAt).toISOString(),
      semanticState,
    });
    return event;
  }

  // ── ticket 500: APPLICATION_READY event already emitted via markReady ───

  // ── ticket 488: recover failed startup ───────────────────────────────────
  recordFailure(reason) {
    this._emit("STARTUP_FAILED", { sessionId: this.sessionId, reason });
    return { sessionId: this.sessionId, failed: true, reason };
  }

  addSnapshot(snapshot) {
    this.startupSnapshots.push({
      ts:       Date.now(),
      snapshot,
      stateHash: hashStartupState(snapshot?.data ?? {}),
    });
  }

  _emit(type, payload) {
    const event = { type, ts: new Date().toISOString(), payload };
    this._events.push(event);
    return event;
  }

  /** All events emitted during this session's lifecycle. */
  get events() { return this._events; }

  /** Return the APPLICATION_OPENED evidence record (ticket 450). */
  toOpenedEvidence() {
    return {
      type:        "APPLICATION_OPENED",
      sessionId:   this.sessionId,
      naturalName: this.naturalName,
      displayName: this.identity?.displayName ?? this.naturalName,
      hwnd:        this.hwnd,
      pid:         this.pid,
      evidence:    this.evidence,
      action:      this.launchAction,
      openedAt:    new Date(this.startedAt).toISOString(),
    };
  }

  toJSON() {
    return {
      sessionId:    this.sessionId,
      naturalName:  this.naturalName,
      hwnd:         this.hwnd,
      pid:          this.pid,
      evidence:     this.evidence,
      ready:        this.ready,
      readyAt:      this.readyAt ? new Date(this.readyAt).toISOString() : null,
      terminated:   this.terminated,
      launchAction: this.launchAction,
      snapshotCount: this.startupSnapshots.length,
      eventCount:   this._events.length,
    };
  }
}
