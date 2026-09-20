import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TaskEngine,
  TaskGraph,
  TaskStateMachine,
  TaskTracker,
  TaskHistory,
  TASK_STATUS,
  NODE_TYPES,
  buildTaskGraph,
  buildTaskSpec,
  buildAuditRecord,
  toStructuredCommand,
  normalizeCommandText,
  applyClarification,
  detectCommandType,
  detectImpossibleTask,
  detectMissingInformation,
  detectAmbiguity,
  COMMAND_TYPES,
} from "../pipelines/p3_task_engine/index.js";

/**
 * P3 Tests — Intent + Task Engine (Tickets 201–300)
 *
 * The engine is driven through the SAME interfaces the live stack exposes
 * (perception.perceive/verify, toolBox.run), so these tests exercise the real
 * code paths with deterministic fakes rather than a parallel implementation.
 */

// ---------------------------------------------------------------- fixtures

function makeModel({ application = "WhatsApp", screen = "chat_list", elements = [] } = {}) {
  return {
    application,
    screen,
    confidence: 0.85,
    source: "fake",
    elements,
    toJSON() {
      return { application, screen, confidence: 0.85, source: "fake", elements };
    },
  };
}

function makePerception({ verifyPlan = null, model = null } = {}) {
  const state = { verifications: [], perceives: 0 };
  return {
    state,
    perceive: async () => {
      state.perceives += 1;
      return model ? model() : makeModel({ elements: [{ type: "search_box", name: "search_box", query: "Dad" }] });
    },
    verify: async (step) => {
      state.verifications.push(step.type);
      const planned = verifyPlan ? verifyPlan(step, state.verifications.filter((t) => t === step.type).length) : null;
      return planned || { success: true, data: {} };
    },
  };
}

function makeToolBox({ onRun = null } = {}) {
  const calls = [];
  return {
    calls,
    run: async (step) => {
      calls.push({ type: step.type, target: step.target ?? null, text: step.args?.text ?? null });
      if (onRun) await onRun(step, calls.length);
      return {
        success: true,
        action: step.type,
        data: {},
        error: "",
        toJSON() {
          return { success: true, action: step.type, data: {}, error: "" };
        },
      };
    },
  };
}

function makeConfig(overrides = {}) {
  return {
    agent: {
      requireConfirmationFor: [],
      maxRetriesPerAction: 2,
      taskTimeoutMs: 60000,
      ...(overrides.agent || {}),
    },
    perception: { priority: ["uia", "ocr", "opencv", "vision", "coordinate"] },
    ...overrides,
  };
}

/** Ticking fake clock: every read advances, so durations are deterministic. */
function makeClock(start = 1000, step = 10) {
  let now = start;
  return () => {
    now += step;
    return now;
  };
}

function makeEngine({ perception = makePerception(), toolBox = makeToolBox(), config = makeConfig(), clarifier = null, logger = null, idFactory = () => "task_test" } = {}) {
  return new TaskEngine({ perception, toolBox, config, clarifier, logger, clock: makeClock(), idFactory });
}

const SEARCH_COMMAND = "Open WhatsApp and search for Dad";

// ==========================================
// Ticket coverage 201–283
// ==========================================

test("task: receives a structured command and keeps original + normalized copies", () => {
  const command = toStructuredCommand({ text: "  Open   WhatsApp  and search for Dad  ", source: "voice", sessionId: "sess_1", turnOrder: 7 });
  assert.equal(command.original, "  Open   WhatsApp  and search for Dad  ");
  assert.equal(command.text, "Open WhatsApp and search for Dad");
  assert.equal(command.source, "voice");
  assert.equal(command.turnId, 7);
  assert.equal(normalizeCommandText("a \n b"), "a b");
});

