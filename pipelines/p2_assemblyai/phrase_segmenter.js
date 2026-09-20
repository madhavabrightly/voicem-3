/**
 * P2 tickets 133–136 — phrase boundaries and utterance shape.
 *
 *  133. Detect command boundaries.
 *  134. Detect multi-step commands.
 *  135. Detect chained actions.
 *  136. Detect conditional commands.
 *
 * Segmentation works on token spans (quote-aware) so a conjunction inside
 * quoted user content never splits a command. Each clause keeps its exact
 * original text; nothing is rewritten or reordered.
 */
import { tokenize, collapseWhitespace } from "./text_scan.js";

/** Connectors that join two actions into one command. */
export const SEQUENCE_CONNECTORS = ["and then", "then", "after that", "and also", "also", "next", "finally", "and", "and after that"];

/** Markers that make the rest of a clause conditional. */
export const CONDITION_MARKERS = ["if", "when", "unless", "in case", "provided that", "as long as", "whenever"];

/** Verbs P2 recognises when describing a step (execution vocabulary stays in P3). */
export const ACTION_VERBS = [
  "open", "launch", "start", "close", "quit", "switch", "focus", "search", "find", "look", "click", "press", "type", "write", "enter",
  "scroll", "go", "navigate", "read", "show", "tell", "send", "delete", "remove", "save", "copy", "paste", "select", "drag", "move",
  "minimize", "maximize", "restore", "play", "pause", "stop", "call", "message", "book", "set", "turn", "run", "install", "shutdown", "restart",
];

const SENTENCE_END = /[.!?;]$/;

/**
 * Split an utterance into clauses at sentence ends and sequence connectors.
 *
 * @param {string} text
 * @returns {{
 *   clauses: Array<{index:number,text:string,start:number,end:number,connector:string|null,conditional:boolean,condition:string|null}>,
 *   boundaries: Array<{start:number,end:number,reason:string}>,
 *   multiStep: boolean, chained: boolean, conditional: boolean
 * }}
 */
export function segmentPhrases(text) {
  const raw = String(text ?? "");
  const tokens = tokenize(raw);
  const boundaries = [];
  const cuts = [];

  // 133. Sentence punctuation ends a clause.
  for (const token of tokens) {
    if (SENTENCE_END.test(token.text) && !token.quoted) {
      cuts.push({ at: token.end, reason: "sentence" });
      boundaries.push({ start: token.start, end: token.end, reason: "sentence" });
    }
  }

  // 134/135. Sequence connectors join steps inside a sentence.
  for (const connector of SEQUENCE_CONNECTORS) {
    const re = new RegExp(`(^|\\s)${connector.replace(/ /g, "\\s+")}(\\s|$)`, "gi");
    let match;
    while ((match = re.exec(raw)) !== null) {
      const start = match.index + (match[1] ? match[1].length : 0);
      const end = start + connector.length;
      const insideQuote = tokens.some((t) => t.quoted && start >= t.start && end <= t.end);
      if (insideQuote) continue;
      // "if X then Y" — that "then" belongs to the condition, not to a chain.
      const prefix = collapseWhitespace(raw.slice(0, start)).toLowerCase();
      const conditionalLead = CONDITION_MARKERS.some((marker) => new RegExp(`(^|\\s)${marker}\\b`).test(prefix)) && /^(if|when|unless|whenever)\b/.test(prefix);
      if (conditionalLead && connector === "then") continue;
      // Cut BEFORE the connector so the connector joins neither clause.
      cuts.push({ at: start, reason: "connector" });
      boundaries.push({ start, end, reason: "connector", connector: connector.trim() });
      if (re.lastIndex === match.index) re.lastIndex += 1;
    }
  }

  const orderedCuts = [...new Set(cuts.map((c) => c.at))].sort((a, b) => a - b);
  const clauses = [];
  let cursor = 0;
  const push = (start, end) => {
    const slice = raw.slice(start, end);
    const text = collapseWhitespace(slice);
    if (!text) return;
    const leading = slice.length - slice.trimStart().length;
    clauses.push({
      index: clauses.length,
      text,
      start: start + leading,
      end: start + leading + text.length,
      connector: null,
      conditional: false,
      condition: null,
    });
  };

  for (const cut of orderedCuts) {
    if (cut <= cursor) continue;
    push(cursor, cut);
    cursor = cut;
  }
  push(cursor, raw.length);

  // Attach the connector that introduced each clause (for audits/UI).
  for (const boundary of boundaries) {
    if (boundary.reason !== "connector") continue;
    const clause = clauses.find((c) => c.start >= boundary.end);
    if (clause && !clause.connector) clause.connector = boundary.connector;
  }

  // 136. Conditional clauses: the marker splits condition from consequent, so
  // "if the file is open then save it" keeps the CONDITION separate from the
  // action the user actually wants ("save it").
  for (const clause of clauses) {
    const lower = clause.text.toLowerCase();
    for (const marker of CONDITION_MARKERS) {
      const at = lower.indexOf(marker);
      if (at === -1) continue;
      const beforeMarker = lower.slice(0, at).trim();
      if (beforeMarker.length > 0) continue; // marker must introduce the clause
      const rest = clause.text.slice(at + marker.length).trim();
      const split = rest.split(/\s*,\s*(?:then\s+)?|\s+then\s+/i);
      clause.conditional = true;
      clause.condition = split[0] ? split[0].trim() : rest;
      const consequent = split.slice(1).join(" ").trim();
      clause.consequent = consequent || null;
      break;
    }
  }

  const connectors = boundaries.filter((b) => b.reason === "connector").length;
  return {
    clauses,
    boundaries,
    multiStep: clauses.length > 1, // 134
    chained: connectors > 0, // 135
    conditional: clauses.some((c) => c.conditional), // 136
  };
}

/**
 * Describe each clause as a step candidate: verb + object, preserving the
 * clause text verbatim. Tool selection stays in P3 — this is understanding.
 *
 * @param {{clauses:Array}} segmentation
 */
export function describeSteps(segmentation) {
  return (segmentation?.clauses || []).map((clause) => {
    // For a conditional clause the STEP is the consequent ("save it"), while
    // the condition is reported alongside it.
    const stepText = clause.consequent || clause.text;
    const offset = clause.consequent ? clause.text.indexOf(clause.consequent) : 0;
    const tokens = tokenize(stepText);
    const verbToken = tokens.find((t) => !t.quoted && ACTION_VERBS.includes(t.lower.replace(/[^a-z]/g, "")));
    const verb = verbToken ? verbToken.lower.replace(/[^a-z]/g, "") : null;
    // Offsets are relative to the step text, so the object is its tail.
    const object = verbToken ? collapseWhitespace(stepText.slice(verbToken.end)) : stepText;
    const base = clause.start + (offset > 0 ? offset : 0);
    return {
      index: clause.index,
      text: stepText,
      verb,
      verbSpan: verbToken ? { start: base + verbToken.start, end: base + verbToken.end } : null,
      object,
      // A clause WITH a consequent yields an executable step; a bare condition
      // ("if X" with nothing after it) stays a condition.
      conditional: Boolean(clause.conditional && !clause.consequent),
      condition: clause.condition,
      connector: clause.connector,
    };
  });
}
