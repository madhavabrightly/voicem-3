let __nextId = 1;

/**
 * Tracks the lifecycle of a single user-requested task.
 * The orchestrator reads/writes this so it can recover from failures
 * and revisit steps instead of blind-repeating.
 */
export class TaskState {
  /**
   * @param {string} goal Raw user intent text.
   */
  constructor(goal) {
    this.id = `task_${__nextId++}`;
    this.goal = goal;
    this.status = "pending"; // pending | in_progress | awaiting_confirmation | done | failed | aborted
    this.currentStepIndex = -1;
    this.steps = [];          // planned steps (from planner)
    this.executed = [];       // completed steps
    this.attempts = {};       // stepIndex -> attempt count
    this.pendingConfirmation = null;
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
  }

  setStatus(status) {
    this.status = status;
    this.updatedAt = new Date().toISOString();
  }

  plan(steps) {
    this.steps = steps;
    this.currentStepIndex = 0;
    this.setStatus("in_progress");
  }

  currentStep() {
    return this.steps[this.currentStepIndex] || null;
  }

  recordAttempt(stepIndex) {
    this.attempts[stepIndex] = (this.attempts[stepIndex] || 0) + 1;
    return this.attempts[stepIndex];
  }

  attemptsFor(stepIndex) {
    return this.attempts[stepIndex] || 0;
  }

  markDone() {
    this.setStatus("done");
  }

  markFailed(reason) {
    this.setStatus("failed");
    this.failureReason = reason;
  }

  requireConfirmation(question, context) {
    this.status = "awaiting_confirmation";
    this.pendingConfirmation = { question, context };
    this.updatedAt = new Date().toISOString();
    return this.pendingConfirmation;
  }

  resolveConfirmation(approved) {
    this.pendingConfirmation = null;
    if (approved) {
      this.setStatus("in_progress");
      return true;
    }
    this.setStatus("aborted");
    return false;
  }

  toJSON() {
    return {
      id: this.id,
      goal: this.goal,
      status: this.status,
      currentStepIndex: this.currentStepIndex,
      steps: this.steps,
      executed: this.executed,
      attempts: this.attempts,
      failureReason: this.failureReason || null,
      pendingConfirmation: this.pendingConfirmation,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}