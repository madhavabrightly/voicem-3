/**
 * P3 — Intent + Task Engine (Tickets 201–300)
 *
 * TaskEngine is the deterministic executor for this pipeline:
 *
 *   command → spec → task graph → validated node chain → ACT/OBSERVE/VERIFY
 *           → recovery → result → spoken/UI/audit/history → events
 *
 * Everything it touches outside itself goes through the existing interfaces —
 * `perception` (perceive/verify), `toolBox` (run), and an optional confirmator —
 * so the engine is real when wired to the live stack and deterministic when
 * driven by fakes.
 */
import { EventEmitter } from "node:events";
import { toStructuredCommand, commandFingerprint } from "./command_contract.js";
import { buildTaskSpec, applyClarification, detectAmbiguity, detectImpossibleTask, detectMissingInformation } from "./task_spec.js";
import { buildClarification, buildTaskGraph, NODE_STATUS, NODE_TYPES, MUTATING_STEPS } from "./task_graph.js";
import { TaskTracker } from "./task_tracker.js";
import { TaskStateMachine, TASK_STATUS } from "./task_state_machine.js";
import { TaskEventBus } from "./task_events.js";
import { buildAuditRecord, TaskHistory } from "./task_history.js";
import { requiresConfirmation } from "../../backend/agent/risk.js";

/** 245. Perception methods, in the priority order the spec defines. */
export const PERCEPTION_METHODS = ["uia", "ocr", "opencv", "vision", "coordinate"];

/** 246. Tool selected per step type. */
export const TOOL_BY_STEP = {
  open_app: "open_app",
  focus: "focus",
  find_element: "find_element",
  click: "click",
  type: "type",
  press: "press",
  scroll: "scroll",
  read_screen: "read_screen",
  wait: "wait",
  verify: "verify",
  recover: "recover",
};

const DUPLICATE_WINDOW = 20; // 274. how many recent commands are remembered
const MAX_REPLANS = 1; // 253. bounded re-planning (never an infinite loop)

export class TaskEngine extends EventEmitter {
  /**
   * @param {object} [deps]
   * @param {object} [deps.perception] { perceive(intent), verify(step) }
   * @param {object} [deps.toolBox]    { run(step), recover?(args) }
   * @param {object} [deps.confirmator] { confirm(question, ctx) -> boolean }
   * @param {(clarification:object) => Promise<string>} [deps.clarifier] answers clarification questions
   * @param {object} [deps.config]
   * @param {object} [deps.logger] structured logger ({ log(stage,event,data) })
   * @param {() => number} [deps.clock] injectable clock (deterministic tests)
   * @param {() => string} [deps.idFactory] injectable task id factory
   * @param {object} [deps.sinks] { voice(result), ui(result) }
   */
  constructor({
    perception = null,
    toolBox = null,
    confirmator = null,
    clarifier = null,
    config = {},
    logger = null,
    clock = () => Date.now(),
    idFactory = null,
    sinks = {},
    history = null,
  } = {}) {
    super();
    this.perception = perception;
    this.toolBox = toolBox;
    this.confirmator = confirmator;
    this.clarifier = clarifier;
    this.config = config;
    this.clock = clock;
    this.logger = logger;
    this.idFactory = idFactory || (() => `task_${++TaskEngine._seq}`);
    this.sinks = sinks;

    this.history = history || new TaskHistory({ limit: config?.agent?.historyLimit ?? 50, clock });
    this.active = null; // the single in-flight task (276)
    this._recentFingerprints = []; // 274
    this.events = null;
  }

