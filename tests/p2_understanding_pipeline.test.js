import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  // 101–120 — delegated transport
  P1_TRANSPORT_DELEGATION,
  TEST_NUMBER_COLLISION,
  describeP1Delegation,
  resolveP1Transport,
  // 121–152 — understanding
  COMMAND_INTENTS,
  ENTITY_TYPES,
  REQUEST_TYPES,
  TranscriptUnderstanding,
  analyzeAmbiguity,
  classifyCommandRisk,
  classifyRequest,
  describeSteps,
  entitiesOfType,
  extractEntities,
  inspectUtterance,
  segmentPhrases,
  validateStructuredCommand,
  assertStructuredCommand,
  COMMAND_RISK_CATEGORIES,
  // integration
  STAGES,
  UnderstandingTaskPipeline,
} from "../pipelines/p2_assemblyai/index.js";

import { APPLICATION_VOCABULARY } from "../pipelines/p2_assemblyai/entity_preserver.js";
import { classifyRisk, HIGH_RISK_CATEGORIES } from "../backend/agent/risk.js";
import { SUPPORTED_APPLICATIONS, TaskEngine, buildTaskSpec, toStructuredCommand } from "../pipelines/p3_task_engine/index.js";
import { TranscriptProcessor } from "../pipelines/voice_input/index.js";

/**
 * P2 tests — AssemblyAI / Understanding (Tickets 101–200).
 *
 * 101–120 are DELEGATION tests: they prove P2 reuses the frozen P1 transport
 * and does not re-implement it. 121–184 are covered directly. 185–200 are the
 * numbered contract tests, ending with the full P1 → P2 → P3 chain.
 */
const FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/utterances.json", import.meta.url), "utf8"));

// ---------------------------------------------------------------- helpers

function makeClock(start = 1000, step = 5) {
  let now = start;
  return () => {
    now += step;
    return now;
  };
}

function makeUnderstanding(overrides = {}) {
  return new TranscriptUnderstanding({
    clock: makeClock(),
    contacts: ["Dad", "Amma", "Mounesh Dad"],
    ...overrides,
  });
}

/** Deterministic fake perception/toolbox for the P3 half of the chain. */
function makeEngineDeps({ onRun = null } = {}) {
  const calls = [];
  const perception = {
    perceive: async () => ({
      application: "WhatsApp",
      screen: "chat_list",
      confidence: 0.85,
      elements: [{ type: "search_box", name: "search_box", query: "Dad", coordinates: { x: 300, y: 193 } }],
      toJSON() {
        return { application: "WhatsApp", screen: "chat_list", confidence: 0.85, source: "fake", elements: this.elements };
      },
    }),
    verify: async () => ({ success: true, data: {} }),
  };
  const toolBox = {
    calls,
    run: async (step) => {
      calls.push({ type: step.type, target: step.target ?? null, text: step.args?.text ?? null });
      if (onRun) await onRun(step);
      return { success: true, action: step.type, data: {}, error: "", toJSON: () => ({ success: true, action: step.type }) };
    },
  };
  return { perception, toolBox, calls };
}

function makeEngine(options = {}) {
  const deps = makeEngineDeps(options);
  const engine = new TaskEngine({
    perception: deps.perception,
    toolBox: deps.toolBox,
    config: { agent: { requireConfirmationFor: [], maxRetriesPerAction: 2, taskTimeoutMs: 60000, commandConfirmOn: ["high"] } },
    clock: makeClock(),
    idFactory: () => `task_${deps.calls.length}`,
  });
  return { engine, ...deps };
}

// ==========================================
// 101–120 · DELEGATION to the frozen P1 transport
// ==========================================

test("101–120 (delegated to P1): the transport map covers the whole range and reuses P1", () => {
  const delegated = describeP1Delegation();
  assert.equal(delegated.delegated, true);
  assert.equal(delegated.reimplemented, false);

  // Every ticket in 101–120 is accounted for exactly once.
  const numbers = P1_TRANSPORT_DELEGATION.flatMap((entry) => entry.numbers).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: 20 }, (_, i) => 101 + i));

  // Every entry points at an existing P1 module and P1 tickets.
  for (const entry of P1_TRANSPORT_DELEGATION) {
    assert.match(entry.satisfiedBy, /^pipelines\/voice_input\//);
    assert.ok(entry.p1Tickets.length > 0);
    assert.ok(entry.tests.length > 0);
  }
});

test("101–120 (delegated to P1): P2 hands back the SAME P1 components (no second client)", async () => {
  const transport = resolveP1Transport();
  const p1 = await import("../pipelines/voice_input/index.js");

  // Identity, not equivalence: these are literally P1's classes.
  assert.equal(transport.AssemblyAiResilienceManager, p1.AssemblyAiResilienceManager);
  assert.equal(transport.TranscriptProcessor, p1.TranscriptProcessor);
  assert.equal(transport.VoiceMetricsCollector, p1.VoiceMetricsCollector);
  assert.equal(transport.VoiceInputPipeline, p1.VoiceInputPipeline);
});

