/**
 * P3 tickets 206–218, 226–228: turn a received command into the TaskSpec the
 * task graph is built from, and detect the cases that must NOT become a task.
 *
 * The action sequence comes from the existing deterministic planner
 * (`backend/agent/planner.js`) and risk classification from
 * (`backend/agent/risk.js`) — P3 does not re-implement either.
 */
import { plan } from "../../backend/agent/planner.js";
import { classifyRisk, requiresConfirmation } from "../../backend/agent/risk.js";
import { classifyCommandRisk } from "../p2_assemblyai/command_risk.js";
import { normalizeCommandText } from "./command_contract.js";

/** 206. Command types the engine can act on. */
export const COMMAND_TYPES = {
  OPEN_APP: "open_app",
  OPEN_AND_SEARCH: "open_and_search",
  SEARCH: "search",
  TYPE: "type",
  CLICK: "click",
  SCROLL: "scroll",
  QUESTION: "question",
  UNKNOWN: "unknown",
};

/**
 * Applications this machine can actually open (mirrors the launch mapping in
 * `backend/tools/win/win-agent.ps1`). Anything else is not openable, and
 * guessing would be a fabricated capability.
 */
export const SUPPORTED_APPLICATIONS = [
  "whatsapp",
  "opera",
  "edge",
  "chrome",
  "notepad",
  "calculator",
  "vscode",
  "code",
  "settings",
  "explorer",
  "files",
];

export const DEFAULT_TASK_TIMEOUT_MS = 120000;
export const DEFAULT_MAX_RETRIES = 3;

const OPEN_RE = /\bopen\s+([^,]+?)(?:\s+and\b|,|$)/i;
const SEARCH_RE = /\bsearch(?:\s+for)?\s+([^.,]+?)(?:\s+and\s+open\b|$)/i;
const TYPE_RE = /\b(?:type|write)\s+(.+?)(?:\s+in(?:to)?\b|\s*$)/i;
const CLICK_RE = /\b(?:click|tap|press)\s+(?:on\s+)?([^.,]+?)(?:\s*$)/i;
const QUESTION_RE = /^(what|where|which|who|when|why|how|is|are|can|could|does|do)\b/i;
const URGENT_RE = /\b(now|asap|immediately|urgent|right away)\b/i;
const PRONOUN_RE = /\b(it|that|this|them|those|there)\b/i;

function words(text) {
  return normalizeCommandText(text).toLowerCase();
}

function matchGroup(re, text) {
  const m = String(text || "").match(re);
  return m ? normalizeCommandText(m[1]) : null;
}

/** 206. Determine command type from the wording itself. */
export function detectCommandType(text) {
  const t = normalizeCommandText(text);
  if (!t) return COMMAND_TYPES.UNKNOWN;
  const hasOpen = /\bopen\b/i.test(t);
  const hasSearch = /\bsearch\b/i.test(t);

  if (hasOpen && hasSearch) return COMMAND_TYPES.OPEN_AND_SEARCH;
  if (hasOpen) return COMMAND_TYPES.OPEN_APP;
  if (hasSearch) return COMMAND_TYPES.SEARCH;
  if (/\b(type|write)\b/i.test(t)) return COMMAND_TYPES.TYPE;
  if (/\b(click|tap)\b/i.test(t)) return COMMAND_TYPES.CLICK;
  if (/\bscroll\b/i.test(t)) return COMMAND_TYPES.SCROLL;
  if (QUESTION_RE.test(t) || /\?\s*$/.test(t)) return COMMAND_TYPES.QUESTION;
  return COMMAND_TYPES.UNKNOWN;
}

/** 207. Determine the requested application (from the command or the plan). */
export function detectApplication(text, steps = []) {
  const opened = steps.find((s) => s.type === "open_app" && s.target);
  if (opened) return normalizeCommandText(opened.target);
  const mentioned = matchGroup(OPEN_RE, text);
  if (mentioned) return mentioned;
  const t = words(text);
  const known = SUPPORTED_APPLICATIONS.find((app) => new RegExp(`\\b${app}\\b`).test(t));
  return known ? known : null;
}

/** 208. Determine the target entity (search query / clicked element / text). */
export function detectTargetEntity(text, type, steps = []) {
  const typed = steps.find((s) => s.type === "type" && s.args?.text);
  if (typed) return normalizeCommandText(typed.args.text);
  const clicked = steps.find((s) => s.type === "click" && s.target);
  if (clicked) return normalizeCommandText(clicked.target);
  if (type === COMMAND_TYPES.SEARCH || type === COMMAND_TYPES.OPEN_AND_SEARCH) return matchGroup(SEARCH_RE, text);
  if (type === COMMAND_TYPES.TYPE) return matchGroup(TYPE_RE, text);
  if (type === COMMAND_TYPES.CLICK) return matchGroup(CLICK_RE, text);
  return null;
}

