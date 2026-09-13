/**
 * VOICE MVP DEMO
 *
 *   real microphone -> AssemblyAI realtime -> final transcript -> EXISTING agent
 *
 * The agent stack (perception + tools + orchestrator) is the SAME one used by
 * demo/mvp-demo.js, with the same simulated desktop. The only difference is the
 * input source: live speech instead of a hard-coded goal string. The transcript
 * is passed to orchestrator.run() unchanged.
 *
 * Run: node demo/voice-mvp-demo.js
 * Requires ASSEMBLYAI_API_KEY (env/.env) and a microphone. On Windows,
 * node-record-lpcm16 needs SoX on PATH.
 */
import { loadEnv } from "../backend/core/env.js";
import { buildAgent } from "../backend/api/server.js";
import { createVoiceHandler } from "../voice/assemblyai/index.js";
import { ScreenModel } from "../backend/perception/screen_model.js";

loadEnv();

// --- simulated desktop (identical fixture to demo/mvp-demo.js) ---
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

console.log("========================================");
console.log("VOICE SCREEN AGENT");
console.log("========================================\n");

if (!process.env.ASSEMBLYAI_API_KEY) {
  console.error("[voice:error] ASSEMBLYAI_API_KEY is not configured");
  process.exit(1);
}

const voice = createVoiceHandler(orchestrator, {
  logger: console,
  onUserTurn: (transcript) => console.log(`\nUSER:\n${transcript}.\n`),
  tts: async (text) => {
    console.log(`\nAGENT:\n${text}\n`);
    return text;
  },
});

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[voice] Shutting down...");
  try {
    await voice.stop();
  } catch {
    // already closed
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));

console.log("[voice] Connecting to AssemblyAI...");
try {
  await voice.start();
} catch (err) {
  console.error(`[voice:error] ${err?.message || err}`);
  process.exit(1);
}

console.log("\n[voice] Listening...\n");