test("task: derives command type, application, target, expected result and constraints", () => {
  const spec = buildTaskSpec(toStructuredCommand(SEARCH_COMMAND), makeConfig());
  assert.equal(spec.commandType, COMMAND_TYPES.OPEN_AND_SEARCH); // 206
  assert.equal(spec.application, "WhatsApp"); // 207
  assert.equal(spec.targetEntity, "Dad"); // 208
  assert.equal(spec.requestedAction, "open_app+click+type"); // 209
  assert.match(spec.expectedResult, /search results for "Dad"/); // 210
  assert.equal(spec.constraints.readOnly, false); // 211
  assert.ok(spec.dependencies.some((d) => d.reason === "target_must_be_focused")); // 212
  assert.equal(spec.actionSequence.length, 8); // 213
  assert.equal(spec.confirmationRequirements.required, false); // 214
  assert.equal(spec.priority, "normal"); // 215
  assert.equal(spec.timeoutMs, 60000); // 216
  assert.equal(spec.maxRetries, 2); // 217
  assert.equal(spec.verifyEveryAction, true); // 218
  assert.equal(detectCommandType("scroll down please"), COMMAND_TYPES.SCROLL);
});

test("task: builds a graph with task, action, observation, verification and recovery nodes", () => {
  const spec = buildTaskSpec(toStructuredCommand(SEARCH_COMMAND), makeConfig());
  const graph = buildTaskGraph({ taskId: "task_g", spec, maxRetries: 2 });

  assert.equal(graph.nodesOfType(NODE_TYPES.TASK).length, 1); // 220
  assert.ok(graph.nodesOfType(NODE_TYPES.ACTION).length >= 3); // 221
  assert.ok(graph.nodesOfType(NODE_TYPES.OBSERVATION).length >= 3); // 222
  assert.equal(graph.nodesOfType(NODE_TYPES.VERIFICATION).length, graph.nodesOfType(NODE_TYPES.ACTION).length); // 223
  assert.equal(graph.nodesOfType(NODE_TYPES.RECOVERY).length, graph.nodesOfType(NODE_TYPES.ACTION).length); // 224

  const validation = graph.validate(); // 225
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
  // Deterministic ordering: the first step depends only on the task node.
  assert.deepEqual(graph.nodes[1].dependsOn, ["n0_task"]);
});

test("task: graph validation catches a mutating action with no verification node", () => {
  const graph = new TaskGraph({ taskId: "t" });
  graph.addInitialTaskNode({ commandType: "x", expectedResult: "y" });
  graph.addNode({ id: "a1", type: NODE_TYPES.ACTION, step: { type: "click", target: "search_box" }, dependsOn: ["n0_task"] });
  const validation = graph.validate();
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => /no verification node/.test(e)));
  assert.ok(validation.errors.some((e) => /no recovery node/.test(e)));
});

test("task: tracks current/completed/failed/skipped nodes, retries, timing and context", () => {
  const tracker = new TaskTracker({ taskId: "t", clock: makeClock(0, 100) });
  tracker.markCreated();
  tracker.markStarted();
  tracker.setCurrentNode("n1"); // 232
  tracker.completeNode("n1"); // 233
  tracker.failNode("n2", "verification_failed"); // 234
  tracker.skipNode("n3", "replanned"); // 235
  tracker.recordRetry("n2"); // 236
  tracker.recordRetry("n2");
  tracker.observeContext({ application: "WhatsApp", screen: "chat_list" }); // 239, 240
  tracker.expect({ screen: "chat_list", element: "search_box", state: 'query "Dad"' }); // 241–243
  tracker.markFinished();

  assert.equal(tracker.currentNodeId, null);
  assert.deepEqual(tracker.completed, ["n1"]);
  assert.equal(tracker.failed[0].reason, "verification_failed");
  assert.equal(tracker.skipped[0].reason, "replanned");
  assert.equal(tracker.retriesFor("n2"), 2);
  assert.equal(tracker.totalRetries, 2);
  assert.ok(tracker.createdAt !== null && tracker.startedAt !== null && tracker.finishedAt !== null); // 237
  assert.equal(tracker.durationMs, 100); // 238 (clock advances 100 per read)
  assert.equal(tracker.currentApplication, "WhatsApp");
  assert.equal(tracker.currentScreen, "chat_list");
  assert.equal(tracker.expectedScreen, "chat_list");
  assert.equal(tracker.expectedElement, "search_box");
  assert.match(tracker.expectedState, /Dad/);
});