  // ------------------------------------------------------------------ intake
  /**
   * 201–205, 219–231, 274–276. Accept a command, build its task, and decide
   * whether it can run, needs clarification, or must be refused.
   *
   * @param {string|object} input structured command or raw text
   * @returns {object} { accepted, taskId, status, reason?, spec?, graph?, clarification? }
   */
  submit(input) {
    const command = toStructuredCommand(input); // 201, 204, 205

    if (!command.text) {
      return { accepted: false, taskId: null, status: null, reason: "empty_command" };
    }

    // A cancellation is a command to STOP, not a task to plan: P2 marks it, and
    // planning "never mind" would be a fabricated task.
    if (command.understanding?.cancelled || command.understanding?.intent === "cancellation") {
      return { accepted: false, taskId: null, status: null, reason: "cancelled_command" };
    }

    // 274. Prevent duplicate execution of the same command in this session.
    const fingerprint = commandFingerprint(command);
    if (this._recentFingerprints.includes(fingerprint)) {
      return { accepted: false, taskId: null, status: null, reason: "duplicate_command" };
    }

    // 276. Prevent concurrent conflicting tasks: one running task at a time.
    if (this.active && !this.active.machine.isTerminal()) {
      return { accepted: false, taskId: this.active.taskId, status: this.active.machine.status, reason: "concurrent_task" };
    }

    const taskId = this.idFactory(); // 202
    const tracker = new TaskTracker({ taskId, clock: this.clock }); // 203
    tracker.markCreated();
    const machine = new TaskStateMachine({
      taskId,
      onTransition: (stage, event, data) => this.events?.notifyLogger(stage, event, data),
    });
    const events = new TaskEventBus({ logger: this.logger, clock: this.clock, sinks: this.sinks });
    this.events = events;

    const spec = buildTaskSpec(command, this.config); // 206–218
    // Keep the stored command copies on the task itself (204, 205).
    tracker.command = { original: command.original, normalized: command.text };

    this._recentFingerprints.push(fingerprint);
    while (this._recentFingerprints.length > DUPLICATE_WINDOW) this._recentFingerprints.shift();

    events.emitTask("task_submitted", {
      taskId,
      command: spec.command.text,
      commandType: spec.commandType,
      application: spec.application,
      targetEntity: spec.targetEntity,
      priority: spec.priority,
      timeoutMs: spec.timeoutMs,
      maxRetries: spec.maxRetries,
    });
    events.emitTask("task_parsed", {
      taskId,
      requestedAction: spec.requestedAction,
      expectedResult: spec.expectedResult,
      steps: spec.actionSequence.map((s) => s.type),
      dependencies: spec.dependencies.length,
      confirmationRequired: spec.confirmationRequirements.required,
    });

    // 227, 228, 229. Missing information / ambiguity → ask, do not guess.
    // This is checked BEFORE impossibility: "open it" is unresolvable, not
    // undoable, and asking is the honest response.
    // When P2 already produced the clarification question, THAT question is the
    // one that gets asked — two layers must never interrogate the user twice.
    const missing = detectMissingInformation(spec);
    const ambiguous = detectAmbiguity(spec, command);
    const clarification = command.understanding?.clarification
      ? {
          needed: true,
          terminal: false,
          field: command.understanding.clarification.field ?? "reference",
          question: command.understanding.clarification.question,
          candidates: command.understanding.clarification.candidates ?? [],
          source: "p2",
        }
      : buildClarification({ missing, ambiguous, impossible: null });
    if (clarification.needed) {
      machine.transition(TASK_STATUS.AWAITING_CLARIFICATION, { reason: "clarification_required" });
      events.emitTask("clarification_requested", { taskId, question: clarification.question, field: clarification.field });
      this.active = { taskId, spec, tracker, machine, events, graph: null, clarification, command, replans: 0 };
      return { accepted: true, taskId, status: machine.status, spec, clarification };
    }

    // 226. Impossible task: refuse before building an executable graph.
    const impossible = detectImpossibleTask(spec);
    if (impossible) {
      events.emitFailure("task_impossible", { taskId, ...impossible });
      return this._startAndAbort({ taskId, spec, tracker, machine, events }, "impossible_task", impossible);
    }

    // 219–225. Build and validate the graph.
    const graph = buildTaskGraph({ taskId, spec, maxRetries: spec.maxRetries });
    const validation = graph.validate();
    if (!validation.valid) {
      events.emitFailure("task_graph_invalid", { taskId, errors: validation.errors });
      return this._startAndAbort({ taskId, spec, tracker, machine, events }, "invalid_graph", { detail: validation.errors });
    }
    events.emitTask("task_graph_built", {
      taskId,
      nodes: graph.nodes.length,
      actions: graph.nodesOfType(NODE_TYPES.ACTION).length,
      observations: graph.nodesOfType(NODE_TYPES.OBSERVATION).length,
      verifications: graph.nodesOfType(NODE_TYPES.VERIFICATION).length,
      recoveries: graph.nodesOfType(NODE_TYPES.RECOVERY).length,
    });

    this.active = { taskId, spec, tracker, machine, events, graph, clarification: null, command, replans: 0 };
    return { accepted: true, taskId, status: machine.status, spec, graph, validation };
  }

