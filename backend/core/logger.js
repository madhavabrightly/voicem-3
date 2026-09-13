import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "../../logs");

/** Simple structured logger for the act/observe/verify trail. */
export class Logger {
  constructor(enabled = true) {
    this.enabled = enabled;
    this._listeners = new Set();
    fs.mkdirSync(LOG_DIR, { recursive: true });
    this.stream = fs.createWriteStream(
      path.join(LOG_DIR, path.sep, `${new Date().toISOString().slice(0, 10)}.log`),
      { flags: "a" }
    );
  }

  /**
   * Subscribe to every structured entry (the floating UI uses this to show REAL
   * agent progress). Returns an unsubscribe function. A listener can never throw
   * into the agent loop.
   */
  on(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** stage should be one of: perception | decision | action | verification | system */
  log(stage, event, data = {}) {
    const entry = {
      ts: new Date().toISOString(),
      stage,
      event,
      data,
    };
    const line = JSON.stringify(entry);
    if (this.enabled) {
      // eslint-disable-next-line no-console
      console.log(`[${stage}] ${event}`);
    }
    this.stream.write(line + "\n");
    for (const listener of this._listeners) {
      try {
        listener(entry);
      } catch {
        // a UI listener must never break the agent loop
      }
    }
    return entry;
  }

  close() {
    this.stream.end();
  }
}

let defaultLogger = null;
export function getLogger() {
  if (!defaultLogger) defaultLogger = new Logger();
  return defaultLogger;
}