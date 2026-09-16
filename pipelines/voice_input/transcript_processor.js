import { EventEmitter } from "node:events";

/**
 * Normalizes transcript text while strictly preserving user wording.
 *
 * 059. Normalize transcript whitespace.
 * 060. Normalize punctuation.
 * 061. Preserve user wording.
 */
export function normalizeTranscript(raw) {
  if (typeof raw !== "string") return "";

  // 059. Normalize whitespace: collapse runs of spaces/tabs/newlines to single space
  let text = raw.replace(/\s+/g, " ").trim();

  // 060. Normalize spacing around standard punctuation without altering user words (061)
  text = text.replace(/\s+([.,!?;:])/g, "$1");

  return text;
}

/**
 * Checks if transcript represents unintelligible audio.
 * 064. Detect unintelligible speech.
 */
export function isUnintelligible(text) {
  const normalized = text.toLowerCase().trim();
  return (
    normalized === "[unintelligible]" ||
    normalized === "[inaudible]" ||
    normalized === "???" ||
    normalized === "[applause]" ||
    normalized === "[laughter]"
  );
}

/**
 * TranscriptProcessor (Tickets 049–067, 078–080, 095–097)
 *
 * Responsibilities:
 * - 049. Emit partial transcript.
 * - 050. Emit final transcript.
 * - 051. Track transcript sequence.
 * - 052. Deduplicate transcript events.
 * - 053. Detect end-of-turn.
 * - 054. Ignore non-final turns for execution.
 * - 055. Display partial transcript.
 * - 056. Replace partial transcript.
 * - 057. Clear transcript on new activation.
 * - 058. Preserve final transcript.
 * - 059. Normalize transcript whitespace.
 * - 060. Normalize punctuation.
 * - 061. Preserve user wording.
 * - 062. Detect empty transcript.
 * - 063. Ignore empty final transcript.
 * - 064. Detect unintelligible speech.
 * - 065. Display transcription failure.
 * - 066. Stop voice session on failure.
 * - 067. Reset voice state.
 * - 095. Verify partials never execute actions.
 * - 096. Verify final transcript executes once.
 */
export class TranscriptProcessor extends EventEmitter {
  constructor({ logger = console } = {}) {
    super();
    this.logger = logger;
    this.currentPartial = "";
    this.lastFinal = "";
    this.sequenceNumber = 0;
    this.processedTurns = new Set();
    this.processedHashes = new Set();
  }

  /**
   * Process an AssemblyAI turn event.
   * @param {object} event AssemblyAI turn object
   * @returns {{ type: 'partial'|'final'|'ignored', text?: string, execute: boolean }}
   */
  processTurnEvent(event) {
    const rawTranscript = event?.transcript ?? "";
    const isFinal = event?.end_of_turn === true; // 053. Detect end-of-turn
    const turnOrder = event?.turn_order;

    this.sequenceNumber++; // 051. Track transcript sequence

    if (!isFinal) {
      // 049, 055, 056: Partial transcript (display only)
      const normalizedPartial = normalizeTranscript(rawTranscript);
      this.currentPartial = normalizedPartial;

      if (normalizedPartial) {
        this.emit("partial", {
          text: normalizedPartial,
          sequence: this.sequenceNumber,
          timestamp: Date.now(),
        });
      }

      // 054, 095: GUARANTEE: non-final turns NEVER execute actions
      return {
        type: "partial",
        text: normalizedPartial,
        execute: false,
      };
    }

    // --- Final Turn Processing ---
    const normalizedFinal = normalizeTranscript(rawTranscript);

    // 062, 063: Detect empty transcript and ignore empty final
    if (!normalizedFinal) {
      return { type: "ignored", reason: "empty", execute: false };
    }

    // 064. Detect unintelligible speech
    if (isUnintelligible(normalizedFinal)) {
      this.emit("unintelligible", { raw: rawTranscript });
      // 065. Display transcription failure
      this.emit("transcription_failure", { reason: "unintelligible" });
      return { type: "ignored", reason: "unintelligible", execute: false };
    }

    // 052, 080, 096: Deduplicate final turns by turn_order, duplicate content, and content hash
    if (turnOrder !== undefined) {
      if (this.processedTurns.has(turnOrder)) {
        return { type: "ignored", reason: "duplicate_turn_order", execute: false };
      }
      this.processedTurns.add(turnOrder);
    }

    if (this.processedHashes.has(normalizedFinal)) {
      return { type: "ignored", reason: "duplicate_content", execute: false };
    }
    this.processedHashes.add(normalizedFinal);

    // 058. Preserve final transcript
    this.lastFinal = normalizedFinal;
    this.currentPartial = ""; // clear partial once final is received

    // 050, 096: Emit final transcript for EXACTLY ONCE execution
    this.emit("final", {
      text: normalizedFinal,
      turnOrder,
      sequence: this.sequenceNumber,
      timestamp: Date.now(),
    });

    return {
      type: "final",
      text: normalizedFinal,
      turnOrder,
      execute: true, // safe to execute
    };
  }

  getCurrentPartial() {
    return this.currentPartial;
  }

  getLastFinal() {
    return this.lastFinal;
  }

  /**
   * 057. Clear transcript on new activation.
   */
  clearForNewActivation() {
    this.currentPartial = "";
    this.processedTurns.clear();
    this.processedHashes.clear();
    this.emit("cleared");
  }

  /**
   * 067. Reset voice state.
   */
  reset() {
    this.currentPartial = "";
    this.lastFinal = "";
    this.sequenceNumber = 0;
    this.processedTurns.clear();
    this.processedHashes.clear();
    this.emit("reset");
  }
}