  _startAndAbort(task, reason, detail = {}) {
    const { taskId, spec, tracker, machine, events } = task;
    machine.transition(TASK_STATUS.ABORTED, { reason });
    tracker.setCurrentNode(null);
    this.active = null;
    const result = {
      taskId,
      status: machine.status,
      success: false,
      reason,
      detail,
      spoken: `Sorry, it did not work. ${detail.detail || detail.reason || reason}`,
      ui: { state: "failure", label: reason },
      expectedResult: spec.expectedResult,
    };
    tracker.markFinished();
    this._publish(result, { taskId, spec, tracker, events, reason });
    return { accepted: false, taskId, status: machine.status, reason, detail, spec };
  }

  // ------------------------------------------------------------- execution
  /**
   * 250. Run the accepted task to completion. Returns the task result.
   */
  async execute() {
    const task = this.active;
    if (!task) return this._failedResult("no_active_task");
    // An unanswered clarification is not a failure — it is a task waiting.
    if (task.clarification?.needed) return this._awaitingResult(task, "awaiting_clarification");

    const { taskId, spec, tracker, machine, events } = task;
    if (!spec || !task.graph) return this._failedResult("no_plan", task);

    // 278. Timeout is measured from the moment the task starts running.
    tracker.markStarted();
    machine.transition(TASK_STATUS.RUNNING, { reason: "execute" });
    const deadline = tracker.startedAt + spec.timeoutMs;
    events.emitTask("task_started", { taskId, deadline, nodes: task.graph.nodes.length });

    // Initial expectation for the whole task (241–243).
    tracker.expect({
      screen: spec.application ? `${spec.commandType}_screen` : null,
      element: spec.targetEntity ? "search_box" : null,
      state: spec.expectedResult,
    });

    while (true) {
      // 258. Abort on cancellation.
      if (machine.status === TASK_STATUS.CANCELLED) return this._finish(task, TASK_STATUS.CANCELLED, "cancelled_by_user");
      // 257. Abort on timeout (checked against the injected clock).
      if (this.clock() > deadline) {
        events.emitFailure("task_timeout", { taskId, elapsedMs: tracker.durationMs, timeoutMs: spec.timeoutMs });
        return this._finish(task, TASK_STATUS.TIMED_OUT, "task_timeout");
      }
      // 275. Prevent stale task execution: only the active, running task may act.
      if (!this._isCurrent(taskId) || !machine.canExecute()) {
        events.emitFailure("stale_task_refused", { taskId, status: machine.status });
        return this._failedResult("stale_task", task);
      }

      // Always read the CURRENT graph: a mismatch during recovery may have
      // re-planned it (253), and the old graph must not be driven any further.
      const node = task.graph.nextRunnable();
      if (!node) break; // 250. every node finished

      // 274. Prevent duplicate execution of the same node.
      if (node.status !== NODE_STATUS.PENDING) continue;

      const outcome = await this._runNode(task, node);
      if (outcome.aborted) return this._finish(task, outcome.status, outcome.reason, outcome.detail);
    }

    return this._finish(task, TASK_STATUS.SUCCEEDED, "task_complete");
  }

  /** Convenience: submit + (automatically) answer clarification + execute. */
  async run(input) {
    const submitted = this.submit(input);

    // A clarification-pending task WAS accepted — it just cannot run yet.
    if (submitted.status === TASK_STATUS.AWAITING_CLARIFICATION) {
      const answered = await this.answerClarification();
      // No way to answer: report that the task is WAITING, not that it failed.
      if (!answered.accepted) return this._awaitingResult(this.active, answered.reason);
    } else if (!submitted.accepted) {
      return { taskId: submitted.taskId, status: submitted.status, success: false, reason: submitted.reason, spoken: `Sorry, it did not work. ${submitted.reason}`, ui: { state: "failure", label: submitted.reason } };
    }
    return this.execute();
  }

  /**
   * 230, 231. Store the user's clarification answer and resume the task.
   */
  async answerClarification() {
    const task = this.active;
    if (!task) return { accepted: false, reason: "no_active_task" };
    if (!task.clarification?.needed) return { accepted: false, reason: "no_clarification_pending" };
    if (typeof this.clarifier !== "function") return { accepted: false, reason: "no_clarifier" };

    const answer = await this.clarifier(task.clarification);
    if (!answer) return { accepted: false, reason: "clarification_unanswered" };

    // 230. Store clarification.
    task.clarifications = [...(task.clarifications || []), { question: task.clarification.question, answer }];
    task.events.emitTask("clarification_answered", { taskId: task.taskId, question: task.clarification.question, answer });

    // The answer resolves the missing field, so re-derive the task with it.
    const resolvedText = applyClarification(task.spec.command.text, task.clarification, answer);
    const command = toStructuredCommand({
      text: resolvedText,
      original: resolvedText,
      source: task.spec.command.source,
      sessionId: task.spec.command.sessionId,
      turnId: task.spec.command.turnId,
    });
    const spec = buildTaskSpec(command, this.config);
    const impossible = detectImpossibleTask(spec);
    if (impossible) return { accepted: false, reason: "impossible_task" };

    task.spec = spec;
    task.clarification = null;
    task.graph = buildTaskGraph({ taskId: task.taskId, spec, maxRetries: spec.maxRetries });

    // 231. Resume task.
    task.machine.transition(TASK_STATUS.RUNNING, { reason: "resumed_after_clarification" });
    task.events.emitTask("task_resumed", { taskId: task.taskId, reason: "clarification" });
    return { accepted: true, taskId: task.taskId, spec, graph: task.graph };
  }

