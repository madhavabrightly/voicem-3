import { Perception } from "./index.js";

// Steps that change the screen, so their effect has to RENDER before it can
// be verified (reading the screen does not change it).
const MUTATING_STEPS = new Set(["click", "type", "press", "scroll"]);
// How long such an effect may take to appear, and how often to look.
const DEFAULT_SETTLE_MS = 2500;
const DEFAULT_POLL_MS = 250;

/**
 * RealPerception — Perception-interface implementation for the live desktop.
 *
 * Uses the same sensor-stack `perceive()` as the base Perception, but its
 * `verify(step)` implements REAL semantic verification per the spec:
 *
 *   ACT -> OBSERVE -> VERIFY
 *
 * Each action type verifies what should have CHANGED on screen:
 *   - open_app:   WhatsApp window is foreground / app content visible
 *   - click:      the clicked target element still exists (or its effect state)
 *   - type:       typed text now appears in the search box
 *   - read_screen / wait / find_element: perception succeeded at all
 *
 * Verification of a mutating step polls within a bounded settle window,
 * because an action is only *delivered* synchronously — the application
 * still has to process it and repaint. It also detects FOREGROUND DRIFT:
 * once an app has been opened for the task, a mutating step that leaves a
 * DIFFERENT process in the foreground (OS search, popup, another window)
 * means the action hit the wrong target — verification fails with `drift`
 * info so the orchestrator can recover (Escape + refocus) instead of
 * blindly retrying.
 *
 * The orchestrator / ToolBox interfaces are unchanged.
 */
export class RealPerception extends Perception {
  /**
   * @param {Array} sensors ordered sensor stack
   * @param {object} [config]
   * @param {object} [hooks]
   * @param {() => Promise<{title:string, proc:string, pid:number} | null>} [hooks.foreground]
   */
  constructor(sensors, config = {}, hooks = {}) {
    super(sensors, config);
    this.foreground = hooks.foreground || null;
    this._taskFg = null; // foreground info captured when the task app opened
    this.settleMs = config?.agent?.verifySettleMs ?? DEFAULT_SETTLE_MS;
    this.pollMs = config?.agent?.verifyPollMs ?? DEFAULT_POLL_MS;
    this._lastModel = null;
  }

  /**
   * Fail-closed mutation gate: verifies expected application is active before mutation.
   */
  canMutate(expectedApp, model = null) {
    const currentModel = model || this._lastModel;
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

  /** True when the current foreground belongs to a different application. */
  async _detectDrift() {
    if (!this.foreground || !this._taskFg?.proc) return null;
    const fg = await this.foreground().catch(() => null);
    if (!fg?.proc) return null;
    if (fg.proc === this._taskFg.proc || fg.pid === this._taskFg.pid) return null;
    return { expected: this._taskFg, actual: fg };
  }

  /**
   * Verify a step against the live screen.
   *
   * Mutating steps get a bounded SETTLE WINDOW: sending a keystroke or a
   * click only hands the input to the app — the app still has to process it
   * and repaint. A single snapshot taken right after the action therefore
   * reports "not done" for actions that simply had not rendered yet, and the
   * orchestrator would retry (and eventually kill) a step that worked. So
   * re-perceive until the effect appears, or the window closes.
   */
  async verify(step) {
    const mutating = MUTATING_STEPS.has(step.type);
    const deadline = Date.now() + (mutating ? this.settleMs : 0);

    for (;;) {
      const model = await this.perceive({ intent: `verify ${step.type} ${step.target || ""}` });
      const data = model.toJSON ? model.toJSON() : model;

      if (await this._check(step, model, data)) {
        if (!mutating) return { success: true, data };
        // Foreground-drift gate: even a locally-consistent model is a failure
        // if the action kicked focus out of the task app.
        const drift = await this._detectDrift();
        return drift ? { success: false, data: { ...data, drift } } : { success: true, data };
      }

      if (Date.now() >= deadline) return { success: false, data };
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  /** Whether the screen now shows what `step` was supposed to change. */
  async _check(step, model, data) {
    switch (step.type) {
      case "open_app": {
        // The app counts as open when its window is foreground (title match)
        // or its content resolved in the model. Content may still be loading,
        // so a foreground window title match is enough — the follow-up wait
        // step verifies interactivity.
        const target = String(step.target || "").toLowerCase();
        const fg = this.foreground ? await this.foreground().catch(() => null) : null;
        // Deterministic regression fix: DuckDuckGo / search engine window titles are NOT the app
        const isSearchEngine = Boolean(fg?.title && /duckduckgo|google search|bing/i.test(fg.title));
        const titleHit = Boolean(!isSearchEngine && target && fg?.title && fg.title.toLowerCase().includes(target));
        const search = model.find({ type: "search_box" });
        const appHit = Boolean(!isSearchEngine && target && String(model.application || "").toLowerCase().includes(target));
        const success = titleHit || (appHit && (search.length > 0 || model.screen !== "unknown"));
        if (success && fg) this._taskFg = fg;
        return success;
      }
      case "click": {
        // A click should land on a search box; verify the search control exists
        const target = step.target || "search_box";
        const found = model.find({ type: "search_box" }) || model.find({ name: target });
        return found.length > 0;
      }
      case "type": {
        // Typing goes into the focused search box. Verify the box itself now
        // carries the query — a structure-derived box (unreadable field) has
        // no query, so it can never pose as evidence that the text landed.
        const q = step.args?.text || "";
        if (!q) return false;
        const search = model.find({ type: "search_box" });
        const boxHasQuery = search.some((e) => String(e.query || "").length > 0);
        const resultsMatch = data.elements?.some((e) => String(e.name || "").toLowerCase().includes(q.toLowerCase()));
        return Boolean(search.length > 0 && boxHasQuery && resultsMatch);
      }
      case "read_screen":
      case "wait":
      case "find_element":
      default:
        // Perception itself is the verification for read-only steps.
        return Boolean(data.confidence > 0 && data.elements?.length > 0);
    }
  }
}