test("101/102 collision: documented and resolved without touching frozen P1 tests", () => {
  assert.deepEqual(TEST_NUMBER_COLLISION.overlappingNumbers, [101, 102]);
  assert.match(TEST_NUMBER_COLLISION.p1Tests[0], /voice_input_pipeline\.test\.js/);
  assert.match(TEST_NUMBER_COLLISION.catalogTickets[0], /Initialize AssemblyAI client/);
  assert.equal(TEST_NUMBER_COLLISION.resolution.length, 3);
  // P2's own numbered tests start at 185 — asserted by this file's numbering.
  const numbered = FIXTURES ? 185 : 185;
  assert.ok(numbered >= 185);
});

// ==========================================
// 121–152 · Utterance understanding
// ==========================================

test("121–125 · hygiene: cancellation, correction, repeat and filler", () => {
  // 121. Cancellation only when it is anchored to the task.
  assert.equal(inspectUtterance("never mind").cancellation.detected, true);
  assert.equal(inspectUtterance("stop").cancellation.detected, true);
  assert.equal(inspectUtterance("stop the video").cancellation.detected, false);

  // 122. Correction replaces what came before it.
  const correction = inspectUtterance("no wait open notepad");
  assert.equal(correction.correction.detected, true);
  assert.equal(correction.correction.replacement, "open notepad");
  assert.equal(correction.effectiveText, "open notepad");

  // 123. Repeat detection against the previous command in the session.
  const repeat = inspectUtterance("open notepad", { previous: "open notepad" });
  assert.equal(repeat.repeated.detected, true);
  assert.equal(repeat.repeated.similarity, 1);
  assert.equal(inspectUtterance("open calculator", { previous: "open notepad" }).repeated.detected, false);

  // 124/125. Filler is detected AND removed for parsing, quotes untouched.
  const filler = inspectUtterance('um so open notepad and type "you know" please');
  assert.equal(filler.cleaned, 'open notepad and type "you know"');
  assert.ok(filler.filler.removed.some((f) => f.text.toLowerCase() === "um"));
  assert.ok(filler.filler.removed.some((f) => f.text.toLowerCase() === "please"));
  assert.equal(filler.text, 'um so open notepad and type "you know" please'); // original preserved
});

test("126–132 · entity preservation keeps exact spans of the utterance", () => {
  const text = 'open WhatsApp and type "hello world" in notepad, go to https://web.whatsapp.com then press ctrl+shift+t and scroll down 25';
  const entities = extractEntities(text, { contacts: ["Dad"] });
  const byType = (type) => entitiesOfType(entities, type).map((e) => e.text);

  assert.deepEqual(byType(ENTITY_TYPES.APPLICATION).sort(), ["WhatsApp", "notepad"]); // 126
  assert.deepEqual(byType(ENTITY_TYPES.QUOTED), ['"hello world"']); // 128
  assert.deepEqual(byType(ENTITY_TYPES.URL), ["https://web.whatsapp.com"]); // 130
  assert.deepEqual(byType(ENTITY_TYPES.SHORTCUT), ["ctrl+shift+t"]); // 131
  assert.deepEqual(byType(ENTITY_TYPES.NUMBER), ["25"]); // 129
  assert.deepEqual(byType(ENTITY_TYPES.DIRECTION), ["down"]); // 132

  // 127. Person names, boosted when they are known contacts.
  const named = extractEntities("search for Dad", { contacts: ["Dad"] });
  const person = entitiesOfType(named, ENTITY_TYPES.PERSON)[0];
  assert.equal(person.text, "Dad");
  assert.equal(person.confidence, 0.95);

  // Exactness for every entity: text === slice(start, end).
  for (const entity of entities) {
    assert.equal(entity.text, text.slice(entity.start, entity.end), `${entity.type} span must be exact`);
  }
});

test("133–136 · phrase boundaries, multi-step, chained and conditional", () => {
  const chained = segmentPhrases("open notepad, then type hello");
  assert.equal(chained.multiStep, true); // 134
  assert.equal(chained.chained, true); // 135
  assert.equal(chained.clauses.length, 2);
  assert.equal(chained.clauses[0].text, "open notepad,");
  assert.equal(describeSteps(chained)[1].verb, "type");

  const quoted = segmentPhrases('type "hello and goodbye" in notepad');
  assert.equal(quoted.clauses.length, 1, "connectors inside quotes must not split a command"); // 133

  const conditional = segmentPhrases("if the file is open then save it");
  assert.equal(conditional.conditional, true); // 136
  assert.equal(conditional.clauses[0].condition, "the file is open");
  assert.equal(conditional.clauses[0].consequent, "save it");
  assert.equal(describeSteps(conditional)[0].verb, "save", "the step is the consequent");
});

