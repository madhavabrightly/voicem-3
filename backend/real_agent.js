import { WindowsDriver } from "./tools/win/win_driver.js";
import { RealOcrSensor } from "./perception/real_ocr_sensor.js";
import { RealUiaSensor } from "./perception/uia_sensor.js";
import { PaddleOcrSensor } from "./perception/paddle_ocr_sensor.js";
import { RealPerception } from "./perception/real_perception.js";
import { ToolBox } from "./tools/index.js";
import { Orchestrator } from "./agent/orchestrator.js";
import { Memory } from "./memory/index.js";

/**
 * Real-agent builder: assembles the SAME interfaces (Perception, ToolBox,
 * Orchestrator) but backed by the real Windows driver + live sensors.
 *
 *   PlatformDriver  -> WindowsDriver (persistent PowerShell win-agent)
 *   perception      -> RealPerception([uia, paddle-ocr, windows-ocr])  (ACT->OBSERVE->VERIFY)
 *   tools           -> ToolBox(driver, perception)     (unchanged)
 *   orchestrator    -> Orchestrator(...)               (unchanged)
 *
 * Sensor order (additive): the proven Windows OCR semantic sensor stays first
 * so existing behaviour/tests are preserved; the new ONNX OCR and UIA sensors
 * are appended as fallbacks that take over when Windows OCR yields nothing
 * (e.g. no language pack, headless, or a machine without WinRT OCR).
 * Set config.perception.uia / .paddleOcr to false to disable either fallback.
 *
 * Use for the real-desktop demo:
 *   import { buildRealAgent } from "./backend/real_agent.js";
 *   const { orchestrator } = buildRealAgent({ config });
 */
export function buildRealAgent({ config = {} } = {}) {
  const driver = new WindowsDriver();
  const sensors = [];

  // 1) Proven primary: Windows.Media.Ocr semantic sensor (unchanged behaviour).
  sensors.push(new RealOcrSensor(driver));

  // 2) New: local PaddleOCR ONNX engine (offscreen-capable, no language pack).
  if (config?.perception?.paddleOcr !== false) {
    sensors.push(
      new PaddleOcrSensor({
        capture: () => driver.capture(),
        foreground: () => driver.foreground(),
      })
    );
  }

  // 3) New: real Windows UI Automation tree (structured controls).
  if (config?.perception?.uia !== false) {
    sensors.push(new RealUiaSensor({ foreground: () => driver.foreground() }));
  }

  const perception = new RealPerception(sensors, config);
  const toolBox = new ToolBox({ driver, perception });
  const memory = new Memory();
  const orchestrator = new Orchestrator({ perception, toolBox }, config);
  return { orchestrator, memory, perception, toolBox, driver };
}
