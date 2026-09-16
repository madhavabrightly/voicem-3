import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  VoiceInputPipeline,
  HotkeyController,
  VoiceUiState,
  MicrophoneEngine,
  MicState,
  AudioLevelProcessor,
  VadDetector,
  AssemblyAiResilienceManager,
  ConnectionState,
  TranscriptProcessor,
  VoiceMetricsCollector,
  sanitizeLog,
} from "../pipelines/voice_input/index.js";

// --- Helpers for Test Mocks ---

function makePcm16Buffer(sampleCount = 160, amplitude = 8000) {
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    const val = Math.round(amplitude * Math.sin((i / sampleCount) * Math.PI * 2));
    buf.writeInt16LE(val, i * 2);
  }
  return buf;
}

function makeMockRecorderLib() {
  const stream = new PassThrough();
  const proc = new EventEmitter();
  proc.killed = false;
  proc.kill = (sig) => {
    proc.killed = true;
    proc.emit("exit", 0, sig);
  };
  return {
    record: () => ({
      stream: () => stream,
      process: proc,
      stop: () => {
        proc.kill();
        stream.end();
      },
    }),
    stream,
    proc,
  };
}

class MockAssemblyAiTranscriber extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.sentAudio = [];
  }

  async connect() {
    this.connected = true;
    process.nextTick(() => this.emit("open", { id: "test_assemblyai_session_1" }));
  }

  sendAudio(chunk) {
    this.sentAudio.push(chunk);
  }

  async close() {
    this.connected = false;
    this.emit("close", 1000, "clean_close");
  }
}

function makeMockAssemblyAiFactory() {
  let latestTranscriber = null;
  const factory = () => {
    latestTranscriber = new MockAssemblyAiTranscriber();
    return {
      streaming: {
        transcriber: () => latestTranscriber,
      },
    };
  };
  return { factory, getLatest: () => latestTranscriber };
}

// ==========================================
// P1 Tests (Tickets 076–100)
// ==========================================

test("076. Test microphone start", () => {
  const mockRec = makeMockRecorderLib();
  const mic = new MicrophoneEngine({
    recorder: "mock",
    recorderLib: mockRec,
  });

  const stream = mic.start();
  assert.ok(stream, "stream returned");
  assert.equal(mic.getState(), MicState.RECORDING);
  mic.stop();
});

test("077. Test microphone stop", () => {
  const mockRec = makeMockRecorderLib();
  const mic = new MicrophoneEngine({
    recorder: "mock",
    recorderLib: mockRec,
  });

  mic.start();
  assert.equal(mic.getState(), MicState.RECORDING);
  mic.stop("user_requested");
  assert.equal(mic.getState(), MicState.STOPPED);
  assert.equal(mic.isRecording(), false);
});

test("078. Test partial transcript", () => {
  const processor = new TranscriptProcessor();
  const partialEvents = [];
  processor.on("partial", (e) => partialEvents.push(e));

  const result = processor.processTurnEvent({
    transcript: "open whats",
    end_of_turn: false,
    turn_order: 1,
  });

  assert.equal(result.type, "partial");
  assert.equal(result.execute, false, "partials must never be marked to execute");
  assert.equal(partialEvents.length, 1);
  assert.equal(partialEvents[0].text, "open whats");
  assert.equal(processor.getCurrentPartial(), "open whats");
});

test("079. Test final transcript", () => {
  const processor = new TranscriptProcessor();
  const finalEvents = [];
  processor.on("final", (e) => finalEvents.push(e));

  const result = processor.processTurnEvent({
    transcript: "Open WhatsApp and search for Dad",
    end_of_turn: true,
    turn_order: 1,
  });

  assert.equal(result.type, "final");
  assert.equal(result.execute, true);
  assert.equal(result.text, "Open WhatsApp and search for Dad");
  assert.equal(finalEvents.length, 1);
  assert.equal(processor.getLastFinal(), "Open WhatsApp and search for Dad");
});

