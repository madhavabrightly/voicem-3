/**
 * P2 tickets 165–167 — the StructuredCommand schema.
 *
 *  165. Create structured command object.
 *  166. Validate command schema.
 *  167. Reject malformed command.
 *
 * The schema is strict on purpose: P3's duplicate detection, confidence,
 * latency and turn tracking were all designed to consume this metadata, so a
 * command that is missing it (or carries a span that does not match the text it
 * claims to describe) must be refused rather than half-consumed.
 */
import { ENTITY_TYPES } from "./entity_preserver.js";
import { REQUEST_TYPES } from "./request_classifier.js";
import { COMMAND_RISK_LEVEL } from "./command_risk.js";

export const COMMAND_SOURCES = ["voice", "text", "ui"];

/** Field descriptor table — kept declarative so validation stays auditable. */
export const COMMAND_SCHEMA = {
  text: { required: true, type: "nonEmptyString" },
  source: { required: true, type: "enum", values: COMMAND_SOURCES },
  sessionId: { required: true, type: "nullableString" },
  turnId: { required: true, type: "nullableStringOrNumber" },
  timestamp: { required: true, type: "nullableNumber" },
  confidence: { required: true, type: "nullableConfidence" },
  intent: { required: true, type: "string" },
  requestType: { required: true, type: "enum", values: [...Object.values(REQUEST_TYPES)] },
  entities: { required: true, type: "entities" },
  clauses: { required: true, type: "array" },
  actionSequence: { required: true, type: "array" },
  ambiguity: { required: true, type: "ambiguity" },
  clarification: { required: true, type: "nullableClarification" },
  risk: { required: true, type: "commandRisk" },
  confirmationRequired: { required: true, type: "boolean" },
  cancelled: { required: true, type: "boolean" },
  repeated: { required: true, type: "repeatInfo" },
  latency: { required: true, type: "latency" },
};

const TYPE_CHECKS = {
  nonEmptyString: (v) => typeof v === "string" && v.trim().length > 0,
  string: (v) => typeof v === "string",
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  nullableString: (v) => v === null || typeof v === "string",
  nullableStringOrNumber: (v) => v === null || typeof v === "string" || typeof v === "number",
  nullableNumber: (v) => v === null || (typeof v === "number" && Number.isFinite(v)),
  nullableConfidence: (v) => v === null || (typeof v === "number" && v >= 0 && v <= 1),
  enum: (v, descriptor) => descriptor.values.includes(v),
};

