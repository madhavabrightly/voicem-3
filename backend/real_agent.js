import { WindowsDriver } from "./tools/win/win_driver.js";
import { RealOcrSensor } from "./perception/real_ocr_sensor.js";
import { RealPerception } from "./perception/real_perception.js";
import { ToolBox } from "./tools/index.js";
import { Orchestrator } from "./agent/orchestrator.js";
import { Memory } from "./memory/index.js";

/**
 * Real-agent builder: assembles the SAME interfaces (Perception, ToolBox,
 * Orchestrator) but backed by the real Windows driver + live OCR sensor.
 *
 *   PlatformDriver  -> WindowsDriver (persistent PowerShell win-agent)
 *   perception      -> RealPerception([RealOcrSensor])  (real ACT->OBSERVE->VERIFY)
 *   tools           -> ToolBox(driver, perception)     (unchanged)
 *   orchestrator    -> Orchestrator(...)               (unchanged)
 *
 * Use for the real-desktop demo:
 *   import { buildRealAgent } from "./backend/real_agent.js";
 *   const { orchestrator } = buildRealAgent({ config });
 */
export function buildRealAgent({ config = {} } = {}) {
  const driver = new WindowsDriver();
  const ocrSensor = new RealOcrSensor(driver);
  const perception = new RealPerception([ocrSensor], config);
  const toolBox = new ToolBox({ driver, perception });
  const memory = new Memory();
  const orchestrator = new Orchestrator({ perception, toolBox }, config);
  return { orchestrator, memory, perception, toolBox, driver };
}