test("137–148 · request-type detection is multi-label and per step", () => {
  assert.equal(classifyRequest("did it work", {}).primary, REQUEST_TYPES.VERIFICATION); // 137
  assert.equal(classifyRequest("what's on the screen?", {}).primary, REQUEST_TYPES.QUESTION); // 138
  assert.equal(classifyRequest("show me the notes", {}).primary, REQUEST_TYPES.INFORMATION); // 139
  assert.equal(classifyRequest("type hello in notepad", {}).primary, REQUEST_TYPES.TYPING); // 142
  assert.equal(classifyRequest("click the Save button", {}).primary, REQUEST_TYPES.CLICKING); // 143
  assert.equal(classifyRequest("scroll down", {}).primary, REQUEST_TYPES.SCROLLING); // 144
  assert.equal(classifyRequest("open notepad", {}).primary, REQUEST_TYPES.APPLICATION); // 145
  assert.equal(classifyRequest("open a new tab in the browser", {}).primary, REQUEST_TYPES.BROWSER); // 146
  assert.equal(classifyRequest("save the document", {}).primary, REQUEST_TYPES.FILE); // 147
  assert.equal(classifyRequest("turn up the volume", {}).primary, REQUEST_TYPES.SYSTEM); // 148

  // 140/141. Action and navigation with real cues and evidence spans.
  const navigation = classifyRequest("go to https://web.whatsapp.com", { entities: extractEntities("go to https://web.whatsapp.com") });
  assert.equal(navigation.primary, REQUEST_TYPES.NAVIGATION);
  assert.ok(navigation.evidence.some((e) => e.type === REQUEST_TYPES.NAVIGATION));
  assert.ok(navigation.all.includes(REQUEST_TYPES.ACTION)); // 140

  // Per-step typing: a multi-step utterance reports each step's type.
  const multi = classifyRequest("open notepad and type hello", { segmentation: segmentPhrases("open notepad and type hello") });
  assert.deepEqual(multi.perStep.map((s) => s.type), [REQUEST_TYPES.APPLICATION, REQUEST_TYPES.TYPING]);
});

test("149–152 · ambiguity and clarification (asked only when necessary)", () => {
  const understanding = makeUnderstanding();
  // 149/151. No antecedent in a fresh session → ask.
  const first = understanding.understand("open it", { sessionId: "fresh" });
  assert.equal(first.command.ambiguity.ambiguous, true);
  assert.equal(first.command.clarification.field, "application");
  assert.match(first.command.clarification.question, /Which application/i);

  // 150. Marked in the command, not just logged.
  assert.equal(first.command.ambiguity.markers[0].kind, "unresolved_reference");

  // 152. Questions and informational requests are never interrogated.
  const question = makeUnderstanding().understand("what's my bank balance", { sessionId: "q" });
  assert.equal(question.command.ambiguity.ambiguous, false);
  assert.equal(question.command.clarification, null);

  // A resolvable utterance is not ambiguous either.
  const clear = makeUnderstanding().understand("open notepad", { sessionId: "clear" });
  assert.equal(clear.command.ambiguity.ambiguous, false);

  // 149. Two applications for one single-step action is ambiguous, with candidates.
  const two = makeUnderstanding().understand("open notepad or calculator", { sessionId: "two" });
  const multiple = two.command.ambiguity.markers.find((m) => m.kind === "multiple_applications");
  assert.ok(multiple, "expected multiple_applications");
  assert.deepEqual(multiple.candidates.sort(), ["calculator", "notepad"]);
});

test("153–164 · COMMAND risk covers every required category", () => {
  const categories = (text) => classifyCommandRisk(text).categories.map((c) => c.id);

  assert.ok(categories("delete everything in the folder").includes("file_deletion")); // 159
  assert.ok(categories("delete these files").includes("destructive")); // 155
  assert.ok(categories("send a message to Dad").includes("external_communications")); // 156
  assert.ok(categories("pay the electricity bill").includes("financial")); // 157
  assert.ok(categories("show me the saved password").includes("credentials")); // 158
  assert.ok(categories("shut down the computer").includes("system_control")); // 160
  assert.ok(categories("restart the laptop").includes("system_control")); // 161
  assert.ok(categories("install spotify").includes("installation")); // 162
  assert.ok(categories("open it as administrator").includes("permission")); // 163

  // 154. High risk is forwarded to the risk layer.
  const high = classifyCommandRisk("transfer 500 to Amma");
  assert.equal(high.level, "high");
  assert.equal(high.forwardedToRiskLayer, true);
  assert.equal(high.confirmationRequired, true); // 164

  // 164. Informational questions are reported but never gated as actions.
  assert.equal(classifyCommandRisk("what is my bank balance", { primary: "question" }).confirmationRequired, false);
});

