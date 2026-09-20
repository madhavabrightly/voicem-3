/**
 * P3 — Intent + Task Engine (Tickets 201–300)
 *
 * Command contract: what the task engine receives from the voice/understanding
 * layer (P2) and what it stores about it.
 *
 *  201. Receive structured voice command.
 *  204. Store original command.
 *  205. Store normalized command.
 */

/** Command sources accepted by the engine. */
export const COMMAND_SOURCES = ["voice", "text", "ui"];

/**
 * 205. Normalize the command text: whitespace only. Wording is preserved —
 * "Dad" must stay "Dad", never a rewritten synonym.
 */
export function normalizeCommandText(raw) {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 201. Accept either a structured command from P2 or a plain string, and
 * produce the one shape the rest of P3 works with. Unknown/absent fields stay
 * `null` rather than being invented.
 *
 * When P2 (the understanding layer) ran, its result is carried through
 * untouched in `understanding` — P3 must not re-derive what upstream already
 * established, and must not fabricate fields P2 did not produce.
 *
 * @param {string|object} input structured command or raw text
 * @returns {{text:string, original:string, source:string, sessionId:string|null, turnId:(number|string|null), confidence:number|null, receivedAt:(string|number|null), understanding:object|null}}
 */
export function toStructuredCommand(input) {
  const raw = typeof input === "string" ? { text: input } : input || {};
  // 204. Store original command (exactly as received, before normalization).
  const original = String(raw.text ?? raw.command ?? "");

  return {
    text: normalizeCommandText(original), // 205. Store normalized command
    original,
    source: COMMAND_SOURCES.includes(raw.source) ? raw.source : "voice",
    sessionId: raw.sessionId ?? null,
    turnId: raw.turnId ?? raw.turnOrder ?? null,
    confidence: typeof raw.confidence === "number" ? raw.confidence : null,
    receivedAt: raw.timestamp ?? null,
    // P2 output, when the command came through the understanding pipeline.
    understanding: extractUnderstanding(raw),
  };
}

/** Fields P2 owns. Missing pieces stay null — nothing is invented here. */
const UNDERSTANDING_FIELDS = [
  "intent",
  "requestType",
  "requestTypes",
  "entities",
  "clauses",
  "actionSequence",
  "ambiguity",
  "clarification",
  "risk",
  "confirmationRequired",
  "cancelled",
  "repeated",
  "latency",
  "originalText",
  "correction",
];

/**
 * 201. Pick up P2's understanding only when it is actually there (a command
 * object that carries a request type and an entity list). A plain utterance
 * yields `null`, and P3 falls back to its own derivation.
 */
export function extractUnderstanding(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.requestType !== "string" || !Array.isArray(raw.entities)) return null;
  const understanding = {};
  for (const field of UNDERSTANDING_FIELDS) {
    understanding[field] = raw[field] === undefined ? null : raw[field];
  }
  return understanding;
}

/**
 * Stable hash of a command, used to suppress duplicate submissions (274).
 *
 * A duplicate is the SAME utterance arriving twice — same session, same turn,
 * same text — which is what a double delivery looks like. A user repeating a
 * command later speaks a new turn, and that is not a duplicate.
 */
export function commandFingerprint(command) {
  const text = normalizeCommandText(command?.text ?? command).toLowerCase();
  const session = command?.sessionId ?? "";
  const turn = command?.turnId ?? "no-turn";
  return `${session}::${turn}::${text}`;
}
