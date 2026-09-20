/**
 * P4 Tests — World State & Proven Identity Pipeline (Tickets 301–400)
 *
 * Asserting:
 *   OBSERVATION ≠ IDENTITY ≠ INTERPRETATION
 *   - Explicit evidence levels: PROVEN, SUPPORTED, INFERRED, UNKNOWN
 *   - Deterministic reason codes: IDENTITY_PROVEN, IDENTITY_SUPPORTED, IDENTITY_INFERRED,
 *     IDENTITY_UNKNOWN, IDENTITY_MISMATCH, IDENTITY_STALE, IDENTITY_CHANGED, IDENTITY_UNVERIFIED
 *   - Adversarial fixtures (page body, URL, tab title, notification, chat, noise, etc.)
 *   - Mandatory vs optional field schema matching
 *   - Element ownership stamping
 *   - Screen hashing & change detection (including same-process tab switch)
 *   - Fail-closed mutation gating (BEFORE ACTION -> RESOLVE -> BEFORE INPUT -> BLOCK IF MISMATCH)
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
  isNonAppWebDocument,
  EVIDENCE_LEVELS,
  IDENTITY_REASON_CODES,
  MultiSensorManager,
  normalizeCoordinates,
  classifyRoleType,
  stampElementOwnership,
  ScreenStateClassifier,
  compareScreens,
  CHANGE_STATUS,
  StalenessManager,
  DEFAULT_VALIDITY_WINDOW_MS,
  SENSOR_VALIDITY_WINDOWS,
  ObserverEngine,
  rankMatchingElements,
  computeCaptureHash,
  computeSemanticStateHash,
} from "../pipelines/p4_perception/index.js";

// ---------------------------------------------------------------- Test Fixtures

function makeFakeDriver({ fg = null, ocrLines = [], captureData = null } = {}) {
  return {
    foreground: async () => fg || { hwnd: "0x1A2B", pid: 1001, proc: "notepad.exe", title: "Untitled - Notepad", class: "Notepad" },
    ocr: async () => ({ success: true, lines: ocrLines, capturePath: "C:\\temp\\cap.png", width: 1920, height: 1080 }),
    capture: async () => captureData || { success: true, path: "C:\\temp\\cap.png", width: 1920, height: 1080 },
  };
}

// ---------------------------------------------------------------- Adversarial Identity Fixtures

test("P4 ADVERSARIAL: 1. Application name in page body text (never upgraded to PROVEN)", () => {
  const env = { hwnd: "0x101", pid: 2001, proc: "chrome", title: "Tech News Daily - Google Chrome", isBrowser: true };
  const ocrLines = [
    { text: "Download WhatsApp for Windows", x: 200, y: 300, w: 250, h: 20 },
    { text: "WhatsApp is a popular messaging tool.", x: 200, y: 330, w: 300, h: 18 },
  ];

  const identity = resolveProvenIdentity({
    environment: env,
    browserTarget: { isBrowser: true, activeTab: { name: "Tech News Daily", isSelected: true }, proven: true, titleInfo: { cleanDocumentTitle: "Tech News Daily" } },
    ocrEvidence: ocrLines,
  });

  // Observation contains "WhatsApp", but identity candidate is Tech News Daily (web page)
  assert.equal(identity.application, "chrome");
  assert.equal(identity.document, "Tech News Daily");
  assert.equal(identity.isAppActive("WhatsApp"), false);

  const check = isIdentityCompatible(identity, "WhatsApp");
  assert.equal(check.compatible, false);
  assert.equal(check.code, IDENTITY_REASON_CODES.IDENTITY_MISMATCH);
  assert.equal(check.failedField, "application");
});

test("P4 ADVERSARIAL: 2. Application name in URL / address bar", () => {
  const env = { hwnd: "0x102", pid: 2002, proc: "msedge", title: "https://duckduckgo.com/?q=whatsapp - Microsoft Edge", isBrowser: true };
  const ocrLines = [{ text: "https://duckduckgo.com/?q=whatsapp", x: 100, y: 40, w: 300, h: 15 }];

  const identity = resolveProvenIdentity({
    environment: env,
    browserTarget: { isBrowser: true, activeTab: { name: "https://duckduckgo.com/?q=whatsapp", isSelected: true }, proven: true, titleInfo: { cleanDocumentTitle: "https://duckduckgo.com/?q=whatsapp", isSearchEngine: true, searchEngine: "DuckDuckGo" } },
    ocrEvidence: ocrLines,
  });

  assert.equal(identity.documentType, "search_engine");
  assert.equal(identity.isAppActive("WhatsApp"), false);

  const check = isIdentityCompatible(identity, "WhatsApp");
  assert.equal(check.compatible, false);
  assert.equal(check.code, IDENTITY_REASON_CODES.IDENTITY_MISMATCH);
});

test("P4 ADVERSARIAL: 3. Application name in browser tab title of non-app page (FAQ/Blog)", () => {
  const env = { hwnd: "0x103", pid: 2003, proc: "opera", title: "WhatsApp FAQ & Help Center - Opera", isBrowser: true };
  const identity = resolveProvenIdentity({
    environment: env,
    browserTarget: { isBrowser: true, activeTab: { name: "WhatsApp FAQ & Help Center", isSelected: true }, proven: true, titleInfo: { cleanDocumentTitle: "WhatsApp FAQ & Help Center" } },
    ocrEvidence: [],
  });

  assert.equal(identity.documentType, "web_page");
  assert.equal(identity.isAppActive("WhatsApp"), false);

  const check = isIdentityCompatible(identity, "WhatsApp");
  assert.equal(check.compatible, false);
  assert.equal(check.code, IDENTITY_REASON_CODES.IDENTITY_MISMATCH);
});

test("P4 ADVERSARIAL: 4. Application name in unrelated toast notification", () => {
  // Active window is VS Code, but a toast notification with "WhatsApp: Alice sent a photo" is on screen
  const env = { hwnd: "0x104", pid: 2004, proc: "code.exe", title: "server.js - voicem - Visual Studio Code", isBrowser: false };
  const ocrLines = [
    { text: "import { server } from 'http';", x: 100, y: 200, w: 200, h: 16 },
    { text: "WhatsApp: Alice sent a photo", x: 1600, y: 900, w: 250, h: 25 }, // Toast popup near taskbar
  ];

  const identity = resolveProvenIdentity({ environment: env, ocrEvidence: ocrLines });
  assert.equal(identity.application, "code.exe");
  assert.equal(identity.isAppActive("WhatsApp"), false);

  const check = isIdentityCompatible(identity, "WhatsApp");
  assert.equal(check.compatible, false);
  assert.equal(check.code, IDENTITY_REASON_CODES.IDENTITY_MISMATCH);
});

test("P4 ADVERSARIAL: 5. Application name in chat/message content inside another app (Slack)", () => {
  const env = { hwnd: "0x105", pid: 2005, proc: "slack.exe", title: "#general | Acme Corp | Slack", isBrowser: false };
  const ocrLines = [
    { text: "Bob: Can someone check the message on WhatsApp?", x: 300, y: 450, w: 400, h: 18 },
  ];

  const identity = resolveProvenIdentity({ environment: env, ocrEvidence: ocrLines });
  assert.equal(identity.application, "slack.exe");
  assert.equal(identity.isAppActive("WhatsApp"), false);

  const check = isIdentityCompatible(identity, "WhatsApp");
  assert.equal(check.compatible, false);
  assert.equal(check.code, IDENTITY_REASON_CODES.IDENTITY_MISMATCH);
});

test("P4 ADVERSARIAL: 6. Application name in OCR noise / partial match", () => {
  const env = { hwnd: "0x106", pid: 2006, proc: "explorer.exe", title: "File Explorer", isBrowser: false };
  const ocrLines = [
    { text: "What...", x: 200, y: 300, w: 60, h: 15 },
    { text: "App Store", x: 200, y: 340, w: 80, h: 15 },
  ];

  const identity = resolveProvenIdentity({ environment: env, ocrEvidence: ocrLines });
  assert.equal(identity.application, "explorer.exe");

  const check = isIdentityCompatible(identity, "WhatsApp");
  assert.equal(check.compatible, false);
});

test("P4 ADVERSARIAL: 7. Actual selected WhatsApp tab produces PROVEN", () => {
  const env = { hwnd: "0x107", pid: 2007, proc: "chrome", title: "(5) WhatsApp - Google Chrome", isBrowser: true };
  const identity = resolveProvenIdentity({
    environment: env,
    browserTarget: { isBrowser: true, activeTab: { name: "(5) WhatsApp", isSelected: true }, proven: true, titleInfo: { cleanDocumentTitle: "WhatsApp" } },
    ocrEvidence: [{ text: "WhatsApp", x: 100, y: 120, w: 100, h: 20 }],
  });

  assert.equal(identity.application, "WhatsApp");
  assert.equal(identity.level, EVIDENCE_LEVELS.PROVEN);
  assert.equal(identity.isAppActive("WhatsApp"), true);

  const check = isIdentityCompatible(identity, "WhatsApp");
  assert.equal(check.compatible, true);
  assert.equal(check.code, IDENTITY_REASON_CODES.IDENTITY_PROVEN);
});

test("P4 ADVERSARIAL: 8. WhatsApp background tab with another active tab fails closed", () => {
  const env = { hwnd: "0x108", pid: 2008, proc: "opera", title: "DuckDuckGo Search - Opera", isBrowser: true };
  const uiaTabs = [
    { role: "tabitem", name: "WhatsApp", isSelected: false },
    { role: "tabitem", name: "DuckDuckGo Search", isSelected: true },
  ];

  const resolver = new BrowserTargetResolver();
  const target = {
    isBrowser: true,
    activeTab: { name: "DuckDuckGo Search", isSelected: true },
    tabs: uiaTabs,
    documentIdentity: "DuckDuckGo Search",
    titleInfo: { cleanDocumentTitle: "DuckDuckGo Search", isSearchEngine: true, searchEngine: "DuckDuckGo" },
    proven: true,
  };

  const identity = resolveProvenIdentity({ environment: env, browserTarget: target });
  assert.equal(identity.document, "DuckDuckGo");
  assert.equal(identity.isAppActive("WhatsApp"), false);

  const check = isIdentityCompatible(identity, "WhatsApp");
  assert.equal(check.compatible, false);
  assert.equal(check.code, IDENTITY_REASON_CODES.IDENTITY_MISMATCH);
});

test("P4 ADVERSARIAL: 9. Same browser process, different selected tab switch detected", () => {
  const manager = new StalenessManager();
  const env = { hwnd: "0x5555", pid: 4444, proc: "chrome", title: "WhatsApp - Google Chrome", isBrowser: true };

  const modelA = new ScreenModel({
    application: "WhatsApp",
    document: "WhatsApp",
    environment: env,
    identity: { application: "WhatsApp", document: "WhatsApp", level: EVIDENCE_LEVELS.PROVEN, isAppActive: () => true },
    hash: "hash_whatsapp_tab",
  });

  const modelB = new ScreenModel({
    application: "chrome",
    document: "DuckDuckGo",
    environment: env, // Same HWND, same PID
    identity: { application: "chrome", document: "DuckDuckGo", level: EVIDENCE_LEVELS.PROVEN, isAppActive: () => false },
    hash: "hash_ddg_tab",
  });

  // Change detection detects tab switch even with same HWND & PID
  const diff = compareScreens(modelA, modelB);
  assert.equal(diff.status, CHANGE_STATUS.CHANGED);
  assert.equal(diff.changes.docChanged, true);
  assert.equal(diff.changes.hashChanged, true);

  // Mutation gate blocks action against modelB
  const perception = new P4Perception();
  const gateA = perception.canMutate("WhatsApp", modelA);
  const gateB = perception.canMutate("WhatsApp", modelB);
  assert.equal(gateA.allowed, true);
  assert.equal(gateB.allowed, false);
  assert.equal(gateB.code, IDENTITY_REASON_CODES.IDENTITY_MISMATCH);
});

test("P4 ADVERSARIAL: 10. Same PID, different document fails document compatibility check", () => {
  const env = { hwnd: "0x8888", pid: 9000, proc: "opera", isBrowser: true };
  const identity = {
    application: "opera",
    document: "WhatsApp Status Updates",
    level: EVIDENCE_LEVELS.PROVEN,
    provenance: env,
    isAppActive: () => false,
  };

  const check = isIdentityCompatible(identity, { application: "opera", document: "WhatsApp Web" });
  assert.equal(check.compatible, false);
  assert.equal(check.code, IDENTITY_REASON_CODES.IDENTITY_MISMATCH);
  assert.equal(check.failedField, "document");
});

test("P4 ADVERSARIAL: 11. Same title prefix, different document (search vs app)", () => {
  const env = { hwnd: "0x9999", pid: 9100, proc: "opera", title: "WhatsApp at DuckDuckGo - Opera", isBrowser: true };
  const identity = resolveProvenIdentity({
    environment: env,
    browserTarget: { isBrowser: true, activeTab: { name: "WhatsApp at DuckDuckGo", isSelected: true }, proven: true, titleInfo: { cleanDocumentTitle: "WhatsApp at DuckDuckGo", isSearchEngine: true, searchEngine: "DuckDuckGo" } },
  });

  assert.equal(identity.documentType, "search_engine");
  assert.equal(identity.isAppActive("WhatsApp"), false);

  const check = isIdentityCompatible(identity, "WhatsApp");
  assert.equal(check.compatible, false);
  assert.equal(check.code, IDENTITY_REASON_CODES.IDENTITY_MISMATCH);
});

// ---------------------------------------------------------------- Identity Compatibility Rules (Mandatory & Optional)

test("P4 RULES: Mandatory vs optional field schema matching", () => {
  const provenActual = {
    application: "WhatsApp",
    document: "WhatsApp Web",
    level: EVIDENCE_LEVELS.PROVEN,
    provenance: { hwnd: "0x123", pid: 456, proc: "opera", class: "Chrome_WidgetWin_1" },
    selectedTab: { name: "WhatsApp Web", isSelected: true },
    isAppActive: (app) => app.toLowerCase() === "whatsapp",
  };

  // 1. Mandatory application matches, optional fields omitted -> SUCCESS
  const res1 = isIdentityCompatible(provenActual, { application: "WhatsApp" });
  assert.equal(res1.compatible, true);
  assert.equal(res1.code, IDENTITY_REASON_CODES.IDENTITY_PROVEN);

  // 2. Mandatory application matches, matching optional fields provided -> SUCCESS
  const res2 = isIdentityCompatible(provenActual, {
    application: "WhatsApp",
    hwnd: "0x123",
    pid: 456,
    proc: "opera",
  });
  assert.equal(res2.compatible, true);

  // 3. Optional field conflict (PID mismatch) -> FAILS CLOSED with reason
  const res3 = isIdentityCompatible(provenActual, {
    application: "WhatsApp",
    pid: 9999, // Mismatched PID
  });
  assert.equal(res3.compatible, false);
  assert.equal(res3.code, IDENTITY_REASON_CODES.IDENTITY_MISMATCH);
  assert.equal(res3.failedField, "pid");

  // 4. Optional field conflict (HWND mismatch) -> FAILS CLOSED
  const res4 = isIdentityCompatible(provenActual, {
    application: "WhatsApp",
    hwnd: "0x999",
  });
  assert.equal(res4.compatible, false);
  assert.equal(res4.code, IDENTITY_REASON_CODES.IDENTITY_MISMATCH);
  assert.equal(res4.failedField, "hwnd");

  // 5. Weaker INFERRED identity is never upgraded to PROVEN
  const inferredActual = {
    application: "unknown",
    level: EVIDENCE_LEVELS.INFERRED,
    provenance: {},
  };
  const res5 = isIdentityCompatible(inferredActual, "WhatsApp");
  assert.equal(res5.compatible, false);
  assert.equal(res5.code, IDENTITY_REASON_CODES.IDENTITY_INFERRED);

  // 6. UNKNOWN identity fails closed
  const unknownActual = {
    application: "unknown",
    level: EVIDENCE_LEVELS.UNKNOWN,
    provenance: {},
  };
  const res6 = isIdentityCompatible(unknownActual, "WhatsApp");
  assert.equal(res6.compatible, false);
  assert.equal(res6.code, IDENTITY_REASON_CODES.IDENTITY_UNKNOWN);
});

// ---------------------------------------------------------------- Mutation Gating Lifecycle

test("P4 GATE: Mutation gating sequence prevents keystroke/click on identity mismatch", async () => {
  const driver = makeFakeDriver({
    fg: { hwnd: "0x333", pid: 777, proc: "opera", title: "whatsapp status at DuckDuckGo - Opera" },
    ocrLines: [{ text: "whatsapp status at DuckDuckGo", x: 100, y: 100, w: 200, h: 20 }],
  });

  const perception = new P4Perception({ driver, config: { agent: { verifySettleMs: 0 } } });

  // 1. BEFORE ACTION: capture identity
  const model = await perception.perceive({ intent: "prepare action" });

  // 2. ACTION TARGET: check if target "WhatsApp" is valid
  const gateCheck = perception.canMutate("WhatsApp", model);

  // 3. BEFORE INPUT: gate MUST block mutation
  assert.equal(gateCheck.allowed, false);
  assert.equal(gateCheck.code, IDENTITY_REASON_CODES.IDENTITY_MISMATCH);
  assert.equal(gateCheck.failedField, "application");

  // 4. Verification must also fail closed
  const verifyResult = await perception.verify({ type: "open_app", target: "WhatsApp" });
  assert.equal(verifyResult.success, false);
});

test("P4 REGRESSION 1: Opera active, DuckDuckGo active with 'WhatsApp' in page text -> refuses to claim WhatsApp active and cannot store false taskFg", async () => {
  const driver = makeFakeDriver({
    fg: { hwnd: "0x333", pid: 777, proc: "opera", title: "whatsapp status at DuckDuckGo - Opera" },
    ocrLines: [{ text: "whatsapp status at DuckDuckGo", x: 100, y: 100, w: 200, h: 20 }],
  });

  const perception = new P4Perception({ driver, config: { agent: { verifySettleMs: 0 } } });
  const model = await perception.perceive({ intent: "open WhatsApp" });

  assert.notEqual(model.identity.application, "WhatsApp");
  assert.equal(model.identity.isAppActive("WhatsApp"), false);

  const verifyResult = await perception.verify({ type: "open_app", target: "WhatsApp" });
  assert.equal(verifyResult.success, false);
  assert.equal(perception._taskFg, null); // Cannot store false taskFg!
});

test("P4 REGRESSION 2: Opera active, WhatsApp tab selected -> PROVEN only with independent UIA/browser evidence", () => {
  const env = { hwnd: "0x444", pid: 888, proc: "opera", title: "(3) WhatsApp - Opera", isBrowser: true };

  // Case A: Title only, no UIA tab evidence -> SUPPORTED, NEVER PROVEN
  const idTitleOnly = resolveProvenIdentity({
    environment: env,
    browserTarget: { isBrowser: true, activeTab: null, titleInfo: { cleanDocumentTitle: "WhatsApp" }, proven: false },
  });
  assert.equal(idTitleOnly.application, "WhatsApp");
  assert.equal(idTitleOnly.level, EVIDENCE_LEVELS.SUPPORTED);
  assert.notEqual(idTitleOnly.level, EVIDENCE_LEVELS.PROVEN);

  // Case B: Independent UIA selected tab verified -> PROVEN
  const idWithUia = resolveProvenIdentity({
    environment: env,
    browserTarget: { isBrowser: true, activeTab: { name: "(3) WhatsApp", isSelected: true }, proven: true, titleInfo: { cleanDocumentTitle: "WhatsApp" } },
  });
  assert.equal(idWithUia.application, "WhatsApp");
  assert.equal(idWithUia.level, EVIDENCE_LEVELS.PROVEN);
});

test("P4 REGRESSION 3: WhatsApp tab selected, action begins, tab switches before typing -> identity gate blocks typing", async () => {
  let activeTabName = "WhatsApp Web";
  let activeTitle = "WhatsApp Web - Opera";

  const driver = {
    foreground: async () => ({ hwnd: "0x777", pid: 1234, proc: "opera", title: activeTitle, class: "Chrome_WidgetWin_1" }),
    ocr: async () => ({ success: true, lines: [{ text: "Search or start new chat", x: 100, y: 100, w: 200, h: 20 }] }),
    capture: async () => ({ success: true, path: "C:\\temp\\cap.png", width: 1920, height: 1080 }),
    findUiaElements: async () => [{ name: activeTabName, isSelected: true, role: "tab", type: "tab", bbox: { x: 50, y: 10, w: 100, h: 30 } }],
  };

  const perception = new P4Perception({ driver, config: { agent: { verifySettleMs: 0 } } });

  // 1. Action begins: WhatsApp tab is active and proven
  const modelBefore = await perception.perceive({ intent: "prepare message" });
  const checkBefore = perception.canMutate("WhatsApp", modelBefore);
  assert.equal(checkBefore.allowed, true);
  assert.equal(checkBefore.code, IDENTITY_REASON_CODES.IDENTITY_PROVEN);

  // 2. Tab switches to YouTube before typing keystrokes
  activeTabName = "YouTube - Watch Videos";
  activeTitle = "YouTube - Watch Videos - Opera";

  // 3. Re-perception before input detects the tab switch
  const modelDuring = await perception.perceive({ intent: "type message" });
  const checkDuring = perception.canMutate("WhatsApp", modelDuring);

  // Gate MUST block mutation (NO KEYSTROKE)
  assert.equal(checkDuring.allowed, false);
  assert.equal(checkDuring.code, IDENTITY_REASON_CODES.IDENTITY_MISMATCH);
  assert.ok(checkDuring.recoveryHandoff);
  assert.equal(checkDuring.recoveryHandoff.mismatchReason, checkDuring.reason);
});

// ---------------------------------------------------------------- Standard P4 Tests

test("P4: Title-only identity must NOT become PROVEN", () => {
  const env = { hwnd: "0x9999", pid: 4500, proc: "opera", title: "WhatsApp - Opera", isBrowser: true };
  const identity = resolveProvenIdentity({
    environment: env,
    browserTarget: { isBrowser: true, activeTab: null, titleInfo: { cleanDocumentTitle: "WhatsApp" } },
    ocrEvidence: [],
  });

  assert.equal(identity.application, "WhatsApp");
  assert.equal(identity.level, EVIDENCE_LEVELS.SUPPORTED);
  assert.notEqual(identity.level, EVIDENCE_LEVELS.PROVEN);
});

test("P4: Ownership stamping on mapped elements", () => {
  const env = { hwnd: "0xABCD", pid: 9999, hash: "env_hash_123" };
  const rawElement = { type: "button", name: "Send", bbox: { x: 10, y: 10, w: 50, h: 20 } };

  const stamped = stampElementOwnership(rawElement, env, 1700000000);
  assert.equal(stamped.ownership.hwnd, "0xABCD");
  assert.equal(stamped.ownership.pid, 9999);
  assert.equal(stamped.ownership.environmentHash, "env_hash_123");
  assert.equal(stamped.ownership.capturedAt, 1700000000);
});

test("P4 STATE: Identical semantic state produces identical hash", () => {
  const model1 = new ScreenModel({
    application: "WhatsApp",
    document: "Chat with Alice",
    screen: "chat",
    elements: [
      { type: "input", name: "Type a message", bbox: { x: 100, y: 800, w: 500, h: 40 } },
      { type: "button", name: "Send", bbox: { x: 620, y: 800, w: 40, h: 40 } },
    ],
  });

  const model2 = new ScreenModel({
    application: "WhatsApp",
    document: "Chat with Alice",
    screen: "chat",
    elements: [
      { type: "input", name: "Type a message", bbox: { x: 100, y: 800, w: 500, h: 40 } },
      { type: "button", name: "Send", bbox: { x: 620, y: 800, w: 40, h: 40 } },
    ],
  });

  assert.equal(typeof model1.hash, "string");
  assert.equal(model1.hash, model2.hash);
  assert.equal(model1.stateHash, model2.stateHash);
  assert.equal(compareScreens(model1, model2).status, CHANGE_STATUS.UNCHANGED);
});

test("P4 STATE: Timestamp changes do NOT change hash", () => {
  const modelT1 = new ScreenModel({
    application: "WhatsApp",
    document: "WhatsApp Web",
    capturedAt: 1000000,
    elements: [{ type: "button", name: "Search", bbox: { x: 50, y: 50, w: 30, h: 30 } }],
  });

  const modelT2 = new ScreenModel({
    application: "WhatsApp",
    document: "WhatsApp Web",
    capturedAt: 9999999, // 100+ minutes later
    elements: [{ type: "button", name: "Search", bbox: { x: 50, y: 50, w: 30, h: 30 } }],
  });

  assert.equal(modelT1.hash, modelT2.hash);
});

test("P4 STATE: OCR element ordering changes do NOT change hash", () => {
  const elementsA = [
    { type: "text", name: "Header Title", bbox: { x: 10, y: 10, w: 100, h: 20 } },
    { type: "button", name: "Send Message", bbox: { x: 200, y: 500, w: 80, h: 30 } },
    { type: "input", name: "Search Contacts", bbox: { x: 20, y: 50, w: 150, h: 25 } },
  ];

  const elementsB = [
    { type: "input", name: "Search Contacts", bbox: { x: 20, y: 50, w: 150, h: 25 } },
    { type: "text", name: "Header Title", bbox: { x: 10, y: 10, w: 100, h: 20 } },
    { type: "button", name: "Send Message", bbox: { x: 200, y: 500, w: 80, h: 30 } },
  ];

  const modelA = new ScreenModel({ application: "App", elements: elementsA });
  const modelB = new ScreenModel({ application: "App", elements: elementsB });

  assert.equal(modelA.hash, modelB.hash);
});

test("P4 STATE: Selected-tab change changes hash", () => {
  const modelTab1 = new ScreenModel({
    application: "Opera",
    selectedTab: { name: "WhatsApp Web", isSelected: true },
  });

  const modelTab2 = new ScreenModel({
    application: "Opera",
    selectedTab: { name: "Reddit - Dive into anything", isSelected: true },
  });

  assert.notEqual(modelTab1.hash, modelTab2.hash);
  assert.equal(compareScreens(modelTab1, modelTab2).status, CHANGE_STATUS.CHANGED);
});

test("P4 STATE: Document change changes hash", () => {
  const modelDoc1 = new ScreenModel({ application: "Word", document: "Report_Q1.docx" });
  const modelDoc2 = new ScreenModel({ application: "Word", document: "Report_Q2.docx" });

  assert.notEqual(modelDoc1.hash, modelDoc2.hash);
  assert.equal(compareScreens(modelDoc1, modelDoc2).status, CHANGE_STATUS.CHANGED);
});

test("P4 STATE: Dialog appearance changes hash", () => {
  const baseModel = new ScreenModel({
    application: "App",
    elements: [{ type: "button", name: "Save" }],
    modalState: false,
  });

  const dialogModel = new ScreenModel({
    application: "App",
    elements: [{ type: "button", name: "Save" }, { type: "dialog", role: "dialog", name: "Confirm Overwrite" }],
    modalState: true,
  });

  assert.notEqual(baseModel.hash, dialogModel.hash);
  assert.equal(compareScreens(baseModel, dialogModel).status, CHANGE_STATUS.CHANGED);
});

test("P4 STATE: Stale result is rejected with sensor-specific validity window", () => {
  let currentTime = 10000;
  const clock = () => currentTime;
  const manager = new StalenessManager({ clock });

  // UIA validity window is 2500ms
  const uiaModel = new ScreenModel({ source: "uia", capturedAt: 10000, clock });
  assert.equal(manager.isStale(uiaModel), false);
  assert.equal(uiaModel.stalenessStatus, "FRESH");

  currentTime = 12600; // 2600ms later -> exceeds UIA 2500ms
  assert.equal(manager.isStale(uiaModel), true);
  assert.equal(uiaModel.stalenessStatus, "STALE");

  // OCR validity window is 1500ms
  const ocrModel = new ScreenModel({ source: "ocr", capturedAt: 10000, clock });
  currentTime = 11600; // 1600ms later -> exceeds OCR 1500ms
  assert.equal(manager.isStale(ocrModel), true);
  assert.equal(ocrModel.stalenessStatus, "STALE");
});

test("P4 STATE: Unknown hash does not equal unchanged", () => {
  const modelValid = new ScreenModel({ application: "App", hash: "valid_hash" });
  const modelNoHash = new ScreenModel({ application: "App", hash: null });

  const comp = compareScreens(modelValid, modelNoHash);
  assert.equal(comp.status, CHANGE_STATUS.UNKNOWN);
  assert.notEqual(comp.status, CHANGE_STATUS.UNCHANGED);
});

test("P4 STATE: Same browser PID with changed tab is detected", () => {
  const envA = { hwnd: "0x555", pid: 8888, proc: "opera", isBrowser: true, title: "WhatsApp Web - Opera" };
  const envB = { hwnd: "0x555", pid: 8888, proc: "opera", isBrowser: true, title: "DuckDuckGo - Opera" };

  const modelA = new ScreenModel({
    application: "Opera",
    document: "WhatsApp Web",
    selectedTab: { name: "WhatsApp Web" },
    environment: envA,
  });

  const modelB = new ScreenModel({
    application: "Opera",
    document: "DuckDuckGo",
    selectedTab: { name: "DuckDuckGo" },
    environment: envB,
  });

  assert.notEqual(modelA.hash, modelB.hash);
  const comp = compareScreens(modelA, modelB);
  assert.equal(comp.status, CHANGE_STATUS.CHANGED);

  const manager = new StalenessManager();
  const drift = manager.detectEnvironmentDrift(modelA, envB);
  assert.equal(drift.drifted, true);
  assert.equal(drift.reason, "browser_tab_drift");
});

test("P4 STATE: ScreenModel carries temporal and state-aware properties", () => {
  let currentTime = 50000;
  const clock = () => currentTime;
  const env = { hwnd: "0x123", pid: 456, hash: "env_hash" };
  const identity = { application: "WhatsApp", level: EVIDENCE_LEVELS.PROVEN };

  const model = new ScreenModel({
    application: "WhatsApp",
    document: "Chat",
    source: "uia",
    confidence: 0.95,
    environment: env,
    identity,
    capturedAt: 50000,
    clock,
    elements: [{ type: "button", name: "Send", bbox: { x: 10, y: 10, w: 50, h: 20 } }],
  });

  assert.equal(model.capturedAt, 50000);
  assert.equal(model.ageMs, 0);
  assert.equal(model.evidenceLevel, EVIDENCE_LEVELS.PROVEN);
  assert.equal(model.sensorProvenance.source, "uia");
  assert.equal(model.sensorProvenance.confidence, 0.95);
  assert.equal(model.elementOwnership.hwnd, "0x123");
  assert.equal(model.elementOwnership.pid, 456);
  assert.equal(model.stalenessStatus, "FRESH");
  assert.equal(model.isStale, false);
  assert.equal(typeof model.stateHash, "string");
  assert.equal(model.stateHash, model.hash);

  // Age advance
  currentTime = 53500;
  assert.equal(model.ageMs, 3500);
  assert.equal(model.stalenessStatus, "STALE");
  assert.equal(model.isStale, true);
});

test("P4 STATE: Re-perception triggers for STALE, IDENTITY_MISMATCH, and CHANGED", () => {
  let currentTime = 1000;
  const clock = () => currentTime;
  const manager = new StalenessManager({ validityWindowMs: 2000, clock });

  const model = new ScreenModel({
    application: "WhatsApp",
    capturedAt: 1000,
    identity: { application: "WhatsApp", level: EVIDENCE_LEVELS.PROVEN, isCompatibleWith: (t) => t.toLowerCase() === "whatsapp" },
    clock,
  });

  // Fresh + Compatible -> false
  assert.equal(manager.shouldReperceive({ model, expectedTarget: "WhatsApp" }), false);

  // 1. STALE -> true
  currentTime = 4000;
  assert.equal(manager.shouldReperceive({ model, expectedTarget: "WhatsApp" }), true);

  // 2. IDENTITY_MISMATCH -> true
  currentTime = 1000;
  assert.equal(manager.shouldReperceive({ model, expectedTarget: "Telegram" }), true);

  // 3. CHANGED -> true
  const changedCompare = { status: CHANGE_STATUS.CHANGED, changes: { elementsChanged: true } };
  assert.equal(manager.shouldReperceive({ model, compareResult: changedCompare }), true);
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
  const elements = [{ type: "input", name: "search_box", role: "search", confidence: 0.85 }];
  const found = rankMatchingElements(elements, { type: "search_box" });
  assert.equal(found.length, 1);
});

test("388. Resolve fuzzy text target", () => {
  const elements = [{ type: "contact", name: "Mounesh Dad (Home)", confidence: 0.8 }];
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
  const elements = [{ type: "button", name: "Ghost Button", confidence: 0.2 }];
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
