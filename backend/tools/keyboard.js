import { ToolResult } from "../core/result.js";

// Keyboard tool: type text and press keys.
export class Keyboard {
  constructor(driver) {
    this.driver = driver;
  }

  async type(text) {
    if (!text) return ToolResult.fail("type", "nothing to type");
    const r = await this.driver.typeText(String(text));
    if (r.success) return ToolResult.ok("type", { text });
    return ToolResult.fail("type", r.error || "type failed");
  }

  async press(key) {
    const r = await this.driver.pressKey(key);
    if (r.success) return ToolResult.ok("press", { key });
    return ToolResult.fail("press", r.error || "press failed");
  }
}