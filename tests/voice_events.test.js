import { test } from "node:test";
import assert from "node:assert/strict";
import { AssemblyAITranscriber } from "../voice/assemblyai/transcriber.js";
import { VoiceInterface } from "../voice/assemblyai/index.js";
import { buildAgent } from "../backend/api/server.js";
import { ScreenModel } from "../backend/perception/screen_model.js";

/**
 * Voice layer tests — no microphone or network required.
 *
 * The critical guarantee: PARTIAL transcripts never reach the agent, and a
 * FINAL turn reaches the existing orchestrator exactly once, unchanged.
 */
const silent = { log() {}, error() {} };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Deterministic stand-in for AssemblyAITranscriber (same event surface). */
class FakeTranscriber {
  constructor() {
    this.handlers = new Map();
    this.started = false;
  }

  on(event, callback) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(callback);
    return this;
  }

  async start() {
    this.started = true;
  }

  async stop() {
    this.started = false;
  }

  emit(event, payload) {
    for (const cb of this.handlers.get(event) || []) cb(payload);
  }
}

test("voice: partials never emit final; finals emit exactly once", () => {
  const transcriber = new AssemblyAITranscriber({ apiKey: "dummy", logger: silent });
  const partials = [];
  const finals = [];
  transcriber.on("partial", (t) => partials.push(t));
  transcriber.on("final", (t) => finals.push(t));

  // Interim updates — display only.
  transcriber._handleTurn({ turn_order: 0, end_of_turn: false, transcript: "Open" });
  transcriber._handleTurn({ turn_order: 0, end_of_turn: false, transcript: "Open WhatsApp" });
  transcriber._handleTurn({ turn_order: 0, end_of_turn: false, transcript: "Open WhatsApp and search" });
  assert.equal(finals.length, 0, "partials must not produce a final");
  assert.equal(partials.length, 3);

  // Completed turn.
  transcriber._handleTurn({ turn_order: 0, end_of_turn: true, transcript: "Open WhatsApp and search for Dad" });
  assert.deepEqual(finals, ["Open WhatsApp and search for Dad"]);

  // A repeated final for the same turn order must not emit twice.
  transcriber._handleTurn({ turn_order: 0, end_of_turn: true, transcript: "Open WhatsApp and search for Dad" });
  assert.equal(finals.length, 1, "duplicate final suppressed");

  // Empty / whitespace-only finals are ignored; a new turn still emits.
  transcriber._handleTurn({ turn_order: 1, end_of_turn: true, transcript: "   " });
  assert.equal(finals.length, 1, "empty final ignored");
  transcriber._handleTurn({ turn_order: 2, end_of_turn: true, transcript: "  Search for Mom  " });
  assert.deepEqual(finals, ["Open WhatsApp and search for Dad", "Search for Mom"]);
});

test("voice: only the final turn reaches the REAL orchestrator, exactly once", async () => {
  const platform = {
    launch: async () => ({ success: true }),
    click: async () => ({ success: true }),
    typeText: async () => ({ success: true }),
    pressKey: async () => ({ success: true }),
    scroll: async () => ({ success: true }),
    capture: async () => ({ success: true }),
  };
  const { orchestrator } = buildAgent({
    platformImpl: platform,
    visionAnalyze: async () => new ScreenModel({ application: "none", screen: "desktop", confidence: 0.95, source: "vision" }),
    config: { agent: { requireConfirmationFor: [], maxRetriesPerAction: 1 } },
  });

  // Spy on the real orchestrator entry point.
  const runs = [];
  const originalRun = orchestrator.run.bind(orchestrator);
  orchestrator.run = async (goal) => {
    runs.push(goal);
    return originalRun(goal);
  };

  const fake = new FakeTranscriber();
  const voice = new VoiceInterface({
    apiKey: "dummy",
    logger: silent,
    transcriber: fake,
    onPartial: () => {},
    onTranscript: async (transcript) => {
      const result = await orchestrator.run(transcript);
      return result.spoken;
    },
  });

  await voice.start();

  fake.emit("partial", "Open WhatsApp");
  fake.emit("partial", "Open WhatsApp and search");
  fake.emit("partial", "Open WhatsApp and search for Dad");
  await settle();
  assert.equal(runs.length, 0, "partials must NOT execute the agent");

  fake.emit("final", "Open WhatsApp and search for Dad");
  await settle();
  assert.deepEqual(runs, ["Open WhatsApp and search for Dad"], "final transcript must reach the orchestrator exactly once");

  await voice.stop();
});

test("voice: onError is invoked when the transcriber errors", async () => {
  const fake = new FakeTranscriber();
  const voice = new VoiceInterface({ apiKey: "dummy", logger: silent, transcriber: fake });
  const errors = [];
  voice.onError((err) => errors.push(err));

  await voice.start();
  fake.emit("error", new Error("boom"));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "boom");
});

test("voice: stop() stops the transcriber", async () => {
  const fake = new FakeTranscriber();
  const voice = new VoiceInterface({ apiKey: "dummy", logger: silent, transcriber: fake });
  await voice.start();
  assert.equal(fake.started, true);
  await voice.stop();
  assert.equal(fake.started, false);
});

test("voice: missing API key fails cleanly before touching the network", async () => {
  const transcriber = new AssemblyAITranscriber({ apiKey: "", logger: silent });
  await assert.rejects(() => transcriber.start(), /ASSEMBLYAI_API_KEY is not configured/);
});