/** 209. Determine the requested action (the verbs that must run). */
export function detectRequestedAction(type, steps = []) {
  const mutating = steps.filter((s) => ["open_app", "click", "type", "press", "scroll"].includes(s.type));
  if (mutating.length === 0) return "observe";
  return mutating.map((s) => s.type).join("+");
}

/** 210. Determine the expected result (what success looks like, in words). */
export function detectExpectedResult(type, { application, targetEntity }) {
  switch (type) {
    case COMMAND_TYPES.OPEN_AND_SEARCH:
      return `${application || "the application"} shows search results for "${targetEntity}"`;
    case COMMAND_TYPES.OPEN_APP:
      return `${application || "the application"} is open and ready`;
    case COMMAND_TYPES.SEARCH:
      return `search results for "${targetEntity}" are rendered`;
    case COMMAND_TYPES.TYPE:
      return `"${targetEntity}" appears in the focused field`;
    case COMMAND_TYPES.CLICK:
      return `${targetEntity} is clicked and its effect is visible`;
    case COMMAND_TYPES.SCROLL:
      return "the screen scrolled as requested";
    case COMMAND_TYPES.QUESTION:
      return "the requested information is reported back";
    default:
      return "unknown";
  }
}

/**
 * 211. Determine constraints.
 *
 * COMMAND risk is owned by P2 (`classifyCommandRisk`) and is consumed here —
 * P3 keeps no second copy of the dangerous-word list. The per-step ACTION risk
 * (`requiresConfirmation`) stays separate, exactly as the ownership boundary
 * documents: P2 answers "is this request dangerous?", P3 answers "is this step
 * dangerous to run?".
 */
export function detectConstraints(text, steps, config = {}, understanding = null) {
  const policy = config?.agent?.requireConfirmationFor || ["high", "medium"];
  const commandRisk = understanding?.risk ?? classifyCommandRisk(text, { confirmOn: config?.agent?.commandConfirmOn || ["high"] });
  const constraints = {
    confirmationPolicy: policy,
    riskLevel: commandRisk.level,
    riskCategories: (commandRisk.categories || []).map((c) => c.id),
    dangerous: commandRisk.level === "high",
    commandRequiresConfirmation: Boolean(commandRisk.confirmationRequired),
    readOnly: steps.every((s) => ["read_screen", "wait", "find_element", "verify"].includes(s.type)),
  };
  constraints.requiresConfirmation = steps.some((s) => requiresConfirmation(s, config) !== null);
  return constraints;
}

/**
 * 212. Determine dependencies between sequence entries: execution order, plus
 * the semantic ones the UI actually needs (an app must be open before its
 * controls can be found, a field must be focused before typing into it).
 */
export function detectDependencies(steps) {
  const deps = [];
  for (let i = 1; i < steps.length; i++) deps.push({ index: i, dependsOn: i - 1, reason: "sequence" });

  const openIdx = steps.findIndex((s) => s.type === "open_app");
  const findIdx = steps.findIndex((s) => s.type === "find_element");
  const clickIdx = steps.findIndex((s) => s.type === "click");
  const typeIdx = steps.findIndex((s) => s.type === "type");

  if (openIdx >= 0 && findIdx > openIdx) deps.push({ index: findIdx, dependsOn: openIdx, reason: "application_must_be_open" });
  if (findIdx >= 0 && clickIdx > findIdx) deps.push({ index: clickIdx, dependsOn: findIdx, reason: "target_must_be_resolved" });
  if (clickIdx >= 0 && typeIdx > clickIdx) deps.push({ index: typeIdx, dependsOn: clickIdx, reason: "target_must_be_focused" });

  return deps;
}

/** 213. Determine the action sequence (deterministic planner output). */
export function detectActionSequence(goal, config = {}) {
  return plan(goal).map((step) => ({
    type: step.type,
    target: step.target ?? null,
    args: step.args || {},
    risk: classifyRisk(step),
    // 218. Verification requirement for this step.
    verifiable: config?.agent?.verifyEveryAction !== false,
  }));
}

/**
 * 214. Determine confirmation requirements across the whole task.
 */
export function detectConfirmationRequirements(steps, config = {}) {
  const risks = [...new Set(steps.map((s) => requiresConfirmation(s, config)).filter(Boolean))];
  return { required: risks.length > 0, risks, steps: steps.map((s, i) => ({ index: i, risk: s.risk })) };
}

/** 215. Determine task priority (explicit urgency only, never invented). */
export function detectPriority(text) {
  return URGENT_RE.test(words(text)) ? "high" : "normal";
}

/**
 * 206–218. Build the full task spec for a normalized command.
 *
 * @param {object} command structured command (`text`, `original`, …)
 * @param {object} [config]
 * @returns {object} spec
 */
