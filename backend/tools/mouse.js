import { ToolResult } from "../core/result.js";

// Mouse tool: click a target resolved to coordinates by perception.
export class Mouse {
  constructor(driver) {
    this.driver = driver;
  }

  async click(target) {
    // target may be {name} (resolved elsewhere) or explicit {x,y}.
    if (target && typeof target.x === "number" && typeof target.y === "number") {
      const r = await this.driver.click(target.x, target.y);
      if (r.success) return ToolResult.ok("click", { x: target.x, y: target.y });
      return ToolResult.fail("click", r.error || "click failed");
    }
    return ToolResult.fail("click", "click requires coordinates; perception must resolve target first");
  }

  async doubleClick(target) {
    if (target && typeof target.x === "number" && typeof target.y === "number") {
      const r = typeof this.driver.doubleClick === "function"
        ? await this.driver.doubleClick(target.x, target.y)
        : await this.driver.click(target.x, target.y);
      if (r.success) return ToolResult.ok("double_click", { x: target.x, y: target.y });
      return ToolResult.fail("double_click", r.error || "double_click failed");
    }
    return ToolResult.fail("double_click", "double_click requires coordinates");
  }

  async rightClick(target) {
    if (target && typeof target.x === "number" && typeof target.y === "number") {
      const r = typeof this.driver.rightClick === "function"
        ? await this.driver.rightClick(target.x, target.y)
        : await this.driver.click(target.x, target.y);
      if (r.success) return ToolResult.ok("right_click", { x: target.x, y: target.y });
      return ToolResult.fail("right_click", r.error || "right_click failed");
    }
    return ToolResult.fail("right_click", "right_click requires coordinates");
  }

  async scroll(direction) {
    const r = await this.driver.scroll(direction);
    if (r.success) return ToolResult.ok("scroll", { direction });
    return ToolResult.fail("scroll", r.error || "scroll failed");
  }
}