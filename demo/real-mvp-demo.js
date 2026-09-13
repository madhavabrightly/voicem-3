/**
 * REAL DESKTOP MVP DEMO
 *   "Open WhatsApp and search for Dad"
 *
 * Runs the EXISTING agent stack (unchanged Planner/Orchestrator/Risk/Verify)
 * against the REAL Windows desktop via the real win-agent bridge + live OCR.
 *
 * Run: node demo/real-mvp-demo.js
 */
import { buildRealAgent } from "../backend/real_agent.js";

const config = {
  agent: {
    requireConfirmationFor: [], // demo: no interactive confirm prompt
    maxRetriesPerAction: 2,
  },
};

const { orchestrator, driver } = buildRealAgent({ config });
const goal = "Open WhatsApp and search for Dad";

console.log(`USER SPEECH:\n  "${goal}"\n`);
console.log("AssemblyAI -> Agent -> Real Windows\n");

try {
  const result = await orchestrator.run(goal);
  console.log(`\nAGENT: "${result.spoken}"`);
  console.log(`task status: ${result.task.status}`);
  console.log(`\n--- executed steps ---`);
  for (const ex of result.task.executed) {
    console.log(`  ${ex.step}${ex.target ? " " + ex.target : ""} -> ${ex.result.success ? "OK" : "FAIL: " + ex.result.error}`);
  }
  // Save full trace (perception -> decision -> action -> verification) to logs.
  // The logger already wrote JSONL to logs/<date>.log.
  console.log(`\nfull trace: logs/${new Date().toISOString().slice(0, 10)}.log`);
} finally {
  driver.stop();
  process.exit(0);
}
