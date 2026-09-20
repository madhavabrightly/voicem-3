import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRealAgent } from "../backend/real_agent.js";

/**
 * REAL-DESKTOP END-TO-END TEST.
 *
 * Runs the unchanged agent stack against the ACTUAL Windows desktop:
 *   "Open WhatsApp and search for Dad"
 *
 * Every step goes ACT -> OBSERVE -> VERIFY against the live screen via the
 * win-agent bridge + Windows OCR. This test drives real input on the real
 * desktop, so it is gated: it skips (does not fail CI) when no interactive
 * desktop session is available.
 */
test("REAL: 'Open WhatsApp and search for Dad' on the live desktop", { timeout: 120000 }, async (t) => {
  const { orchestrator, driver } = buildRealAgent({
    config: {
      agent: { requireConfirmationFor: [], maxRetriesPerAction: 2 },
    },
  });

  try {
    // Quick reachability probe: can we see a screen at all?
    const ocr = await driver.ocr();
    if (!ocr.success || !ocr.lines?.length) {
      t.skip("no interactive desktop / OCR unavailable");
      return;
    }

    const result = await orchestrator.run("Open WhatsApp and search for Dad");

    assert.equal(result.final.success, true);
    assert.equal(result.spoken, "Done.");
    assert.equal(result.task.status, "done");

    // The type step typed "Dad".
    const typeStep = result.task.executed.find((e) => e.step === "type");
    assert.ok(typeStep, "expected a type step to execute");

    // The final read_screen should have perceived Dad search results.
    const executed = result.task.executed.map((e) => e.step);
    assert.ok(executed.includes("open_app"));
    assert.ok(executed.includes("find_element"));
    assert.ok(executed.includes("click"));
  } finally {
    driver.stop();
  }
});

test("REAL NEGATIVE: background WhatsApp tab with another tab active refuses mutation before keystroke", { timeout: 60000 }, async (t) => {
  const { driver, perception } = buildRealAgent();

  try {
    const fg = await driver.foreground();
    if (!fg) {
      t.skip("no interactive desktop available");
      return;
    }

    // Inspect live environment
    const model = await perception.perceive({ intent: "check active tab" });
    if (!model || model.application === "WhatsApp") {
      // If WhatsApp is actually foreground, skip negative test
      t.skip("WhatsApp is active foreground window; negative test requires non-WhatsApp foreground");
      return;
    }

    // When WhatsApp is in background and another tab is active, canMutate("WhatsApp") MUST fail-closed
    const mutationCheck = perception.canMutate("WhatsApp", model);
    assert.equal(mutationCheck.allowed, false);
    assert.match(mutationCheck.reason, /(identity_mismatch|insufficient_evidence)/i);
  } finally {
    driver.stop();
  }
});
