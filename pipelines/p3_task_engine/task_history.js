/**
 * P3 tickets 262–263: audit record + stored task history.
 *
 *  262. Generate audit record.
 *  263. Store task history.
 */

/**
 * 262. Build the audit record for a finished (or aborted) task. Everything in
 * it is copied from the live tracker/events — no reconstructed narrative.
 */
export function buildAuditRecord({ taskId, spec = null, tracker = null, events = [], result = null, reason = null }) {
  const snapshot = tracker?.toJSON ? tracker.toJSON() : tracker || {};
  const understanding = spec?.understanding || null;
  return {
    taskId,
    command: spec?.command?.text ?? null,
    originalCommand: understanding?.originalText ?? spec?.command?.original ?? null,
    commandType: spec?.commandType ?? null,
    application: spec?.application ?? null,
    expectedResult: spec?.expectedResult ?? null,
    // Understanding metadata P2 produced (null when the command was raw text).
    intent: understanding?.intent ?? null,
    requestType: understanding?.requestType ?? null,
    entities: understanding?.entities ?? null,
    ambiguity: understanding?.ambiguity ?? null,
    commandRisk: understanding?.risk ?? null,
    commandConfirmationRequired: spec?.constraints?.commandRequiresConfirmation ?? false,
    actionConfirmationRequired: spec?.constraints?.requiresConfirmation ?? false,
    confidence: spec?.command?.confidence ?? null,
    commandLatencyMs: understanding?.latency?.commandLatencyMs ?? null,
    assemblyAiLatencyMs: understanding?.latency?.assemblyAiLatencyMs ?? null,
    turnId: spec?.command?.turnId ?? null,
    sessionId: spec?.command?.sessionId ?? null,
    status: result?.status ?? null,
    success: result?.success ?? null,
    reason: reason || result?.failureReason || null,
    completedNodes: snapshot.completed || [],
    failedNodes: snapshot.failed || [],
    skippedNodes: snapshot.skipped || [],
    retries: snapshot.retries || {},
    totalRetries: snapshot.totalRetries ?? 0,
    durationMs: snapshot.durationMs ?? 0,
    currentApplication: snapshot.currentApplication ?? null,
    currentScreen: snapshot.currentScreen ?? null,
    expectedElement: snapshot.expectedElement ?? null,
    eventCount: events.length,
    events: events.map((e) => ({ seq: e.seq, name: e.name, event: e.event, at: e.at })),
  };
}

/**
 * 263. Bounded, in-memory task history. It is the record the UI/UX and the
 * next session read back; nothing is deleted while a task is still referenced.
 */
export class TaskHistory {
  constructor({ limit = 50, clock = () => Date.now() } = {}) {
    this.limit = limit;
    this.clock = clock;
    this.records = [];
  }

  /** Store a task record (oldest trimmed once the limit is reached). */
  add(record) {
    this.records.push({ ...record, storedAt: this.clock() });
    while (this.records.length > this.limit) this.records.shift();
    return record;
  }

  get(taskId) {
    return this.records.find((r) => r.taskId === taskId) || null;
  }

  list() {
    return this.records.map((r) => ({ ...r }));
  }

  get size() {
    return this.records.length;
  }

  /** 283. Cleanup: keep only the newest `keep` records (or drop one task). */
  cleanup({ keep = null, taskId = null } = {}) {
    if (taskId) {
      const before = this.records.length;
      this.records = this.records.filter((r) => r.taskId !== taskId);
      return before - this.records.length;
    }
    if (keep !== null && this.records.length > keep) {
      const removed = this.records.length - keep;
      this.records = this.records.slice(-keep);
      return removed;
    }
    return 0;
  }

  /** 296. Task state persistence — export/restore the history as JSON. */
  export() {
    return JSON.stringify({ limit: this.limit, records: this.records });
  }

  load(serialized) {
    const parsed = typeof serialized === "string" ? JSON.parse(serialized) : serialized;
    this.limit = parsed?.limit ?? this.limit;
    this.records = (parsed?.records || []).map((r) => ({ ...r }));
    return this.records.length;
  }
}
