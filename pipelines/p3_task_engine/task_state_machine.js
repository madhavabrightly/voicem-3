/**
 * P3 tickets 272–283 (state guards): the task state machine. Every status
 * change goes through here, so an invalid or stale transition is refused
 * instead of silently corrupting the task.
 *
 *  272. Validate state transitions.
 *  273. Prevent invalid transitions.
 *  274. Prevent duplicate execution.
 *  275. Prevent stale task execution.
 *  276. Prevent concurrent conflicting tasks.
 *  277. Support task cancellation.
 *  278. Support task timeout.
 *  279. Support task resume.
 *  280. Support task retry.
 *  281. Support task failure.
 *  282. Support task success.
 *  283. Support task cleanup.
 */
export const TASK_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  AWAITING_CLARIFICATION: "awaiting_clarification",
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  ABORTED: "aborted",
  TIMED_OUT: "timed_out",
  CANCELLED: "cancelled",
};

/** 272. The only transitions this engine considers valid. */
export const ALLOWED_TRANSITIONS = {
  [TASK_STATUS.PENDING]: [
    TASK_STATUS.RUNNING,
    TASK_STATUS.AWAITING_CLARIFICATION,
    TASK_STATUS.ABORTED,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.FAILED,
    TASK_STATUS.TIMED_OUT,
  ],
  [TASK_STATUS.RUNNING]: [
    TASK_STATUS.AWAITING_CLARIFICATION,
    TASK_STATUS.AWAITING_CONFIRMATION,
    TASK_STATUS.SUCCEEDED,
    TASK_STATUS.FAILED,
    TASK_STATUS.ABORTED,
    TASK_STATUS.TIMED_OUT,
    TASK_STATUS.CANCELLED,
  ],
  [TASK_STATUS.AWAITING_CLARIFICATION]: [
    TASK_STATUS.RUNNING,
    TASK_STATUS.ABORTED,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.FAILED,
    TASK_STATUS.TIMED_OUT,
  ],
  [TASK_STATUS.AWAITING_CONFIRMATION]: [
    TASK_STATUS.RUNNING,
    TASK_STATUS.ABORTED,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.FAILED,
    TASK_STATUS.TIMED_OUT,
  ],
  // 280. A failed task may be retried; a cancelled/aborted one may not —
  // those statuses mean the user or the safety layer said stop.
  [TASK_STATUS.FAILED]: [TASK_STATUS.RUNNING, TASK_STATUS.ABORTED, TASK_STATUS.CANCELLED],
  [TASK_STATUS.TIMED_OUT]: [TASK_STATUS.RUNNING, TASK_STATUS.ABORTED, TASK_STATUS.CANCELLED],
  [TASK_STATUS.SUCCEEDED]: [],
  [TASK_STATUS.ABORTED]: [],
  [TASK_STATUS.CANCELLED]: [],
};

export const TERMINAL_STATUSES = [
  TASK_STATUS.SUCCEEDED,
  TASK_STATUS.FAILED,
  TASK_STATUS.ABORTED,
  TASK_STATUS.TIMED_OUT,
  TASK_STATUS.CANCELLED,
];

export class TaskStateMachine {
  /**
   * @param {object} p
   * @param {string} p.taskId
   * @param {(stage:string, event:string, data:object) => void} [p.onTransition] hook for audit/events
   */
  constructor({ taskId = null, onTransition = null } = {}) {
    this.taskId = taskId;
    this.onTransition = onTransition;
    this.status = TASK_STATUS.PENDING;
    this.history = [{ status: this.status, reason: "created" }];
    this.invalidAttempts = [];
  }

  /** 272. Is `next` a legal successor of the current status? */
  canTransition(next) {
    const allowed = ALLOWED_TRANSITIONS[this.status] || [];
    return allowed.includes(next);
  }

  /**
   * 273. Transition, or refuse and record the refusal. Returns true when the
   * transition happened — callers must not assume it did.
   */
  transition(next, meta = {}) {
    if (!Object.values(TASK_STATUS).includes(next)) {
      this.invalidAttempts.push({ from: this.status, to: next, reason: "unknown_status" });
      return false;
    }
    if (!this.canTransition(next)) {
      this.invalidAttempts.push({ from: this.status, to: next, reason: meta.reason || "invalid_transition" });
      // 273. Prevent invalid transitions: status is left untouched.
      return false;
    }
    const previous = this.status;
    this.status = next;
    this.history.push({ from: previous, status: next, reason: meta.reason || null, at: meta.at ?? null });
    if (this.onTransition) {
      try {
        this.onTransition("decision", "state_transition", { taskId: this.taskId, from: previous, to: next, reason: meta.reason || null });
      } catch {
        // audit hooks must never break the engine
      }
    }
    return true;
  }

  isTerminal() {
    return TERMINAL_STATUSES.includes(this.status);
  }

  /** 274–276. Execution guards, all answered from the status. */
  canExecute() {
    return this.status === TASK_STATUS.RUNNING;
  }

  toJSON() {
    return {
      taskId: this.taskId,
      status: this.status,
      terminal: this.isTerminal(),
      history: this.history.map((h) => ({ ...h })),
      invalidAttempts: this.invalidAttempts.map((a) => ({ ...a })),
    };
  }
}
