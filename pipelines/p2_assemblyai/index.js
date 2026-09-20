/**
 * P2: AssemblyAI / Understanding (Tickets 101–200)
 *
 * Public API export for the understanding pipeline.
 *
 *   101–120  delegated to the frozen P1 transport (see `p1_transport.js`)
 *   121–152  utterance understanding (hygiene, phrases, entities, requests, ambiguity)
 *   153–164  COMMAND-level risk classification (ACTION risk stays in backend/agent/risk.js)
 *   165–184  StructuredCommand producer, strict schema, dispatch + error handling
 *   185–200  numbered tests (see tests/p2_understanding_pipeline.test.js)
 */
export {
  P1_TRANSPORT_DELEGATION,
  TEST_NUMBER_COLLISION,
  describeP1Delegation,
  resolveP1Transport,
} from "./p1_transport.js";

export { collapseWhitespace, inQuotedSpan, scanQuotes, sliceSpan, tokenize } from "./text_scan.js";

export {
  CANCELLATION_CUES,
  CORRECTION_CUES,
  FILLER_PREFIXES,
  FILLER_WORDS,
  describeHygiene,
  inspectUtterance,
  normalizeForComparison,
  similarity,
} from "./utterance_hygiene.js";

export { ACTION_VERBS, CONDITION_MARKERS, SEQUENCE_CONNECTORS, describeSteps, segmentPhrases } from "./phrase_segmenter.js";

export { APPLICATION_VOCABULARY, DIRECTIONS, ENTITY_TYPES, entitiesOfType, extractEntities } from "./entity_preserver.js";

export { REQUEST_CUES, REQUEST_PRIORITY, REQUEST_TYPES, classifyRequest, isMutatingRequest, isQuestion } from "./request_classifier.js";

export { REFERENCE_WORDS, VAGUE_TARGETS, analyzeAmbiguity, describeAmbiguity, questionFor } from "./ambiguity_analyzer.js";

export {
  ALWAYS_CONFIRM,
  COMMAND_RISK_CATEGORIES,
  COMMAND_RISK_LEVEL,
  classifyCommandRisk,
  describeCommandRisk,
  requiresCommandConfirmation,
} from "./command_risk.js";

export {
  COMMAND_SCHEMA,
  COMMAND_SOURCES,
  assertStructuredCommand,
  validateStructuredCommand,
} from "./command_schema.js";

export { TurnGuard } from "./turn_guard.js";

export { COMMAND_INTENTS, TranscriptUnderstanding } from "./understanding_pipeline.js";

export { STAGES, UnderstandingTaskPipeline } from "./integration.js";