test("080. Test duplicate final transcript", () => {
  const processor = new TranscriptProcessor();
  const finalEvents = [];
  processor.on("final", (e) => finalEvents.push(e));

  // First final turn
  const r1 = processor.processTurnEvent({
    transcript: "Open WhatsApp",
    end_of_turn: true,
    turn_order: 1,
  });
  assert.equal(r1.execute, true);

  // Duplicate final turn with identical turn_order
  const r2 = processor.processTurnEvent({
    transcript: "Open WhatsApp",
    end_of_turn: true,
    turn_order: 1,
  });
  assert.equal(r2.execute, false);
  assert.equal(r2.reason, "duplicate_turn_order");

  // Duplicate with same content in same session
  const r3 = processor.processTurnEvent({
    transcript: "Open WhatsApp",
    end_of_turn: true,
    turn_order: 2,
  });
  assert.equal(r3.execute, false);

  assert.equal(finalEvents.length, 1, "only 1 final event emitted despite duplicates");
});

test("081. Test cancellation", () => {
  const hotkey = new HotkeyController();
  let cancelledFired = false;
  hotkey.on("cancelled", () => {
    cancelledFired = true;
  });

  hotkey.handleActivation();
  assert.equal(hotkey.isListening(), true);

  const cancelled = hotkey.handleCancellation();
  assert.equal(cancelled, true);
  assert.equal(cancelledFired, true);
  assert.equal(hotkey.getState(), VoiceUiState.IDLE);
});

test("082. Test reconnect", async () => {
  let attemptCount = 0;
  const clientFactory = () => ({
    streaming: {
      transcriber: () => {
        attemptCount++;
        const transcriber = new EventEmitter();
        transcriber.connect = async () => {
          if (attemptCount === 1) {
            throw new Error("Network transient failure");
          }
          process.nextTick(() => transcriber.emit("open", { id: "recovered_session" }));
        };
        transcriber.sendAudio = () => {};
        transcriber.close = async () => {};
        return transcriber;
      },
    },
  });

  const manager = new AssemblyAiResilienceManager({
    apiKey: "dummy_valid_hex_key_0123456789abcdef0123",
    maxReconnectAttempts: 2,
    baseBackoffMs: 10,
    clientFactory,
  });

  await manager.connect();
  assert.equal(manager.getState(), ConnectionState.CONNECTED);
  assert.equal(attemptCount, 2, "reconnected after initial transient failure");
  await manager.close();
});

test("083. Test missing API key", () => {
  const manager = new AssemblyAiResilienceManager({ apiKey: null });
  assert.throws(
    () => manager.validateApiKey(),
    /Missing AssemblyAI API key/
  );
});

test("084. Test invalid API key", () => {
  const placeholderManager = new AssemblyAiResilienceManager({ apiKey: "YOUR_ASSEMBLYAI_API_KEY_HERE" });
  assert.throws(
    () => placeholderManager.validateApiKey(),
    /placeholder value detected/
  );

  const shortManager = new AssemblyAiResilienceManager({ apiKey: "short" });
  assert.throws(
    () => shortManager.validateApiKey(),
    /malformed key structure/
  );
});

test("085. Test microphone failure", async () => {
  const mockRec = makeMockRecorderLib();
  const mic = new MicrophoneEngine({
    recorder: "mock",
    recorderLib: mockRec,
  });

  mic.start();
  let errorEmitted = false;
  mic.on("error", () => {
    errorEmitted = true;
  });

  mockRec.stream.emit("error", new Error("Device I/O failure"));
  assert.equal(errorEmitted, true);
  assert.equal(mic.getState(), MicState.ERROR);
  mic.stop();
});

test("086. Test silence", () => {
  const vad = new VadDetector({ speechThreshold: 0.05, silenceDurationToCompleteMs: 100 });
  const silenceEvents = [];
  vad.on("silence", (s) => silenceEvents.push(s));

  // Audio below threshold
  const r1 = vad.processLevel({ normalized: 0.01, timestamp: 1000 });
  assert.equal(r1.isSpeaking, false);
  assert.equal(silenceEvents.length, 1);

  const r2 = vad.processLevel({ normalized: 0.005, timestamp: 1150 });
  assert.equal(r2.silenceDurationMs, 150);
});

