/**
 * Platform driver abstraction. Keeps computer actions (mouse, keyboard,
 * app launching) isolated from the orchestrator. On Windows these would
 * bind to real Win32/UI Automation APIs; tests inject fake drivers.
 */
export class PlatformDriver {
  constructor(impl = {}) {
    this.impl = impl;
  }

  async launch(appName) {
    return this.impl.launch ? this.impl.launch(appName) : { success: false, error: "launch not implemented" };
  }
  async focus(appName) {
    return this.impl.focus ? this.impl.focus(appName) : { success: false, error: "focus not implemented" };
  }
  async click(x, y) {
    return this.impl.click ? this.impl.click(x, y) : { success: false, error: "click not implemented" };
  }
  async typeText(text) {
    return this.impl.typeText ? this.impl.typeText(text) : { success: false, error: "typeText not implemented" };
  }
  async pressKey(key) {
    return this.impl.pressKey ? this.impl.pressKey(key) : { success: false, error: "pressKey not implemented" };
  }
  async scroll(dir) {
    return this.impl.scroll ? this.impl.scroll(dir) : { success: false, error: "scroll not implemented" };
  }
  async capture() {
    return this.impl.capture ? this.impl.capture() : { success: false, error: "capture not implemented" };
  }
}