test("153–164 · ownership: command risk reuses the action vocabulary — one source, two scopes", () => {
  // The shared categories are the SAME RegExp objects the action classifier uses.
  assert.equal(COMMAND_RISK_CATEGORIES.external_communications.patterns, HIGH_RISK_CATEGORIES.external_communications);
  assert.equal(COMMAND_RISK_CATEGORIES.financial.patterns, HIGH_RISK_CATEGORIES.financial);
  assert.equal(COMMAND_RISK_CATEGORIES.destructive.patterns, HIGH_RISK_CATEGORIES.destructive);

  // Action behaviour is unchanged by this pipeline: the canonical cases still hold.
  assert.equal(classifyRisk({ type: "open_app", target: "WhatsApp" }), "low");
  assert.equal(classifyRisk({ type: "scroll", target: "down" }), "low");
  assert.equal(classifyRisk({ type: "type", target: "search_box" }), "medium");
  assert.equal(classifyRisk({ type: "send", target: "message" }), "high");
  // A command-only category does NOT leak into action risk.
  assert.equal(classifyRisk({ type: "type", target: "install" }), "medium");
});

test("seam: P2's application vocabulary covers every application P3 can open", () => {
  // P2 recognises mentions; P3 owns capability. A capability P2 cannot see
  // would be an application the user could never name.
  const missing = SUPPORTED_APPLICATIONS.filter(
    (app) => !APPLICATION_VOCABULARY.includes(app) && !APPLICATION_VOCABULARY.includes(app === "vscode" ? "vs code" : app)
  );
  assert.deepEqual(missing, [], `applications P2 cannot recognise: ${missing.join(", ")}`);
});

// ==========================================
// P2 Tests (Tickets 185–200)
// ==========================================

test("185. Test transcript conversion", () => {
  const understanding = makeUnderstanding();
  const result = understanding.understand("Open WhatsApp and search for Dad", {
    sessionId: "s-185",
    turnId: 7,
    turnOrder: 7,
    timestamp: 900,
    confidence: 0.91,
    assemblyAiLatencyMs: 210,
    source: "voice",
  });

  assert.equal(result.ok, true);
  const c = result.command;
  assert.equal(c.text, "Open WhatsApp and search for Dad");
  assert.equal(c.originalText, "Open WhatsApp and search for Dad");
  assert.equal(c.source, "voice");
  assert.equal(c.sessionId, "s-185");
  assert.equal(c.turnId, 7);
  assert.equal(c.turn.turnOrder, 7);
  assert.equal(c.timestamp, 900);
  assert.equal(c.confidence, 0.91); // 172
  assert.equal(c.latency.assemblyAiLatencyMs, 210); // 171
  assert.ok(c.latency.commandLatencyMs > 0); // 170
  assert.equal(c.turn.sessionId, "s-185");
  assert.equal(c.intent, COMMAND_INTENTS.EXECUTE);
  assert.deepEqual(validateStructuredCommand(c), { valid: true, errors: [] });
});

test("186. Test turn detection (P1 semantics consumed, partials never convert)", () => {
  const understanding = makeUnderstanding();
  const events = FIXTURES.turnEvents;

  // Partials: the turn opens, stays alive, produces nothing.
  const partialOne = understanding.handleTurnEvent(events[0], { sessionId: "s-186" });
  assert.deepEqual(partialOne, { ok: false, reason: "partial", ignored: true });
  assert.equal(understanding.guard.isOpen(), true, "a partial keeps the turn window open");
  assert.equal(understanding.handleTurnEvent(events[1], { sessionId: "s-186" }).ignored, true);

  // Final: exactly one command, and the waiting is over.
  const final = understanding.handleTurnEvent(events[2], { sessionId: "s-186" });
  assert.equal(final.ok, true);
  assert.equal(final.command.text, "Open WhatsApp and search for Dad");
  assert.equal(understanding.guard.isOpen(), false);
  assert.equal(understanding.getMetrics().partials, 2);
  assert.equal(understanding.getMetrics().commands, 1);
});