test("task: the state machine refuses invalid and unknown transitions", () => {
  const machine = new TaskStateMachine({ taskId: "t" });
  assert.equal(machine.status, TASK_STATUS.PENDING);
  assert.equal(machine.transition(TASK_STATUS.SUCCEEDED), false); // 273. cannot succeed from pending
  assert.equal(machine.status, TASK_STATUS.PENDING);
  assert.equal(machine.transition("teleported"), false);
  assert.equal(machine.invalidAttempts.length, 2);

  assert.equal(machine.transition(TASK_STATUS.RUNNING), true); // 272
  assert.equal(machine.transition(TASK_STATUS.SUCCEEDED), true);
  assert.equal(machine.isTerminal(), true); // 282
  assert.equal(machine.transition(TASK_STATUS.RUNNING), false); // terminal stays terminal
});

test("task: emits task/step/verification/success events and notifies voice, UI and logger", async () => {
  const logged = [];
  const logger = { log: (stage, event, data) => logged.push({ stage, event, data }) };
  const voiceResults = [];
  const uiResults = [];
  const engine = new TaskEngine({
    perception: makePerception(),
    toolBox: makeToolBox(),
    config: makeConfig(),
    clock: makeClock(),
    idFactory: () => "task_events",
    logger,
    sinks: { voice: (r) => voiceResults.push(r), ui: (r) => uiResults.push(r) },
  });

  const result = await engine.run(SEARCH_COMMAND); // 264–268 covered below in event ordering
  assert.equal(result.success, true);

  const names = engine.events.getEvents().map((e) => e.name);
  assert.ok(names.includes("task")); // 264
  assert.ok(names.includes("step")); // 265
  assert.ok(names.includes("verification")); // 266
  assert.ok(names.includes("success")); // 268
  assert.equal(names.includes("failure"), false);
  assert.equal(voiceResults.length, 1); // 269
  assert.equal(uiResults.length, 1); // 270
  assert.equal(uiResults[0].ui.state, "success");
  assert.ok(logged.some((l) => l.event === "task_result")); // 271
  assert.ok(logged.some((l) => l.stage === "verification"));
});

test("task: stores an audit record and bounded task history", async () => {
  const engine = makeEngine();
  const result = await engine.run(SEARCH_COMMAND);

  assert.equal(result.audit.taskId, "task_test"); // 262
  assert.equal(result.audit.command, SEARCH_COMMAND);
  assert.equal(result.audit.status, "succeeded");
  assert.equal(result.audit.success, true);
  assert.ok(result.audit.eventCount > 0);
  assert.ok(result.audit.events.length === result.audit.eventCount);

  const stored = engine.history.get("task_test"); // 263
  assert.ok(stored);
  assert.equal(stored.status, "succeeded");

  const bounded = new TaskHistory({ limit: 2 });
  bounded.add({ taskId: "a" });
  bounded.add({ taskId: "b" });
  bounded.add({ taskId: "c" });
  assert.equal(bounded.size, 2);
  assert.equal(bounded.get("a"), null);
  assert.equal(buildAuditRecord({ taskId: "x", events: [] }).taskId, "x");
});

test("task: an unsafe step never runs without confirmation", async () => {
  // "type" is a medium-risk action; the policy gates it.
  const toolBox = makeToolBox();
  const engine = new TaskEngine({
    perception: makePerception(),
    toolBox,
    config: makeConfig({ agent: { requireConfirmationFor: ["medium", "high"], maxRetriesPerAction: 1, taskTimeoutMs: 60000 } }),
    confirmator: { confirm: async () => false },
    clock: makeClock(),
    idFactory: () => "task_unsafe",
  });

  const result = await engine.run(SEARCH_COMMAND);

  assert.equal(result.success, false);
  assert.equal(result.status, "aborted");
  // 256. The type step was refused — it was never handed to the toolbox.
  assert.equal(toolBox.calls.some((c) => c.type === "type"), false);
});

test("task: rollback is reported honestly when a step declares none", async () => {
  const perception = makePerception({ verifyPlan: (step) => (step.type === "type" ? { success: false, data: {} } : null) });
  const engine = new TaskEngine({
    perception,
    toolBox: makeToolBox(),
    config: makeConfig({ agent: { requireConfirmationFor: [], maxRetriesPerAction: 1, taskTimeoutMs: 60000 } }),
    clock: makeClock(),
    idFactory: () => "task_rollback",
  });

  const result = await engine.run(SEARCH_COMMAND);
  assert.equal(result.success, false); // 254. no rollback support -> the failure stands
  const events = engine.events.getEvents();
  assert.ok(events.some((e) => e.event === "rollback_unsupported"));
});

