/**
 * P4 Tests — World State & Proven Identity Pipeline (Tickets 301–400)
 *
 * Asserting:
 *   OBSERVATION ≠ IDENTITY ≠ INTERPRETATION
 *   - Explicit evidence levels: PROVEN, SUPPORTED, INFERRED, UNKNOWN
 *   - Deterministic DuckDuckGo regression fixture
 *   - Element ownership stamping
 *   - Screen hashing & change detection
 *   - Fail-closed mutation gating
 *   - Bounded staleness & drift recovery
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  P4Perception,
  ScreenModel,
  ScreenCaptureEngine,
  EnvironmentProbe,
  sanitizeApplicationName,
  BrowserTargetResolver,
  resolveProvenIdentity,
  isIdentityCompatible,
  EVIDENCE_LEVELS,
  MultiSensorManager,
  normalizeCoordinates,
  classifyRoleType,
  stampElementOwnership,
  ScreenStateClassifier,
  compareScreens,
  CHANGE_STATUS,
  StalenessManager,
  ObserverEngine,
  rankMatchingElements,
  computeCaptureHash,
} from "../pipelines/p4_perception/index.js";

// ---------------------------------------------------------------- Test Fixtures

function makeFakeDriver({ fg = null, ocrLines = [], captureData = null } = {}) {
  return {
    foreground: async () => fg || { hwnd: "0x1A2B", pid: 1001, proc: "notepad.exe", title: "Untitled - Notepad", class: "Notepad" },
    ocr: async () => ({ success: true, lines: ocrLines, capturePath: "C:\\temp\\cap.png", width: 1920, height: 1080 }),
    capture: async () => captureData || { success: true, path: "C:\\temp\\cap.png", width: 1920, height: 1080 },
  };
}

// ---------------------------------------------------------------- Core Identity & Regression Tests

test("P4: Deterministic DuckDuckGo regression fixture (whatsapp status at DuckDuckGo - Opera)", async () => {
  const env = {
    hwnd: "0x3402",
    pid: 8844,
    proc: "opera",
    title: "whatsapp status at DuckDuckGo - Opera",
    class: "Chrome_WidgetWin_1",
    isBrowser: true,
  };

  const ocrLines = [
    { text: "whatsapp status at DuckDuckGo", x: 100, y: 50, w: 300, h: 20 },
    { text: "whatsapp web login status", x: 150, y: 180, w: 250, h: 18 },
    { text: "whatsapp status updates online", x: 150, y: 240, w: 260, h: 18 },
    { text: "Search", x: 600, y: 50, w: 80, h: 25 },
  ];

  const browserResolver = new BrowserTargetResolver();
  const browserTarget = await browserResolver.resolveBrowserTarget({
    environment: env,
    uiaElements: [
      { role: "tabitem", name: "whatsapp status at DuckDuckGo", isSelected: true },
    ],
  });

  const identity = resolveProvenIdentity({
    environment: env,
    browserTarget,
    ocrEvidence: ocrLines,
  });

  // Core assertion: Active document is DuckDuckGo / Search Engine, NOT WhatsApp!
  assert.equal(identity.isBrowser, true);
  assert.equal(identity.documentType, "search_engine");
  assert.equal(identity.isAppActive("WhatsApp"), false);

  // WhatsApp is NOT proven compatible with this search page
  const compat = isIdentityCompatible(identity, "WhatsApp");
  assert.equal(compat.compatible, false);
  assert.match(compat.reason, /identity_mismatch/i);

  // Verification of open_app("WhatsApp") against this screen must FAIL
  const perception = new P4Perception({
    driver: makeFakeDriver({ fg: env, ocrLines }),
    config: { agent: { verifySettleMs: 0 } },
  });

  const verifyResult = await perception.verify({ type: "open_app", target: "WhatsApp" });
  assert.equal(verifyResult.success, false);
});

test("P4: Title-only identity must NOT become PROVEN", () => {
  const env = {
    hwnd: "0x9999",
    pid: 4500,
    proc: "opera",
    title: "WhatsApp - Opera",
    isBrowser: true,
  };

  // Window title matches WhatsApp, but no verified tab is present
  const identity = resolveProvenIdentity({
    environment: env,
    browserTarget: { isBrowser: true, activeTab: null, titleInfo: { cleanDocumentTitle: "WhatsApp" } },
    ocrEvidence: [],
  });

  assert.equal(identity.application, "WhatsApp");
  // Without verified tab or native process proof, level must be SUPPORTED, NEVER PROVEN
  assert.equal(identity.level, EVIDENCE_LEVELS.SUPPORTED);
  assert.notEqual(identity.level, EVIDENCE_LEVELS.PROVEN);
});

test("P4: Proven identity when native process or selected browser tab verifies it", async () => {
  // Case A: Native application
  const nativeEnv = {
    hwnd: "0x1111",
    pid: 5000,
    proc: "WhatsApp.exe",
    title: "WhatsApp",
    isBrowser: false,
  };
  const nativeId = resolveProvenIdentity({ environment: nativeEnv });
  assert.equal(nativeId.application, "WhatsApp");
  assert.equal(nativeId.level, EVIDENCE_LEVELS.PROVEN);

  // Case B: Browser with confirmed active TabItem (IsSelected: true)
  const browserEnv = {
    hwnd: "0x2222",
    pid: 6000,
    proc: "chrome",
    title: "(3) WhatsApp - Google Chrome",
    isBrowser: true,
  };
  const resolver = new BrowserTargetResolver();
  const target = await resolver.resolveBrowserTarget({
    environment: browserEnv,
    uiaElements: [{ role: "tabitem", name: "(3) WhatsApp", isSelected: true }],
  });
  const browserId = resolveProvenIdentity({ environment: browserEnv, browserTarget: target });
  assert.equal(browserId.application, "WhatsApp");
  assert.equal(browserId.level, EVIDENCE_LEVELS.PROVEN);
  assert.equal(browserId.isAppActive("WhatsApp"), true);
});

test("P4: Browser selected-tab resolution distinguishes active from background tabs", async () => {
  const env = {
    hwnd: "0x7777",
    pid: 8000,
    proc: "msedge",
    title: "Documentation - Microsoft Edge",
    isBrowser: true,
  };

  const tabs = [
    { role: "tabitem", name: "WhatsApp Web", isSelected: false },
    { role: "tabitem", name: "Documentation", isSelected: true },
    { role: "tabitem", name: "Inbox (5)", isSelected: false },
  ];

  const resolver = new BrowserTargetResolver();
  const target = await resolver.resolveBrowserTarget({ environment: env, uiaElements: tabs });

  assert.equal(target.activeTab.name, "Documentation");
  assert.equal(target.activeTab.isSelected, true);

  const identity = resolveProvenIdentity({ environment: env, browserTarget: target });
  assert.equal(identity.document, "Documentation");
  assert.equal(identity.isAppActive("WhatsApp"), false);
});

test("P4: Ownership stamping on mapped elements", () => {
  const env = { hwnd: "0xABCD", pid: 9999, hash: "env_hash_123" };
  const rawElement = { type: "button", name: "Send", bbox: { x: 10, y: 10, w: 50, h: 20 } };

  const stamped = stampElementOwnership(rawElement, env, 1700000000);
  assert.equal(stamped.ownership.hwnd, "0xABCD");
  assert.equal(stamped.ownership.pid, 9999);
  assert.equal(stamped.ownership.environmentHash, "env_hash_123");
  assert.equal(stamped.ownership.capturedAt, 1700000000);

  const model = new ScreenModel({
    application: "App",
    environment: env,
    elements: [rawElement],
    capturedAt: 1700000000,
  });
  assert.equal(model.elements[0].ownership.hwnd, "0xABCD");
  assert.equal(model.elements[0].ownership.pid, 9999);
});

test("P4: Stale model rejection and validity window", () => {
  let currentTime = 10000;
  const manager = new StalenessManager({ validityWindowMs: 2500, clock: () => currentTime });

  const freshModel = new ScreenModel({ application: "App", capturedAt: 9000 });
  assert.equal(manager.isStale(freshModel), false);
  assert.equal(manager.getAge(freshModel), 1000);

  // Advance clock beyond validity window
  currentTime = 13000;
  assert.equal(manager.isStale(freshModel), true);
  assert.equal(manager.getAge(freshModel), 4000);
  assert.equal(manager.shouldReperceive({ model: freshModel }), true);
});

test("P4: Screen hash and change detection", () => {
  const modelA = new ScreenModel({
    application: "App",
    screen: "chat_list",
    elements: [{ type: "contact", name: "Alice" }],
    hash: "hash_A",
  });

  const modelSame = new ScreenModel({
    application: "App",
    screen: "chat_list",
    elements: [{ type: "contact", name: "Alice" }],
    hash: "hash_A",
  });

  const modelB = new ScreenModel({
    application: "App",
    screen: "chat_list",
    elements: [{ type: "contact", name: "Bob" }],
    hash: "hash_B",
  });

  // 1. Identical models
  const comp1 = compareScreens(modelA, modelSame);
  assert.equal(comp1.status, CHANGE_STATUS.UNCHANGED);
  assert.equal(comp1.changes.elementsChanged, false);

  // 2. Changed models
  const comp2 = compareScreens(modelA, modelB);
  assert.equal(comp2.status, CHANGE_STATUS.CHANGED);
  assert.equal(comp2.changes.elementsChanged, true);

  // 3. Never treat unavailable hash as UNCHANGED
  const modelNoHash = new ScreenModel({ application: "App", hash: null });
  modelNoHash.hash = null;
  const comp3 = compareScreens(modelA, modelNoHash);
  assert.equal(comp3.status, CHANGE_STATUS.UNKNOWN);
  assert.notEqual(comp3.status, CHANGE_STATUS.UNCHANGED);
});

test("P4: Same-process different-document drift detection", () => {
  const manager = new StalenessManager();

  const doc1Env = { hwnd: "0x1111", pid: 5000, proc: "opera", title: "WhatsApp Web - Opera" };
  const doc2Env = { hwnd: "0x2222", pid: 5000, proc: "opera", title: "DuckDuckGo Search - Opera" };

  const model = new ScreenModel({ application: "WhatsApp", environment: doc1Env, capturedAt: Date.now() });

  const drift = manager.detectEnvironmentDrift(model, doc2Env);
  assert.equal(drift.drifted, true);
  assert.equal(drift.reason, "window_hwnd_drift");
});

test("P4: Fail-closed mutation gate blocks incompatible target", () => {
  const ddgModel = new ScreenModel({
    application: "Opera",
    document: "DuckDuckGo",
    identity: {
      application: "Opera",
      document: "DuckDuckGo",
      level: EVIDENCE_LEVELS.PROVEN,
      isAppActive: () => false,
      isCompatibleWith: (exp) => exp.toLowerCase() === "opera",
    },
  });

  const perception = new P4Perception();
  // Expecting WhatsApp on DuckDuckGo screen -> must be blocked
  const gateBlocked = perception.canMutate("WhatsApp", ddgModel);
  assert.equal(gateBlocked.allowed, false);
  assert.match(gateBlocked.reason, /identity_mismatch/i);

  // Expecting Opera -> allowed
  const gateAllowed = perception.canMutate("Opera", ddgModel);
  assert.equal(gateAllowed.allowed, true);
});

test("P4: Re-perception and ranking after target mismatch", () => {
  const elements = [
    { type: "text", name: "Send", confidence: 0.8 },
    { type: "button", name: "Send Message", confidence: 0.9 },
    { type: "search_box", name: "Search", role: "search", confidence: 0.95 },
  ];

  // Exact search match
  const rankedSearch = rankMatchingElements(elements, { type: "search_box" });
  assert.equal(rankedSearch[0].type, "search_box");

  // Fuzzy message match
  const rankedSend = rankMatchingElements(elements, { name: "Send" });
  assert.equal(rankedSend[0].name, "Send"); // Exact text matches first
  assert.equal(rankedSend[1].name, "Send Message"); // Fuzzy text matches second
});

// ---------------------------------------------------------------- Numbered Tickets 385–400

test("385. Detect task-relevant element", () => {
  const elements = [
    { type: "search_box", name: "search_box", role: "search", confidence: 0.9 },
    { type: "button", name: "Close", confidence: 0.7 },
  ];
  const found = rankMatchingElements(elements, { role: "search" });
  assert.ok(found.length >= 1);
  assert.equal(found[0].role, "search");
});

test("386. Rank matching elements", () => {
  const elements = [
    { type: "button", name: "Cancel Action", confidence: 0.7 },
    { type: "button", name: "Cancel", confidence: 0.9 },
  ];
  const ranked = rankMatchingElements(elements, { name: "Cancel" });
  assert.equal(ranked[0].name, "Cancel");
});

test("387. Resolve semantic target", () => {
  const elements = [
    { type: "input", name: "search_box", role: "search", confidence: 0.85 },
  ];
  const found = rankMatchingElements(elements, { type: "search_box" });
  assert.equal(found.length, 1);
});

test("388. Resolve fuzzy text target", () => {
  const elements = [
    { type: "contact", name: "Mounesh Dad (Home)", confidence: 0.8 },
  ];
  const found = rankMatchingElements(elements, { name: "Dad" });
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "Mounesh Dad (Home)");
});

test("389. Resolve exact text target", () => {
  const elements = [
    { type: "contact", name: "Dad", confidence: 0.8 },
    { type: "contact", name: "Dad Office", confidence: 0.8 },
  ];
  const found = rankMatchingElements(elements, { name: "Dad" });
  assert.equal(found[0].name, "Dad");
});

test("390. Resolve role target", () => {
  const roleType = classifyRoleType("ControlType.Button", "Submit");
  assert.equal(roleType, "button");
});

test("391. Resolve application target", () => {
  const app = sanitizeApplicationName("opera.exe", "WhatsApp - Opera");
  assert.equal(app, "WhatsApp Web");
});

test("392. Resolve context target", () => {
  const env = { hwnd: "0x12", pid: 34, proc: "notepad.exe", title: "Notes.txt - Notepad" };
  const identity = resolveProvenIdentity({ environment: env });
  assert.equal(identity.application, "notepad.exe");
  assert.equal(identity.isAppActive("notepad.exe"), true);
});

test("393. Reject low-confidence target", () => {
  const elements = [
    { type: "button", name: "Ghost Button", confidence: 0.2 },
  ];
  const found = rankMatchingElements(elements, { name: "Ghost Button" }, { minConfidence: 0.5 });
  assert.equal(found.length, 0);
});

test("394. Request re-perception", () => {
  const manager = new StalenessManager({ validityWindowMs: 1000 });
  const staleModel = new ScreenModel({ application: "App", capturedAt: Date.now() - 5000 });
  assert.equal(manager.shouldReperceive({ model: staleModel }), true);
});

test("395. Retry OCR", async () => {
  let attempts = 0;
  const driver = {
    ocr: async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient OCR engine busy");
      return { success: true, lines: [{ text: "Recovered Text", x: 10, y: 10, w: 100, h: 20 }] };
    },
  };
  const sensorMgr = new MultiSensorManager({ driver });
  const result = await sensorMgr.scan();
  assert.ok(result.elements.length >= 1);
});

test("396. Retry UIA", async () => {
  const observer = new ObserverEngine({
    sensorManager: {
      scan: async () => ({ elements: [{ type: "button", name: "OK", confidence: 0.9 }], source: "uia", confidence: 0.9 }),
    },
  });
  const res = await observer.observe();
  assert.equal(res.elements.length, 1);
  assert.equal(res.source, "uia");
});

test("397. Retry vision", async () => {
  const observer = new ObserverEngine({
    sensorManager: {
      scan: async () => ({ elements: [{ type: "icon", name: "SearchIcon", confidence: 0.7 }], source: "vision", confidence: 0.7 }),
    },
  });
  const res = await observer.observe();
  assert.equal(res.elements[0].name, "SearchIcon");
});

test("398. Return ScreenModel", async () => {
  const driver = makeFakeDriver({
    fg: { hwnd: "0xABC", pid: 1234, proc: "notepad.exe", title: "Document - Notepad" },
    ocrLines: [{ text: "Hello World", x: 20, y: 30, w: 100, h: 15 }],
  });
  const perception = new P4Perception({ driver });
  const model = await perception.perceive();

  assert.ok(model instanceof ScreenModel);
  assert.equal(model.application, "Notepad");
  assert.ok(model.elements.length >= 1);
  assert.ok(model.hash);
  assert.ok(model.capturedAt > 0);
});

test("399. Test perception pipeline", async () => {
  const driver = makeFakeDriver({
    fg: { hwnd: "0x123", pid: 9876, proc: "calc.exe", title: "Calculator" },
    ocrLines: [{ text: "0", x: 50, y: 50, w: 20, h: 20 }],
  });
  const perception = new P4Perception({ driver });
  const model = await perception.perceive({ intent: "read calculator" });

  assert.equal(model.application, "Calculator");
  assert.equal(model.confidence >= 0.7, true);
  assert.equal(model.environment.proc, "calc.exe");
});

test("400. Verify complete perception pipeline", async () => {
  const fg = { hwnd: "0x999", pid: 4321, proc: "opera", title: "WhatsApp - Opera" };
  const ocrLines = [
    { text: "web.whatsapp.com", x: 55, y: 48, w: 232, h: 15 },
    { text: "WhatsApp", x: 130, y: 131, w: 104, h: 20 },
    { text: "Search or start a new chat", x: 148, y: 185, w: 220, h: 15 },
    { text: "Dad", x: 197, y: 330, w: 70, h: 12 },
  ];

  const driver = makeFakeDriver({ fg, ocrLines });
  const perception = new P4Perception({ driver });

  const model = await perception.perceive({ intent: "task observe" });
  assert.equal(model.application, "WhatsApp");
  assert.equal(model.screen, "chat_list");
  assert.ok(model.elements.length >= 2);

  // Ownership stamped
  assert.equal(model.elements[0].ownership.hwnd, "0x999");
  assert.equal(model.elements[0].ownership.pid, 4321);

  // Verified open_app
  const openVerify = await perception.verify({ type: "open_app", target: "WhatsApp" });
  assert.equal(openVerify.success, true);

  // Gate check
  const gate = perception.canMutate("WhatsApp", model);
  assert.equal(gate.allowed, true);
});
