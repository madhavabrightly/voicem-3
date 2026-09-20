/**
 * P3: Intent + Task Engine (Tickets 201–300)
 *
 * Public API export for the task engine pipeline.
 */
export { TaskEngine, PERCEPTION_METHODS, TOOL_BY_STEP } from "./task_engine.js";
export {
  COMMAND_SOURCES,
  commandFingerprint,
  normalizeCommandText,
  toStructuredCommand,
} from "./command_contract.js";
export {
  COMMAND_TYPES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TASK_TIMEOUT_MS,
  SUPPORTED_APPLICATIONS,
  applyClarification,
  buildTaskSpec,
  detectAmbiguity,
  detectApplication,
  detectCommandType,
  detectConfirmationRequirements,
  detectConstraints,
  detectDependencies,
  detectExpectedResult,
  detectImpossibleTask,
  detectMissingInformation,
  detectPriority,
  detectRequestedAction,
  detectTargetEntity,
} from "./task_spec.js";
export {
  NODE_STATUS,
  NODE_TYPES,
  TaskGraph,
  buildClarification,
  buildTaskGraph,
} from "./task_graph.js";
export { TaskTracker } from "./task_tracker.js";
export { ALLOWED_TRANSITIONS, TASK_STATUS, TERMINAL_STATUSES, TaskStateMachine } from "./task_state_machine.js";
export { EVENT_NAMES, TaskEventBus } from "./task_events.js";
export { TaskHistory, buildAuditRecord } from "./task_history.js";