// ==========================================
// P3 Tests (Tickets 284–300)
// ==========================================

test("284. Test simple command", async () => {
  const toolBox = makeToolBox();
  const engine = makeEngine({ toolBox });

  const result = await engine.run("Open WhatsApp");

  assert.equal(result.success, true);
  assert.equal(result.status, TASK_STATUS.SUCCEEDED);
  assert.equal(result.spoken, "Done.");
  assert.deepEqual(toolBox.calls.map((c) => c.type), ["open_app", "wait", "read_screen"]);
  assert.equal(engine.history.size, 1);
});

test("285. Test multi-step command", async () => {
  const toolBox = makeToolBox();
  const engine = makeEngine({ toolBox });

  const result = await engine.run(SEARCH_COMMAND);

  assert.equal(result.success, true);
  assert.equal(result.totalRetries, 0);
  // The whole planned sequence ran, in order, exactly once.
  assert.deepEqual(toolBox.calls.map((c) => c.type), [
    "open_app",
    "wait",
    "read_screen",
    "find_element",
    "click",
    "type",
    "wait",
    "read_screen",
  ]);
  assert.equal(toolBox.calls.find((c) => c.type === "type").text, "Dad");
  assert.equal(result.ui.state, "success");
  assert.match(result.ui.label, /search results for "Dad"/);
});

test("286. Test cancellation", async () => {
  let engine = null;
  const toolBox = makeToolBox(); // cancel the task once the app is open
  const cancellingToolBox = {
    calls: toolBox.calls,
    run: async (step) => {
      const r = await toolBox.run(step);
      if (step.type === "open_app") engine.cancel("user_pressed_escape");
      return r;
    },
  };
  engine = makeEngine({ toolBox: cancellingToolBox });

  const result = await engine.run(SEARCH_COMMAND);

  assert.equal(result.success, false);
  assert.equal(result.status, TASK_STATUS.CANCELLED);
  assert.equal(result.ui.state, "cancelled");
  // 258. Nothing ran after the cancellation.
  assert.equal(toolBox.calls.some((c) => c.type === "type"), false);
  // A cancelled task cannot be retried or resumed — that is the point of cancelling.
  assert.equal(engine.retry(), false);
  assert.equal(engine.resume(), false);
});

test("287. Test retry", async () => {
  // The first type attempt fails verification; the retry succeeds.
  const perception = makePerception({ verifyPlan: (step, attempt) => (step.type === "type" && attempt === 1 ? { success: false, data: {} } : null) });
  const engine = makeEngine({ perception });

  const result = await engine.run(SEARCH_COMMAND);

  assert.equal(result.success, true);
  assert.equal(result.totalRetries, 1);
  assert.ok(engine.events.getEvents().some((e) => e.event === "step_retry"));
  assert.ok(engine.events.getEvents().some((e) => e.event === "recovered"));
});

test("task: a retry restores focus before re-acting (the live failure mode)", async () => {
  // On the real desktop the typed text sometimes never lands, leaving the
  // field's text selected — retrying blindly repeats the same failure. The
  // engine must dismiss that state and re-run the focus dependency first.
  const recoveries = [];
  const calls = [];
  const toolBox = {
    calls,
    run: async (step) => {
      calls.push(step.type);
      return { success: true, action: step.type, data: {}, error: "", toJSON: () => ({ success: true, action: step.type }) };
    },
    recover: async (args) => {
      recoveries.push(args);
      return { success: true, action: "recover", data: args, error: "", toJSON: () => ({ success: true }) };
    },
  };
  const perception = makePerception({ verifyPlan: (step, attempt) => (step.type === "type" && attempt === 1 ? { success: false, data: {} } : null) });
  const engine = new TaskEngine({
    perception,
    toolBox,
    config: makeConfig(),
    clock: makeClock(),
    idFactory: () => "task_refocus",
  });

  const result = await engine.run(SEARCH_COMMAND);

  assert.equal(result.success, true);
  // The textbook sequence around the retry: dismiss + refocus the app,
  // re-click the target, then re-type.
  assert.deepEqual(recoveries, [{ refocus: "WhatsApp" }]);
  const firstType = calls.indexOf("type");
  const secondType = calls.indexOf("type", firstType + 1);
  assert.deepEqual(calls.slice(firstType + 1, secondType + 1), ["click", "type"]);
  const events = engine.events.getEvents().map((e) => e.event);
  assert.ok(events.includes("recovered_focus"));
  assert.ok(events.includes("refocused_target"));
});