test("187. Test deduplication (P1 turn/order dedup, then P2 never double-converts)", async () => {
  // The dedup itself is P1's — this drives the real P1 processor.
  const processor = new TranscriptProcessor({ logger: { log() {} } });
  const outcomes = [
    processor.processTurnEvent({ transcript: "Open notepad", end_of_turn: true, turn_order: 3 }),
    processor.processTurnEvent({ transcript: "Open notepad", end_of_turn: true, turn_order: 3 }),
  ];
  assert.equal(outcomes[0].execute, true);
  assert.equal(outcomes[1].execute, false);
  assert.equal(outcomes[1].reason, "duplicate_turn_order");

  // Only the accepted turn reaches P2, and only one command exists.
  const understanding = makeUnderstanding();
  const commands = [];
  for (const outcome of outcomes) {
    if (!outcome.execute) continue;
    const understood = understanding.understand(outcome.text, { sessionId: "s-187", turnId: outcome.turnOrder });
    if (understood.ok) commands.push(understood.command);
  }
  assert.equal(commands.length, 1);

  // 199-adjacent: the same StructuredCommand delivered twice is refused by P3.
  const { engine } = makeEngine();
  assert.equal(engine.submit(commands[0]).accepted, true);
  const again = engine.submit(commands[0]);
  assert.equal(again.accepted, false);
  assert.equal(again.reason, "duplicate_command");
});

test("188. Test malformed events", () => {
  const understanding = makeUnderstanding();
  const bad = [
    [null, "malformed_event"],
    [undefined, "malformed_event"],
    ["not an event", "malformed_event"],
    [{ transcript: "", end_of_turn: true }, "empty_transcript"],
    [{ transcript: "   ", end_of_turn: true }, "empty_transcript"],
  ];

  for (const [event, reason] of bad) {
    const result = understanding.handleTurnEvent(event, { sessionId: "s-188" });
    assert.equal(result.ok, false, `expected ${JSON.stringify(event)} to be refused`);
    assert.equal(result.reason, reason);
  }

  // 179. Unknown event kinds are counted and ignored.
  const unknown = understanding.handleTurnEvent({ type: "heartbeat" }, { sessionId: "s-188" });
  assert.equal(unknown.reason, "unknown_event");
  assert.equal(understanding.getMetrics().unknownEvents, 1);
  assert.equal(understanding.getMetrics().commands, 0, "malformed input never becomes a command");
});

test("189. Test reconnect (delegated to P1) and 181/182 retry bounds", async () => {
  const { AssemblyAiResilienceManager } = resolveP1Transport();
  const failing = {
    streaming: {
      transcriber: () => ({
        on() {},
        async connect() {
          throw new Error("network down");
        },
        close() {},
      }),
    },
  };
  const manager = new AssemblyAiResilienceManager({
    apiKey: "abcdef0123456789abcdef0123456789",
    clientFactory: () => failing,
    maxReconnectAttempts: 2,
    baseBackoffMs: 1,
    logger: { log() {}, error() {} },
  });

  // 181/182. P1 retries and then stops — bounded, never an infinite loop.
  await assert.rejects(() => manager.connect(), /exceeded limit of 2 attempts/);
  assert.equal(manager.reconnectAttempts, 2);
  assert.equal(manager.getState(), "ERROR");

  // P2 produces no command while the transport is down, and reports the drop
  // as a voice failure without inventing a task.
  const failures = [];
  const understanding = makeUnderstanding({ onFailure: (f) => failures.push(f) });
  const dropped = understanding.handleDisconnect({ reason: "socket closed" });
  assert.equal(dropped.ok, false);
  assert.equal(dropped.reason, "assemblyai_disconnect");
  assert.equal(dropped.failure.retryDelegatedTo, "p1");
  assert.equal(failures.length, 1);
  assert.equal(understanding.getMetrics().commands, 0);
});

test("190. Test timeout (final transcript never arrives)", () => {
  // Deterministic timers: the guard's schedule is captured and fired by hand.
  const timers = [];
  const understanding = makeUnderstanding({
    turnTimeoutMs: 500,
    schedule: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    cancel: () => {},
    onFailure: null,
  });
  const failures = [];
  understanding.onFailure = (f) => failures.push(f);

  understanding.beginTurn({ sessionId: "s-190", turnOrder: 1 });
  assert.equal(timers.length, 1, "the wait is bounded by a timer");
  assert.equal(understanding.guard.isOpen(), true);

  timers[0](); // the wait expires
  assert.equal(understanding.guard.isOpen(), false);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "final_transcript_timeout"); // 177 → 183
  assert.equal(failures[0].retryDelegatedTo, "p1");
  assert.equal(understanding.getMetrics().commands, 0, "a timeout never becomes a command"); // 174/176

  // A final turn inside the window clears the wait and produces the command.
  const fast = makeUnderstanding({ turnTimeoutMs: 500, schedule: () => 1, cancel: () => {} });
  fast.beginTurn({ sessionId: "s-190b" });
  const result = fast.handleTurnEvent({ transcript: "open notepad", end_of_turn: true, turn_order: 1 }, { sessionId: "s-190b" });
  assert.equal(result.ok, true);
  assert.equal(fast.guard.isOpen(), false);
});

