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

export const CHANGE_STATUS = {
  UNCHANGED: "UNCHANGED",
  CHANGED: "CHANGED",
  UNKNOWN: "UNKNOWN",
};

/**
 * 369–374. Compare previous and current screen models.
 * Rule: NEVER treat an unavailable hash or missing model as UNCHANGED.
 */
export function compareScreens(prevModel, currModel) {
  if (!prevModel || !currModel) {
    return {
      status: CHANGE_STATUS.UNKNOWN,
      reason: "missing_model",
      changes: { appChanged: true, windowChanged: true, elementsChanged: true, textChanged: true },
    };
  }

  if (!prevModel.hash || !currModel.hash) {
    return {
      status: CHANGE_STATUS.UNKNOWN,
      reason: "missing_hash",
      changes: { appChanged: true, windowChanged: true, elementsChanged: true, textChanged: true },
    };
  }

  const appChanged = prevModel.application !== currModel.application; // 371
  const docChanged = prevModel.document !== currModel.document;
  const windowChanged = prevModel.environment?.hwnd !== currModel.environment?.hwnd; // 372

  const prevText = (prevModel.elements || []).map((e) => e.name || "").join(" ");
  const currText = (currModel.elements || []).map((e) => e.name || "").join(" ");
  const textChanged = prevText !== currText; // 374

  const elementsChanged =
    prevModel.elements?.length !== currModel.elements?.length ||
    JSON.stringify((prevModel.elements || []).map((e) => e.name)) !==
      JSON.stringify((currModel.elements || []).map((e) => e.name)); // 373

  const hashChanged = prevModel.hash !== currModel.hash; // 370

  const hasAnyChange = appChanged || docChanged || windowChanged || textChanged || elementsChanged || hashChanged;

  return {
    status: hasAnyChange ? CHANGE_STATUS.CHANGED : CHANGE_STATUS.UNCHANGED,
    reason: hasAnyChange ? "screen_modified" : "identical_hash_and_elements",
    changes: {
      appChanged,
      docChanged,
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
