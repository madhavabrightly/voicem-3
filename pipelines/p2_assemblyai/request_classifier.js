/**
 * P2 tickets 137–148 — request-type detection.
 *
 *  137. Detect verification requests.   143. Detect clicking requests.
 *  138. Detect question commands.       144. Detect scrolling requests.
 *  139. Detect information requests.    145. Detect application requests.
 *  140. Detect action requests.         146. Detect browser requests.
 *  141. Detect navigation requests.     147. Detect file requests.
 *  142. Detect typing requests.         148. Detect system requests.
 *
 * Detection is cue-based and multi-label: an utterance can be a question AND an
 * application request ("what's open in notepad"), and a multi-step utterance is
 * classified per clause as well as as a whole. Cues are declared in one table
 * so behaviour is auditable instead of scattered across regexes.
 */
import { describeSteps } from "./phrase_segmenter.js";
import { ENTITY_TYPES } from "./entity_preserver.js";

export const REQUEST_TYPES = {
  VERIFICATION: "verification",
  QUESTION: "question",
  INFORMATION: "information",
  ACTION: "action",
  NAVIGATION: "navigation",
  TYPING: "typing",
  CLICKING: "clicking",
  SCROLLING: "scrolling",
  APPLICATION: "application",
  BROWSER: "browser",
  FILE: "file",
  SYSTEM: "system",
  UNKNOWN: "unknown",
};