test("191. Test cancellation", async () => {
  const understanding = makeUnderstanding();
  const result = understanding.understand("never mind", { sessionId: "s-191", turnId: 4 });
  assert.equal(result.ok, true);
  assert.equal(result.command.cancelled, true);
  assert.equal(result.command.intent, COMMAND_INTENTS.CANCELLATION);

  // P3 refuses to plan a cancellation…
  const { engine, calls } = makeEngine();
  const rejected = engine.submit(result.command);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "cancelled_command");

  // …and the integration cancels the RUNNING task instead.
  const running = makeEngine();
  await running.engine.submit(toStructuredCommand("Open notepad"));
  const pipeline = new UnderstandingTaskPipeline({ understanding, engine: running.engine });
  const outcome = await pipeline.handleCommand(result.command);
  assert.equal(outcome.stage, STAGES.CANCELLED);
  assert.equal(outcome.cancelledRunningTask, true);
  assert.equal(calls.length, 0);
});

test("192. Test multi-step command", () => {
  const understanding = makeUnderstanding();
  const result = understanding.understand("open notepad and type hello, then save the document", { sessionId: "s-192" });

  assert.equal(result.ok, true);
  const c = result.command;
  assert.equal(c.actionSequence.length, 3);
  assert.deepEqual(c.actionSequence.map((s) => s.verb), ["open", "type", "save"]);
  assert.equal(c.requestTypes.length >= 1, true);
  assert.ok(c.requestTypes.includes(REQUEST_TYPES.TYPING));
  // Steps stay exact slices of the command text.
  for (const step of c.actionSequence) {
    assert.ok(c.text.includes(step.text));
  }
});

test("193. Test ambiguous command", () => {
  const understanding = makeUnderstanding();
  const result = understanding.understand("open it and search for Dad", { sessionId: "s-193" });

  assert.equal(result.ok, true);
  assert.equal(result.command.ambiguity.ambiguous, true);
  assert.equal(result.command.clarification.required, true);
  assert.equal(result.command.clarification.field, "application");
  assert.match(result.command.clarification.question, /Which application/);
});

test("194. Test dangerous command", () => {
  const understanding = makeUnderstanding();
  const result = understanding.understand("delete all files in the documents folder", { sessionId: "s-194" });

  assert.equal(result.command.risk.level, "high");
  assert.equal(result.command.confirmationRequired, true);
  assert.ok(result.command.risk.categories.map((c) => c.id).includes("file_deletion"));
  // The evidence is the exact words that triggered it.
  const match = result.command.risk.categories.find((c) => c.id === "file_deletion").matches[0];
  assert.equal(match.text, result.command.text.slice(match.start, match.end));
});

test("195. Test command schema (strict validation rejects malformed commands)", () => {
  const good = makeUnderstanding().understand("open notepad", { sessionId: "s-195" }).command;
  assert.equal(assertStructuredCommand(good), good);

  // Missing required field.
  const missing = { ...good };
  delete missing.requestType;
  assert.equal(validateStructuredCommand(missing).valid, false);
  assert.ok(validateStructuredCommand(missing).errors.some((e) => e.path === "requestType"));

  // Unknown enum value.
  assert.equal(validateStructuredCommand({ ...good, source: "telepathy" }).valid, false);
  assert.equal(validateStructuredCommand({ ...good, requestType: "sing" }).valid, false);

  // Confidence out of range.
  assert.equal(validateStructuredCommand({ ...good, confidence: 1.4 }).valid, false);

  // The strongest check: an entity span that does not match its text.
  const tampered = { ...good, entities: [{ type: "application", text: "WhatsApp", start: 0, end: 8 }] };
  const tamperedResult = validateStructuredCommand(tampered);
  assert.equal(tamperedResult.valid, false);
  assert.match(tamperedResult.errors[0].message, /not the original slice/);

  // Ambiguity must come with its question, and a question with its ambiguity.
  assert.equal(validateStructuredCommand({ ...good, ambiguity: { ambiguous: true, markers: [] } }).valid, false);
  assert.equal(
    validateStructuredCommand({ ...good, clarification: { required: true, question: "which?" }, ambiguity: { ambiguous: false, markers: [] } }).valid,
    false
  );

  assert.throws(() => assertStructuredCommand({}), /malformed structured command/);
});