test("087. Test rapid activation", () => {
  const hotkey = new HotkeyController({ debounceMs: 100 });
  const first = hotkey.handleActivation();
  assert.equal(first, true);

  // Immediate second press must be suppressed by debounce/isListening
  const second = hotkey.handleActivation();
  assert.equal(second, false);
});

test("088. Test repeated activation", async () => {
  const hotkey = new HotkeyController({ debounceMs: 20 });
  hotkey.handleActivation();
  hotkey.handleCancellation();
  assert.equal(hotkey.getState(), VoiceUiState.IDLE);

  await new Promise((r) => setTimeout(r, 25));

  // Next activation succeeds cleanly
  const repeat = hotkey.handleActivation();
  assert.equal(repeat, true);
  assert.equal(hotkey.getState(), VoiceUiState.LISTENING);
});

test("089. Test simultaneous callbacks", () => {
  const processor = new TranscriptProcessor();
  let partialCount = 0;
  let finalCount = 0;

  processor.on("partial", () => partialCount++);
  processor.on("final", () => finalCount++);

  // Simultaneous events
  processor.processTurnEvent({ transcript: "hello", end_of_turn: false });
  processor.processTurnEvent({ transcript: "hello world", end_of_turn: true, turn_order: 1 });

  assert.equal(partialCount, 1);
  assert.equal(finalCount, 1);
});

test("090. Test shutdown", async () => {
  const mockRec = makeMockRecorderLib();
  const mockAai = makeMockAssemblyAiFactory();

  const pipeline = new VoiceInputPipeline({
    apiKey: "dummy_valid_hex_key_0123456789abcdef0123",
    components: {
      recorderLib: mockRec,
      recorder: "mock",
      clientFactory: mockAai.factory,
    },
  });

  await pipeline.start();
  assert.equal(pipeline.isRunning, true);

  await pipeline.stop();
  assert.equal(pipeline.isRunning, false);
  assert.equal(pipeline.getState().uiState, VoiceUiState.IDLE);
});

test("091. Verify no orphan audio process", async () => {
  const mockRec = makeMockRecorderLib();
  const mic = new MicrophoneEngine({
    recorder: "mock",
    recorderLib: mockRec,
  });

  mic.start();
  assert.equal(mockRec.proc.killed, false);

  mic.stop();
  assert.equal(mockRec.proc.killed, true, "child audio process must be killed on stop");
});

test("092. Verify no duplicate AssemblyAI stream", async () => {
  let instanceCount = 0;
  const clientFactory = () => {
    instanceCount++;
    const t = new MockAssemblyAiTranscriber();
    return { streaming: { transcriber: () => t } };
  };

  const manager = new AssemblyAiResilienceManager({
    apiKey: "dummy_valid_hex_key_0123456789abcdef0123",
    clientFactory,
  });

  await manager.connect();
  // Second connect call when already connected must reuse existing stream
  await manager.connect();

  assert.equal(instanceCount, 1, "must not create duplicate streams");
  await manager.close();
});

test("093. Verify UI receives real amplitude", () => {
  const processor = new AudioLevelProcessor();
  const levels = [];
  processor.on("level", (l) => levels.push(l));

  const pcmChunk = makePcm16Buffer(160, 15000);
  const result = processor.processChunk(pcmChunk);

  assert.ok(result.rawRms > 5000, "RMS correctly calculated from PCM buffer");
  assert.ok(result.normalized > 0.1 && result.normalized <= 1.0);
  assert.equal(result.isReal, true, "explicit verification flag confirms real PCM source");
  assert.equal(levels.length, 1);
});

test("094. Verify UI never generates fake amplitude", () => {
  const processor = new AudioLevelProcessor({ silenceFloor: 200 });
  // Pass empty / zero silence buffer
  const zeroChunk = Buffer.alloc(320); // 160 zeros
  const result = processor.processChunk(zeroChunk);

  assert.equal(result.rawRms, 0);
  assert.equal(result.normalized, 0);
  assert.equal(result.smoothed, 0, "must not invent artificial non-zero amplitude");
});

