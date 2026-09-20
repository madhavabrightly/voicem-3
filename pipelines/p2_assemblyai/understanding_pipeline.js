/**
 * P2 — Transcript Understanding (tickets 121–184).
 *
 *   P1 final turn ──▶ hygiene ──▶ segmentation ──▶ entities ──▶ request type
 *                 ──▶ ambiguity ──▶ command risk ──▶ StructuredCommand
 *                 ──▶ strict schema validation ──▶ P3 Task Engine
 *
 * Tickets covered here:
 *  168. Store command in task state (per-session history).
 *  169. Send command to orchestrator (via the `onCommand` dispatch hook).
 *  170. Track command latency.
 *  171. Track AssemblyAI latency.
 *  172. Track transcript confidence if available.
 *  173. Log command lifecycle.
 *  174, 176, 177, 183, 184 — turn timeouts, voice failure, UI notification.
 *  177 also covers the final-transcript wait; see `turn_guard.js`.
 *  178. Handle malformed event.   181/182. Retry + retry limit → delegated to P1.
 *  179. Handle unknown event.     180. Handle SDK exception.
 *  175. Handle AssemblyAI disconnect (reconnect itself is P1's, ticket 035/036).
 *
 * The module never rewrites the user's words: `text` is the command text P2
 * understood (the post-correction form when the user corrected themselves) and
 * `originalText` is always the exact transcript.
 */
import { inspectUtterance, stripFiller } from "./utterance_hygiene.js";
import { segmentPhrases, describeSteps } from "./phrase_segmenter.js";
import { extractEntities, ENTITY_TYPES, APPLICATION_VOCABULARY } from "./entity_preserver.js";
import { classifyRequest, REQUEST_TYPES } from "./request_classifier.js";
import { analyzeAmbiguity } from "./ambiguity_analyzer.js";
import { classifyCommandRisk } from "./command_risk.js";
import { validateStructuredCommand } from "./command_schema.js";
import { TurnGuard } from "./turn_guard.js";

/** Semantic intents P2 assigns (task typing stays in P3). */
export const COMMAND_INTENTS = {
  CANCELLATION: "cancellation", // 121
  CORRECTION: "correction", // 122
  REPEAT: "repeat", // 123
  ANSWER: "answer", // 138/139 — informational, nothing to execute
  EXECUTE: "execute", // 140
};

function intentFor(hygiene, requestType) {
  if (hygiene.cancellation.detected) return COMMAND_INTENTS.CANCELLATION;
  if (hygiene.correction.detected) return COMMAND_INTENTS.CORRECTION;
  if (hygiene.repeated.detected) return COMMAND_INTENTS.REPEAT;
  if ([REQUEST_TYPES.QUESTION, REQUEST_TYPES.INFORMATION, REQUEST_TYPES.VERIFICATION].includes(requestType)) return COMMAND_INTENTS.ANSWER;
  return COMMAND_INTENTS.EXECUTE;
}