export function buildTaskSpec(command, config = {}) {
  const text = normalizeCommandText(command?.text);
  const understanding = command?.understanding ?? null;
  const commandType = detectCommandType(text);
  const actionSequence = detectActionSequence(text, config);
  // 207. P2's application entity is an exact span of the utterance, so it is
  // more precise than re-parsing the text; the local derivation stays the
  // fallback for raw (non-P2) input.
  const understoodApplication = (understanding?.entities || []).find((e) => e.type === "application");
  const application = understoodApplication?.text ?? detectApplication(text, actionSequence);
  const targetEntity = detectTargetEntity(text, commandType, actionSequence);

  return {
    command: {
      text, // 205
      original: command?.original ?? text, // 204
      source: command?.source ?? "voice",
      sessionId: command?.sessionId ?? null,
      turnId: command?.turnId ?? null,
      confidence: command?.confidence ?? null,
    },
    // P2's understanding, recorded for the audit trail and reused below.
    understanding,
    commandType, // 206
    application, // 207
    targetEntity, // 208
    requestedAction: detectRequestedAction(commandType, actionSequence), // 209
    expectedResult: detectExpectedResult(commandType, { application, targetEntity }), // 210
    constraints: detectConstraints(text, actionSequence, config, understanding), // 211
    dependencies: detectDependencies(actionSequence), // 212
    actionSequence, // 213
    confirmationRequirements: detectConfirmationRequirements(actionSequence, config), // 214
    priority: understanding?.intent === "cancellation" ? "low" : detectPriority(text), // 215
    timeoutMs: config?.agent?.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS, // 216
    maxRetries: config?.agent?.maxRetriesPerAction ?? DEFAULT_MAX_RETRIES, // 217
    verifyEveryAction: config?.agent?.verifyEveryAction !== false, // 218
  };
}

/** 227. Detect missing information that makes the task unactionable. */
export function detectMissingInformation(spec) {
  const missing = [];
  const needsApp = [COMMAND_TYPES.OPEN_APP, COMMAND_TYPES.OPEN_AND_SEARCH].includes(spec.commandType);
  const needsQuery = [COMMAND_TYPES.SEARCH, COMMAND_TYPES.OPEN_AND_SEARCH].includes(spec.commandType);

  if (needsApp && !spec.application) {
    missing.push({ field: "application", question: "Which application should I use?" });
  }
  if (needsQuery && !spec.targetEntity) {
    missing.push({ field: "target", question: "What should I search for?" });
  }
  if ([COMMAND_TYPES.TYPE, COMMAND_TYPES.CLICK].includes(spec.commandType) && !spec.targetEntity) {
    missing.push({ field: "target", question: "What should I act on?" });
  }
  return missing;
}

/** 228. Detect ambiguity: references that cannot be resolved from the wording. */
export function detectAmbiguity(spec, command) {
  const text = normalizeCommandText(command?.original ?? spec.command?.original);
  const issues = [];
  const match = text.match(PRONOUN_RE);
  // A reference is only ambiguous when it is ALSO what the app was read as —
  // "open it" resolves to the literal app "it", which is no application at all.
  const reference = match ? match[1].toLowerCase() : null;
  const appIsReference = reference && String(spec.application || "").toLowerCase() === reference;
  if (reference && (!spec.application || appIsReference)) {
    issues.push({
      question: `What does "${reference}" refer to?`,
      candidates: [],
      field: "application",
    });
  }
  return issues;
}

/**
 * 230. Fold a clarification answer into the command it belongs to, so the task
 * is re-derived with the missing information actually resolved.
 *
 * @param {string} text original command text
 * @param {{field?:string}} clarification
 * @param {string} answer
 */
export function applyClarification(text, clarification, answer) {
  const base = normalizeCommandText(text);
  const value = normalizeCommandText(answer);
  if (!value) return base;

  if (clarification?.field === "application") {
    const reference = base.match(PRONOUN_RE);
    if (reference) return normalizeCommandText(base.replace(PRONOUN_RE, value));
    const open = base.match(/^open\s+/i);
    if (open) return normalizeCommandText(`${open[0]}${value} ${base.slice(open[0].length)}`);
  }
  return normalizeCommandText(`${base} ${value}`);
}

/**
 * 226. Detect an impossible task — one the engine must refuse to start rather
 * than attempt and fail: no understood action, or an application this machine
 * cannot open.
 */
export function detectImpossibleTask(spec, { supportedApplications = SUPPORTED_APPLICATIONS } = {}) {
  if (spec.actionSequence.length === 0 || spec.commandType === COMMAND_TYPES.QUESTION || spec.commandType === COMMAND_TYPES.UNKNOWN) {
    return { reason: "could_not_understand", detail: `no action sequence for "${spec.command.text}"` };
  }
  if (spec.application) {
    const app = spec.application.toLowerCase();
    const supported = supportedApplications.some((known) => app.includes(known));
    if (!supported) return { reason: "unknown_application", detail: `cannot open "${spec.application}"` };
  }
  return null;
}