test("095. Verify partials never execute actions", () => {
  let executed = false;
  const processor = new TranscriptProcessor();

  processor.on("partial", () => {
    // UI displays only
  });

  const res = processor.processTurnEvent({
    transcript: "delete all files",
    end_of_turn: false,
  });

  assert.equal(res.execute, false);
  assert.equal(executed, false, "partial transcript must NEVER trigger execution");
});

test("096. Verify final transcript executes once", async () => {
  let executionCount = 0;
  const mockRec = makeMockRecorderLib();
  const mockAai = makeMockAssemblyAiFactory();

  const pipeline = new VoiceInputPipeline({
    apiKey: "dummy_valid_hex_key_0123456789abcdef0123",
    onFinalTranscript: async () => {
      executionCount++;
    },
    components: {
      recorderLib: mockRec,
      recorder: "mock",
      clientFactory: mockAai.factory,
    },
  });

  await pipeline.start();

  // Trigger final turn from AssemblyAI mock
  const transcriber = mockAai.getLatest();
  transcriber.emit("turn", {
    transcript: "Open WhatsApp and search for Dad",
    end_of_turn: true,
    turn_order: 1,
  });

  // Re-emit duplicate final turn (e.g. repeated turn from AssemblyAI)
  transcriber.emit("turn", {
    transcript: "Open WhatsApp and search for Dad",
    end_of_turn: true,
    turn_order: 1,
  });

  // Give tick for async handling
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(executionCount, 1, "final transcript must execute EXACTLY ONCE");
  await pipeline.stop();
});

