/**
 * P3 tickets 264–271: task events and notifications. Every event is emitted on
 * the bus AND handed to the structured logger, and the bus keeps the ordered
 * event log that later becomes the audit record.
 *
 *  264. Emit task events.
 *  265. Emit step events.
 *  266. Emit verification events.
 *  267. Emit failure events.
 *  268. Emit success event.
 *  269. Notify voice layer.
 *  270. Notify UI layer.
 *  271. Notify logger.
 */
import { EventEmitter } from "node:events";

export const EVENT_NAMES = {
  TASK: "task",
  STEP: "step",
  VERIFICATION: "verification",
  FAILURE: "failure",
  SUCCESS: "success",
  NOTIFICATION: "notification",
};

export class TaskEventBus extends EventEmitter {
  /**
   * @param {object} p
   * @param {object} [p.logger] structured logger ({ log(stage, event, data) })
   * @param {() => number} [p.clock]
   * @param {object} [p.sinks] { voice(result), ui(result) } downstream layers
   */
  constructor({ logger = null, clock = () => Date.now(), sinks = {} } = {}) {
    super();
    this.logger = logger;
    this.clock = clock;
    this.sinks = sinks;
    this.events = []; // ordered log (297 event ordering / 262 audit)
  }

  _record(name, event, data = {}, stage = "decision") {
    const entry = { seq: this.events.length + 1, at: this.clock(), name, event, data };
    this.events.push(entry);
    // 271. Notify logger (never let logging break the run).
    this.notifyLogger(stage, event, data);
    return entry;
  }

  _emit(name, event, data, stage) {
    const entry = this._record(name, event, data, stage);
    this.emit(name, entry);
    this.emit("any", entry);
    return entry;
  }

  /** 264. Emit task events. */
  emitTask(event, data = {}) {
    return this._emit(EVENT_NAMES.TASK, event, data, "decision");
  }

  /** 265. Emit step events. */
  emitStep(event, data = {}) {
    return this._emit(EVENT_NAMES.STEP, event, data, "action");
  }

  /** 266. Emit verification events. */
  emitVerification(event, data = {}) {
    return this._emit(EVENT_NAMES.VERIFICATION, event, data, "verification");
  }

  /** 267. Emit failure events. */
  emitFailure(event, data = {}) {
    return this._emit(EVENT_NAMES.FAILURE, event, data, "verification");
  }

  /** 268. Emit the success event. */
  emitSuccess(event, data = {}) {
    return this._emit(EVENT_NAMES.SUCCESS, event, data, "verification");
  }

  /** 269. Notify voice layer. */
  notifyVoice(result) {
    const delivered = typeof this.sinks.voice === "function";
    if (delivered) this.sinks.voice(result);
    this._record(EVENT_NAMES.NOTIFICATION, "notify_voice", { delivered, spoken: result?.spoken ?? null });
    return delivered;
  }

  /** 270. Notify UI layer. */
  notifyUi(result) {
    const delivered = typeof this.sinks.ui === "function";
    if (delivered) this.sinks.ui(result);
    this._record(EVENT_NAMES.NOTIFICATION, "notify_ui", { delivered, state: result?.ui?.state ?? null });
    return delivered;
  }

  /** 271. Notify logger. */
  notifyLogger(stage, event, data = {}) {
    if (!this.logger || typeof this.logger.log !== "function") return false;
    try {
      this.logger.log(stage, event, data);
      return true;
    } catch {
      return false;
    }
  }

  /** Ordered event log (used for event-ordering assertions and the audit record). */
  getEvents() {
    return this.events.map((e) => ({ ...e }));
  }

  eventsOf(name) {
    return this.events.filter((e) => e.name === name).map((e) => ({ ...e }));
  }
}