  /**
   * 244–254. Execute one node: generate the step, choose perception + tool,
   * gate on risk, act, observe, verify — and recover when verification fails.
   */
  async _runNode(task, node) {
    const { taskId, tracker, events, graph, spec } = task;

    node.status = NODE_STATUS.RUNNING;
    tracker.setCurrentNode(node.id); // 232
    events.emitStep("step_start", { taskId, node: node.id, step: node.step?.type ?? node.type, target: node.step?.target ?? null });

    // 220. The task node carries no step; it only marks the start.
    if (node.type === NODE_TYPES.TASK) {
      node.status = NODE_STATUS.DONE;
      tracker.completeNode(node.id);
      events.emitStep("step_done", { taskId, node: node.id, step: "task" });
      return { ok: true };
    }

    // 244. Generate task step.
    const step = node.step;
    // 245 + 246. Select perception method and tool.
    const perceptionMethod = this.selectPerceptionMethod(step);
    const tool = this.selectTool(step);
    // 241, 242. What this step expects to see.
    tracker.expect(this._expectationFor(step));
    events.emitStep("step_prepared", { taskId, node: node.id, step: step.type, tool, perceptionMethod });

    // 256. Unsafe step: a confirmation-required action never runs silently.
    // Two independent gates, in the documented order: the COMMAND gate (P2's
    // classification of the request, asked once per task) and the ACTION gate
    // (`requiresConfirmation` on the concrete step).
    if (!task.commandApproved && spec.constraints?.commandRequiresConfirmation) {
      const approved = await this._confirmCommand(task);
      if (!approved) return this._abort(task, TASK_STATUS.ABORTED, "unsafe_command_refused", { command: spec.command.text });
      task.commandApproved = true;
    }

    const risk = requiresConfirmation(step, this.config);
    if (risk) {
      const approved = await this._confirm(task, step, risk);
      if (!approved) return this._abort(task, TASK_STATUS.ABORTED, "unsafe_action_refused", { node: node.id, risk });
    }

    // 247 + 248 + 249. ACT → OBSERVE → VERIFY.
    const first = await this._attempt(task, node, { perceptionMethod, tool });

    if (first.ok) return { ok: true };

    // 251–254. Recovery: bounded retries with re-perception, re-plan, rollback.
    const recovery = graph.recoveryFor(node.id);
    const maxRetries = recovery?.maxRetries ?? spec.maxRetries;
    let recoveryNode = recovery;
    if (recoveryNode) recoveryNode.status = NODE_STATUS.RUNNING;
    let currentNode = node;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      tracker.recordRetry(currentNode.id); // 236
      events.emitFailure("step_retry", { taskId, node: currentNode.id, attempt, maxRetries, reason: first.reason });
      recoveryNode && (recoveryNode.attempts = attempt);
      if (recoveryNode) recoveryNode.strategy = "re_perceive_refocus_and_retry";

      // 252. Re-perceive after failure, so the retry acts on the current screen.
      const observed = await this._observe(task, currentNode.step);
      events.emitStep("re_perceived", { taskId, node: currentNode.id, attempt, screen: observed?.screen ?? null });

      // 251. Restore the input state the step depends on BEFORE re-acting:
      // a half-finished field (typed text that never landed, or a selection
      // left behind by the previous attempt) and a lost focus would otherwise
      // make every retry fail exactly like the attempt before it.
      await this._reestablishFocus(task, currentNode, attempt);

      // 253. Re-plan after mismatch (bounded — never an infinite loop).
      if (first.reason === "verification_mismatch" && task.replans < MAX_REPLANS) {
        task.replans += 1;
        const previousId = currentNode.id;
        task.graph = buildTaskGraph({ taskId, spec: task.spec, maxRetries: spec.maxRetries });
        // Carry the already-finished work over so the new graph does not re-run it.
        for (const doneId of tracker.completed) {
          const doneNode = task.graph.getNode(doneId);
          if (doneNode) doneNode.status = NODE_STATUS.DONE;
        }
        for (const failure of tracker.failed) {
          const failedNode = task.graph.getNode(failure.nodeId);
          if (failedNode) failedNode.status = NODE_STATUS.FAILED;
        }
        const rebound = task.graph.getNode(previousId) || task.graph.nextRunnable();
        events.emitStep("re_planned", { taskId, node: previousId, replans: task.replans, nodes: task.graph.nodes.length });
        if (rebound) {
          currentNode = rebound; // keep executing the freshly planned node
          recoveryNode = task.graph.recoveryFor(rebound.id); // and its recovery node
          if (recoveryNode) recoveryNode.status = NODE_STATUS.RUNNING;
        }
      }

      const attemptResult = await this._attempt(task, currentNode, { perceptionMethod, tool, attempt });
      if (attemptResult.ok) {
        if (recoveryNode) {
          recoveryNode.status = NODE_STATUS.DONE;
          tracker.completeNode(recoveryNode.id);
        }
        events.emitVerification("recovered", { taskId, node: currentNode.id, attempt });
        return { ok: true };
      }

      // 254. Roll back when supported — and say so when it is not.
      const rollback = await this._rollback(task, currentNode, attemptResult);
      if (rollback.status === "rolled_back") {
        currentNode.status = NODE_STATUS.PENDING; // rollback restored the pre-action state
        tracker.completeNode(recoveryNode?.id ?? currentNode.id);
        events.emitStep("rolled_back", { taskId, node: currentNode.id, attempt, rollback: rollback.detail });
        continue;
      }
      events.emitStep("rollback_unsupported", { taskId, node: currentNode.id, attempt, detail: rollback.detail });
    }

