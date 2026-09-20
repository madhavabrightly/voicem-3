/**
 * P4 Tickets 368–384: Screen Change Detection & Screen State Classification
 *
 *  368. Store screen hash.
 *  369. Compare previous screen.
 *  370. Detect screen change.
 *  371. Detect application change.
 *  372. Detect window change.
 *  373. Detect element change.
 *  374. Detect text change.
 *  375. Detect loading state.
 *  376. Detect dialog appearance.
 *  377. Detect modal state.
 *  378. Detect popup state.
 *  379. Detect error state.
 *  380. Detect success state.
 *  381. Detect search state.
 *  382. Detect login state.
 *  383. Detect browser state.
 *  384. Detect desktop state.
 */

import { isIdentityCompatible } from "./identity.js";

export const CHANGE_STATUS = {
  UNCHANGED: "UNCHANGED",
  CHANGED: "CHANGED",
  UNKNOWN: "UNKNOWN",
  STALE: "STALE",
  MISMATCH: "MISMATCH",
};

/**
 * 369–374. Compare previous and current screen models according to deterministic state rules.
 *
 * Rules:
 *   NO HASH → UNKNOWN
 *   different identity → CHANGED
 *   same hash + compatible identity → UNCHANGED
 *   different hash + compatible identity → CHANGED
 *   stale capture → STALE
 *   identity mismatch → MISMATCH
 */
export function compareScreens(prevModel, currModel, { expectedTarget = null, checkStale = false } = {}) {
  // 1. NO HASH or missing model -> UNKNOWN
  if (!prevModel || !currModel || !prevModel.hash || !currModel.hash) {
    return {
      status: CHANGE_STATUS.UNKNOWN,
      code: "UNKNOWN",
      reason: "missing_hash_or_model",
      changes: { appChanged: true, windowChanged: true, elementsChanged: true, textChanged: true, hashChanged: true },
    };
  }

  // 2. Identity mismatch if expectedTarget requested
  if (expectedTarget && currModel.identity) {
    const compat = isIdentityCompatible(currModel.identity, expectedTarget);
    if (!compat.compatible) {
      return {
        status: CHANGE_STATUS.MISMATCH,
        code: "MISMATCH",
        reason: compat.reason || "identity_mismatch",
        failedField: compat.failedField,
        changes: { appChanged: true, windowChanged: false, elementsChanged: true, textChanged: true, hashChanged: true },
      };
    }
  }

  // 3. Stale capture check (if requested or model flagged stale)
  if (checkStale && (currModel.isStale || prevModel.isStale)) {
    return {
      status: CHANGE_STATUS.STALE,
      code: "STALE",
      reason: "stale_screen_model",
      changes: { appChanged: false, windowChanged: false, elementsChanged: false, textChanged: false, hashChanged: false },
    };
  }

  // 4. Different identity -> CHANGED
  const appChanged = prevModel.application !== currModel.application; // 371
  const docChanged = Boolean(prevModel.document && currModel.document && prevModel.document !== currModel.document);
  const tabChanged = Boolean(prevModel.selectedTab?.name && currModel.selectedTab?.name && prevModel.selectedTab.name !== currModel.selectedTab.name);
  const windowChanged = Boolean(
    prevModel.environment?.hwnd &&
    currModel.environment?.hwnd &&
    prevModel.environment.hwnd !== "0x0" &&
    currModel.environment.hwnd !== "0x0" &&
    prevModel.environment.hwnd !== currModel.environment.hwnd
  );

  const prevText = (prevModel.elements || []).map((e) => e.name || "").join(" ");
  const currText = (currModel.elements || []).map((e) => e.name || "").join(" ");
  const textChanged = prevText !== currText; // 374

  const elementsChanged =
    prevModel.elements?.length !== currModel.elements?.length ||
    JSON.stringify((prevModel.elements || []).map((e) => e.name)) !==
      JSON.stringify((currModel.elements || []).map((e) => e.name)); // 373

  const hashChanged = prevModel.hash !== currModel.hash; // 370

  const identityChanged = appChanged || docChanged || tabChanged || windowChanged;

  if (identityChanged) {
    return {
      status: CHANGE_STATUS.CHANGED,
      code: "CHANGED",
      reason: "identity_or_window_drift",
      changes: {
        appChanged,
        docChanged,
        tabChanged,
        windowChanged,
        textChanged,
        elementsChanged,
        hashChanged,
      },
    };
  }

  // 5. Same hash + compatible identity -> UNCHANGED
  if (!hashChanged) {
    return {
      status: CHANGE_STATUS.UNCHANGED,
      code: "UNCHANGED",
      reason: "identical_semantic_state",
      changes: {
        appChanged: false,
        docChanged: false,
        tabChanged: false,
        windowChanged: false,
        textChanged: false,
        elementsChanged: false,
        hashChanged: false,
      },
    };
  }

  // 6. Different hash + compatible identity -> CHANGED
  return {
    status: CHANGE_STATUS.CHANGED,
    code: "CHANGED",
    reason: "semantic_state_modified",
    changes: {
      appChanged,
      docChanged,
      tabChanged,
      windowChanged,
      textChanged,
      elementsChanged,
      hashChanged,
    },
  };
}

/**
 * 375–384. Screen state classifiers.
 */
export class ScreenStateClassifier {
  static classify(model) {
    if (!model) return "unknown";
    const text = (model.elements || []).map((e) => String(e.name || "").toLowerCase()).join(" ");

    if (this.isLoading(model, text)) return "loading"; // 375
    if (this.isDialog(model)) return "dialog"; // 376, 377, 378
    if (this.isError(model, text)) return "error"; // 379
    if (this.isLogin(model, text)) return "login"; // 382
    if (this.isSearch(model)) return "search"; // 381
    if (this.isBrowser(model)) return "browser"; // 383
    if (this.isDesktop(model)) return "desktop"; // 384
    return model.screen || "generic";
  }

  static isLoading(model, text = "") {
    return (
      /connecting|loading|please wait|buffering|syncing/i.test(text) ||
      (model.elements || []).some((e) => /spinner|progressbar/i.test(e.role))
    );
  }

  static isDialog(model) {
    return (model.elements || []).some((e) => /dialog|alert|modal|popup/i.test(e.role || e.type));
  }

  static isError(model, text = "") {
    return /error|failed to load|something went wrong|try again|access denied/i.test(text);
  }

  static isSuccess(model, text = "") {
    return /success|completed|message sent|done/i.test(text);
  }

  static isSearch(model) {
    return model.find({ type: "search_box" }).length > 0;
  }

  static isLogin(model, text = "") {
    return /scan qr code|log in|sign in|password|enter phone/i.test(text);
  }

  static isBrowser(model) {
    return Boolean(model.environment?.isBrowser || model.documentType === "web_page" || model.documentType === "search_engine");
  }

  static isDesktop(model) {
    return model.screen === "desktop" || model.application === "explorer" || model.application === "Windows Explorer";
  }
}
