/**
 * Structured result type returned by every tool, perception, and verification step.
 * Guarantees deterministic, JSON-serializable output the orchestrator can act on.
 */
export class ToolResult {
  /**
   * @param {boolean} success
   * @param {string} action
   * @param {object} [data]
   * @param {string} [error]
   */
  constructor(success, action, data = {}, error = "") {
    this.success = success;
    this.action = action;
    this.data = data;
    this.error = error;
    this.timestamp = new Date().toISOString();
  }

  static ok(action, data = {}) {
    return new ToolResult(true, action, data);
  }

  static fail(action, error, data = {}) {
    return new ToolResult(false, action, data, error);
  }

  toJSON() {
    return {
      success: this.success,
      action: this.action,
      data: this.data,
      error: this.error,
      timestamp: this.timestamp,
    };
  }
}