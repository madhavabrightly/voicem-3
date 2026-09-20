/**
 * P2 — P1 → P2 → P3 integration.
 *
 *   P1 final turn ──▶ TranscriptUnderstanding ──▶ StructuredCommand
 *                                                      │
 *                                          P3 TaskEngine.submit/execute
 *                                                      │
 *                                    task graph → ACT → OBSERVE → VERIFY
 *                                                      │
 *                                                  RESULT
 *
 * This module is the missing producer/consumer seam: before it existed the
 * voice path handed a bare string to the orchestrator, so P3's duplicate
 * detection, confidence, latency and turn tracking had no metadata to work
 * with. Routing decisions that belong to neither layer live here and nowhere
 * else:
 *   - a cancelled utterance cancels the running task instead of becoming one
 *   - an informational utterance is reported, never executed
 *   - repeats are marked but not silently suppressed (the user may mean it);
 *     same-turn duplicates are still refused by P3's own guard
 */

export const STAGES = {
  IGNORED: "ignored",
  FAILED: "failed",
  CANCELLED: "cancelled",
  INFORMATIONAL: "informational",
  REJECTED: "rejected",
  COMPLETED: "completed",
};

export class UnderstandingTaskPipeline {
  /**
   * @param {object} deps
   * @param {object} deps.understanding TranscriptUnderstanding
   * @param {object} deps.engine        P3 TaskEngine (submit/execute/cancel)
   * @param {object} [deps.logger]
   */
  constructor({ understanding, engine, logger = null } = {}) {
    this.understanding = understanding;
    this.engine = engine;
    this.logger = logger;
    this.handled = 0;
  }

  /**
   * Full path from a P1 turn event to a task result.
   *
   * @param {object} event AssemblyAI/P1 turn event ({ transcript, end_of_turn, turn_order })
   * @param {object} [meta] { sessionId, timestamp, confidence, assemblyAiLatencyMs, source }
   */
  async handleTurnEvent(event, meta = {}) {
    const understood = this.understanding.handleTurnEvent(event, meta);

    if (!understood.ok) {
      const stage = understood.ignored ? STAGES.IGNORED : STAGES.FAILED;
      this._log("decision", "turn_not_actionable", { stage, reason: understood.reason });
      return { stage, reason: understood.reason, command: understood.command ?? null };
    }

    return this.handleCommand(understood.command);
  }

  /** Drive a validated StructuredCommand through P3. */
  async handleCommand(command) {
    this.handled += 1;

    // 121 — a cancellation is not a task.
    if (command.cancelled) {
      const cancelled = typeof this.engine.cancel === "function" ? this.engine.cancel("voice_cancellation") : false;
      this._log("decision", "command_cancelled_task", { cancelled, sessionId: command.sessionId });
      return { stage: STAGES.CANCELLED, command, cancelledRunningTask: cancelled };
    }

    // 138/139 — questions and information requests are answered, not executed.
    if (command.intent === "answer") {
      this._log("decision", "command_informational", { requestType: command.requestType });
      return { stage: STAGES.INFORMATIONAL, command, spoken: null };
    }

    const submitted = this.engine.submit(command);
    if (!submitted.accepted) {
      this._log("decision", "command_rejected_by_engine", { reason: submitted.reason, taskId: submitted.taskId });
      return { stage: STAGES.REJECTED, command, reason: submitted.reason, taskId: submitted.taskId };
    }

    // A clarification-pending task must be surfaced (P2 already supplied the
    // question, so P3 asks that one instead of inventing a second).
    if (submitted.status === "awaiting_clarification") {
      this._log("decision", "clarification_required", { question: submitted.clarification?.question ?? null });
      return { stage: "awaiting_clarification", command, taskId: submitted.taskId, clarification: submitted.clarification };
    }

    const result = await this.engine.execute();
    this._log("verification", "task_result", {
      taskId: result.taskId,
      status: result.status,
      success: result.success,
      retries: result.totalRetries,
      durationMs: result.durationMs,
    });
    return { stage: STAGES.COMPLETED, command, taskId: result.taskId, result };
  }

  /** Convenience for fixtures: feed a list of turn events in order. */
  async handleTurns(events, meta = {}) {
    const outcomes = [];
    for (const event of events) outcomes.push(await this.handleTurnEvent(event, meta));
    return outcomes;
  }

  getState() {
    return { handled: this.handled, understanding: this.understanding.getMetrics() };
  }

  _log(stage, event, data) {
    if (!this.logger || typeof this.logger.log !== "function") return;
    try {
      this.logger.log(stage, event, data);
    } catch {
      // logging must never break the pipeline
    }
  }
}
