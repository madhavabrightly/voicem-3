import { test } from "node:test";
import assert from "node:assert/strict";
import { OcrDict } from "../backend/perception/paddle_ocr/dict.js";
import { ctcDecode } from "../backend/perception/paddle_ocr/rec.js";
import { postprocessDet } from "../backend/perception/paddle_ocr/det.js";

test("ocr dict: PaddleOCR blank/chars/space mapping", () => {
  const dict = new OcrDict(["A", "B", "C"]);
  assert.equal(dict.classes, 5); // blank + 3 chars + space
  assert.equal(dict.charAt(0), null); // CTC blank
  assert.equal(dict.charAt(1), "A");
  assert.equal(dict.charAt(3), "C");
  assert.equal(dict.charAt(4), " "); // trailing space class
});

test("ocr ctc: collapses repeats, drops blank, maps via dict", () => {
  const dict = new OcrDict(["A", "B", "C"]);
  const seq = [1, 1, 0, 2, 2, 3]; // A A blank B B C -> "ABC"
  const C = 5;
  const T = seq.length;
  const logits = new Float32Array(T * C);
  seq.forEach((idx, t) => {
    logits[t * C + idx] = 0.9;
  });
  const { text, confidence } = ctcDecode(logits, T, C, dict);
  assert.equal(text, "ABC");
  assert.ok(confidence > 0.8, `confidence ${confidence}`);
});

test("ocr det: finds a text blob and unclips its box", () => {
  const rw = 64;
  const rh = 32;
  const prob = new Float32Array(rw * rh);
  for (let y = 8; y < 16; y++) {
    for (let x = 10; x < 40; x++) prob[y * rw + x] = 0.9;
  }
  const boxes = postprocessDet(prob, rw, rh, { scaleX: 1, scaleY: 1 });
  assert.equal(boxes.length, 1);
  const b = boxes[0];
  assert.ok(b.x <= 10 && b.y <= 8, `box should expand past the blob: ${JSON.stringify(b)}`);
  assert.ok(b.x + b.w >= 40 && b.y + b.h >= 16, `box should cover the blob: ${JSON.stringify(b)}`);
  assert.ok(b.score > 0.5);
});

test("ocr det: empty probability map yields no boxes", () => {
  const boxes = postprocessDet(new Float32Array(64 * 32), 64, 32, {});
  assert.deepEqual(boxes, []);
});
