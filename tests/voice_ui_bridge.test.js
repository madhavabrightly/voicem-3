import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceUiBridge, UI_STATES, stepToLabel } from "../voice/ui_bridge.js";
import { getLogger } from "../backend/core/logger.js";

/**
 * Floating-UI bridge tests — no window, no microphone, no network.
 *
 * Proves the presentation layer obeys the architecture rules:
 *   - partial transcripts NEVER execute the agent
 *   - a final turn executes the real orchestrator exactly once
 *   - real agent steps drive the working state
 *   - amplitude is forwarded (and smoothed) to the UI
 */
const silent = { log() {}, error() {} };
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

class FakeUi {
  constructor() {
    this.sent = [];
    this.handlers = [];
  }

  send(message) {
    this.sent.push(message);
  }

  onMessage(handler) {
    this.handlers.push(handler);
    return this;
  }

  emit(message) {
    for (const handler of this.handlers) handler(message);
  }

  close() {}

  states() {
    return this.sent.filter((m) => m.type === "state").map((m) => m.state);
  }

  lastState() {
    return this.states().at(-1);
  }
}

function makeFakeVoice() {
  const handlers = { audio: [], partial: [], error: [], transcript: null };
  return {
    handlers,
    onAudio(cb) { handlers.audio.push(cb); },
    onPartial(cb) { handlers.partial.push(cb); },
    onError(cb) { handlers.error.push(cb); },
    onTranscript(cb) { handlers.transcript = cb; },
    started: 0,
    stopped: 0,
    async start() { this.started++; },
    async stop() { this.stopped++; },
  };
}

function makeOrchestrator({ success = true } = {}) {
  const calls = [];
  return {
    calls,
    async run(goal) {
      calls.push(goal);
      getLogger().log("decision", "step_start", { type: "open_app", target: "WhatsApp" });
      getLogger().log("verification", "task_done", {});
      return { final: { success }, spoken: success ? "Done." : "Sorry." };
    },
  };
}

test("stepToLabel maps planner steps to human progress", () => {
  assert.equal(stepToLabel({ type: "open_app", target: "WhatsApp" }), "Opening WhatsApp...");
  assert.equal(stepToLabel({ type: "find_element", target: "search_box" }), "Finding search_box...");
  assert.equal(stepToLabel({ type: "type", args: { text: "Dad" } }), 'Typing "Dad"...');
  assert.equal(stepToLabel({ type: "read_screen" }), "Reading screen...");
  assert.equal(stepToLabel({ type: "verify" }), "Verifying...");
});

test("ui: partials never execute the agent; the final turn does, exactly once", async () => {
  const ui = new FakeUi();
  const voice = makeFakeVoice();
  const orchestrator = makeOrchestrator();
  const bridge = new VoiceUiBridge({ orchestrator, voice, ui, logger: silent, successHoldMs: 5 });
  bridge.start();

  await bridge.activate();
  assert.equal(voice.started, 1);

  for (const partial of ["Open WhatsApp", "Open WhatsApp and search"]) {
    for (const cb of voice.handlers.partial) cb(partial);
  }
  await settle();
  assert.equal(orchestrator.calls.length, 0, "partials must not run the agent");

  await voice.handlers.transcript("Open WhatsApp and search for Dad");
  assert.deepEqual(orchestrator.calls, ["Open WhatsApp and search for Dad"]);

  const states = ui.states();
  assert.ok(states.includes(UI_STATES.LISTENING), `expected listening, got ${states}`);
  assert.ok(states.includes(UI_STATES.PROCESSING), `expected processing, got ${states}`);
  assert.ok(states.includes(UI_STATES.WORKING), `expected working, got ${states}`);
  assert.equal(ui.lastState(), UI_STATES.SUCCESS);

  const working = ui.sent.find((m) => m.type === "state" && m.state === UI_STATES.WORKING);
  assert.equal(working.label, "Opening WhatsApp...");

  const finals = ui.sent.filter((m) => m.type === "transcript" && m.final);
  assert.deepEqual(finals.map((m) => m.text), ["Open WhatsApp and search for Dad"]);

  await bridge.stop();
});

test("ui: amplitude is forwarded and smoothed toward the target", async () => {
  const ui = new FakeUi();
  const voice = makeFakeVoice();
  const bridge = new VoiceUiBridge({
    orchestrator: makeOrchestrator(),
    voice,
    ui,
    logger: silent,
    amplitudeGain: 2,
    smoothing: 0.5,
    throttleMs: 0,
  });
  bridge.start();
  await bridge.activate();

  for (const [i, level] of [0.1, 0.4, 0.9].entries()) {
    for (const cb of voice.handlers.audio) cb(level);
    void i;
  }
  const amps = ui.sent.filter((m) => m.type === "amplitude").map((m) => m.value);
  assert.ok(amps.length >= 3, `expected amplitude frames, got ${amps.length}`);
  assert.ok(amps.at(-1) > amps[0], "level should rise toward the louder input");
  assert.ok(amps.every((v) => v >= 0 && v <= 1), "levels stay normalised");

  await bridge.stop();
});

test("ui: failure is reported (never a fake success) and retry re-runs the command", async () => {
  const ui = new FakeUi();
  const voice = makeFakeVoice();
  const orchestrator = makeOrchestrator({ success: false });
  const bridge = new VoiceUiBridge({ orchestrator, voice, ui, logger: silent });
  bridge.start();
  await bridge.activate();

  await voice.handlers.transcript("Open WhatsApp and search for Dad");
  assert.equal(ui.lastState(), UI_STATES.FAILURE);
  assert.equal(ui.sent.filter((m) => m.type === "state").at(-1).label, "Couldn't verify");

  await bridge.retry();
  assert.equal(orchestrator.calls.length, 2);

  await bridge.stop();
});

test("ui: cancel stops the voice and returns to idle", async () => {
  const ui = new FakeUi();
  const voice = makeFakeVoice();
  const bridge = new VoiceUiBridge({ orchestrator: makeOrchestrator(), voice, ui, logger: silent });
  bridge.start();
  await bridge.activate();
  await bridge.cancel();
  assert.equal(voice.stopped, 1);
  assert.equal(ui.lastState(), UI_STATES.IDLE);
  await bridge.stop();
});

test("ui: activating without a microphone reports the failure and does not crash", async () => {
  const ui = new FakeUi();
  const voice = makeFakeVoice();
  voice.start = async () => { throw new Error("Microphone unavailable"); };
  const bridge = new VoiceUiBridge({ orchestrator: makeOrchestrator(), voice, ui, logger: silent });
  bridge.start();
  await bridge.activate();
  assert.equal(ui.lastState(), UI_STATES.FAILURE);
  assert.equal(ui.sent.filter((m) => m.type === "state").at(-1).label, "Microphone unavailable");
  await bridge.stop();
});
