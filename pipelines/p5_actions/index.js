/**
 * pipelines/p5_actions/index.js — P5 Computer Action Pipeline (Tickets 401–500)
 *
 * This is the formal P5 entry point matching the catalog.
 * It delegates to the existing ToolBox (backend/tools/) and
 * p5_app_lifecycle pipeline for the application lifecycle sub-domain.
 *
 * Design invariants:
 *   - NEVER duplicate action implementations — delegate to ToolBox
 *   - NEVER spawn Python; all input dispatch is via Win32 (user32.dll)
 *   - Every tool call returns a structured ToolResult (deterministic, JSON-serializable)
 *   - Fail-closed: a failed action returns a failure ToolResult, never a false success
 *
 * Pipeline map (ticket → module):
 *   401–434: Windows driver init + target resolution    → backend/tools/win/win_driver.js
 *   435–500: Application lifecycle (open/probe/ready)  → pipelines/p5_app_lifecycle/
 *   401–492: Computer action dispatch (click/type/etc.) → backend/tools/index.js (ToolBox)
 *   489–492: ToolResult schema + logging                → backend/core/result.js
 *   493–500: Test coverage                              → tests/p5_action_pipeline.test.js
 */

export {
  // Application lifecycle (tickets 435–500)
  openApplication,
  attachToExisting,
  closeApplication,
  appEngineDriver,
} from "../p5_app_lifecycle/index.js";

export {
  // App resolution (tickets 418–434)
  resolveAppIdentity,
  normalizeName,
  resolveAlias,
  rankCandidates,
  scoreCandidate,
  checkAmbiguity,
  confirmTarget,
  prepareLaunchRequest,
} from "../p5_app_lifecycle/app_resolver.js";

export {
  // App session (tickets 479–500)
  AppSession,
  SESSION_EVIDENCE,
  hashStartupState,
} from "../p5_app_lifecycle/app_session.js";

export {
  // App engine driver (tickets 401–413, 435–437, 441–449, 451–496)
  AppEngineDriver,
} from "../p5_app_lifecycle/app_engine_driver.js";

export {
  // Startup classifier (tickets 451–478, 488)
  buildStartupSnapshot,
  calculateStability,
  recoverFailedStartup,
  retryControlledLaunch,
} from "../p5_app_lifecycle/startup_classifier.js";

// ─────────────────────────────────────────────────────── ToolResult contract ──

export { ToolResult } from "../../backend/core/result.js";

// ─────────────────────────────────────────────────── P5 Action dispatcher ────

/**
 * Action type constants (catalog tickets 409–492).
 * Used by the orchestrator to determine which ToolBox method to call.
 */
export const P5_ACTION_TYPES = {
  OPEN_APP:      "open_app",       // 401–406: init + open + focus
  CLOSE_APP:     "close_app",      // 467
  FOCUS:         "focus",          // 405–406
  FIND_ELEMENT:  "find_element",   // 407–408
  CLICK:         "click",          // 409–410 (Win32 SendInput mouse)
  TYPE:          "type",           // 411–412 (Win32 SendInput keyboard)
  PRESS:         "press",          // 413–416 (Win32 SendInput key)
  SCROLL:        "scroll",         // 419–422 (Win32 mouse wheel)
  READ_SCREEN:   "read_screen",    // 398, 501
  WAIT:          "wait",           // poll condition (perception-backed)
  VERIFY:        "verify",         // 493–494 (delegates to P6)
  RECOVER:       "recover",        // 481–484 (Escape + refocus)
};

/**
 * Structured log entry for a P5 tool dispatch (ticket 489 — log tool call).
 * @param {string} actionType  P5_ACTION_TYPES value
 * @param {object} step        Raw step from orchestrator
 * @param {import('../../backend/core/result.js').ToolResult} result
 * @returns {object}
 */
export function buildActionAuditEntry(actionType, step, result) {
  return {
    pipeline:  "P5",
    ticket:    "489-490",
    type:      actionType,
    step:      step ? { type: step.type, target: step.target ?? null, args: step.args ?? null } : null,
    success:   result.success,
    action:    result.action,
    error:     result.error || null,
    timestamp: result.timestamp,
  };
}

/**
 * Validate that a ToolResult satisfies the P5 schema (ticket 492).
 * @param {any} result
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateToolResult(result) {
  if (!result || typeof result !== "object") {
    return { valid: false, reason: "result is not an object" };
  }
  if (typeof result.success !== "boolean") {
    return { valid: false, reason: "result.success must be boolean" };
  }
  if (typeof result.action !== "string" || !result.action) {
    return { valid: false, reason: "result.action must be a non-empty string" };
  }
  if (typeof result.data !== "object" || result.data === null) {
    return { valid: false, reason: "result.data must be an object" };
  }
  if (typeof result.timestamp !== "string" || !result.timestamp) {
    return { valid: false, reason: "result.timestamp must be a non-empty ISO string" };
  }
  return { valid: true };
}
