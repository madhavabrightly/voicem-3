import { ToolResult } from "../core/result.js";

// Application launcher tool (open_app).
export class Applications {
  constructor(driver) {
    this.driver = driver;
  }

  async open(appName) {
    const r = await this.driver.launch(appName);
    if (r.success) return ToolResult.ok("open_app", { application: appName });
    return ToolResult.fail("open_app", r.error || `Could not open ${appName}`);
  }

  async focus(appName) {
    const r = await this.driver.focus(appName);
    if (r.success) return ToolResult.ok("focus", { application: appName });
    return ToolResult.fail("focus", r.error || `Could not focus ${appName}`);
  }
}