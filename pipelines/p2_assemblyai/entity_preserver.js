/**
 * P2 tickets 126–132 — entity preservation.
 *
 *  126. Preserve application names.
 *  127. Preserve person names.
 *  128. Preserve quoted text.
 *  129. Preserve numbers.
 *  130. Preserve URLs.
 *  131. Preserve keyboard shortcuts.
 *  132. Preserve directional commands.
 *
 * Every entity is an exact span of the original utterance: `text` is the
 * original slice (never re-cased, never re-spelled) and `value` is the
 * normalized semantic value P3 may act on. Spans never overlap: candidates are
 * ranked by how specific the recogniser is, and the strongest claim wins.
 */
import { tokenize, scanQuotes, sliceSpan } from "./text_scan.js";

export const ENTITY_TYPES = {
  URL: "url", // 130
  SHORTCUT: "shortcut", // 131
  QUOTED: "quoted", // 128
  NUMBER: "number", // 129
  APPLICATION: "application", // 126
  PERSON: "person", // 127
  DIRECTION: "direction", // 132
};

/** Recognised application vocabulary (mentions only — P3 owns capability). */
export const APPLICATION_VOCABULARY = [
  "whatsapp business",
  "whatsapp",
  "opera",
  "edge",
  "chrome",
  "firefox",
  "notepad",
  "calculator",
  "vs code",
  "vscode",
  "code",
  "settings",
  "file explorer",
  "explorer",
  "files",
  "terminal",
  "powershell",
  "command prompt",
  "spotify",
  "slack",
  "discord",
  "outlook",
  "gmail",
  "word",
  "excel",
  "powerpoint",
  "paint",
  "browser",
  "store",
  "camera",
  "photos",
];

/**
 * Words that are ordinary English too ("code", "files"), so they only count as
 * an application when a cue puts them in an application position or they are
 * capitalised. Documented limitation: a capitalised prose word can still be
 * read as an application name.
 */
const CUE_REQUIRED = new Set(["code", "files", "settings", "paint", "word", "excel", "store", "camera", "photos", "browser"]);
const APPLICATION_CUES = ["open", "launch", "start", "close", "quit", "switch to", "focus", "in", "on", "to", "from", "using", "with"];

export const DIRECTIONS = ["up", "down", "left", "right", "top", "bottom", "next", "previous", "forward", "backward", "back", "page up", "page down"];

const MODIFIERS = new Set(["ctrl", "control", "alt", "shift", "cmd", "command", "win", "meta", "super"]);
const NAMED_KEYS = new Set(["enter", "return", "escape", "esc", "tab", "space", "backspace", "delete", "home", "end", "pageup", "pagedown", "up", "down", "left", "right"]);
const KEY_TLDS = ["com", "org", "net", "io", "dev", "ai", "app", "edu", "gov", "co", "in", "uk", "me", "gg", "sh"];

const PRIORITY = [ENTITY_TYPES.URL, ENTITY_TYPES.SHORTCUT, ENTITY_TYPES.QUOTED, ENTITY_TYPES.NUMBER, ENTITY_TYPES.APPLICATION, ENTITY_TYPES.PERSON, ENTITY_TYPES.DIRECTION];

function push(candidates, type, text, start, end, value, confidence) {
  candidates.push({ type, text, start, end, value, confidence });
}

/** 130. URLs: schemed, www-prefixed, or a bare host with a known TLD. */
function findUrls(text, candidates) {
  const schemed = /\b(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|ai|app|edu|gov|co|in|uk|me|gg|sh)\b/gi;
  let match;
  while ((match = schemed.exec(text)) !== null) {
    const value = match[0].replace(/[.,;:!?)]+$/, "");
    push(candidates, ENTITY_TYPES.URL, match[0], match.index, match.index + match[0].length, value.toLowerCase(), 0.95);
  }
}

/** 131. Keyboard shortcuts: modifier chains and named keys after "press". */
function findShortcuts(text, candidates) {
  const combo = /\b((?:(?:ctrl|control|alt|shift|cmd|command|win|meta|super)\s*\+\s*)+(?:[a-z0-9]|f\d{1,2}|enter|escape|tab|space|delete|backspace|home|end|pageup|pagedown|up|down|left|right))\b/gi;
  let match;
  while ((match = combo.exec(text)) !== null) {
    const parts = match[0].split(/\s*\+\s*/).map((p) => p.trim().toLowerCase());
    if (!parts.some((p) => MODIFIERS.has(p))) continue;
    push(candidates, ENTITY_TYPES.SHORTCUT, match[0], match.index, match.index + match[0].length, parts.join("+"), 0.95);
  }

  const named = /\b(?:press|hit|tap)\s+(?:the\s+)?([a-z]+)\b/gi;
  while ((match = named.exec(text)) !== null) {
    const key = match[1].toLowerCase();
    if (!NAMED_KEYS.has(key) && !/^f\d{1,2}$/.test(key)) continue;
    const start = match.index + match[0].length - match[1].length;
    push(candidates, ENTITY_TYPES.SHORTCUT, match[1], start, start + match[1].length, key, 0.9);
  }
}

/** 128. Quoted text, including the quotes in the span. */
function findQuoted(text, candidates) {
  for (const span of scanQuotes(text)) {
    const inner = sliceSpan(text, span.innerStart, span.innerEnd);
    if (!inner.trim()) continue;
    push(candidates, ENTITY_TYPES.QUOTED, text.slice(span.start, span.end), span.start, span.end, inner, 0.99);
  }
}

