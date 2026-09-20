/**
 * P2 tickets 101–120 — SATISFIED BY P1 (delegation, not reimplementation).
 *
 * The catalog assigns 101–120 to P2 ("AssemblyAI / Understanding"), but those
 * tickets are already implemented, tested and live-wired inside the frozen P1
 * Voice Input Pipeline, under P1's own ticket numbers. Re-implementing them
 * here would duplicate working transport code, so P2 declares the mapping and
 * REUSES the existing classes. Nothing in this file creates a second client,
 * a second stream, or a second deduplicator.
 *
 * Ticket collision note (resolved without renumbering anything):
 *   `tests/voice_input_pipeline.test.js` contains two tests labelled "101." and
 *   "102.". Those are P1 VERIFICATION CONTINUATIONS (dedup + self-healing),
 *   not P2's tickets 101/102. P1's tests stay exactly as they are; P2 claims no
 *   test number below 185, and this module documents the overlap so the
 *   ticket↔test map stays unambiguous.
 */
import {
  AssemblyAiResilienceManager,
  TranscriptProcessor,
  VoiceMetricsCollector,
  VoiceInputPipeline,
  DEFAULT_CONNECTION_PARAMS,
  sanitizeLog,
  normalizeTranscript,
} from "../voice_input/index.js";

/** Ticket-by-ticket ownership map for 101–120. */
export const P1_TRANSPORT_DELEGATION = [
  {
    tickets: "101–108",
    numbers: [101, 102, 103, 104, 105, 106, 107, 108],
    topic: "AssemblyAI client init, realtime transcriber config, connect, PCM chunks",
    satisfiedBy: "pipelines/voice_input/assemblyai_resilience.js",
    symbols: ["AssemblyAiResilienceManager.connect", "DEFAULT_CONNECTION_PARAMS", "sendAudio"],
    p1Tickets: ["017", "033", "034", "039", "041", "042"],
    tests: ["tests/voice_input_pipeline.test.js (076–090)", "tests/voice_events.test.js"],
  },
  {
    tickets: "109–113",
    numbers: [109, 110, 111, 112, 113],
    topic: "transcript events, turn completion, turn order, deduplication",
    satisfiedBy: "pipelines/voice_input/transcript_processor.js",
    symbols: ["TranscriptProcessor.processTurnEvent", "normalizeTranscript"],
    p1Tickets: ["049", "050", "051", "052", "053", "054", "063"],
    tests: ["tests/voice_input_pipeline.test.js (078–080, 096)", "tests/voice_events.test.js"],
  },
  {
    tickets: "114–120",
    numbers: [114, 115, 116, 117, 118, 119, 120],
    topic: "final turn acceptance, session/turn metadata, no empty commands",
    satisfiedBy: "pipelines/voice_input/voice_input_pipeline.js + transcript_processor.js",
    symbols: ["VoiceInputPipeline.onFinalTranscript", "TranscriptProcessor.getLastFinal"],
    p1Tickets: ["050", "058", "062", "096", "097"],
    tests: ["tests/voice_input_pipeline.test.js (079, 095–097)"],
  },
  {
    tickets: "170–172 (latency/confidence inputs)",
    numbers: [],
    topic: "session timestamps and transcription latency fed into P2's latency fields",
    satisfiedBy: "pipelines/voice_input/voice_metrics.js",
    symbols: ["VoiceMetricsCollector.recordTranscriptionLatency", "VoiceMetricsCollector.endSession"],
    p1Tickets: ["069", "070", "071", "072", "073", "074", "075"],
    tests: ["tests/voice_input_pipeline.test.js (074/075 metrics coverage)"],
  },
];

/** Documented, resolved collision — see the module header. */
export const TEST_NUMBER_COLLISION = {
  overlappingNumbers: [101, 102],
  p1Tests: [
    "tests/voice_input_pipeline.test.js → \"101. Verify deduplication when comment is said twice\"",
    "tests/voice_input_pipeline.test.js → \"102. Verify self-healing pipeline recovery on unexpected error\"",
  ],
  catalogTickets: ["101. Initialize AssemblyAI client.", "102. Configure realtime transcriber."],
  resolution: [
    "P1 tests are frozen: no renumbering, no edits.",
    "Tickets 101–102 (and 103–120) are reported as satisfied by the modules above.",
    "P2's numbered tests start at 185, so no P2 test claims 101/102.",
  ],
};

/**
 * Resolve the existing P1 transport components for an integration that needs
 * them. This is a lookup, not a factory: it never instantiates anything, so
 * wiring P2 in cannot create a second stream or client.
 */
export function resolveP1Transport() {
  return {
    AssemblyAiResilienceManager,
    TranscriptProcessor,
    VoiceMetricsCollector,
    VoiceInputPipeline,
    DEFAULT_CONNECTION_PARAMS,
    sanitizeLog,
    normalizeTranscript,
  };
}

/** Human-readable summary used by the catalog/docs and by the delegation test. */
export function describeP1Delegation() {
  return {
    range: "101–120",
    delegated: true,
    reimplemented: false,
    entries: P1_TRANSPORT_DELEGATION.map((entry) => ({ tickets: entry.tickets, module: entry.satisfiedBy })),
    collision: TEST_NUMBER_COLLISION,
  };
}