function checkField(name, descriptor, value, errors) {
  if (value === undefined) {
    if (descriptor.required) errors.push({ path: name, message: "missing required field" });
    return;
  }
  if (descriptor.type === "enum") {
    if (!TYPE_CHECKS.enum(value, descriptor)) {
      errors.push({ path: name, message: `expected one of ${descriptor.values.join(", ")}, got ${JSON.stringify(value)}` });
    }
    return;
  }
  if (descriptor.type === "entities") {
    if (!Array.isArray(value)) {
      errors.push({ path: name, message: "expected an array of entities" });
      return;
    }
    value.forEach((entity, index) => {
      const path = `${name}[${index}]`;
      if (!entity || typeof entity !== "object") {
        errors.push({ path, message: "entity must be an object" });
        return;
      }
      if (!Object.values(ENTITY_TYPES).includes(entity.type)) {
        errors.push({ path: `${path}.type`, message: `unknown entity type ${JSON.stringify(entity.type)}` });
      }
      if (typeof entity.text !== "string" || entity.text.length === 0) {
        errors.push({ path: `${path}.text`, message: "entity text must be a non-empty string" });
      }
      if (!Number.isInteger(entity.start) || !Number.isInteger(entity.end) || entity.end <= entity.start) {
        errors.push({ path: `${path}.span`, message: "entity span must be integers with end > start" });
      }
    });
    return;
  }
  if (descriptor.type === "ambiguity") {
    if (!value || typeof value !== "object" || typeof value.ambiguous !== "boolean" || !Array.isArray(value.markers)) {
      errors.push({ path: name, message: "expected { ambiguous: boolean, markers: array }" });
    }
    return;
  }
  if (descriptor.type === "nullableClarification") {
    if (value === null) return;
    if (typeof value !== "object" || typeof value.question !== "string" || value.question.length === 0) {
      errors.push({ path: name, message: "clarification must be null or { question: non-empty string }" });
    }
    return;
  }
  if (descriptor.type === "commandRisk") {
    if (!value || typeof value !== "object" || !Object.values(COMMAND_RISK_LEVEL).includes(value.level) || !Array.isArray(value.categories)) {
      errors.push({ path: name, message: `expected { level: one of ${Object.values(COMMAND_RISK_LEVEL).join(", ")}, categories: array }` });
    }
    return;
  }
  if (descriptor.type === "repeatInfo") {
    if (!value || typeof value !== "object" || typeof value.detected !== "boolean") {
      errors.push({ path: name, message: "expected { detected: boolean }" });
    }
    return;
  }
  if (descriptor.type === "latency") {
    if (!value || typeof value !== "object") {
      errors.push({ path: name, message: "expected a latency object" });
      return;
    }
    for (const key of ["commandLatencyMs", "assemblyAiLatencyMs"]) {
      const v = value[key];
      if (v !== null && (typeof v !== "number" || v < 0)) {
        errors.push({ path: `${name}.${key}`, message: "must be null or a non-negative number" });
      }
    }
    return;
  }
  const check = TYPE_CHECKS[descriptor.type];
  if (!check || !check(value, descriptor)) {
    errors.push({ path: name, message: `expected ${descriptor.type}, got ${JSON.stringify(value)}` });
  }
}

/**
 * 166. Validate a structured command. Returns every problem found, never throws.
 *
 * @param {object} command
 * @returns {{valid:boolean, errors:Array<{path:string,message:string}>}}
 */
export function validateStructuredCommand(command) {
  const errors = [];
  if (!command || typeof command !== "object") {
    return { valid: false, errors: [{ path: "", message: "command must be an object" }] };
  }

  for (const [name, descriptor] of Object.entries(COMMAND_SCHEMA)) {
    checkField(name, descriptor, command[name], errors);
  }

  // Entity spans must describe THIS text — the strongest guarantee that
  // preserved entities were never reworded or re-indexed.
  if (typeof command.text === "string" && Array.isArray(command.entities)) {
    command.entities.forEach((entity, index) => {
      if (typeof entity?.start !== "number" || typeof entity?.end !== "number") return;
      const slice = command.text.slice(entity.start, entity.end);
      if (slice !== entity.text) {
        errors.push({
          path: `entities[${index}]`,
          message: `entity text ${JSON.stringify(entity.text)} is not the original slice ${JSON.stringify(slice)} at ${entity.start}..${entity.end}`,
        });
      }
    });
  }

  // A clarification must be present exactly when the utterance is ambiguous.
  if (command.ambiguity && typeof command.ambiguity.ambiguous === "boolean") {
    if (command.ambiguity.ambiguous && !command.clarification) {
      errors.push({ path: "clarification", message: "an ambiguous command must carry its clarification question" });
    }
    if (!command.ambiguity.ambiguous && command.clarification) {
      errors.push({ path: "clarification", message: "a clarification question requires ambiguity to be marked" });
    }
  }

  return { valid: errors.length === 0, errors };
}

/** 167. Throw for malformed commands — used on the strict ingestion path. */
export function assertStructuredCommand(command) {
  const { valid, errors } = validateStructuredCommand(command);
  if (!valid) {
    const error = new Error(`malformed structured command: ${errors.map((e) => `${e.path} (${e.message})`).join("; ")}`);
    error.errors = errors;
    throw error;
  }
  return command;
}