/** 129. Numbers. */
function findNumbers(text, candidates) {
  const re = /\b\d+(?:\.\d+)?\b/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    push(candidates, ENTITY_TYPES.NUMBER, match[0], match.index, match.index + match[0].length, match[0], 0.9);
  }
}

/** 126. Application mentions. */
function findApplications(text, candidates, vocabulary) {
  const tokens = tokenize(text);
  for (const app of vocabulary) {
    const re = new RegExp(`\\b${app.replace(/ /g, "\\s+")}\\b`, "gi");
    let match;
    while ((match = re.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const token = tokens.find((t) => t.start === start);
      const capitalized = token ? /^[A-Z]/.test(token.text) : false;
      const preceding = text.slice(0, start).trim().toLowerCase().split(/\s+/).pop() || "";
      const cued = APPLICATION_CUES.includes(preceding);
      if (CUE_REQUIRED.has(app.toLowerCase()) && !capitalized && !cued) continue;
      push(candidates, ENTITY_TYPES.APPLICATION, match[0], start, end, app.toLowerCase(), capitalized || !CUE_REQUIRED.has(app.toLowerCase()) ? 0.9 : 0.75);
    }
  }
}

/** UI nouns that end a capitalised run which is really a control name. */
const UI_NOUNS = new Set(["button", "link", "icon", "menu", "tab", "window", "file", "folder", "page", "bar", "panel", "settings", "list", "item", "field", "box", "screen", "app", "checkbox", "dialog", "option", "row", "column", "header", "footer", "bar"]);

/** Verbs that may be capitalised at the start of a sentence without being names. */
const VERB_STOPWORDS = new Set([
  "open", "launch", "start", "close", "quit", "switch", "focus", "search", "find", "look", "click", "press", "type", "write", "enter",
  "scroll", "go", "navigate", "read", "show", "tell", "send", "delete", "remove", "save", "copy", "paste", "select", "drag", "move",
  "minimize", "maximize", "restore", "play", "pause", "stop", "call", "message", "book", "set", "turn", "run", "install", "shutdown", "restart",
]);

/** 127. Person/contact names: capitalised runs, boosted by the contact list. */
function findPersons(text, candidates, contacts) {
  const tokens = tokenize(text);
  const contactSet = new Set((contacts || []).map((c) => String(c).toLowerCase()));
  let run = [];

  const flush = () => {
    if (run.length === 0) return;
    const first = run[0];
    const last = run[run.length - 1];
    const phrase = sliceSpan(text, first.start, last.end);
    const lowered = phrase.toLowerCase();
    const head = first.lower.replace(/[^a-z'’-]/g, "");
    const tail = last.lower.replace(/[^a-z'’-]/g, "");
    // "Save button" / "Open" are controls and verbs, not people.
    const isControl = UI_NOUNS.has(tail) || UI_NOUNS.has(head);
    const isVerb = VERB_STOPWORDS.has(lowered) || (run.length === 1 && first.sentenceStart && VERB_STOPWORDS.has(head));
    if (!isControl && !isVerb && lowered.length > 1) {
      const known = contactSet.has(lowered);
      push(candidates, ENTITY_TYPES.PERSON, phrase, first.start, last.end, phrase, known ? 0.95 : 0.6);
    }
    run = [];
  };

  for (const token of tokens) {
    const isName = /^[A-Z][a-z'’-]*$/.test(token.text) && !token.quoted;
    if (isName) run.push(token);
    else flush();
  }
  flush();
}

/** 132. Directional commands. */
function findDirections(text, candidates) {
  for (const direction of DIRECTIONS) {
    const re = new RegExp(`\\b${direction.replace(/ /g, "\\s+")}\\b`, "gi");
    let match;
    while ((match = re.exec(text)) !== null) {
      push(candidates, ENTITY_TYPES.DIRECTION, match[0], match.index, match.index + match[0].length, direction, 0.7);
    }
  }
}

/**
 * Extract entities from the ORIGINAL utterance text.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string[]} [opts.contacts] known contact names (optional, boosts 127)
 * @param {string[]} [opts.applications] vocabulary override
 * @returns {Array<{type:string,text:string,start:number,end:number,value:string,confidence:number}>}
 */
export function extractEntities(text, { contacts = [], applications = APPLICATION_VOCABULARY } = {}) {
  const raw = String(text ?? "");
  const candidates = [];

  findUrls(raw, candidates); // 130
  findShortcuts(raw, candidates); // 131
  findQuoted(raw, candidates); // 128
  findNumbers(raw, candidates); // 129
  findApplications(raw, candidates, applications); // 126
  findPersons(raw, candidates, contacts); // 127
  findDirections(raw, candidates); // 132

  // Strongest recogniser wins; ties break by position for determinism.
  candidates.sort((a, b) => {
    const byPriority = PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type);
    if (byPriority !== 0) return byPriority;
    if (a.start !== b.start) return a.start - b.start;
    return b.end - b.start - (a.end - a.start);
  });

  const accepted = [];
  for (const candidate of candidates) {
    const overlaps = accepted.some((e) => candidate.start < e.end && candidate.end > e.start);
    if (overlaps) continue;
    // Exactness guarantee: the text is the original slice, always.
    if (sliceSpan(raw, candidate.start, candidate.end) !== candidate.text) continue;
    accepted.push(candidate);
  }

  return accepted.sort((a, b) => a.start - b.start);
}

/** Convenience accessor used by P3 and the classifier. */
export function entitiesOfType(entities, type) {
  return (entities || []).filter((e) => e.type === type);
}

export { KEY_TLDS };