test("288. Test timeout", async () => {
  // The task's deadline is already past on the first loop check.
  const engine = new TaskEngine({
    perception: makePerception(),
    toolBox: makeToolBox(),
    config: makeConfig({ agent: { requireConfirmationFor: [], maxRetriesPerAction: 1, taskTimeoutMs: 0 } }),
    clock: makeClock(),
    idFactory: () => "task_timeout",
  });

  const result = await engine.run(SEARCH_COMMAND);

  assert.equal(result.success, false);
  assert.equal(result.status, TASK_STATUS.TIMED_OUT);
  assert.equal(result.ui.state, "timeout");
  assert.ok(engine.events.getEvents().some((e) => e.event === "task_timeout"));
});

test("289. Test verification failure", async () => {
  const perception = makePerception({ verifyPlan: (step) => (step.type === "type" ? { success: false, data: { ok: false } } : null) });
  const engine = makeEngine({ perception });

  const result = await engine.run(SEARCH_COMMAND);

  // An action that could never be verified is a failure — never a false success.
  assert.equal(result.success, false);
  assert.equal(result.status, TASK_STATUS.FAILED);
  assert.equal(result.reason, "step_failed");
  assert.match(result.spoken, /Sorry/);
  assert.ok(result.failedNodes.some((f) => f.nodeId.includes("type")));
  assert.equal(result.completedNodes.some((id) => id.includes("type")), false);
});

test("290. Test recovery", async () => {
  // The click lands on the wrong window first (drift) — recovery re-perceives,
  // re-plans and retries, and the task still completes.
  const perception = makePerception({
    verifyPlan: (step, attempt) =>
      step.type === "click" && attempt === 1
        ? { success: false, data: { drift: { expected: { proc: "opera" }, actual: { proc: "notepad" } } } }
        : null,
  });
  const engine = makeEngine({ perception });

  const result = await engine.run(SEARCH_COMMAND);

  assert.equal(result.success, true);
  const events = engine.events.getEvents().map((e) => e.event);
  assert.ok(events.includes("re_perceived")); // 252
  assert.ok(events.includes("re_planned")); // 253
  assert.ok(events.includes("recovered"));
  assert.ok(result.totalRetries >= 1);
  // The task did NOT finish early after the re-plan: every step still ran.
  assert.ok(result.completedNodes.some((id) => id.includes("read_screen")));
});

test("291. Test ambiguous command", async () => {
  // "it" cannot be resolved — the engine must ask, not guess.
  const asking = makeEngine();
  const submitted = asking.submit("Open it and search for Dad");

  assert.equal(submitted.accepted, true);
  assert.equal(submitted.status, TASK_STATUS.AWAITING_CLARIFICATION);
  assert.match(submitted.clarification.question, /"it"/);
  assert.equal(submitted.clarification.field, "application");
  // Executing an unanswered clarification is not a failure: the task is waiting.
  const waiting = await asking.execute();
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.ui.state, "awaiting_clarification");

  // 229–231. With an answer, the task is re-derived, resumed and completed.
  const clarifying = makeEngine({ clarifier: async () => "WhatsApp" });
  const result = await clarifying.run("Open it and search for Dad");

  assert.equal(result.success, true);
  assert.equal(result.command, SEARCH_COMMAND);
  assert.ok(clarifying.events.getEvents().some((e) => e.event === "clarification_answered"));
  assert.ok(clarifying.events.getEvents().some((e) => e.event === "task_resumed"));
});

