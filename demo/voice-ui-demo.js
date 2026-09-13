/**
 * FLOATING VOICE UI DEMO
 *
 *   hotkey (Ctrl+Space) -> floating WPF voice core -> microphone -> AssemblyAI
 *     -> final transcript -> the REAL agent orchestrator -> Screen-AI perception
 *     -> Windows tools -> verification -> success/failure on the core
 *
 * Run (real microphone + assemblyai):
 *   node demo/voice-ui-demo.js
 *
 * Run (no microphone / no API key — scripted transcript, clearly labelled):
 *   node demo/voice-ui-demo.js --simulate
 *
 * The UI is a thin presentation layer: it never touches OCR, Windows tools or
 * AssemblyAI directly — only VoiceInterface does.
 */
import { loadEnv } from "../backend/core/env.js";
import { buildRealAgent } from "../backend/real_agent.js";
import { VoiceInterface } from "../voice/assemblyai/index.js";
import { VoiceUiBridge } from "../voice/ui_bridge.js";
import { createScriptedVoice } from "../voice/scripted_voice.js";

loadEnv();

const simulate = process.argv.includes("--simulate");
const exitAfterArg = process.argv.indexOf("--exit-after");
const exitAfter = exitAfterArg >= 0 ? Number(process.argv[exitAfterArg + 1]) : 0;

const { orchestrator } = buildRealAgent({
  config: { agent: { requireConfirmationFor: [], maxRetriesPerAction: 2 } },
});

if (simulate) {
  console.log("[voice-ui] SIMULATION MODE — scripted transcript, no microphone/AssemblyAI.\n");
} else if (!process.env.ASSEMBLYAI_API_KEY) {
  console.error("[voice:error] ASSEMBLYAI_API_KEY is not configured");
  process.exit(1);
}

const voice = simulate ? createScriptedVoice() : new VoiceInterface({ logger: console });
const bridge = new VoiceUiBridge({ orchestrator, voice, logger: console });
bridge.start();

if (exitAfter > 0) {
  setTimeout(async () => {
    console.log(`\n[voice-ui] exit-after ${exitAfter}ms reached — shutting down.`);
    await bridge.stop();
    process.exit(0);
  }, exitAfter);
}

if (simulate) {
  // Auto-activate once the overlay is up, then let the scripted voice drive it.
  setTimeout(() => bridge.activate(), 600);
}

process.on("SIGINT", async () => {
  console.log("\n[voice-ui] shutting down...");
  await bridge.stop();
  process.exit(0);
});
