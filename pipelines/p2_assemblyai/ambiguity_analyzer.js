/**
 * P2 tickets 149–152 — ambiguity and clarification at the UTTERANCE level.
 *
 *  149. Detect ambiguous commands.
 *  150. Mark ambiguity.
 *  151. Request clarification when necessary.
 *  152. Avoid unnecessary clarification.
 *
 * OWNERSHIP: P2 owns "could a human tell what was meant by this sentence?".
 * P3 still owns task-level feasibility (impossible / missing / which app this
 * machine can actually open). A command marked ambiguous here is handed to P3
 * WITH the clarification question, so P3 asks that question instead of
 * inventing a second one.
 */
import { ENTITY_TYPES } from "./entity_preserver.js";
import { isMutatingRequest, REQUEST_TYPES } from "./request_classifier.js";
import { normalizeForComparison } from "./utterance_hygiene.js";

/** References that need an antecedent. */
export const REFERENCE_WORDS = ["it", "that", "this", "them", "those", "there", "one"];

/** Placeholders that stand in for a real object. */
export const VAGUE_TARGETS = ["something", "stuff", "things", "anything", "whatever", "some stuff"];

const APPLICATION_OR_PERSON = [ENTITY_TYPES.APPLICATION, ENTITY_TYPES.PERSON];

/** Question shaped by what is actually missing. */
export function questionFor(field, kind) {
  if (field === "application") return "Which application should I use?";
  if (kind === "multiple_applications") return "Which one should I act on?";
  if (field === "target") return "What should I act on?";
  return "Could you say that again with a bit more detail?";
}

/**
 * @param {string} text
 * @param {object} opts
 * @param {Array}  [opts.entities]
 * @param {string} [opts.primary] primary request type
 * @param {object} [opts.steps] understood steps (objects prove a target exists)
 * @param {object} [opts.context] { previousTarget?: string, previousTargetType?: string, conditional?: boolean }
 * @returns {{ambiguous:boolean, markers:Array, clarification:object|null}}
 */
export function analyzeAmbiguity(text, { entities = [], primary = REQUEST_TYPES.UNKNOWN, steps = [], context = {} } = {}) {
  const raw = String(text ?? "");
  const markers = [];
  const words = normalizeForComparison(raw).split(" ").filter(Boolean);
  const appOrPerson = entities.filter((e) => APPLICATION_OR_PERSON.includes(e.type));
  const applications = entities.filter((e) => e.type === ENTITY_TYPES.APPLICATION);
  const entityTarget = entities.some((e) => [ENTITY_TYPES.QUOTED, ENTITY_TYPES.URL, ...APPLICATION_OR_PERSON].includes(e.type));
  const mutating = isMutatingRequest(primary);

  // A named control ("the Save button") is a target too: an object the step
  // actually acts on counts, as long as it is not itself a reference.
  const objectTarget = (steps || [])
    .filter((s) => !s.conditional)
    .some((s) => {
      const object = String(s.object ?? "").trim().toLowerCase();
      if (!object) return false;
      if (REFERENCE_WORDS.includes(object)) return false;
      return !VAGUE_TARGETS.includes(object);
    });
  const anyTarget = entityTarget || objectTarget;

  // Some requests need an APPLICATION specifically; "open it" cannot be
  // satisfied by the person name that happens to appear in the query.
  const needsApplication = [
    REQUEST_TYPES.APPLICATION,
    REQUEST_TYPES.BROWSER,
    REQUEST_TYPES.FILE,
    REQUEST_TYPES.SYSTEM,
    REQUEST_TYPES.NAVIGATION,
  ].includes(primary);

  // 149. An unresolved reference with nothing in this utterance to bind to.
  // A remembered target only counts when it is the right KIND of thing: a
  // person name from the previous command cannot resolve "open it".
  const remembersKind = needsApplication
    ? context.previousTargetType === ENTITY_TYPES.APPLICATION
    : Boolean(context.previousTarget);
  const reference = words.find((w) => REFERENCE_WORDS.includes(w));
  const referenceResolvable = needsApplication ? applications.length > 0 : appOrPerson.length > 0;
  const bindsInCondition = Boolean(context.conditional); // "if the file is open then save it" — the condition supplies the object
  if (reference && mutating && !referenceResolvable && !remembersKind && !bindsInCondition) {
    markers.push({
      kind: "unresolved_reference",
      text: reference,
      field: needsApplication ? "application" : "target",
      question: needsApplication ? questionFor("application") : `What does "${reference}" refer to?`,
      candidates: [],
    });
  }

  // 149. A placeholder instead of an object.
  if (mutating) {
    const vague = VAGUE_TARGETS.find((v) => new RegExp(`\\b${v}\\b`, "i").test(raw));
    if (vague && !anyTarget) {
      markers.push({ kind: "vague_target", text: vague, field: "target", question: questionFor("target"), candidates: [] });
    }
  }

  // 145/149. Two applications mentioned for one single-step action.
  if (applications.length > 1 && !/\b(and then|then|after that)\b/i.test(raw)) {
    markers.push({
      kind: "multiple_applications",
      text: applications.map((a) => a.text).join(", "),
      field: "application",
      question: questionFor("application", "multiple_applications"),
      candidates: applications.map((a) => a.value),
    });
  }

  // 151. Nothing to act on at all for a mutating request. A bound reference or
  // a conditional utterance is exempt: the object is supplied by context
  // ("open it" after WhatsApp) or by the condition ("if the file is open then
  // save it").
  const referenceBound = Boolean(reference) && (referenceResolvable || remembersKind);
  if (mutating && !anyTarget && markers.length === 0 && !bindsInCondition && !referenceBound) {
    const asksForApplication = primary === REQUEST_TYPES.APPLICATION || primary === REQUEST_TYPES.BROWSER;
    markers.push({
      kind: asksForApplication ? "missing_application" : "missing_target",
      text: "",
      field: asksForApplication ? "application" : "target",
      question: questionFor(asksForApplication ? "application" : "target"),
      candidates: [],
    });
  }

  // 152. Never ask when asking would be noise: questions, cancellations and
  // requests that are clearly informational are answered, not interrogated.
  const unnecessary = !mutating || primary === REQUEST_TYPES.QUESTION || primary === REQUEST_TYPES.INFORMATION || primary === REQUEST_TYPES.UNKNOWN;
  const blocking = markers.filter((m) => m.kind !== "vague_target" || !/\bjust\b/i.test(raw));
  const clarification = unnecessary || blocking.length === 0
    ? null
    : {
        required: true,
        field: blocking[0].field,
        question: blocking[0].question,
        candidates: blocking[0].candidates,
      };

  return { ambiguous: markers.length > 0, markers, clarification }; // 150
}

/** Human-readable summary used in logs and audit records. */
export function describeAmbiguity(analysis) {
  return {
    ambiguous: analysis.ambiguous,
    kinds: analysis.markers.map((m) => m.kind),
    clarification: analysis.clarification ? analysis.clarification.question : null,
  };
}