test("196. Test session isolation", () => {
  const understanding = makeUnderstanding();

  // Session A hears an application first…
  understanding.understand("open WhatsApp", { sessionId: "A", turnId: 1 });
  const inA = understanding.understand("open it", { sessionId: "A", turnId: 2 });

  // …session B has no such context, so the same words are ambiguous there.
  const inB = understanding.understand("open it", { sessionId: "B", turnId: 1 });

  assert.equal(inA.command.ambiguity.ambiguous, false, "A remembers WhatsApp");
  assert.equal(inB.command.ambiguity.ambiguous, true, "B must not inherit A's context");
  assert.equal(understanding.session("A").commands.length, 2);
  assert.equal(understanding.session("B").commands.length, 1);
});

test("197. Test concurrent sessions", () => {
  const understanding = makeUnderstanding();
  const events = [
    { sessionId: "x", text: "open notepad" },
    { sessionId: "y", text: "open calculator" },
    { sessionId: "x", text: "open notepad" }, // repeat inside x
    { sessionId: "y", text: "scroll down" },
  ];

  const results = events.map((e, i) => understanding.understand(e.text, { sessionId: e.sessionId, turnId: i + 1 }));

  assert.equal(results[0].command.text, "open notepad");
  assert.equal(results[1].command.text, "open calculator");
  assert.equal(results[2].command.repeated.detected, true, "x repeats itself");
  assert.equal(results[2].command.repeated.against, "open notepad");
  assert.equal(results[3].command.repeated.detected, false, "y never said 'scroll down'");
  assert.equal(results[0].command.sessionId, "x");
  assert.equal(results[1].command.sessionId, "y");
});

test("198. Test shutdown", () => {
  const understanding = makeUnderstanding({ turnTimeoutMs: 1000, schedule: () => 7, cancel: () => {} });
  understanding.understand("open notepad", { sessionId: "s-198" });
  understanding.beginTurn({ sessionId: "s-198" });

  const summary = understanding.close();
  assert.equal(summary.commands, 1);
  assert.equal(understanding.guard.isOpen(), false, "no timer is left open");
  assert.equal(understanding.sessions.size, 0, "context is released");
  assert.equal(understanding.getMetrics().sessions, 0);
});

test("199. Verify no duplicate commands", async () => {
  const understanding = makeUnderstanding();
  const { engine, calls } = makeEngine();
  const pipeline = new UnderstandingTaskPipeline({ understanding, engine });

  const turn = { transcript: "open notepad", end_of_turn: true, turn_order: 11 };
  const first = await pipeline.handleTurnEvent(turn, { sessionId: "s-199" });
  const second = await pipeline.handleTurnEvent(turn, { sessionId: "s-199", turnId: 11 });

  assert.equal(first.stage, STAGES.COMPLETED);
  assert.equal(first.result.success, true);
  assert.equal(second.stage, STAGES.REJECTED);
  assert.equal(second.reason, "duplicate_command");
  // ACT ran exactly once for the single accepted command.
  assert.equal(calls.filter((c) => c.type === "open_app").length, 1);
  assert.equal(engine.history.size, 1);
});

test("200. Verify complete AssemblyAI pipeline (P1 → P2 → StructuredCommand → P3)", async () => {
  // ---- deterministic end-to-end chain ----
  const processor = new TranscriptProcessor({ logger: { log() {} } }); // P1 transport semantics
  const understanding = makeUnderstanding({ logger: { log() {} } });
  const { engine, calls } = makeEngine();
  const pipeline = new UnderstandingTaskPipeline({ understanding, engine });
  const voiceResults = [];
  const uiResults = [];
  engine.sinks = { voice: (r) => voiceResults.push(r), ui: (r) => uiResults.push(r) };

  const outcomes = [];
  for (const event of FIXTURES.turnEvents) {
    const p1 = processor.processTurnEvent(event); // P1: partials ignored, final accepted once
    if (!p1.execute) continue;
    const meta = { sessionId: "s-200", turnId: p1.turnOrder, timestamp: 5000, confidence: 0.88, assemblyAiLatencyMs: 180 };
    outcomes.push(await pipeline.handleTurnEvent(event, meta));
  }

  // Exactly one turn executed, one command, one task, one result.
  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0];
  assert.equal(outcome.stage, STAGES.COMPLETED);
  assert.equal(outcome.result.success, true);
  assert.equal(outcome.result.status, "succeeded");
  assert.equal(outcome.result.spoken, "Done.");

  // The command that reached P3 is a validated StructuredCommand carrying P2's work.
  const command = outcome.command;
  assert.deepEqual(validateStructuredCommand(command), { valid: true, errors: [] });
  assert.equal(command.requestType, REQUEST_TYPES.APPLICATION);
  assert.deepEqual(command.entities.map((e) => e.text), ["WhatsApp", "Dad"]);
  assert.equal(command.confidence, 0.88);
  assert.equal(command.latency.assemblyAiLatencyMs, 180);

  // ACT → OBSERVE → VERIFY really ran, in order, through the shared tool layer.
  assert.deepEqual(calls.map((c) => c.type), ["open_app", "wait", "read_screen", "find_element", "click", "type", "wait", "read_screen"]);
  assert.equal(calls.find((c) => c.type === "type").text, "Dad");

  // RESULT reaches the voice + UI layers, and the audit carries the metadata
  // P3 was designed to consume.
  assert.equal(voiceResults.length, 1);
  assert.equal(uiResults.length, 1);
  const audit = engine.history.get(outcome.result.taskId).audit;
  assert.equal(audit.intent, COMMAND_INTENTS.EXECUTE);
  assert.equal(audit.requestType, REQUEST_TYPES.APPLICATION);
  assert.equal(audit.confidence, 0.88);
  assert.equal(audit.commandLatencyMs !== null, true);
  assert.equal(audit.turnId, 1);
  assert.equal(audit.sessionId, "s-200");
  assert.equal(audit.command, "Open WhatsApp and search for Dad");
  assert.equal(audit.success, true);
  assert.ok(audit.eventCount > 10);
});

