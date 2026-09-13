import { ToolResult } from "../core/result.js";

// Screen tool: capture the screen for the perception layer, and wait/poll a condition.
export class Screen {
  constructor(driver) {
    this.driver = driver;
  }

  async capture() {
    const r = await this.driver.capture();
    if (r.success) return ToolResult.ok("read_screen", { path: r.path });
    return ToolResult.fail("read_screen", r.error || "capture failed");
  }

  /**
   * wait(condition) — polls the condition via an injected checker.
   * @param {object} step { args: { condition } }
   * @param {() => Promise<boolean>} [checker]
   */
  async wait(step, checker) {
    const condition = step?.args?.condition || "unspecified";
    const check = checker || (async () => true);
    const started = Date.now();
    const timeoutMs = this.driver.waitTimeoutMs || 5000;
    while (Date.now() - started < timeoutMs) {
      if (await check()) return ToolResult.ok("wait", { condition });
    }
    return ToolResult.fail("wait", `condition not met within ${timeoutMs}ms: ${condition}`);
  }
}