test("097. Verify cancellation prevents execution", async () => {
  let executed = false;
  const mockRec = makeMockRecorderLib();
  const mockAai = makeMockAssemblyAiFactory();

  const pipeline = new VoiceInputPipeline({
    apiKey: "dummy_valid_hex_key_0123456789abcdef0123",
    onFinalTranscript: async () => {
      executed = true;
    },
    components: {
      recorderLib: mockRec,
      recorder: "mock",
      clientFactory: mockAai.factory,
    },
  });

  await pipeline.start();

  // User presses Escape to cancel
  pipeline.triggerCancellation();

  // Final transcript arrives afterwards
  const transcriber = mockAai.getLatest();
  transcriber.emit("turn", {
    transcript: "Open WhatsApp",
    end_of_turn: true,
    turn_order: 1,
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(executed, false, "cancellation must prevent any downstream execution");
  await pipeline.stop();
});

test("098. Verify session cleanup", () => {
  const metrics = new VoiceMetricsCollector();
  const id = metrics.startSession();
  assert.ok(id);
  metrics.recordSpeechOnset();
  metrics.recordSpeechCompletion();
  metrics.recordFinalTranscript();

  const res = metrics.endSession();
  assert.equal(res.turnCount, 1);
  assert.ok(res.totalDurationMs >= 0);

  metrics.cleanup();
  assert.equal(metrics.sessionId, null);
  assert.equal(metrics.turnCount, 0);
});

test("099. Verify logs contain no secrets", () => {
  const secretKey = "4a8c88f192b04753ba0f898124589d81";
  const rawLog = `Connecting with API key: ${secretKey} to https://api.assemblyai.com`;
  const sanitized = sanitizeLog(rawLog, secretKey);

  assert.ok(!sanitized.includes(secretKey), "API key must be redacted");
  assert.ok(sanitized.includes("[REDACTED_KEY]") || sanitized.includes("***9d81"));
});

test("100. Verify complete voice-input pipeline", async () => {
  const mockRec = makeMockRecorderLib();
  const mockAai = makeMockAssemblyAiFactory();
  let receivedGoal = null;
  const audioLevels = [];

  const pipeline = new VoiceInputPipeline({
    apiKey: "dummy_valid_hex_key_0123456789abcdef0123",
    onAudioLevel: (l) => audioLevels.push(l),
    onFinalTranscript: async (text) => {
      receivedGoal = text;
    },
    components: {
      recorderLib: mockRec,
      recorder: "mock",
      clientFactory: mockAai.factory,
    },
  });

  // 1. Activate
  pipeline.triggerActivation();
  assert.equal(pipeline.getState().uiState, VoiceUiState.LISTENING);

  // 2. Start
  const startResult = await pipeline.start();
  assert.equal(startResult.ok, true);
  assert.ok(pipeline.getState().sessionId);

  // 3. Audio chunk arrives -> real RMS amplitude emitted
  const pcm = makePcm16Buffer(160, 12000);
  pipeline.handleAudioChunk(pcm);
  assert.ok(audioLevels.length > 0);
  assert.equal(audioLevels[0].isReal, true);

  // 4. AssemblyAI sends turn event
  const transcriber = mockAai.getLatest();
  transcriber.emit("turn", {
    transcript: "Open WhatsApp and search for Dad",
    end_of_turn: true,
    turn_order: 1,
  });

  await new Promise((r) => setTimeout(r, 20));

  // 5. Goal delivered downstream to orchestrator
  assert.equal(receivedGoal, "Open WhatsApp and search for Dad");

  // 6. Stop
  const stopResult = await pipeline.stop();
  assert.equal(stopResult.ok, true);
  assert.equal(pipeline.getState().uiState, VoiceUiState.IDLE);
});

test("101. Verify deduplication when comment is said twice", async () => {
  const processor = new TranscriptProcessor();
  const executedTurns = [];
  processor.on("final", (turn) => executedTurns.push(turn.text));

  // User says partial twice: "search for Dad... search for Dad"
  const p1 = processor.processTurnEvent({ transcript: "search for Dad", end_of_turn: false, turn_order: 1 });
  const p2 = processor.processTurnEvent({ transcript: "search for Dad", end_of_turn: false, turn_order: 1 });
  assert.equal(p1.execute, false);
  assert.equal(p2.execute, false);

  // User turn completes: "search for Dad"
  const f1 = processor.processTurnEvent({ transcript: "search for Dad", end_of_turn: true, turn_order: 1 });
  assert.equal(f1.execute, true);

  // Duplicate turn arrives (same turn_order)
  const f2 = processor.processTurnEvent({ transcript: "search for Dad", end_of_turn: true, turn_order: 1 });
  assert.equal(f2.execute, false);
  assert.equal(f2.reason, "duplicate_turn_order");

  // Repeated identical comment in same stream (new turn_order)
  const f3 = processor.processTurnEvent({ transcript: "search for Dad", end_of_turn: true, turn_order: 2 });
  assert.equal(f3.execute, false);
  assert.equal(f3.reason, "duplicate_content");

  // Exact 1 execution occurred despite repeated speech
  assert.equal(executedTurns.length, 1);
  assert.equal(executedTurns[0], "search for Dad");

  // New activation clears deduplication and allows legitimate new command
  processor.clearForNewActivation();
  const f4 = processor.processTurnEvent({ transcript: "search for Dad", end_of_turn: true, turn_order: 1 });
  assert.equal(f4.execute, true);
  assert.equal(executedTurns.length, 2);
});

test("102. Verify self-healing pipeline recovery on unexpected error", async () => {
  const mockRec = makeMockRecorderLib();
  const mockAai = makeMockAssemblyAiFactory();
  let failureHandled = false;

  const pipeline = new VoiceInputPipeline({
    apiKey: "dummy_valid_hex_key_0123456789abcdef0123",
    onFinalTranscript: async () => {
      throw new Error("Downstream execution unexpected failure");
    },
    components: {
      recorderLib: mockRec,
      recorder: "mock",
      clientFactory: mockAai.factory,
    },
  });

  await pipeline.start();
  assert.equal(pipeline.isRunning, true);

  // Final turn triggers execution which throws
  const transcriber = mockAai.getLatest();
  transcriber.emit("turn", {
    transcript: "Open WhatsApp",
    end_of_turn: true,
    turn_order: 1,
  });

  await new Promise((r) => setTimeout(r, 30));

  // The pipeline should heal and return UI back to IDLE
  assert.equal(pipeline.getState().uiState, VoiceUiState.IDLE, "pipeline must heal back to IDLE on downstream error");
  await pipeline.stop();
});

