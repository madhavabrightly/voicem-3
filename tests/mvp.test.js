import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgent } from "../backend/api/server.js";
import { ScreenModel } from "../backend/perception/screen_model.js";

/**
 * End-to-end MVP test: "Open WhatsApp and search for Dad."
 * Simulates the desktop with fake perception + fake platform, following
 * the ACT -> OBSERVE -> VERIFY loop exactly as a live system would.
 */

function makeFakePlatform() {
  const calls = [];
  const driver = {
    launch: async (app) => { calls.push(`launch:${app}`); return { success: true }; },
    focus: async (app) => { calls.push(`focus:${app}`); return { success: true }; },
    click: async (x, y) => { calls.push(`click:${x},${y}`); return { success: true }; },
    typeText: async (t) => { calls.push(`type:${t}`); return { success: true }; },
    pressKey: async (k) => { calls.push(`press:${k}`); return { success: true }; },
    scroll: async (d) => { calls.push(`scroll:${d}`); return { success: true }; },
    capture: async () => { calls.push("capture"); return { success: true }; },
  };
  return { driver, calls };
}

function makeFakePerception() {
  let phase = "closed";
  return {
    // realtime model depending on what has been done
    current: () => {
      if (phase === "chat_list") {
        return new ScreenModel({
          application: "WhatsApp",
          screen: "chat_list",
          confidence: 0.9,
          source: "vision",
          elements: [
            { type: "application", name: "WhatsApp", coordinates: { x: 10, y: 10 } },
            { type: "search", name: "search_box", coordinates: { x: 200, y: 40 } },
            { type: "contact", name: "Dad", coordinates: { x: 200, y: 120 }, action: "open" },
          ],
        });
      }
      return new ScreenModel({ application: "none", screen: "desktop", confidence: 0.9, source: "vision" });
    },
    perceive: async () => {
      // simulate screen state transition after open_app
      return phase === "closed" ? new ScreenModel({ application: "none", screen: "desktop", confidence: 0.9, source: "vision" }) : new ScreenModel({
        application: "WhatsApp",
        screen: "chat_list",
        confidence: 0.9,
        source: "vision",
        elements: [
          { type: "application", name: "WhatsApp", coordinates: { x: 10, y: 10 } },
          { type: "search", name: "search_box", coordinates: { x: 200, y: 40 } },
          { type: "contact", name: "Dad", coordinates: { x: 200, y: 120 }, action: "open" },
        ],
      });
    },
    verify: async () => ({ success: true, data: {} }),
    transition: (p) => { phase = p; },
  };
}

test("MVP: 'Open WhatsApp and search for Dad' completes with voice response", async () => {
  const { driver, calls } = makeFakePlatform();
  const fakePerception = makeFakePerception();
  const { orchestrator } = buildAgent({
    platformImpl: driver,
    visionAnalyze: async () => fakePerception.current(),
    config: { agent: { requireConfirmationFor: [], maxRetriesPerAction: 2 } },
  });

  // Simulate WhatsApp appearing shortly after launch: switch phase during run.
  const origOpen = driver.launch;
  driver.launch = async (app) => { const r = await origOpen(app); if (app === "WhatsApp") { fakePerception.transition("chat_list"); } return r; };

  const result = await orchestrator.run("Open WhatsApp and search for Dad");

  assert.equal(result.final.success, true);
  assert.equal(result.spoken, "Done.");
  assert.equal(result.task.status, "done");
  // The type step should have typed "Dad".
  assert.ok(calls.includes("type:Dad"));
  // open and search path exercised.
  assert.ok(calls.includes("launch:WhatsApp"));
  assert.ok(calls.some((c) => c.startsWith("click:")));
});

test("high-risk action requires user confirmation", async () => {
  const { classifyRisk, requiresConfirmation } = await import("../backend/agent/risk.js");
  assert.equal(requiresConfirmation({ type: "open_app", target: "WhatsApp" }, {}), null);
  assert.equal(requiresConfirmation({ type: "type", target: "search" }, {}), "medium");
  assert.equal(requiresConfirmation({ type: "send", target: "message" }, {}), "high");
});