export class TranscriptUnderstanding {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.clock]
   * @param {object} [opts.logger] structured logger ({ log(stage,event,data) })
   * @param {string[]} [opts.contacts] known contact names (entity boost)
   * @param {string[]} [opts.applications] application vocabulary override
   * @param {object} [opts.policy] { confirmOn: string[] }
   * @param {(command:object) => any} [opts.onCommand] 169 — dispatch hook
   * @param {(failure:object) => any} [opts.onFailure] 183/184 — voice + UI failure
   * @param {number} [opts.turnTimeoutMs]
   * @param {Function} [opts.schedule] timer injection for the turn guard
   * @param {Function} [opts.cancel]
   */
  constructor({
    clock = () => Date.now(),
    logger = null,
    contacts = [],
    applications = APPLICATION_VOCABULARY,
    policy = {},
    onCommand = null,
    onFailure = null,
    turnTimeoutMs = 15000,
    schedule = setTimeout,
    cancel = clearTimeout,
  } = {}) {
    this.clock = clock;
    this.logger = logger;
    this.contacts = contacts;
    this.applications = applications;
    this.policy = { confirmOn: ["high"], ...policy };
    this.onCommand = onCommand;
    this.onFailure = onFailure;
    this.sessions = new Map();
    this.metrics = { commands: 0, rejected: 0, partials: 0, unknownEvents: 0, failures: 0, lastCommandLatencyMs: null };
    this.guard = new TurnGuard({
      clock,
      timeoutMs: turnTimeoutMs,
      schedule,
      cancel,
      onTimeout: (info) => {
        // 177 → 183/184: no final arrived, so this is a voice failure, not a task.
        this._fail("final_transcript_timeout", info);
      },
    });
  }

  /** Per-session context: repeat detection, targets, stored commands (196/197). */
  session(sessionId = null) {
    const key = sessionId ?? "default";
    if (!this.sessions.has(key)) {
      this.sessions.set(key, { id: key, commands: [], lastCommandText: null, lastTarget: null, turnOrder: null });
    }
    return this.sessions.get(key);
  }

  /**
   * 121–184. Turn a transcript into a validated StructuredCommand.
   *
   * @param {string} input exact transcript text
   * @param {object} [meta] { sessionId, turnId, timestamp, confidence, source, assemblyAiLatencyMs }
   * @returns {{ok:boolean, command?:object, errors?:Array, reason?:string}}
   */
  understand(input, meta = {}) {
    const raw = typeof input === "string" ? input : String(input?.text ?? "");
    const session = this.session(meta.sessionId ?? null);

    // 178-adjacent: an empty transcript is never a command.
    if (raw.trim().length === 0) {
      this.metrics.rejected += 1;
      this._log("decision", "command_rejected", { reason: "empty_transcript", sessionId: session.id });
      return { ok: false, reason: "empty_transcript", errors: [{ path: "text", message: "empty transcript" }] };
    }

    // 121–125. Hygiene first: cancellation, correction, repeat, filler.
    const hygiene = inspectUtterance(raw, { previous: session.lastCommandText });

    // The command text P2 understood: the corrected tail when the user
    // corrected themselves, otherwise the utterance. Filler is stripped so the
    // text every span is validated against is the text that was parsed;
    // `originalText` always keeps the exact transcript untouched.
    const effective = hygiene.correction.detected && hygiene.correction.replacement ? hygiene.correction.replacement : raw;
    const stripped = stripFiller(effective);
    const commandText = stripped.cleaned;

    // A cancellation carries no steps and no request type — it stops a task.
    if (hygiene.cancellation.detected) {
      const command = {
        text: commandText || raw,
        originalText: raw,
        cleaned: commandText,
        source: meta.source ?? "voice",
        sessionId: meta.sessionId ?? null,
        turnId: meta.turnId ?? null,
        timestamp: meta.timestamp ?? null,
        confidence: meta.confidence ?? null,
        intent: COMMAND_INTENTS.CANCELLATION,
        requestType: REQUEST_TYPES.UNKNOWN,
        requestTypes: [REQUEST_TYPES.UNKNOWN],
        entities: [],
        clauses: [],
        actionSequence: [],
        ambiguity: { ambiguous: false, markers: [] },
        clarification: null,
        risk: classifyCommandRisk("", { primary: REQUEST_TYPES.UNKNOWN, confirmOn: this.policy.confirmOn }),
        confirmationRequired: false,
        cancelled: true,
        repeated: hygiene.repeated,
        filler: { removed: stripped.removed },
        correction: hygiene.correction,
        cancellation: hygiene.cancellation,
        latency: { commandLatencyMs: meta.timestamp ? Math.max(0, this.clock() - meta.timestamp) : null, assemblyAiLatencyMs: meta.assemblyAiLatencyMs ?? null },
        turn: { sessionId: meta.sessionId ?? null, turnId: meta.turnId ?? null, turnOrder: meta.turnOrder ?? null },
      };
      const cancelled = validateStructuredCommand(command);
      if (!cancelled.valid) {
        this.metrics.rejected += 1;
        return { ok: false, reason: "schema_invalid", errors: cancelled.errors, command };
      }
      this.metrics.commands += 1;
      this._log("decision", "command_created", { sessionId: command.sessionId, intent: command.intent, cancelled: true });
      return { ok: true, command };
    }

    // 133–136, 126–132, 137–148, 149–152, 153–164.
    const segmentation = segmentPhrases(commandText);
    const entities = extractEntities(commandText, { contacts: this.contacts, applications: this.applications });
    const request = classifyRequest(commandText, { entities, segmentation });
    const steps = describeSteps(segmentation);
    const ambiguity = analyzeAmbiguity(commandText, {
      entities,
      primary: request.primary,
      steps,
      context: {
        previousTarget: session.lastTarget?.value ?? null,
        previousTargetType: session.lastTarget?.type ?? null,
        conditional: segmentation.conditional,
      },
    });
    const risk = classifyCommandRisk(commandText, { primary: request.primary, confirmOn: this.policy.confirmOn });

    const startedAt = meta.timestamp ?? null;
    const command = {
      text: commandText,
      originalText: raw,
      cleaned: hygiene.cleaned,
      source: meta.source ?? "voice",
      sessionId: meta.sessionId ?? null,
      turnId: meta.turnId ?? null,
      timestamp: meta.timestamp ?? null,
      confidence: meta.confidence ?? null, // 172 — null when the transport has none
      intent: intentFor(hygiene, request.primary),
      requestType: request.primary,
      requestTypes: request.all,
      entities, // 126–132
      clauses: segmentation.clauses, // 133–136
      actionSequence: steps, // 134/135 — understood steps, not executable tools
      ambiguity: { ambiguous: ambiguity.ambiguous, markers: ambiguity.markers }, // 149/150
      clarification: ambiguity.clarification, // 151/152
      risk, // 153–164
      confirmationRequired: risk.confirmationRequired, // 164
      cancelled: hygiene.cancellation.detected,
      repeated: hygiene.repeated, // 123
      filler: { removed: stripped.removed },
      correction: hygiene.correction, // 122
      cancellation: hygiene.cancellation,
      latency: {
        commandLatencyMs: startedAt !== null ? Math.max(0, this.clock() - startedAt) : null, // 170
        assemblyAiLatencyMs: meta.assemblyAiLatencyMs ?? null, // 171
      },
      // Bookkeeping for P3's duplicate/latency/turn tracking.
      turn: { sessionId: meta.sessionId ?? null, turnId: meta.turnId ?? null, turnOrder: meta.turnOrder ?? null },
    };

    // 166/167. Strict validation — a malformed command is refused, never sent on.
    const validation = validateStructuredCommand(command);
    if (!validation.valid) {
      this.metrics.rejected += 1;
      this._log("decision", "command_rejected", { reason: "schema_invalid", errors: validation.errors, sessionId: session.id });
      return { ok: false, reason: "schema_invalid", errors: validation.errors, command };
    }

    // 168. Store command in (session) task state.
    session.commands.push(command);
    session.lastCommandText = commandText;
    session.turnOrder = command.turn.turnOrder ?? session.turnOrder;
    const target = entities.find((e) => [ENTITY_TYPES.APPLICATION, ENTITY_TYPES.PERSON, ENTITY_TYPES.QUOTED].includes(e.type));
    if (target) session.lastTarget = { value: target.value, type: target.type };

    this.metrics.commands += 1;
    this.metrics.lastCommandLatencyMs = command.latency.commandLatencyMs;
    // 173. Log command lifecycle.
    this._log("decision", "command_created", {
      sessionId: command.sessionId,
      turnId: command.turnId,
      intent: command.intent,
      requestType: command.requestType,
      entities: entities.length,
      steps: command.actionSequence.length,
      ambiguous: command.ambiguity.ambiguous,
      risk: command.risk.level,
      commandLatencyMs: command.latency.commandLatencyMs,
    });

    // 169. Send command to the orchestrator/task engine.
    if (this.onCommand) {
      try {
        this.onCommand(command);
      } catch (err) {
        this._fail("dispatch_failed", { error: String(err?.message || err) }); // 180
      }
    }

    return { ok: true, command };
  }

  /**
   * 174–184. Transport-facing entry point: feed raw AssemblyAI turn events.
   * Partials only keep the turn alive; only a completed turn becomes a command.
   */
  handleTurnEvent(event, meta = {}) {
    try {
      // 178. Malformed event.
      if (!event || typeof event !== "object") {
        return this._fail("malformed_event", { detail: String(event) });
      }
      // 179. Unknown event kind — counted and ignored, never a command.
      if (event.type && !["turn", "transcript", "final", "partial"].includes(event.type)) {
        this.metrics.unknownEvents += 1;
        this._log("decision", "unknown_event_ignored", { type: event.type, sessionId: meta.sessionId ?? null });
        return { ok: false, reason: "unknown_event", ignored: true };
      }

      const isFinal = event.end_of_turn === true || event.type === "final";
      if (!isFinal) {
        // 176. A partial proves the turn is alive: re-arm the guard.
        this.metrics.partials += 1;
        this.guard.touch({ sessionId: meta.sessionId ?? null, turnOrder: event.turn_order ?? null });
        return { ok: false, reason: "partial", ignored: true };
      }

      this.guard.clear(); // 177. Turn completed.
      return this.understand(event.transcript ?? "", {
        ...meta,
        turnId: meta.turnId ?? event.turn_order ?? null,
        turnOrder: event.turn_order ?? null,
        timestamp: meta.timestamp ?? event.timestamp ?? null,
      });
    } catch (err) {
      // 180. SDK/consumer exception never escapes as a crash.
      return this._fail("sdk_exception", { error: String(err?.message || err) });
    }
  }

  /**
   * 175. The stream dropped mid-turn. Reconnecting is P1's job (035/036); the
   * understanding layer discards the incomplete turn and reports the failure.
   */
  handleDisconnect(detail = {}) {
    this.guard.clear();
    return this._fail("assemblyai_disconnect", detail);
  }

  /** Arm the final-transcript window (called when a turn starts). */
  beginTurn(meta = {}) {
    return this.guard.arm({ sessionId: meta.sessionId ?? null, turnOrder: meta.turnOrder ?? null, timeoutMs: meta.timeoutMs });
  }

  /** 183/184. Report a voice failure to the voice + UI layers. */
  _fail(reason, detail = {}) {
    this.metrics.failures += 1;
    const failure = { reason, detail, at: this.clock(), retryDelegatedTo: ["assemblyai_disconnect", "final_transcript_timeout"].includes(reason) ? "p1" : null };
    this._log("verification", "voice_failure", { reason, detail });
    if (this.onFailure) {
      try {
        this.onFailure(failure);
      } catch (err) {
        this._log("verification", "failure_notification_failed", { error: String(err?.message || err) });
      }
    }
    return { ok: false, reason, detail, failure };
  }

  /** 196. Drop one session's context (isolation between sessions). */
  resetSession(sessionId = null) {
    this.sessions.delete(sessionId ?? "default");
    return true;
  }

  /** 198. Shutdown: no timers left, no further commands. */
  close() {
    this.guard.clear();
    this.sessions.clear();
    return { commands: this.metrics.commands, failures: this.metrics.failures };
  }

  getMetrics() {
    return { ...this.metrics, guard: this.guard.getState(), sessions: this.sessions.size };
  }

  _log(stage, event, data) {
    if (!this.logger || typeof this.logger.log !== "function") return;
    try {
      this.logger.log(stage, event, data);
    } catch {
      // logging must never break understanding
    }
  }
}
