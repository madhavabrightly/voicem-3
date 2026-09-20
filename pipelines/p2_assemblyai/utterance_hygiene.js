/**
 * P2 tickets 121–125 — utterance hygiene.
 *
 *  121. Detect command cancellation.
 *  122. Detect command correction.
 *  123. Detect repeated command.
 *  124. Detect conversational filler.
 *  125. Remove irrelevant filler.
 *
 * Rules are cue-based and documented here on purpose: the module never guesses
 * beyond its cues, and every decision carries the exact span that caused it.
 * The ORIGINAL text is always preserved — filler removal only produces a
 * separate `cleaned` string used for parsing, never for echoing the user.
 */
import { tokenize, scanQuotes, collapseWhitespace, inQuotedSpan } from "./text_scan.js";

/** Utterances that cancel the task in progress. */
export const CANCELLATION_CUES = [
  "never mind",
  "nevermind",
  "forget it",
  "scratch that",
  "cancel that",
  "cancel it",
  "cancel",
  "stop",
  "abort",
  "no no no",
];

/** Cues that replace what came before them in the same utterance. */
export const CORRECTION_CUES = [
  "no wait",
  "wait no",
  "sorry i meant",
  "i meant",
  "i mean",
  "correction",
  "rather",
  "actually",
  "make that",
];

/** Pure hesitation noise — safe to drop for parsing. */
export const FILLER_WORDS = ["um", "uh", "erm", "uhh", "hmm", "mm", "like", "basically", "literally", "you know", "i guess", "sort of", "kind of"];

/** Politeness/attention words that only count as filler at the very start. */
export const FILLER_PREFIXES = ["hey", "hi", "hello", "ok", "okay", "so", "please", "just"];

/** Politeness words that only count as filler at the very end. */
export const FILLER_SUFFIXES = ["please", "thanks", "thank you", "cheers"];

/** Words that keep a cancellation cue anchored to the task it cancels. */
const TASK_REFERENCES = ["that", "it", "this", "everything", "the task", "all of it"];

function findCue(text, cues, { atStart = false } = {}) {
  const src = text.toLowerCase();
  for (const cue of cues) {
    const index = src.indexOf(cue);
    if (index === -1) continue;
    const before = src.slice(0, index).trim();
    if (atStart && before.length > 0) continue;
    const after = src.slice(index + cue.length);
    if (/^[a-z0-9]/.test(after)) continue; // cue must end on a word boundary
    return { cue, start: index, end: index + cue.length, before, after };
  }
  return null;
}

/**
 * Find the next removable filler in the CURRENT string, honouring quotes.
 * Removals are applied one at a time so quote positions are never stale —
 * editing a string while holding offsets into it is how quoted user content
 * gets deleted by accident.
 */
function findRemovable(text, quotes) {
  // Hesitation words/phrases anywhere they are not quoted user content.
  for (const filler of FILLER_WORDS) {
    const re = new RegExp(`\\b${filler.replace(/ /g, "\\s+")}\\b`, "gi");
    let match;
    while ((match = re.exec(text)) !== null) {
      if (!inQuotedSpan(quotes, match.index, match.index + match[0].length)) {
        return { start: match.index, end: match.index + match[0].length, kind: "hesitation" };
      }
      if (re.lastIndex === match.index) re.lastIndex += 1;
    }
  }

  const tokens = tokenize(text);
  const first = tokens[0];
  if (first && !first.quoted && FILLER_PREFIXES.includes(first.lower.replace(/[^a-z]/g, ""))) {
    return { start: first.start, end: first.end, kind: "prefix" };
  }
  const last = tokens[tokens.length - 1];
  if (last && !last.quoted && FILLER_SUFFIXES.includes(last.lower.replace(/[^a-z]/g, ""))) {
    return { start: last.start, end: last.end, kind: "suffix" };
  }
  return null;
}

/**
 * 124/125. Detect and remove conversational filler.
 *
 * Removals are reported by TEXT and kind, not by span: each removal shifts the
 * rest of the string, so a span would be a claim about a string that no longer
 * exists. (Entity spans, by contrast, are always exact — they are validated.)
 */
