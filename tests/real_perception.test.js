import { test } from "node:test";
import assert from "node:assert/strict";
import { RealPerception } from "../backend/perception/real_perception.js";
import { ScreenModel } from "../backend/perception/screen_model.js";

/**
 * Verification of a mutating step must survive the gap between "the input was
 * delivered" and "the application repainted it" — a live WhatsApp/Opera run
 * failed exactly there: the query WAS typed, but the snapshot taken 254ms
 * later still showed the placeholder, so a step that worked was retried and
 * then killed.
 */

function modelWithBox(query) {
  const elements = [
    {
      type: "search_box",
      name: query || "search_box",
      role: "search",
      coordinates: { x: 300, y: 193 },
      bbox: { x: 148, y: 185, w: 55, h: 16 },
      confidence: 0.8,
      action: "click",
      query,
      ...(query ? {} : { derived: "structure" }),
    },
  ];
  if (query) elements.push({ type: "contact", name: "Bala Dad..", coordinates: { x: 232, y: 336 }, bbox: {}, confidence: 0.8, action: "open" });
  return new ScreenModel({ application: "WhatsApp", screen: "chat_list", elements, source: "ocr", confidence: 0.85 });
}

/** Sensor that replays a fixed sequence of models, holding on the last one. */
function sensorFrom(models) {
  let reads = 0;
  return {
    name: "scripted",
    canHandle: () => true,
    reads: () => reads,
    read: async () => {
      const model = models[Math.min(reads, models.length - 1)];
      reads += 1;
      return model;
    },
  };
}

test("real_perception: type verification waits for the app to render the query", async () => {
  // First read: still the untouched field. Second: the query has rendered.
  const sensor = sensorFrom([modelWithBox(""), modelWithBox("Dad")]);
  const perception = new RealPerception([sensor], { agent: { verifyPollMs: 5 } });

  const result = await perception.verify({ type: "type", target: "search_box", args: { text: "Dad" } });

  assert.equal(result.success, true);
  assert.equal(sensor.reads(), 2, "expected a re-read instead of a false failure");
  assert.equal(result.data.drift, undefined);
});

test("real_perception: type verification fails when the query never appears", async () => {
  const sensor = sensorFrom([modelWithBox("")]);
  const perception = new RealPerception([sensor], { agent: { verifySettleMs: 60, verifyPollMs: 10 } });

  const result = await perception.verify({ type: "type", target: "search_box", args: { text: "Dad" } });

  assert.equal(result.success, false);
  assert.ok(sensor.reads() >= 2, "expected the settle window to be used before failing");
});

test("real_perception: a structure-derived box never counts as typed evidence", async () => {
  // Box resolved from the tab row (unreadable field) + results that merely
  // resemble the query: the query itself was never read back.
  const derived = modelWithBox("");
  const sensor = sensorFrom([derived]);
  const perception = new RealPerception([sensor], { agent: { verifySettleMs: 0 } });

  const result = await perception.verify({ type: "type", target: "search_box", args: { text: "Dad" } });

  assert.equal(result.success, false);
});

test("real_perception: a successful action that loses the foreground is a failure", async () => {
  let fg = { proc: "opera", pid: 13052, title: "(21) WhatsApp Business - Opera" };
  const perception = new RealPerception([sensorFrom([modelWithBox("Dad")])], { agent: { verifySettleMs: 0 } }, {
    foreground: async () => fg,
  });

  await perception.verify({ type: "open_app", target: "WhatsApp" });
  fg = { proc: "notepad", pid: 4242, title: "Untitled - Notepad" };

  const result = await perception.verify({ type: "type", target: "search_box", args: { text: "Dad" } });

  assert.equal(result.success, false);
  assert.equal(result.data.drift.actual.proc, "notepad");
  assert.equal(result.data.drift.expected.proc, "opera");
});

test("real_perception: read-only steps verify from a single look", async () => {
  const sensor = sensorFrom([modelWithBox("")]);
  const perception = new RealPerception([sensor], { agent: { verifySettleMs: 5000 } });

  const result = await perception.verify({ type: "read_screen" });

  assert.equal(result.success, true);
  assert.equal(sensor.reads(), 1);
});
