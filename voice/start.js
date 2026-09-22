#!/usr/bin/env node
/**
 * Screen-AI Voice — PRODUCTION entry point.
 *
 * Composes the EXISTING components only:
 *   floating WPF UI  <-  VoiceUiBridge  <-  VoiceInterface  <-  AssemblyAI
 *                                                        <-  Agent Orchestrator
 *                                                        <-  Screen-AI perception/tools
 *
 * No business logic lives here. Emits small machine-readable markers so the
 * launcher can report startup problems:
 *   SCREENAI_READY             app + UI are up
 *   SCREENAI_FATAL: <message>  fatal startup error (exit code 2)
 *   SCREENAI_WARN: <message>   non-fatal dependency warning
 *
 * Run: node voice/start.js [--simulate] [--debug]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../backend/core/env.js";
import { buildRealAgent } from "../backend/real_agent.js";
import { VoiceInterface } from "./assemblyai/index.js";
import { VoiceUiBridge } from "./ui_bridge.js";
import { createScriptedVoice } from "./scripted_voice.js";
import { parseStartArgs } from "./app_paths.js";

import { WindowsVoiceInterface } from "./windows_speech.js";
import { VoiceConfirmator } from "./voice_confirmator.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SCRIPT = join(HERE, "..", "ui", "screenai-voice-ui.ps1");

const { simulate, local } = parseStartArgs(process.argv.slice(2));
loadEnv();

function fatal(message) {
  console.error(`SCREENAI_FATAL: ${message}`);
  process.exit(2);
}

function warn(message) {
  console.warn(`SCREENAI_WARN: ${message}`);
}

// ---- preflight (never assume a dependency exists) --------------------------
if (!existsSync(UI_SCRIPT)) {
  fatal(`UI script not found: ${UI_SCRIPT}`);
}
if (!simulate && !local && !process.env.ASSEMBLYAI_API_KEY) {
  fatal("ASSEMBLYAI_API_KEY is not configured");
}
if (!simulate && !local) {
  const sox = spawnSync("sox", ["--version"], { stdio: "ignore" });
  if (sox.error) {
    warn("SoX not found on PATH - microphone capture will be unavailable until SoX is installed.");
  }
}

// ---- compose the voice engine ----------------------------------------------
let voice;
if (simulate) {
  voice = createScriptedVoice();
} else if (local) {
  console.log("[voice] Local mode selected — using Windows Speech Recognition (offline local engine)");
  voice = new WindowsVoiceInterface({ logger: console });
} else {
  voice = new VoiceInterface({ logger: console });
}

// ---- interactive voice consent gate ----------------------------------------
const consent = process.argv.includes("--consent") || process.env.VOICE_CONSENT === "true";
const requireConfirmationFor = consent ? ["high", "medium", "low"] : ["high"];
const confirmator = new VoiceConfirmator({ voice, logger: console });

// ---- compose the existing stack --------------------------------------------
const { orchestrator } = buildRealAgent({
  config: { agent: { requireConfirmationFor, maxRetriesPerAction: 2 } },
  confirmator,
});

let bridge;
async function shutdown(code = 0) {
  try {
    await bridge?.stop();
    if (typeof voice?.shutdown === "function") await voice.shutdown();
  } catch {
    // already stopped
  }
  process.exit(code);
}

bridge = new VoiceUiBridge({
  orchestrator,
  voice,
  logger: console,
  autoRelisten: !simulate,
  onReady: () => console.log("SCREENAI_READY"),
  onQuit: () => shutdown(0),
});
bridge.start();

if (simulate) {
  warn("simulation mode — scripted transcript, no microphone/AssemblyAI (development only)");
  setTimeout(() => bridge.activate(), 600);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