    // Exhausted: an action that could not be verified is a failure, never a success.
    if (recoveryNode) recoveryNode.status = NODE_STATUS.FAILED;
    currentNode.status = NODE_STATUS.FAILED;
    tracker.failNode(currentNode.id, first.reason);
    events.emitFailure("step_failed", { taskId, node: currentNode.id, step: currentNode.step?.type, reason: first.reason, attempts: maxRetries });
    return this._abort(task, TASK_STATUS.FAILED, "step_failed", { node: currentNode.id, reason: first.reason });
  }

  /** 247, 248, 249. One ACT → OBSERVE → VERIFY cycle for a node. */
  async _attempt(task, node, { perceptionMethod, tool, attempt = 1 } = {}) {
    const { taskId, tracker, events, graph } = task;
    const step = node.step;

    // 247. Execute tool.
    if (!this.toolBox || typeof this.toolBox.run !== "function") {
      return { ok: false, reason: "no_toolbox" };
    }
    const toolResult = await this.toolBox.run(step);
    node.attempts = (node.attempts || 0) + 1;
    events.emitStep("tool_result", {
      taskId,
      node: node.id,
      step: step.type,
      tool,
      attempt,
      success: Boolean(toolResult?.success),
      error: toolResult?.error || null,
    });

    if (!toolResult?.success) return { ok: false, reason: "tool_failed", detail: toolResult?.error || null };

    // 248. Observe result (fresh screen model for the tracker + audit).
    const model = await this._observe(task, step, perceptionMethod);
    if (model) {
      tracker.observeContext({ application: model.application, screen: model.screen }); // 239, 240
    }

    // 249. Verify result — only for steps that change the screen.
    if (!MUTATING_STEPS.has(step.type) || step.verifiable === false) {
      node.status = NODE_STATUS.DONE;
      tracker.completeNode(node.id);
      events.emitStep("step_done", { taskId, node: node.id, step: step.type, verified: false });
      return { ok: true };
    }

    const verificationNode = graph.verificationFor(node.id);
    const verdict = await this.verifyResult(step);
    if (verificationNode) verificationNode.attempts = (verificationNode.attempts || 0) + 1;
    events.emitVerification("verify", {
      taskId,
      node: node.id,
      step: step.type,
      attempt,
      passed: Boolean(verdict?.success),
      drift: verdict?.data?.drift ? true : false,
    });

    if (!verdict?.success) {
      // A mismatch is when the screen proves we are somewhere else: the action
      // hit another window (drift) or the target application is gone.
      const screenLost = Boolean(model && model.screen === "unknown");
      const drifted = Boolean(verdict?.data?.drift);
      const reason = drifted || screenLost ? "verification_mismatch" : "verification_failed";
      return { ok: false, reason, detail: verdict?.data ?? null };
    }

    if (verificationNode) {
      verificationNode.status = NODE_STATUS.DONE;
      tracker.completeNode(verificationNode.id);
    }
    node.status = NODE_STATUS.DONE;
    tracker.completeNode(node.id); // 233
    events.emitStep("step_done", { taskId, node: node.id, step: step.type, verified: true });
    return { ok: true };
  }

  async _observe(task, step, perceptionMethod = null) {
    if (!this.perception || typeof this.perception.perceive !== "function") return null;
    try {
      return await this.perception.perceive({ intent: `task ${task.taskId} observe ${step.type}`, method: perceptionMethod });
    } catch (err) {
      task.events.emitFailure("observe_failed", { taskId: task.taskId, step: step.type, error: String(err?.message || err) });
      return null;
    }
  }

  /** 249. Verify via perception; a perception-less engine verifies the tool result only. */
  async verifyResult(step) {
    if (!this.perception || typeof this.perception.verify !== "function") return { success: false, data: { reason: "no_perception" } };
    return this.perception.verify(step);
  }

  /** 245. Select perception method from the configured priority list. */
  selectPerceptionMethod(step) {
    const priority = this.config?.perception?.priority || PERCEPTION_METHODS;
    const available = Array.isArray(priority) && priority.length ? priority : PERCEPTION_METHODS;
    // Structured controls resolve through UIA; text-only targets need OCR.
    if (step?.type === "type" || step?.type === "read_screen") {
      return available.includes("ocr") ? "ocr" : available[0];
    }
    if (step?.target === "search_box") return available.includes("uia") ? "uia" : available[0];
    return available[0];
  }

  /** 246. Select the tool for a step. */
  selectTool(step) {
    return TOOL_BY_STEP[step?.type] || step?.type || "unknown";
  }

  /** 241–243. What a step expects to see afterwards. */
  _expectationFor(step) {
    switch (step?.type) {
      case "open_app":
        return { screen: "application_loaded", state: `${step.target} open` };
      case "find_element":
      case "click":
        return { element: step.target || "search_box", state: "target resolved" };
      case "type":
        return { element: step.target || "search_box", state: `query "${step.args?.text ?? ""}"` };
      default:
        return {};
    }
  }

  /**
   * 256. COMMAND gate: P2 classified the request itself as dangerous, so the
   * whole task is approved or refused before any mutation happens.
   */
  async _confirmCommand(task) {
    const { taskId, machine, events, spec } = task;
    const risk = spec.constraints?.riskLevel || "high";
    const question = `Allow ${risk}-risk command: "${spec.command.text}"?`;
    machine.transition(TASK_STATUS.AWAITING_CONFIRMATION, { reason: `command_risk_${risk}` });
    events.emitTask("command_confirmation_required", { taskId, risk, question, categories: spec.constraints?.riskCategories || [] });

    let approved = false;
    if (this.confirmator && typeof this.confirmator.confirm === "function") {
      approved = Boolean(await this.confirmator.confirm(question, { taskId, command: spec.command.text, risk }));
    }
    if (approved) {
      machine.transition(TASK_STATUS.RUNNING, { reason: "command_confirmed" });
      events.emitTask("command_confirmation_granted", { taskId, risk });
    } else {
      events.emitFailure("command_confirmation_refused", { taskId, risk });
    }
    return approved;
  }

  /** 256. Ask before an action the risk policy says needs confirmation. */
  async _confirm(task, step, risk) {
    const { taskId, machine, events } = task;
    machine.transition(TASK_STATUS.AWAITING_CONFIRMATION, { reason: `risk_${risk}` });
    const question = `Allow ${risk} action: ${step.type} "${step.target || ""}"?`;
    events.emitTask("confirmation_required", { taskId, step: step.type, risk, question });

    let approved = false;
    if (this.confirmator && typeof this.confirmator.confirm === "function") {
      approved = Boolean(await this.confirmator.confirm(question, { taskId, step }));
    }
    if (approved) {
      machine.transition(TASK_STATUS.RUNNING, { reason: "confirmed" });
      events.emitTask("confirmation_granted", { taskId, step: step.type, risk });
    } else {
      events.emitFailure("confirmation_refused", { taskId, step: step.type, risk });
    }
    return approved;
  }

  /**
   * 251, 252. Restore the input state a failed step depends on before retrying
   * it: dismiss whatever the previous attempt left behind (Escape + refocus the
   * task's application, when the toolbox can do that) and re-run the
   * focus-establishing dependency the plan declared for this step.
   */
  async _reestablishFocus(task, node, attempt) {
    const { taskId, events, spec } = task;
    const refocus = spec?.application || null;

    if (refocus && this.toolBox && typeof this.toolBox.recover === "function") {
      const recovered = await this.toolBox.recover({ refocus });
      events.emitStep("recovered_focus", { taskId, node: node.id, attempt, refocus, success: Boolean(recovered?.success) });
    }

    const focusStep = this._focusDependency(task.graph, node);
    if (focusStep && this.toolBox && typeof this.toolBox.run === "function") {
      const result = await this.toolBox.run(focusStep);
      events.emitStep("refocused_target", {
        taskId,
        node: node.id,
        attempt,
        step: focusStep.type,
        target: focusStep.target ?? null,
        success: Boolean(result?.success),
      });
    }
  }

  /** The dependency that put the input where this node needs it (click/focus). */
  _focusDependency(graph, node) {
    const focusSteps = new Set(["click", "focus"]);
    for (const depId of node.dependsOn) {
      const dep = graph?.getNode(depId);
      if (dep?.status === NODE_STATUS.DONE && dep.step && focusSteps.has(dep.step.type)) return dep.step;
    }
    return null;
  }

  /** 254. Roll back when the step declares a rollback and tools can run it. */
  async _rollback(task, node, attemptResult) {
    const rollbackStep = node.step?.rollback || null;
    if (!rollbackStep) return { status: "unsupported", detail: "step declares no rollback" };
    if (!this.toolBox || typeof this.toolBox.run !== "function") return { status: "unsupported", detail: "no toolbox" };
    const result = await this.toolBox.run(rollbackStep);
    task.events.emitStep("rollback", { taskId: task.taskId, node: node.id, success: Boolean(result?.success) });
    return result?.success ? { status: "rolled_back", detail: rollbackStep.type } : { status: "failed", detail: result?.error || null };
  }

  // -------------------------------------------------------------- lifecycle
  /** 277. Support task cancellation. */
  cancel(reason = "cancelled_by_user") {
    const task = this.active;
    if (!task) return false;
    const allowed = task.machine.canTransition(TASK_STATUS.CANCELLED);
    if (!allowed) return false;
    task.machine.transition(TASK_STATUS.CANCELLED, { reason });
    task.events.emitFailure("task_cancelled", { taskId: task.taskId, reason });
    return true;
  }

  /** 278. Support task timeout (also enforced inside the run loop). */
  timeout(reason = "task_timeout") {
    const task = this.active;
    if (!task) return false;
    if (!task.machine.canTransition(TASK_STATUS.TIMED_OUT)) return false;
    task.machine.transition(TASK_STATUS.TIMED_OUT, { reason });
    task.events.emitFailure("task_timeout", { taskId: task.taskId, reason });
    return true;
  }

  /** 279. Support task resume. */
  resume() {
    const task = this.active;
    if (!task) return false;
    if (task.machine.status === TASK_STATUS.AWAITING_CLARIFICATION) return false; // needs an answer first
    const ok = task.machine.transition(TASK_STATUS.RUNNING, { reason: "resume" });
    if (ok) task.events.emitTask("task_resumed", { taskId: task.taskId, reason: "resume" });
    return ok;
  }

  /** 280. Support task retry (failed/timed-out tasks may be re-run). */
  retry() {
    const task = this.active;
    if (!task) return false;
    const ok = task.machine.transition(TASK_STATUS.RUNNING, { reason: "retry" });
    if (ok) {
      task.tracker.recordRetry("task");
      task.events.emitTask("task_retried", { taskId: task.taskId, attempt: task.tracker.retriesFor("task") });
    }
    return ok;
  }

  /** 283. Support task cleanup: release the active slot and trim history. */
  cleanup({ keep = null } = {}) {
    const task = this.active;
    const removed = this.history.cleanup({ keep });
    this.active = null;
    this.events = null;
    this._recentFingerprints = []; // the duplicate guard is released with the task
    return { released: Boolean(task), historyRemoved: removed };
  }

  /** 275. A task is current only while it is the active, running one. */
  _isCurrent(taskId) {
    return Boolean(this.active && this.active.taskId === taskId && !this.active.machine.isTerminal());
  }

  // ---------------------------------------------------------------- results
  /** 259–263, 267–271, 283. Produce, publish and store the task result. */
  _finish(task, status, reason, detail = {}) {
    const { taskId, spec, tracker, machine, events } = task;
    // 282. Success / 281. Failure — through the state machine, never by force.
    if (status === TASK_STATUS.SUCCEEDED) machine.transition(TASK_STATUS.SUCCEEDED, { reason });
    else if (machine.status !== status && machine.canTransition(status)) machine.transition(status, { reason });

    tracker.markFinished(); // 237, 238

    const success = machine.status === TASK_STATUS.SUCCEEDED;
    const failureReason = success ? null : reason;

    // 259. Generate task result.
    const result = {
      taskId,
      status: machine.status,
      success,
      reason: failureReason,
      detail,
      expectedResult: spec?.expectedResult ?? null,
      command: spec?.command?.text ?? null,
      completedNodes: [...tracker.completed],
      failedNodes: tracker.failed.map((f) => ({ ...f })),
      skippedNodes: tracker.skipped.map((s) => ({ ...s })),
      totalRetries: tracker.totalRetries,
      durationMs: tracker.durationMs,
      // 260. Generate spoken response.
      spoken: success ? "Done." : `Sorry, it did not work. ${this._explain(task, failureReason)}`,
      // 261. Generate UI result.
      ui: {
        state: success ? "success" : machine.status === TASK_STATUS.CANCELLED ? "cancelled" : machine.status === TASK_STATUS.TIMED_OUT ? "timeout" : "failure",
        label: success ? spec?.expectedResult ?? "task complete" : this._explain(task, failureReason),
        taskId,
      },
    };

    this._publish(result, task);
    this.active = null; // 283. release the slot so the next task can run
    return result;
  }

  _publish(result, task) {
    const { taskId, spec, tracker, events } = task;
    if (!events) return;

    // 262. Generate audit record + 263. Store task history.
    const audit = buildAuditRecord({ taskId, spec, tracker, events: events.getEvents(), result });
    result.audit = audit;
    this.history.add({ taskId, status: result.status, success: result.success, durationMs: result.durationMs, audit });
    // 271. Notify logger with the outcome.
    events.notifyLogger("verification", "task_result", { taskId, status: result.status, success: result.success, durationMs: result.durationMs });
    // 267 / 268. Failure or success event.
    if (result.success) events.emitSuccess("task_success", { taskId, durationMs: result.durationMs, retries: result.totalRetries });
    else events.emitFailure("task_failure", { taskId, status: result.status, reason: result.reason });

    // 269 + 270. Notify the voice and UI layers.
    events.notifyVoice(result);
    events.notifyUi(result);
    this.emit("result", result);
  }

  /** 255–258. Abort a running task with a recorded status and reason. */
  _abort(task, status, reason, detail = {}) {
    // A cancellation that already happened outranks the abort being raised now.
    const finalStatus = task.machine.status === TASK_STATUS.CANCELLED ? TASK_STATUS.CANCELLED : status;
    task.events.emitFailure("task_aborted", { taskId: task.taskId, reason, status: finalStatus, ...detail });
    return { aborted: true, status: finalStatus, reason, detail };
  }

  _explain(task, reason) {
    const failed = task.tracker.failed.at(-1);
    if (failed?.reason) return `${failed.reason}${failed.nodeId ? ` (${failed.nodeId})` : ""}`;
    return reason || "task did not complete";
  }

  _failedResult(reason, task = null) {
    if (!task) return { taskId: null, status: null, success: false, reason, spoken: `Sorry, it did not work. ${reason}`, ui: { state: "failure", label: reason } };
    const result = this._finish(task, reason === "task_timeout" ? TASK_STATUS.TIMED_OUT : TASK_STATUS.FAILED, reason);
    return result;
  }

  /** A task waiting for the user is neither a success nor a failure. */
  _awaitingResult(task, reason = "awaiting_clarification") {
    const question = task?.clarification?.question ?? null;
    task?.events?.emitTask("task_waiting", { taskId: task.taskId, reason, question });
    return {
      taskId: task?.taskId ?? null,
      status: task?.machine?.status ?? null,
      success: false,
      waiting: true,
      reason,
      question,
      spoken: question ? `I need to know: ${question}` : "I need more information to continue.",
      ui: { state: "awaiting_clarification", label: question, taskId: task?.taskId ?? null },
    };
  }

  /** Snapshot of the engine + active task, for the UI and tests. */
  getState() {
    const task = this.active;
    return {
      activeTaskId: task?.taskId ?? null,
      status: task?.machine?.status ?? null,
      graph: task?.graph ? task.graph.toJSON() : null,
      tracker: task?.tracker ? task.tracker.toJSON() : null,
      machine: task?.machine ? task.machine.toJSON() : null,
      historySize: this.history.size,
    };
  }
}

TaskEngine._seq = 0;
