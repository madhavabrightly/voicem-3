import { Applications } from "./applications.js";
import { Mouse } from "./mouse.js";
import { Keyboard } from "./keyboard.js";
import { Screen } from "./screen.js";
import { ToolResult } from "../core/result.js";

/**
 * ToolBox — the clean tool interface the orchestrator sees.
 * Maps planner steps to concrete tools and returns structured ToolResults.
 *
 *   open_app(name)
 *   find_element(description)
 *   click(target)
 *   type(text)
 *   press(key)
 *   scroll(direction)
 *   read_screen()
 *   wait(condition)
 *   verify(condition)   -> delegates to perception
 */
export class ToolBox {
  /**
   * @param {object} p
   * @param {object} p.driver PlatformDriver
   * @param {object} p.perception Perception interface (to resolve targets + verify)
   */
  constructor({ driver, perception }) {
    this.apps = new Applications(driver);
    this.mouse = new Mouse(driver);
    this.keyboard = new Keyboard(driver);
    this.screen = new Screen(driver);
    this.perception = perception;
  }

  /** @param {object} step { type, target?, args? } */
  async run(step) {
    switch (step.type) {
      case "open_app":
        return this.apps.open(step.target);
      case "focus":
        return this.apps.focus(step.target);
      case "find_element":
        return this.findElement(step.target);
      case "click":
        return this.click(step.target);
      case "type":
        return this.type(step);
      case "press":
        return this.keyboard.press(step.target || step.args?.key);
      case "scroll":
        return this.mouse.scroll(step.target || step.args?.direction || "down");
      case "read_screen":
        return this.readScreen();
      case "wait":
        return this.wait(step);
      case "verify":
        return this.verify(step);
      case "recover":
        return this.recover(step.args || {});
      default:
        return ToolResult.fail(step.type, `unhandled tool type: ${step.type}`);
    }
  }

  async findElement(description) {
    const model = await this.perception.perceive({ intent: `find ${description}` });
    // match by type first, then by name, then combined
    let found = model.find({ type: description });
    if (found.length === 0) found = model.find({ name: description });
    if (found.length === 0) found = model.find({ type: description, name: description });
    if (found.length === 0) return ToolResult.fail("find_element", `no element for "${description}" found`, { model: model.toJSON() });
    return ToolResult.ok("find_element", { element: found[0], candidates: found });
  }

  async click(target) {
    const model = await this.perception.perceive({ intent: `click ${target}` });
    const found = model.find({ name: target });
    if (found.length === 0) return ToolResult.fail("click", `no clickable element for "${target}"`, { model: model.toJSON() });
    return this.mouse.click(found[0].coordinates || found[0]);
  }

  /**
   * type(step) — type into a NAMED target, optionally focusing it first.
   *
   * Keystrokes go to whatever holds focus. On the real desktop a retry can find
   * the field with its text selected-but-unreplaced (the select-all landed, the
   * characters did not) — which OCR cannot read, so the verification fails again
   * and the retry repeats the same state. A retry therefore asks for
   * `args.refocus`, and only then is the target re-resolved and clicked: doing
   * that on the FIRST attempt too would land a second click ~400ms after the
   * plan's own click step, which the field reads as a double-click.
   */
  async type(step) {
    const text = step.args?.text;
    if (!text) return ToolResult.fail("type", "nothing to type");

    if (step.target && step.args?.refocus) {
      const model = await this.perception.perceive({ intent: `type into ${step.target}` });
      const found = model.find({ name: step.target });
      if (found.length > 0 && found[0].coordinates) {
        await this.mouse.click(found[0].coordinates);
      }
    }

    return this.keyboard.type(text, {
      // Search/input targets get select-all first: a retry then replaces
      // the field content instead of appending to it.
      clearFirst: step.target === "search_box" || step.args?.clearFirst === true,
    });
  }

  async readScreen() {
    const model = await this.perception.perceive({ intent: "read screen" });
    return ToolResult.ok("read_screen", model.toJSON());
  }

  /**
   * wait(condition) backed by REAL perception polling (bounded):
   *   application_loaded -> a confident, non-empty screen model
   *   results_rendered   -> search box carries the query, or result rows show
   * Anything else falls back to a plain bounded timer wait.
   */
  async wait(step) {
    const condition = step?.args?.condition || "unspecified";
    const checkers = {
      application_loaded: async () => {
        const model = await this.perception.perceive({ intent: "wait application_loaded" });
        // "Loaded" = a recognisable screen (not the app's loading/placeholder
        // state) with actual content. For WhatsApp this means the chat list
        // (search box) resolved; for generic apps any classified content.
        return model.confidence > 0 && model.screen !== "unknown" && (model.elements || []).length > 0;
      },
      results_rendered: async () => {
        const model = await this.perception.perceive({ intent: "wait results_rendered" });
        const search = model.find({ type: "search_box" });
        if (search.some((e) => e.query)) return true;
        return model.find({ type: "contact" }).length > 0;
      },
    };
    return this.screen.wait(step, checkers[condition]);
  }

  /**
   * recover({ refocus }) — dismiss whatever stole the foreground (popup /
   * OS search / dialog) with Escape, then refocus the task application.
   */
  async recover({ refocus } = {}) {
    const pressed = await this.keyboard.press("escape");
    if (!pressed.success) return ToolResult.fail("recover", pressed.error || "escape failed");
    if (refocus) {
      await new Promise((r) => setTimeout(r, 300));
      const focused = await this.apps.focus(refocus);
      if (!focused.success) return ToolResult.fail("recover", focused.error || `could not refocus ${refocus}`);
    }
    return ToolResult.ok("recover", { refocus: refocus || null });
  }

  async verify(step) {
    const r = await this.perception.verify(step);
    return r.success ? ToolResult.ok("verify", r.data) : ToolResult.fail("verify", "verification failed", r.data);
  }
}