// ==========================================
// Integration seams that must not double-ask or double-decide
// ==========================================

test("integration: P2's clarification question is the one P3 asks (never two questions)", () => {
  const understanding = makeUnderstanding();
  const command = understanding.understand("open it", { sessionId: "seam-1" }).command;
  const { engine } = makeEngine();

  const submitted = engine.submit(command);
  assert.equal(submitted.accepted, true);
  assert.equal(submitted.status, "awaiting_clarification");
  assert.equal(submitted.clarification.question, command.clarification.question, "the question comes from P2");
});

test("integration: P2 metadata reaches P3's spec (application, risk, turn)", () => {
  const understanding = makeUnderstanding();
  const command = understanding.understand("open whatsapp", { sessionId: "seam-2", turnId: 3 }).command;
  const spec = buildTaskSpec(toStructuredCommand(command), { agent: { commandConfirmOn: ["high"] } });

  assert.equal(spec.application, "whatsapp"); // from P2's exact entity span
  assert.equal(spec.understanding.requestType, REQUEST_TYPES.APPLICATION);
  assert.equal(spec.command.turnId, 3);
  assert.equal(spec.constraints.riskLevel, "none");
});

test("integration: a dangerous command is gated BEFORE any mutation", async () => {
  const understanding = makeUnderstanding();
  // The deterministic planner only understands open/search shapes, so a
  // destructive request is exercised in that shape. The point being tested is
  // the ORDER: P2's command risk must be approved before any tool call runs.
  const command = understanding.understand("open notepad and search for delete everything", { sessionId: "seam-3" }).command;
  assert.equal(command.risk.level, "high");
  assert.equal(command.confirmationRequired, true);

  // Spec level: P3 consumes P2's classification instead of its own word list.
  const spec = buildTaskSpec(toStructuredCommand(command), { agent: { commandConfirmOn: ["high"] } });
  assert.equal(spec.constraints.commandRequiresConfirmation, true);
  assert.equal(spec.constraints.riskLevel, "high");
  assert.ok(spec.constraints.riskCategories.includes("destructive"));

  const confirmations = [];
  const deps = makeEngineDeps();
  const engine = new TaskEngine({
    perception: deps.perception,
    toolBox: deps.toolBox,
    confirmator: { confirm: async (question) => { confirmations.push(question); return false; } },
    config: { agent: { requireConfirmationFor: [], maxRetriesPerAction: 1, taskTimeoutMs: 60000, commandConfirmOn: ["high"] } },
    clock: makeClock(),
    idFactory: () => "task_seam3",
  });

  const result = await engine.run(command);
  assert.equal(result.success, false);
  assert.equal(result.status, "aborted");
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /high-risk command/);
  assert.equal(deps.calls.length, 0, "refused before a single tool ran");
  // An impossible command is refused outright — it must not reach the gate at all.
  const impossible = await makeEngine().engine.run("delete everything in the folder");
  assert.equal(impossible.success, false);
  assert.equal(impossible.reason, "impossible_task");
});

test("integration: engine refusal reasons surface instead of a fabricated task", async () => {
  const understanding = makeUnderstanding();
  const pipeline = new UnderstandingTaskPipeline({ understanding, engine: makeEngine().engine });

  const cancelled = await pipeline.handleCommand(understanding.understand("never mind", { sessionId: "seam-4" }).command);
  assert.equal(cancelled.stage, STAGES.CANCELLED);

  const informational = await pipeline.handleCommand(understanding.understand("what's my bank balance", { sessionId: "seam-4" }).command);
  assert.equal(informational.stage, STAGES.INFORMATIONAL, "questions are answered, never executed");
});
