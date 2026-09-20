/**
 * P2 tickets 174, 176, 177, 183, 184 — bounded waiting around a turn.
 *
 *  174. Handle AssemblyAI timeout.
 *  176. Handle partial transcript timeout.
 *  177. Handle final transcript timeout.
 *  183. Return voice failure.
 *  184. Notify UI of voice failure.
 *
 * The transport itself (connection, retry limits) stays in P1 — this guard only
 * bounds how long the UNDERSTANDING layer waits for a turn to complete, so a
 * dropped stream can never leave the assistant "listening" forever.
 */

export class TurnGuard {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.clock]
   * @param {number} [opts.timeoutMs] how long a turn may stay open
   * @param {Function} [opts.schedule] timer injection (deterministic tests)
   * @param {Function} [opts.cancel]  timer injection
   * @param {(info:object) => void} [opts.onTimeout]
   */
  constructor({ clock = () => Date.now(), timeoutMs = 15000, schedule = setTimeout, cancel = clearTimeout, onTimeout = null } = {}) {
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.schedule = schedule;
    this.cancel = cancel;
    this.onTimeout = onTimeout;
    this.openTurn = null;
    this.timer = null;
    this.timeouts = 0;
  }

  /** Arm (or re-arm) the window for a turn that has started. */
  arm({ sessionId = null, turnOrder = null, timeoutMs = this.timeoutMs } = {}) {
    this.clear();
    this.openTurn = { sessionId, turnOrder, openedAt: this.clock(), timeoutMs };
    this.timer = this.schedule(() => {
      const expired = this.openTurn;
      this.openTurn = null;
      this.timer = null;
      this.timeouts += 1;
      if (this.onTimeout) this.onTimeout({ reason: "final_transcript_timeout", ...expired });
    }, timeoutMs);
    if (typeof this.timer?.unref === "function") this.timer.unref();
    return this.openTurn;
  }

  /** 176. Activity (a partial arrived) proves the turn is alive. */
  touch({ sessionId = null, turnOrder = null } = {}) {
    if (!this.openTurn) return this.arm({ sessionId, turnOrder });
    return this.arm({ sessionId, turnOrder, timeoutMs: this.openTurn.timeoutMs });
  }

  /** 177. The final transcript arrived — nothing left to wait for. */
  clear() {
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
    this.openTurn = null;
  }

  isOpen() {
    return Boolean(this.openTurn);
  }

  getState() {
    return { open: this.isOpen(), timeouts: this.timeouts, openTurn: this.openTurn };
  }
}
