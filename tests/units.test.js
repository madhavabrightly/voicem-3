import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRisk, requiresConfirmation } from "../backend/agent/risk.js";
import { plan } from "../backend/agent/planner.js";

test("risk: open/search/scroll are low", () => {
  assert.equal(classifyRisk({ type: "open_app", target: "WhatsApp" }), "low");
  assert.equal(classifyRisk({ type: "scroll", target: "down" }), "low");
});

test("risk: type is medium", () => {
  assert.equal(classifyRisk({ type: "type", target: "search" }), "medium");
});

test("risk: send/delete/pay are high", () => {
  assert.equal(classifyRisk({ type: "send", target: "message" }), "high");
  assert.equal(classifyRisk({ type: "delete", target: "data" }), "high");
  assert.equal(classifyRisk({ type: "pay", target: "order" }), "high");
});

test("requiresConfirmation gates medium and high, not low", () => {
  assert.equal(requiresConfirmation({ type: "open_app", target: "WhatsApp" }, {}), null);
  assert.equal(requiresConfirmation({ type: "type", target: "search" }, {}), "medium");
  assert.equal(requiresConfirmation({ type: "send", target: "msg" }, {}), "high");
});

test("planner: open-and-search goal yields ordered steps", () => {
  const steps = plan("Open WhatsApp and search for Dad");
  const types = steps.map((s) => s.type);
  assert.deepEqual(types, ["open_app", "wait", "read_screen", "find_element", "click", "type", "wait", "read_screen"]);
  assert.equal(steps[0].target, "WhatsApp");
  assert.equal(steps[5].args.text, "Dad");
  assert.equal(steps[5].risk, "medium");
});

test("planner: unknown goal gives empty steps", () => {
  assert.equal(plan("tell me a joke").length, 0);
});