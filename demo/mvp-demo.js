/**
 * Demo driver for the MVP: demonstrates the full loop
 *   Voice -> Understand -> Observe -> Act -> Verify -> Voice response
 * using a simulated desktop (fake perception + fake platform) so the
 * pipeline can be exercised end-to-end without a live Windows desktop.
 *
 * Run: node demo/mvp-demo.js
 */
import { buildAgent } from "../backend/api/server.js";
import { ScreenModel } from "../backend/perception/screen_model.js";

const FAKE_SCREEN = new ScreenModel({
  application: "WhatsApp",
  screen: "chat_list",
  confidence: 0.95,
  source: "vision",
  elements: [
    { type: "application", name: "WhatsApp", coordinates: { x: 10, y: 10 } },
    { type: "search", name: "search_box", coordinates: { x: 200, y: 40 } },
    { type: "contact", name: "Dad", coordinates: { x: 200, y: 120 }, action: "open" },
  ],
});

let phase = "closed";
function currentScreen() {
  return phase === "closed"
    ? new ScreenModel({ application: "none", screen: "desktop", confidence: 0.95, source: "vision" })
    : FAKE_SCREEN;
}

let launched = false;
const platform = {
  launch: async (app) => {
    console.log(`  [platform] launching ${app}`);
    launched = true;
    phase = "chat_list";
    return { success: true };
  },
  click: async (x, y) => { console.log(`  [platform] clicked (${x},${y})`); return { success: true }; },
  typeText: async (t) => { console.log(`  [platform] typed "${t}"`); return { success: true }; },
  pressKey: async (k) => { console.log(`  [platform] pressed ${k}`); return { success: true }; },
  scroll: async (d) => { console.log(`  [platform] scrolled ${d}`); return { success: true }; },
  capture: async () => { console.log("  [platform] captured screen"); return { success: true }; },
};

const { orchestrator } = buildAgent({
  platformImpl: platform,
  visionAnalyze: async () => currentScreen(),
  config: { agent: { requireConfirmationFor: [], maxRetriesPerAction: 2 } },
});

const goal = "Open WhatsApp and search for Dad";
console.log(`USER SPEECH: "${goal}"\n`);
const result = await orchestrator.run(goal);
console.log(`\nAGENT: "${result.spoken}"`);
console.log(`task status: ${result.task.status} (launched=${launched})`);