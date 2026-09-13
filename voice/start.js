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

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SCRIPT = join(HERE, "..", "ui", "screenai-voice-ui.ps1");

const { simulate } = parseStartArgs(process.argv.slice(2));
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
if (!simulate && !process.env.ASSEMBLYAI_API_KEY) {
  fatal("ASSEMBLYAI_API_KEY is not configured");
}
if (!simulate) {
  const sox = spawnSync("sox", ["--version"], { stdio: "ignore" });
  if (sox.error) {
    warn("SoX not found on PATH - microphone capture will be unavailable until SoX is installed.");
  }
}

// ---- compose the existing stack --------------------------------------------
const { orchestrator } = buildRealAgent({
  config: { agent: { requireConfirmationFor: [], maxRetriesPerAction: 2 } },
});

const voice = simulate ? createScriptedVoice() : new VoiceInterface({ logger: console });

let bridge;
async function shutdown(code = 0) {
  try {
    await bridge?.stop();
  } catch {
    // already stopped
  }
  process.exit(code);
}

bridge = new VoiceUiBridge({
  orchestrator,
  voice,
  logger: console,
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