/** Cue table — the single source of truth for request classification. */
export const REQUEST_CUES = {
  [REQUEST_TYPES.VERIFICATION]: [/\bdid it work\b/i, /\bdid that work\b/i, /\bcheck (if|whether|that)\b/i, /\bverify\b/i, /\bmake sure\b/i, /\bis it done\b/i, /\bdid you\b/i, /\bconfirm (that|if)\b/i],
  [REQUEST_TYPES.QUESTION]: [/\?\s*$/, /^(what|where|which|who|when|why|how|is|are|can|could|do|does|did|will|would|should)\b/i],
  [REQUEST_TYPES.INFORMATION]: [/\btell me\b/i, /\bshow me\b/i, /\bwhat(?:'s| is| are)\b/i, /\bhow (many|much|long)\b/i, /\bexplain\b/i, /\bgive me\b/i],
  [REQUEST_TYPES.NAVIGATION]: [/\bgo to\b/i, /\bnavigate\b/i, /\bopen the\b.*\b(page|site|website|tab)\b/i, /\bgo back\b/i, /\bgo forward\b/i, /\bnext page\b/i, /\bprevious page\b/i],
  [REQUEST_TYPES.TYPING]: [/\btype\b/i, /\bwrite\b/i, /\benter\b/i, /\bfill in\b/i],
  [REQUEST_TYPES.CLICKING]: [/\bclick\b/i, /\btap\b/i, /\bdouble[- ]click\b/i, /\bpress the\b.*\b(button|link|icon)\b/i, /\bhit the\b/i],
  [REQUEST_TYPES.SCROLLING]: [/\bscroll\b/i, /\bpage down\b/i, /\bpage up\b/i, /\bswipe\b/i],
  [REQUEST_TYPES.APPLICATION]: [/\bopen\b/i, /\blaunch\b/i, /\bstart\b/i, /\bclose\b/i, /\bquit\b/i, /\bswitch to\b/i, /\bfocus\b/i],
  [REQUEST_TYPES.BROWSER]: [/\bbrowser\b/i, /\btab\b/i, /\baddress bar\b/i, /\burl\b/i, /\bwebsite\b/i, /\bgoogle\b/i, /\bnew tab\b/i, /\bsearch the web\b/i],
  [REQUEST_TYPES.FILE]: [/\bfile\b/i, /\bfolder\b/i, /\bdocument\b/i, /\bsave\b/i, /\brename\b/i, /\battachment\b/i, /\.(pdf|docx?|xlsx?|txt|png|jpe?g|csv)\b/i],
  [REQUEST_TYPES.SYSTEM]: [/\bsettings\b/i, /\bvolume\b/i, /\bbrightness\b/i, /\bwi[- ]?fi\b/i, /\bbluetooth\b/i, /\bpower\b/i, /\block\b/i, /\bsleep\b/i, /\btask manager\b/i, /\bprocess\b/i, /\bcontrol panel\b/i],
};

/**
 * Priority when several types match: the most specific instruction wins.
 * Documented order — verification first, generic "action" last. Browser and
 * system cues ("new tab", "settings") outrank the generic "open" verb; FILE
 * stays below APPLICATION so "open the file explorer" stays an application
 * request while "save the document" is a file request.
 */
export const REQUEST_PRIORITY = [
  REQUEST_TYPES.VERIFICATION,
  REQUEST_TYPES.QUESTION,
  REQUEST_TYPES.INFORMATION,
  REQUEST_TYPES.TYPING,
  REQUEST_TYPES.CLICKING,
  REQUEST_TYPES.SCROLLING,
  REQUEST_TYPES.NAVIGATION,
  REQUEST_TYPES.BROWSER,
  REQUEST_TYPES.SYSTEM,
  REQUEST_TYPES.APPLICATION,
  REQUEST_TYPES.FILE,
  REQUEST_TYPES.ACTION,
];

const ACTION_VERB_RE = /\b(open|launch|start|close|quit|switch|focus|search|find|click|press|type|write|enter|scroll|go|navigate|read|show|tell|send|delete|remove|save|copy|paste|select|drag|move|minimize|maximize|restore|play|pause|stop|call|message|book|set|turn|run|install|shutdown|restart)\b/i;

/**
 * @param {string} text
 * @param {object} [opts]
 * @param {Array} [opts.entities] entities from `extractEntities`
 * @param {object} [opts.segmentation] result of `segmentPhrases`
 * @returns {{primary:string, all:string[], evidence:Array<{type:string,cue:string,start:number,end:number}>, perStep:Array<{index:number,text:string,type:string}>}}
 */
export function classifyRequest(text, { entities = [], segmentation = null } = {}) {
  const raw = String(text ?? "");
  const evidence = [];
  const matched = new Set();

  for (const [type, cues] of Object.entries(REQUEST_CUES)) {
    for (const cue of cues) {
      const match = cue.exec(raw);
      if (!match) continue;
      matched.add(type);
      evidence.push({ type, cue: cue.source, start: match.index, end: match.index + match[0].length });
      break; // one piece of evidence per type is enough
    }
  }

  // 140. Action requests: an order to make something happen.
  const hasVerb = ACTION_VERB_RE.test(raw);
  const hasTargetEntity = entities.some((e) => [ENTITY_TYPES.APPLICATION, ENTITY_TYPES.PERSON, ENTITY_TYPES.QUOTED, ENTITY_TYPES.URL].includes(e.type));
  if (hasVerb && hasTargetEntity) matched.add(REQUEST_TYPES.ACTION);

  const typeList = [...matched];
  const perStep = describeSteps(segmentation).map((step) => ({
    index: step.index,
    text: step.text,
    type: classifySingle(step.text, step.verb),
    conditional: step.conditional,
  }));

  // 136. In "if X then Y" the request is the CONSEQUENT: classifying the
  // condition would report the wrong thing to act on.
  const consequentSteps = perStep.filter((s) => !s.conditional);
  const consequentType = REQUEST_PRIORITY.find((type) => consequentSteps.some((s) => s.type === type));

  const primary =
    (segmentation?.conditional && consequentType) ||
    REQUEST_PRIORITY.find((type) => typeList.includes(type)) ||
    consequentType ||
    (hasVerb ? REQUEST_TYPES.ACTION : REQUEST_TYPES.UNKNOWN);

  return { primary, all: typeList.length ? typeList : [primary], evidence, perStep };
}

/** Classification for one clause, using the clause verb when available. */
function classifySingle(text, verb) {
  const matched = Object.entries(REQUEST_CUES)
    .filter(([, cues]) => cues.some((cue) => cue.test(text)))
    .map(([type]) => type);
  if (matched.length === 0 && verb) return REQUEST_TYPES.ACTION;
  return REQUEST_PRIORITY.find((type) => matched.includes(type)) || (verb ? REQUEST_TYPES.ACTION : REQUEST_TYPES.UNKNOWN);
}

/** True when the request changes the machine (used by the ambiguity gate). */
export function isMutatingRequest(primary) {
  return [
    REQUEST_TYPES.ACTION,
    REQUEST_TYPES.TYPING,
    REQUEST_TYPES.CLICKING,
    REQUEST_TYPES.SCROLLING,
    REQUEST_TYPES.NAVIGATION,
    REQUEST_TYPES.APPLICATION,
    REQUEST_TYPES.BROWSER,
    REQUEST_TYPES.FILE,
    REQUEST_TYPES.SYSTEM,
  ].includes(primary);
}

/** 138. Interrogative utterances are answered, never executed blindly. */
export function isQuestion(primary, all = []) {
  return primary === REQUEST_TYPES.QUESTION || primary === REQUEST_TYPES.INFORMATION || all.includes(REQUEST_TYPES.QUESTION);
}
