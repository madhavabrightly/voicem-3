/**
 * REAL OCR DEMO — PaddleOCR ONNX (det + rec).
 *
 *   image (PNG) -> DB text detection -> CTC recognition -> ScreenModel
 *
 * Usage:
 *   node demo/ocr-demo.js                 # capture the live screen, then OCR it
 *   node demo/ocr-demo.js --image x.png   # OCR an existing PNG (headless-safe)
 *
 * Evidence of real wiring: prints the recognised text boxes and the semantic
 * ScreenModel the agent consumes.
 */
import { readFileSync } from "node:fs";
import { PaddleOcr } from "../backend/perception/paddle_ocr/index.js";
import { ocrLinesToModel } from "../backend/perception/real_ocr.js";
import { WindowsDriver } from "../backend/tools/win/win_driver.js";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

console.log("========================================");
console.log("REAL OCR (PaddleOCR ONNX)");
console.log("========================================\n");

const ocr = new PaddleOcr();
if (!ocr.isAvailable()) {
  console.error(`[ocr:error] model artifacts not found in ${ocr.modelDir}`);
  console.error("[ocr:error] run: node scripts/fetch-ocr-models.mjs");
  process.exit(1);
}

const imagePath = arg("--image");
let buffer;
let source;

if (imagePath) {
  buffer = readFileSync(imagePath);
  source = imagePath;
} else {
  const driver = new WindowsDriver();
  try {
    const cap = await driver.capture();
    if (!cap.success) throw new Error(cap.error || "capture failed");
    buffer = readFileSync(cap.path);
    source = cap.path;
  } catch (err) {
    console.error(`[ocr:error] screen capture unavailable: ${err?.message || err}`);
    driver.stop();
    process.exit(1);
  } finally {
    driver.stop();
  }
}

const t0 = Date.now();
const result = await ocr.recognize(buffer);
const elapsed = Date.now() - t0;

console.log(`[ocr] source: ${source}`);
console.log(`[ocr] image:  ${result.width}x${result.height}`);
console.log(`[ocr] ${result.lines.length} text line(s) in ${elapsed} ms\n`);

for (const l of result.lines) {
  const conf = String(Math.round(l.confidence * 100)).padStart(3);
  console.log(`  [${conf}%] (${l.x},${l.y} ${l.w}x${l.h}) ${JSON.stringify(l.text)}`);
}

const model = ocrLinesToModel(
  result.lines.map((l) => ({ text: l.text, x: l.x, y: l.y, w: l.w, h: l.h })),
  null,
  { width: result.width, height: result.height }
);
console.log("\n--- ScreenModel (agent input) ---");
console.log(JSON.stringify(model.toJSON(), null, 2));

process.exit(0);
