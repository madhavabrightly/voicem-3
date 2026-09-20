import { readFileSync } from "node:fs";
import { buildRealAgent } from "../backend/real_agent.js";
import { getLogger } from "../backend/core/logger.js";
import { TranscriptUnderstanding, validateStructuredCommand, UnderstandingTaskPipeline } from "../pipelines/p2_assemblyai/index.js";
import { TaskEngine } from "../pipelines/p3_task_engine/index.js";

/**
 * P1 → P2 → P3 live demo.
 *
 *   AssemblyAI final turn  (simulated here from the CLI argument)
 *     → P1   transport/transcript semantics (frozen; see pipelines/voice_input)
 *     → P2   understanding → StructuredCommand (entities, request type, risk)
 *     → P3   task engine → task graph → ACT → OBSERVE → VERIFY → RESULT
 *
 *   node demo/task-engine-demo.js "Open WhatsApp and search for Dad"
 *
 * On a real voice session the first argument is the FINAL transcript P1 emits;
 * everything after it runs unchanged.
 */
const goal = process.argv[2] || "Open WhatsApp and search for Dad";
const config = JSON.parse(readFileSync("config.json", "utf8"));
const logger = getLogger();
const { perception, toolBox, driver } = buildRealAgent({ config });

// 201/121–167. The understanding layer.
const understanding = new TranscriptUnderstanding({
  logger,
  onFailure: (failure) => logger.log("verification", "voice_failure", failure),
});

// 244–283. The task engine (approves medium/high command risk like the
// orchestrator's default confirmator does, since this demo is unattended).
const engine = new TaskEngine({
  perception,
  toolBox,
  logger,
  config,
  confirmator: {
    confirm: async (question) => {
      console.log(`[confirm] ${question} -> approved`);
      return true;
    },
  },
  sinks: {
    voice: (result) => console.log(`[voice] ${result.spoken}`),
    ui: (result) => console.log(`[ui] state=${result.ui.state} label=${result.ui.label}`),
  },
});

const pipeline = new UnderstandingTaskPipeline({ understanding, engine, logger });

try {
  const started = Date.now();

  // P1 hands over a completed turn. `turn_order`/`timestamp` are the metadata
  // P3's duplicate, latency and turn tracking were designed to receive.
  const turnEvent = { transcript: goal, end_of_turn: true, turn_order: 1 };
  const outcome = await pipeline.handleTurnEvent(turnEvent, {
    sessionId: "demo-session",
    timestamp: Date.now(),
    confidence: null, // P1 does not report confidence; P2 does not invent one
  });

  const wallClockMs = Date.now() - started;

  console.log("\n--- P2 UNDERSTANDING ---");
  if (!outcome.command) {
    console.log(JSON.stringify({ stage: outcome.stage, reason: outcome.reason }, null, 2));
  } else {
    const c = outcome.command;
    console.log(
      JSON.stringify(
        {
          text: c.text,
          originalText: c.originalText,
          intent: c.intent,
          requestType: c.requestType,
          entities: c.entities.map((e) => `${e.type}:${e.text}`),
          steps: c.actionSequence.map((s) => `${s.verb ?? "?"}(${s.object})`),
          ambiguous: c.ambiguity.ambiguous,
          clarification: c.clarification?.question ?? null,
          risk: c.risk.level,
          riskCategories: c.risk.categories.map((x) => x.id),
          confirmationRequired: c.confirmationRequired,
          schemaValid: validateStructuredCommand(c).valid,
        },
        null,
        2
      )
    );
  }

  console.log("\n--- P3 RESULT ---");
  console.log(
    JSON.stringify(
      {
        stage: outcome.stage,
        taskId: outcome.result?.taskId ?? outcome.taskId ?? null,
        status: outcome.result?.status ?? null,
        success: outcome.result?.success ?? false,
        spoken: outcome.result?.spoken ?? null,
        nodesCompleted: outcome.result?.completedNodes?.length ?? null,
        retries: outcome.result?.totalRetries ?? null,
        engineDurationMs: outcome.result?.durationMs ?? null,
        wallClockMs,
      },
      null,
      2
    )
  );

  const audit = outcome.result ? engine.history.get(outcome.result.taskId)?.audit : null;
  if (audit) {
    console.log("\n--- AUDIT (metadata P3 now receives from P2) ---");
    console.log(
      JSON.stringify(
        {
          intent: audit.intent,
          requestType: audit.requestType,
          entities: audit.entities?.map((e) => `${e.type}:${e.text}`),
          turnId: audit.turnId,
          sessionId: audit.sessionId,
          confidence: audit.confidence,
          commandLatencyMs: audit.commandLatencyMs,
          commandRisk: audit.commandRisk?.level ?? null,
          success: audit.success,
          events: audit.eventCount,
        },
        null,
        2
      )
    );
  }

  process.exitCode = outcome.result?.success ? 0 : 1;
} finally {
  driver.stop();
}