function removeFiller(text) {
  const removed = [];
  let cleaned = String(text ?? "");
  let guard = 0;

  while (guard++ < 64) {
    const quotes = scanQuotes(cleaned);
    const hit = findRemovable(cleaned, quotes);
    if (!hit) break;
    removed.push({ text: cleaned.slice(hit.start, hit.end), kind: hit.kind });
    cleaned = `${cleaned.slice(0, hit.start)} ${cleaned.slice(hit.end)}`;
  }

  return { cleaned: collapseWhitespace(cleaned), removed };
}

/**
 * 125. Strip hesitation filler from a piece of text, quote-aware.
 * Exported because the pipeline applies it to the effective command text, so
 * every downstream span refers to the same (cleaned) string it is validated
 * against. The ORIGINAL utterance is preserved separately as `originalText`.
 */
export function stripFiller(text) {
  return removeFiller(String(text ?? ""));
}

/** Normalized form used only for repeat comparison. */
export function normalizeForComparison(text) {
  return collapseWhitespace(String(text ?? ""))
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .trim();
}

/** Deterministic token-overlap ratio (Jaccard) between two normalized texts. */
export function similarity(a, b) {
  const left = new Set(normalizeForComparison(a).split(" ").filter(Boolean));
  const right = new Set(normalizeForComparison(b).split(" ").filter(Boolean));
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Inspect one utterance.
 *
 * @param {string} text exact transcript (never pre-normalized by callers)
 * @param {object} [opts]
 * @param {string|null} [opts.previous] previous command text in the same session
 * @returns {{
 *   text:string, cleaned:string,
 *   cancellation:{detected:boolean,cue:string|null,span:object|null},
 *   correction:{detected:boolean,cue:string|null,replacement:string,span:object|null},
 *   repeated:{detected:boolean,similarity:number,against:string|null},
 *   filler:{removed:Array<object>, cleaned:string},
 *   effectiveText:string
 * }}
 */
export function inspectUtterance(text, { previous = null } = {}) {
  const raw = String(text ?? "");
  const filler = removeFiller(raw);

  // 121. Cancellation must be anchored: "stop" alone cancels, "stop the video" does not.
  const cancelCue = findCue(raw, CANCELLATION_CUES, { atStart: true }) || findCue(filler.cleaned, CANCELLATION_CUES, { atStart: true });
  let cancellation = { detected: false, cue: null, span: null };
  if (cancelCue) {
    const rest = normalizeForComparison(cancelCue.after);
    const anchored = rest.length === 0 || TASK_REFERENCES.some((ref) => rest === ref || rest.startsWith(`${ref} `));
    if (anchored) {
      cancellation = {
        detected: true,
        cue: cancelCue.cue,
        span: { start: cancelCue.start, end: cancelCue.end, text: raw.slice(cancelCue.start, cancelCue.end) },
      };
    }
  }

  // 122. Correction: whatever follows the cue replaces the earlier wording.
  const correctCue = findCue(raw, CORRECTION_CUES);
  let correction = { detected: false, cue: null, replacement: "", span: null };
  if (correctCue && !cancellation.detected) {
    correction = {
      detected: true,
      cue: correctCue.cue,
      replacement: collapseWhitespace(correctCue.after),
      span: { start: correctCue.start, end: correctCue.end, text: raw.slice(correctCue.start, correctCue.end) },
    };
  }

  const effectiveText = cancellation.detected
    ? ""
    : correction.detected
      ? correction.replacement
      : collapseWhitespace(raw);

  // 123. Repeat detection against the previous command in the same session.
  const repeatedAgainst = previous ? normalizeForComparison(previous) : null;
  const score = repeatedAgainst ? similarity(raw, previous) : 0;
  const repeated = {
    detected: Boolean(repeatedAgainst) && (normalizeForComparison(raw) === repeatedAgainst || score >= 0.9),
    similarity: Number(score.toFixed(4)),
    against: repeatedAgainst ? collapseWhitespace(previous) : null,
  };

  return {
    text: raw,
    cleaned: filler.cleaned, // 125 (parsing only)
    cancellation, // 121
    correction, // 122
    repeated, // 123
    filler: { removed: filler.removed, cleaned: filler.cleaned }, // 124, 125
    effectiveText,
  };
}

/** Token-level view used by tests and audits (never rewrites the text). */
export function describeHygiene(inspection) {
  return {
    cancellation: inspection.cancellation.detected,
    correction: inspection.correction.detected,
    repeated: inspection.repeated.detected,
    fillersRemoved: inspection.filler.removed.map((f) => f.text),
  };
}
