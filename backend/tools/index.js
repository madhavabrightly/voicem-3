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
      case "double_click":
        return this.doubleClick(step.target);
      case "right_click":
        return this.rightClick(step.target);
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

  resolveTargetElement(model, target) {
    if (!target) return null;
    const t = String(target).trim();
    // 1. Exact or alias match via model.find
    let found = model.find({ name: t });
    if (found.length === 0) found = model.find({ type: t });
    if (found.length === 0) found = model.find({ name: t, type: t });

    // 2. Substring or token match across all elements (OCR text, UIA buttons/links, Vision)
    if (found.length === 0 && Array.isArray(model.elements)) {
      const lower = t.toLowerCase();
      found = model.elements.filter((e) => {
        const name = String(e.name || "").toLowerCase();
        const role = String(e.role || "").toLowerCase();
        const type = String(e.type || "").toLowerCase();
        return name.includes(lower) || lower.includes(name) || role.includes(lower) || type.includes(lower);
      });
    }

    if (found.length === 0) return null;
    found.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    return found[0];
  }

  async findElement(description) {
    const model = await this.perception.perceive({ intent: `find ${description}` });
    const el = this.resolveTargetElement(model, description);
    if (!el) return ToolResult.fail("find_element", `no element for "${description}" found`, { model: model.toJSON() });
    return ToolResult.ok("find_element", { element: el, candidates: [el] });
  }

  async click(target) {
    const model = await this.perception.perceive({ intent: `click ${target}` });
    const el = this.resolveTargetElement(model, target);
    if (!el) return ToolResult.fail("click", `no clickable element for "${target}"`, { model: model.toJSON() });
    return this.mouse.click(el.coordinates || el);
  }

  async doubleClick(target) {
    const model = await this.perception.perceive({ intent: `double click ${target}` });
    const el = this.resolveTargetElement(model, target);
    if (!el) return ToolResult.fail("double_click", `no element for "${target}"`, { model: model.toJSON() });
    return this.mouse.doubleClick(el.coordinates || el);
  }

  async rightClick(target) {
    const model = await this.perception.perceive({ intent: `right click ${target}` });
    const el = this.resolveTargetElement(model, target);
    if (!el) return ToolResult.fail("right_click", `no element for "${target}"`, { model: model.toJSON() });
    return this.mouse.rightClick(el.coordinates || el);
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
      const el = this.resolveTargetElement(model, step.target);
      if (el && el.coordinates) {
        await this.mouse.click(el.coordinates);
      }
    }

    return this.keyboard.type(text, {
      clearFirst: step.target === "search_box" || step.args?.clearFirst === true,
    });
  }

  async readScreen() {
    const model = await this.perception.perceive({ intent: "read screen" });
    const data = model.toJSON ? model.toJSON() : model;
    const app = data.application || data.environment?.proc || "current window";
    const title = data.environment?.title || "";
    const visibleTexts = (data.elements || [])
      .map((e) => e.name)
      .filter((n) => typeof n === "string" && n.trim().length > 1)
      .slice(0, 15);
    const summary = title
      ? `Active window is ${title}. Visible items: ${visibleTexts.slice(0, 8).join(", ")}.`
      : `App ${app} showing ${visibleTexts.length} visible items.`;
    return ToolResult.ok("read_screen", { ...data, summary, visibleTexts });
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