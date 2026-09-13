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
        return this.keyboard.type(step.args?.text);
      case "press":
        return this.keyboard.press(step.target || step.args?.key);
      case "scroll":
        return this.mouse.scroll(step.target || step.args?.direction || "down");
      case "read_screen":
        return this.readScreen();
      case "wait":
        return this.screen.wait(step);
      case "verify":
        return this.verify(step);
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

  async readScreen() {
    const model = await this.perception.perceive({ intent: "read screen" });
    return ToolResult.ok("read_screen", model.toJSON());
  }

  async verify(step) {
    const r = await this.perception.verify(step);
    return r.success ? ToolResult.ok("verify", r.data) : ToolResult.fail("verify", "verification failed", r.data);
  }
}