test("292. Test impossible command", async () => {
  const engine = makeEngine();

  const submitted = engine.submit("Open FooBar and search for Dad");
  assert.equal(submitted.accepted, false);
  assert.equal(submitted.reason, "impossible_task");
  assert.equal(submitted.status, TASK_STATUS.ABORTED);
  assert.equal(engine.getState().activeTaskId, null); // 255. nothing left running

  const gibberish = await makeEngine().run("flurble the wobble");
  assert.equal(gibberish.success, false);
  assert.equal(gibberish.reason, "impossible_task");

  assert.equal(detectImpossibleTask(buildTaskSpec(toStructuredCommand("open notepad"), makeConfig())), null);
});

test("293. Test unsafe command", async () => {
  const toolBox = makeToolBox();
  const engine = new TaskEngine({
    perception: makePerception(),
    toolBox,
    config: makeConfig({ agent: { requireConfirmationFor: ["high", "medium"], maxRetriesPerAction: 1, taskTimeoutMs: 60000 } }),
    confirmator: { confirm: async () => false },
    clock: makeClock(),
    idFactory: () => "task_declined",
  });

  const result = await engine.run(SEARCH_COMMAND);

  assert.equal(result.success, false);
  assert.equal(result.status, TASK_STATUS.ABORTED);
  assert.equal(toolBox.calls.some((c) => c.type === "type"), false);
  assert.ok(engine.events.getEvents().some((e) => e.event === "confirmation_refused"));

  // The same command with approval does run (631-equivalent behaviour for P3).
  const approved = new TaskEngine({
    perception: makePerception(),
    toolBox,
    config: makeConfig({ agent: { requireConfirmationFor: ["medium"], maxRetriesPerAction: 1, taskTimeoutMs: 60000 } }),
    confirmator: { confirm: async () => true },
    clock: makeClock(),
    idFactory: () => "task_approved",
  });
  assert.equal((await approved.run("Open WhatsApp")).success, true);
});

test("294. Test duplicate command", async () => {
  const engine = makeEngine();

  const first = engine.submit(SEARCH_COMMAND);
  assert.equal(first.accepted, true); // 274. first one is accepted
  const second = engine.submit(SEARCH_COMMAND);
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "duplicate_command");

  // A different command is not a duplicate.
  const other = engine.submit("Open Notepad");
  assert.equal(other.reason, "concurrent_task"); // ... but it is concurrent
});

test("295. Test concurrent command", async () => {
  const engine = makeEngine();
  const first = engine.submit(SEARCH_COMMAND);
  assert.equal(first.accepted, true);

  const second = engine.submit("Open Notepad");
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "concurrent_task"); // 276
  assert.equal(second.taskId, first.taskId);

  // Once the first task is cleaned up, the engine takes new work again.
  await engine.execute();
  engine.cleanup();
  const third = engine.submit("Open Notepad");
  assert.equal(third.accepted, true);
});

test("296. Test task state persistence", async () => {
  const tracker = new TaskTracker({ taskId: "task_persist", clock: makeClock(0, 5) });
  tracker.markCreated();
  tracker.markStarted();
  tracker.setCurrentNode("n4");
  tracker.completeNode("n1");
  tracker.recordRetry("n3");
  const restored = TaskTracker.fromJSON(tracker.toJSON(), { clock: makeClock(0, 5) });

  assert.equal(restored.taskId, "task_persist");
  assert.deepEqual(restored.completed, ["n1"]);
  assert.equal(restored.currentNodeId, "n4");
  assert.equal(restored.retriesFor("n3"), 1);
  // Everything but the live duration (which keeps ticking while unfinished).
  const strip = (json) => ({ ...json, durationMs: null });
  assert.deepEqual(strip(restored.toJSON()), strip(tracker.toJSON()));

  const history = new TaskHistory({ limit: 5 });
  history.add({ taskId: "a", status: "succeeded" });
  const serialized = history.export();
  const reloaded = new TaskHistory({ limit: 5 });
  assert.equal(reloaded.load(serialized), 1);
  assert.equal(reloaded.get("a").status, "succeeded");
});

