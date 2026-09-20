import { test } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../backend/agent/orchestrator.js";
import { ToolResult } from "../backend/core/result.js";

/**
 * Orchestrator recovery paths on the live-desktop stack:
 *   - a step whose effect never verifies is a FAILURE (never a false success)
 *   - a step that loses the foreground is recovered (Escape + refocus) and
 *     retried, rather than blindly re-acted on a foreign window
 */

function makeToolBox() {
  const calls = [];
  const recovered = [];
  return {
    calls,
    recovered,
    run: async (step) => {
      calls.push(step.type);
      if (step.type === "find_element") {
        return ToolResult.ok("find_element", { element: { type: "search_box", coordinates: { x: 200, y: 40 } } });
      }
      return ToolResult.ok(step.type, {});
    },
    recover: async (args) => {
      recovered.push(args);
      return ToolResult.ok("recover", args);
    },
  };
}

function makePerception(answer) {
  const seen = [];
  return {
    seen,
    verify: async (step) => {
      seen.push(step.type);
      return answer(step, seen.filter((s) => s === step.type).length);
    },
    perceive: async () => ({ confidence: 0.9, elements: [], toJSON: () => ({ confidence: 0.9, elements: [] }) }),
  };
}

test("orchestrator: a step that never verifies fails honestly instead of reporting success", async () => {
  const toolBox = makeToolBox();
  const perception = makePerception((step) =>
    step.type === "type" ? { success: false, data: { note: "no query read" } } : { success: true, data: {} }
  );
  const orchestrator = new Orchestrator({ perception, toolBox }, { agent: { requireConfirmationFor: [], maxRetriesPerAction: 2 } });

  const result = await orchestrator.run("Open WhatsApp and search for Dad");

  assert.equal(result.final.success, false);
  assert.equal(result.task.status, "failed");
  assert.match(result.final.error, /Could not verify type/);
  // The step is retried up to the budget, then reported — never marked executed.
  assert.equal(perception.seen.filter((s) => s === "type").length, 2);
  assert.equal(result.task.executed.some((e) => e.step === "type"), false);
});

test("orchestrator: foreground drift triggers recovery and the step is retried", async () => {
  const toolBox = makeToolBox();
  const drift = { expected: { proc: "opera", title: "(21) WhatsApp Business - Opera" }, actual: { proc: "notepad", title: "Untitled - Notepad" } };
  const perception = makePerception((step, attempt) =>
    step.type === "click" && attempt === 1 ? { success: false, data: { drift } } : { success: true, data: {} }
  );
  const orchestrator = new Orchestrator({ perception, toolBox }, { agent: { requireConfirmationFor: [], maxRetriesPerAction: 3 } });

  const result = await orchestrator.run("Open WhatsApp and search for Dad");

  assert.equal(result.final.success, true, result.final.error);
  // Recovery dismissed the interloper and refocused the task app.
  assert.deepEqual(toolBox.recovered[0], { refocus: "WhatsApp" });
  // The click was re-acted after recovery.
  assert.equal(toolBox.calls.filter((c) => c === "click").length, 2);
});

test("orchestrator: a non-drift failure does not trigger recovery", async () => {
  const toolBox = makeToolBox();
  const perception = makePerception((step, attempt) =>
    step.type === "click" && attempt === 1 ? { success: false, data: { note: "no search box" } } : { success: true, data: {} }
  );
  const orchestrator = new Orchestrator({ perception, toolBox }, { agent: { requireConfirmationFor: [], maxRetriesPerAction: 2 } });

  const result = await orchestrator.run("Open WhatsApp and search for Dad");

  assert.equal(result.final.success, true, result.final.error);
  assert.equal(toolBox.recovered.length, 0);
  assert.equal(toolBox.calls.filter((c) => c === "click").length, 2);
});
