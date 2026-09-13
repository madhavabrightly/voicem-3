import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PaddleOcr } from "../backend/perception/paddle_ocr/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "menu_bar.png");

/**
 * Real model test: runs the actual PaddleOCR ONNX det+rec on a UI fixture and
 * asserts recognisable text. Skips (does not fail) when the models or fixture
 * are unavailable, so the suite stays runnable after a fresh clone.
 */
test("PaddleOCR ONNX recognizes UI text in a real fixture", { timeout: 120000 }, async (t) => {
  const ocr = new PaddleOcr();
  if (!ocr.isAvailable()) {
    t.skip("OCR model artifacts not present (run: node scripts/fetch-ocr-models.mjs)");
    return;
  }
  if (!existsSync(FIXTURE)) {
    t.skip("fixture tests/fixtures/menu_bar.png not present");
    return;
  }

  const result = await ocr.recognize(readFileSync(FIXTURE));
  const joined = result.lines.map((l) => l.text).join(" | ");
  assert.ok(result.lines.length > 0, `expected text lines from the model, got ${JSON.stringify(result)}`);
  assert.match(joined, /File|Edit|View|Help/i, `expected recognizable menu text, got: ${joined}`);
});