test("297. Test task event ordering", async () => {
  const engine = makeEngine();
  const result = await engine.run(SEARCH_COMMAND);
  assert.equal(result.success, true);

  const events = engine.events.getEvents();
  // Sequence numbers are dense and increasing — no gaps, no reordering.
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));

  const order = events.map((e) => e.event);
  const indexOf = (name) => order.indexOf(name);
  assert.ok(indexOf("task_submitted") < indexOf("task_parsed"));
  assert.ok(indexOf("task_parsed") < indexOf("task_graph_built"));
  assert.ok(indexOf("task_graph_built") < indexOf("task_started"));
  assert.ok(indexOf("task_started") < indexOf("step_start"));
  assert.ok(indexOf("verify") < indexOf("task_success"));
  // The outcome event is emitted before the downstream notifications.
  assert.ok(indexOf("task_success") < indexOf("notify_voice"));
  assert.ok(indexOf("notify_voice") < indexOf("notify_ui"));
  const lastOutcome = events.filter((e) => e.name !== "notification").at(-1);
  assert.equal(lastOutcome.event, "task_success");

  // Every step in the plan produced a start and a done event.
  const starts = events.filter((e) => e.event === "step_start" && e.data.step !== "task").length;
  const dones = events.filter((e) => e.event === "step_done" && e.data.step !== "task").length;
  assert.equal(starts, 8);
  assert.equal(dones, 8);
});

test("298. Test task cleanup", async () => {
  const engine = makeEngine();
  await engine.run(SEARCH_COMMAND);
  await engine.run("Open Notepad");
  assert.equal(engine.history.size, 2);

  const cleanup = engine.cleanup({ keep: 1 });
  assert.equal(cleanup.historyRemoved, 1); // 283
  assert.equal(engine.history.size, 1);
  assert.equal(engine.getState().activeTaskId, null);
});

test("299. Verify deterministic orchestration", async () => {
  const runOnce = async () => {
    const engine = makeEngine();
    const result = await engine.run(SEARCH_COMMAND);
    return { events: engine.events.getEvents().map((e) => `${e.seq}|${e.name}|${e.event}|${JSON.stringify(e.data)}`), result };
  };

  const first = await runOnce();
  const second = await runOnce();

  // Same command, same injected clock/ids -> the same event stream, byte for byte.
  assert.deepEqual(first.events, second.events);
  assert.equal(first.result.status, second.result.status);
  assert.equal(first.result.success, second.result.success);
  assert.equal(first.result.spoken, second.result.spoken);
  assert.deepEqual(first.result.completedNodes, second.result.completedNodes);
  assert.equal(JSON.stringify(first.result.audit.events), JSON.stringify(second.result.audit.events));
});

test("300. Verify complete task pipeline", async () => {
  const toolBox = makeToolBox();
  const perception = makePerception();
  const logger = { log: () => {} };
  const voice = [];
  const ui = [];
  const engine = new TaskEngine({
    perception,
    toolBox,
    logger,
    config: makeConfig(),
    clock: makeClock(),
    idFactory: () => "task_full",
    sinks: { voice: (r) => voice.push(r), ui: (r) => ui.push(r) },
  });

  const submitted = engine.submit({ text: SEARCH_COMMAND, source: "voice", sessionId: "sess_full" });
  const result = await engine.execute();

  // Every stage of the pipeline contributed to the outcome.
  assert.equal(submitted.accepted, true);
  assert.equal(submitted.spec.application, "WhatsApp");
  assert.equal(submitted.spec.targetEntity, "Dad");
  assert.equal(submitted.validation.valid, true);
  assert.equal(result.taskId, "task_full");
  assert.equal(result.status, "succeeded");
  assert.equal(result.success, true);
  assert.equal(result.spoken, "Done.");
  assert.equal(result.ui.state, "success");
  assert.ok(result.audit.eventCount > 10);
  assert.equal(engine.history.get("task_full").success, true);
  assert.equal(voice.length, 1);
  assert.equal(ui.length, 1);
  assert.equal(engine.getState().activeTaskId, null);

  // Nothing was skipped: the tracker shows every node finished and none failed.
  const executed = toolBox.calls.length;
  assert.equal(executed, 8);
  assert.equal(result.failedNodes.length, 0);
  assert.equal(perception.state.verifications.filter((t) => t === "type").length, 1);

  // The engine stored its own graph/state snapshot for the UI.
  assert.ok(engine.getState().graph === null); // released after cleanup of the slot
  assert.equal(result.audit.completedNodes.length >= 8, true);
});
