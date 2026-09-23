import { ToolResult } from "../core/result.js";
import { openApplication, attachToExisting, closeApplication } from "../../pipelines/p5_app_lifecycle/index.js";

/**
 * Application launcher tool (open_app / focus / close_app).
 *
 * Primary path: P5 openApplication pipeline (tickets 446–450, 491–500).
 * Fallback: legacy driver.launch() for environments where PS1 agents are
 *           not yet spawned (e.g., unit tests without a live Windows desktop).
 */
export class Applications {
  constructor(driver) {
    this.driver    = driver;
    this._sessions = new Map(); // naturalName → AppSession
  }

  /**
   * Open an application by natural language name.
   * Routes through the full P5 pipeline: resolve → launch → startup → verify → ready.
   * @param {string} appName  natural language name (e.g. "WhatsApp", "Notepad")
   */
  async open(appName) {
    // Try the full P5 pipeline first
    try {
      const result = await openApplication(appName, {
        onEvent: (ev) => {
          // Surface key events as debug info; orchestrator can subscribe via onEvent
          if (process.env.DEBUG_P5) {
            console.error("[P5]", JSON.stringify(ev).slice(0, 200));
          }
        },
      });

      if (result.error) {
        // Specific rejection types
        if (result.error === "ambiguous_match") {
          return ToolResult.fail("open_app",
            `Ambiguous application name '${appName}': ${result.ambiguity?.reason}`,
            { candidates: (result.candidates ?? []).slice(0, 3).map((c) => c.stem ?? c.path) }
          );
        }
        // Fall through to legacy driver
        const fallback = await this.driver.launch(appName);
        if (fallback.success) return ToolResult.ok("open_app", { application: appName, via: "legacy" });
        return ToolResult.fail("open_app", result.error || `Could not open ${appName}`);
      }

      // Cache session for focus/close calls
      if (result.session) {
        this._sessions.set(appName.toLowerCase(), result.session);
      }

      return ToolResult.ok("open_app", {
        application: appName,
        sessionId:   result.session?.sessionId,
        hwnd:        result.session?.hwnd,
        pid:         result.session?.pid,
        evidence:    result.session?.evidence,
        via:         "p5",
      });
    } catch (e) {
      // P5 driver not yet available (no PS1 process / test env) → fallback
      const fallback = await this.driver.launch(appName);
      if (fallback.success) return ToolResult.ok("open_app", { application: appName, via: "legacy" });
      return ToolResult.fail("open_app", e.message || `Could not open ${appName}`);
    }
  }

  /**
   * Focus an already-running application (tickets 491–495).
   * @param {string} appName
   */
  async focus(appName) {
    // If we have a P5 session with a known hwnd, use it
    const session = this._sessions.get(appName.toLowerCase());
    if (session?.hwnd) {
      try {
        const { appEngineDriver } = await import("../../pipelines/p5_app_lifecycle/index.js");
        const r = await appEngineDriver.restoreMinimized(session.hwnd);
        if (r.success) return ToolResult.ok("focus", { application: appName, hwnd: session.hwnd, via: "p5" });
      } catch {}
    }

    // Attach to existing (will search running windows)
    try {
      const attached = await attachToExisting(appName);
      if (!attached.error) {
        if (attached.session) this._sessions.set(appName.toLowerCase(), attached.session);
        return ToolResult.ok("focus", { application: appName, via: "p5_attach" });
      }
    } catch {}

    // Legacy fallback
    const r = await this.driver.focus(appName);
    if (r.success) return ToolResult.ok("focus", { application: appName, via: "legacy" });
    return ToolResult.fail("focus", r.error || `Could not focus ${appName}`);
  }

  /**
   * Close an application (tickets 796–799).
   * @param {string} appName
   */
  async close(appName) {
    const session = this._sessions.get(appName.toLowerCase());
    if (session) {
      const r = await closeApplication(session);
      if (r.closed) {
        this._sessions.delete(appName.toLowerCase());
        return ToolResult.ok("close_app", { application: appName });
      }
      return ToolResult.fail("close_app", r.error || `Could not close ${appName}`);
    }
    return ToolResult.fail("close_app", `No active session for '${appName}'. Use open first.`);
  }
}