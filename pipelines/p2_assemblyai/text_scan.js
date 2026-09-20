/**
 * P2 — shared text scanning primitives.
 *
 * The understanding modules must NEVER fabricate or reword text: every piece of
 * information they emit points back at an exact span of the original utterance.
 * This module is the single place that turns a transcript string into tokens
 * and spans, so quote awareness is implemented once instead of per module.
 */

/** Sentence terminators used for "is this token at a sentence start?". */
const TERMINATORS = new Set([".", ";", "!", "?", ":"]);

/**
 * Locate quoted spans (single, double, curly and backtick quotes).
 * Unterminated quotes are ignored rather than swallowing the rest of the text.
 *
 * @param {string} text
 * @returns {Array<{start:number,end:number,innerStart:number,innerEnd:number,quote:string}>}
 */
export function scanQuotes(text) {
  const src = String(text ?? "");
  const spans = [];
  const OPENERS = { '"': '"', "'": "'", "“": "”", "‘": "’", "`": "`" };

  for (let i = 0; i < src.length; i++) {
    const opener = OPENERS[src[i]];
    if (!opener) continue;
    const closeAt = src.indexOf(opener, i + 1);
    if (closeAt === -1) continue;
    spans.push({
      start: i,
      end: closeAt + 1,
      innerStart: i + 1,
      innerEnd: closeAt,
      quote: src[i],
    });
    i = closeAt;
  }
  return spans;
}

/** True when [start,end) lies inside any quote span. */
export function inQuotedSpan(spans, start, end) {
  return spans.some((s) => start >= s.start && end <= s.end);
}

/**
 * Split text into whitespace-separated tokens with exact spans.
 *
 * @param {string} text
 * @returns {Array<{text:string,start:number,end:number,lower:string,quoted:boolean,sentenceStart:boolean}>}
 */
export function tokenize(text) {
  const src = String(text ?? "");
  const quotes = scanQuotes(src);
  const tokens = [];
  let sentenceStart = true;
  const re = /\S+/g;
  let match;

  while ((match = re.exec(src)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    tokens.push({
      text: match[0],
      start,
      end,
      lower: match[0].toLowerCase(),
      quoted: inQuotedSpan(quotes, start, end),
      sentenceStart,
    });
    const last = match[0][match[0].length - 1];
    sentenceStart = TERMINATORS.has(last);
  }
  return tokens;
}

/** Collapse whitespace runs — the only normalization P2 is allowed to do. */
export function collapseWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** Exact original slice for a span (never a reconstruction). */
export function sliceSpan(text, start, end) {
  return String(text ?? "").slice(start, end);
}
