import { TaskState } from "./task_state.js";
import { plan } from "./planner.js";
import { requiresConfirmation } from "./risk.js";
import { getLogger } from "../core/logger.js";
import { ToolResult } from "../core/result.js";

/**
 * Agent Orchestrator: the backend brain/controller.
 *
 * Responsibilities:
 *   - receive user intent
 *   - maintain task state (TaskState)
 *   - decide what needs to be observed (perception interface)
 *   - choose tools (tool registry)
 *   - execute tasks step by step
 *   - handle failures with bounded retries
 *   - request confirmation for risky actions
 *   - send final result back (to the voice layer)
 *
 * The orchestrator knows nothing about AssemblyAI or coordinates directly —
 * it only talks to the Perception interface and the Tools interface.
 */
export class Orchestrator {
  /**
   * @param {object} deps
   * @param {object} deps.perception    implements: perceive(intent), verify(goal)
   * @param {object} deps.toolBox       implements: run(action) -> ToolResult
   * @param {object} deps.confirmator   implements: confirm(question, ctx) -> boolean (async)
   * @param {object} [config]
   */
  constructor(deps, config = {}) {
    this.perception = deps.perception;
    this.toolBox = deps.toolBox;
    this.confirmator = deps.confirmator || { confirm: async () => true };
    this.config = config;
    this.logger = getLogger();
    this.maxRetries = config?.agent?.maxRetriesPerAction ?? 3;
  }

  /**
   * Main entry: run a natural-language goal to completion.
   * @param {string} goal
   * @returns {Promise<{task:object, final:object, spoken:string}>}
   */
  async run(goal) {
    const task = new TaskState(goal);
    this.logger.log("system", "task_started", { taskId: task.id, goal });

    const steps = plan(goal);
    if (steps.length === 0) {
      task.markFailed("planner produced no steps");
      this.logger.log("decision", "no_steps", { taskId: task.id });
      return this._finalize(task, ToolResult.fail("plan", "Could not understand the goal into actions."));
    }
    task.plan(steps);
    this.logger.log("decision", "plan", { steps: steps.map((s) => s.type) });

    let taskAppName = null; // open_app target, used to refocus after drift

    for (let i = 0; i < steps.length; i++) {
      task.currentStepIndex = i;
      const step = steps[i];
      this.logger.log("decision", "step_start", { step: step.type, target: step.target });
      if (step.type === "open_app") taskAppName = step.target;

      // --- risk gate ---
      const risk = requiresConfirmation(step, this.config);
      if (risk) {
        const pending = task.requireConfirmation(`Allow ${risk} action: ${step.type} "${step.target}"?`, step);
        this.logger.log("decision", "awaiting_confirmation", { risk, question: pending.question });
        const approved = await this.confirmator.confirm(pending.question, pending.context);
        if (!task.resolveConfirmation(approved)) {
          this.logger.log("decision", "aborted_by_user", { step: step.type });
          return this._finalize(task, ToolResult.fail("aborted", "User declined the action."));
        }
      }

      // --- bounded retry loop: ACT -> OBSERVE -> VERIFY ---
      let stepResult = null;
      let lastVerify = null;
      const maxAttempts = this.maxRetries;
      const mustVerify = this.config?.agent?.verifyEveryAction !== false && step.verifiable !== false;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        task.recordAttempt(i);
        this.logger.log("action", "act", { attempt, step: step.type, target: step.target });

        stepResult = await this.toolBox.run(step);
        this.logger.log("action", "act_result", stepResult.toJSON());

        if (!stepResult.success) {
          this.logger.log("verification", "action_failed", { attempt, error: stepResult.error });
          await this._recoverIfDrifted(stepResult.data?.drift, taskAppName, attempt);
          continue; // retry
        }

        // --- VERIFY via perception ---
        if (mustVerify) {
          lastVerify = await this.perception.verify(step);
          this.logger.log("verification", "verify", { attempt, passed: lastVerify.success, data: lastVerify.data });
          if (!lastVerify.success) {
            await this._recoverIfDrifted(lastVerify.data?.drift, taskAppName, attempt);
            // A retried type step must re-focus its target: the failed attempt
            // can leave the field selected-but-unreplaced (patched text that
            // never landed), which OCR cannot read and which would make the
            // retry fail in exactly the same way.
            if (step.type === "type" && step.target) {
              step.args = { ...(step.args || {}), refocus: true };
              this.logger.log("verification", "retry_refocus", { attempt, target: step.target });
            }
            continue; // re-perceive on next attempt
          }
        }

        break; // success
      }

      if (!stepResult?.success) {
        task.markFailed(`step failed: ${step.type} ${step.target || ""}`);
        return this._finalize(task, stepResult);
      }

      // An action that ran but could never be VERIFIED is not a success —
      // claiming otherwise would be a false success.
      if (mustVerify && lastVerify && !lastVerify.success) {
        this.logger.log("verification", "verification_exhausted", { step: step.type, attempts: maxAttempts });
        task.markFailed(`verification failed: ${step.type} ${step.target || ""}`);
        return this._finalize(task, ToolResult.fail(step.type, `Could not verify ${step.type} ${step.target || ""}`, lastVerify.data));
      }

      task.executed.push({ step: step.type, target: step.target, result: stepResult.toJSON() });
      this.logger.log("decision", "step_done", { step: step.type });
    }

    task.markDone();
    this.logger.log("verification", "task_done", { taskId: task.id });
    return this._finalize(task, ToolResult.ok("task", { done: true }));
  }

  /**
   * Recovery for foreground drift: dismiss the interloper (Escape) and
   * refocus the task application, so the next attempt acts on the right
   * window. Bounded by the step's existing retry budget.
   */
  async _recoverIfDrifted(drift, taskAppName, attempt) {
    if (!drift || typeof this.toolBox.recover !== "function") return;
    this.logger.log("verification", "foreground_drift", {
      attempt,
      expected: drift.expected?.proc,
      actual: drift.actual?.proc,
    });
    const refocus = taskAppName || drift.expected?.title || null;
    const r = await this.toolBox.recover({ refocus });
    this.logger.log("action", "recover", { attempt, refocus, success: r.success });
  }

  _finalize(task, final) {
    return {
      task: task.toJSON(),
      final: final.toJSON(),
      spoken: final.success ? "Done." : `Sorry, it did not work. ${final.error || ""}`,
    };
  }
}