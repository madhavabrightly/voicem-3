/**
 * P4 Tickets 305, 391, 392: World State & Proven Identity Resolution (Hardened)
 *
 *  305. Detect active application.
 *  391. Resolve application target.
 *  392. Resolve context target.
 *
 * CORE RULE:
 *   OBSERVATION ≠ IDENTITY ≠ INTERPRETATION.
 *   OCR text containing "WhatsApp" is evidence that the word exists on screen.
 *   It is NOT proof that WhatsApp is the active application or document.
 *
 * Evidence Levels:
 *   PROVEN    - Verified at the OS/process level or verified selected browser tab.
 *   SUPPORTED - Structural alignment or window title match, but lacking explicit tab/process proof.
 *   INFERRED  - Derived purely from secondary cues like OCR text or icon candidates. Never PROVEN.
 *   UNKNOWN   - Insufficient evidence or conflicting signals.
 */

import { sanitizeApplicationName } from "./environment_probe.js";

export const EVIDENCE_LEVELS = {
  PROVEN: "PROVEN",
  SUPPORTED: "SUPPORTED",
  INFERRED: "INFERRED",
  UNKNOWN: "UNKNOWN",
};

export const IDENTITY_REASON_CODES = {
  IDENTITY_PROVEN: "IDENTITY_PROVEN",
  IDENTITY_SUPPORTED: "IDENTITY_SUPPORTED",
  IDENTITY_INFERRED: "IDENTITY_INFERRED",
  IDENTITY_UNKNOWN: "IDENTITY_UNKNOWN",
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
  IDENTITY_STALE: "IDENTITY_STALE",
  IDENTITY_CHANGED: "IDENTITY_CHANGED",
  IDENTITY_UNVERIFIED: "IDENTITY_UNVERIFIED",
};

/**
 * Normalizes an application/entity name for robust comparison.
 */
export function normalizeIdentityName(name = "") {
  return String(name || "")
    .toLowerCase()
    .replace(/\.exe$/i, "")
    .replace(/^(web\.|www\.)/i, "")
    .replace(/\s+(web|desktop|app|application)$/i, "")
    .replace(/^\(\d+\)\s*/, "") // Strip unread notification counts e.g. "(12) WhatsApp"
    .trim();
}

/**
 * Normalizes a document title for strict comparison without stripping semantic app suffixes.
 */
export function normalizeDocumentName(doc = "") {
  return String(doc || "")
    .toLowerCase()
    .replace(/^\(\d+\)\s*/, "") // Strip unread notification counts e.g. "(12) WhatsApp"
    .replace(/\s+-\s+.*$/, "") // Strip trailing " - Browser"
    .trim();
}

/**
 * Detects whether text represents a web search, article, blog, documentation, or generic web page
 * rather than a standalone chat application.
 */
export function isNonAppWebDocument(titleOrText = "") {
  const t = String(titleOrText || "").toLowerCase();
  return (
    /duckduckgo|google search|bing search|\bat duckduckgo\b|\bat google\b/i.test(t) ||
    /\b(status at|faq|help center|support|news|blog|documentation|tutorial|review|features|wiki|pricing)\b/i.test(t)
  );
}

/**
 * Resolves proven identity by cross-referencing environment, browser target,
 * UIA elements, and OCR evidence.
 *
 * @param {object} p
 * @param {object} p.environment EnvironmentSnapshot from EnvironmentProbe
 * @param {object} [p.browserTarget] Result from BrowserTargetResolver
 * @param {Array<object>} [p.ocrEvidence] Raw or classified OCR lines
 * @param {Array<object>} [p.uiaEvidence] Raw or classified UIA elements
 * @returns {ProvenIdentityResult}
 */
export function resolveProvenIdentity({
  environment = null,
  browserTarget = null,
  ocrEvidence = [],
  uiaEvidence = [],
} = {}) {
  const evidence = [];
  const provenance = {
    hwnd: environment?.hwnd ?? "0x0",
    pid: environment?.pid ?? 0,
    proc: environment?.proc ?? "unknown",
    title: environment?.title ?? "",
    class: environment?.class ?? "",
    timestamp: environment?.timestamp ?? Date.now(),
  };

  const isBrowser = Boolean(environment?.isBrowser || browserTarget?.isBrowser);
  const procNorm = normalizeIdentityName(environment?.proc);

  // 1. Process Evidence
  if (environment?.proc && !isBrowser) {
    evidence.push({
      source: "process",
      indicator: environment.proc,
      weight: 0.9,
      level: EVIDENCE_LEVELS.PROVEN,
    });
  }

  // 2. Browser Target / Tab Evidence (Adversarial hardening)
  if (isBrowser) {
    const selectedTab = browserTarget?.activeTab || null;
    const titleInfo = browserTarget?.titleInfo || {};
    const cleanDocTitle = titleInfo.cleanDocumentTitle || selectedTab?.name || environment?.title || "";

    if (selectedTab && selectedTab.name) {
      const tabNameNorm = normalizeIdentityName(selectedTab.name);
      evidence.push({
        source: "browser_selected_tab",
        indicator: selectedTab.name,
        weight: 0.95,
        level: browserTarget.proven ? EVIDENCE_LEVELS.PROVEN : EVIDENCE_LEVELS.SUPPORTED,
      });

      // Adversarial Case: Search engine or documentation mentioning an app name in query/title
      if (titleInfo.isSearchEngine || isNonAppWebDocument(selectedTab.name) || isNonAppWebDocument(titleInfo.rawTitle)) {
        const docName = titleInfo.searchEngine || selectedTab.name;
        return {
          application: environment?.proc || "Browser",
          document: docName,
          documentType: titleInfo.isSearchEngine ? "search_engine" : "web_page",
          level: EVIDENCE_LEVELS.PROVEN,
          isBrowser: true,
          selectedTab,
          evidence,
          provenance,
          activeTarget: docName,
          isAppActive: (expected) => {
            const expNorm = normalizeIdentityName(expected);
            return expNorm === "browser" || expNorm === procNorm;
          },
          isCompatibleWith: (expected) => {
            const expNorm = normalizeIdentityName(expected);
            if (expNorm === "whatsapp") return false;
            return expNorm === "browser" || expNorm === procNorm;
          },
        };
      }

      // Legitimate active WhatsApp tab
      if (/whatsapp/i.test(tabNameNorm) && !isNonAppWebDocument(tabNameNorm)) {
        return {
          application: "WhatsApp",
          document: selectedTab.name,
          documentType: "chat_application",
          level: browserTarget.proven ? EVIDENCE_LEVELS.PROVEN : EVIDENCE_LEVELS.SUPPORTED,
          isBrowser: true,
          selectedTab,
          evidence,
          provenance,
          activeTarget: "WhatsApp",
          isAppActive: (expected) => normalizeIdentityName(expected) === "whatsapp",
          isCompatibleWith: (expected) => normalizeIdentityName(expected) === "whatsapp",
        };
      }

      // Generic browser document
      return {
        application: environment?.proc || "Browser",
        document: selectedTab.name,
        documentType: "web_page",
        level: browserTarget.proven ? EVIDENCE_LEVELS.PROVEN : EVIDENCE_LEVELS.SUPPORTED,
        isBrowser: true,
        selectedTab,
        evidence,
        provenance,
        activeTarget: selectedTab.name,
        isAppActive: (expected) => {
          const expNorm = normalizeIdentityName(expected);
          return expNorm === normalizeIdentityName(selectedTab.name) || expNorm === procNorm;
        },
        isCompatibleWith: (expected) => {
          const expNorm = normalizeIdentityName(expected);
          return expNorm === normalizeIdentityName(selectedTab.name);
        },
      };
    }

    // Browser with title but UIA cannot prove selected tab -> must NOT be upgraded to PROVEN
    if (cleanDocTitle) {
      evidence.push({
        source: "window_title",
        indicator: cleanDocTitle,
        weight: 0.6,
        level: EVIDENCE_LEVELS.SUPPORTED,
      });

      if (titleInfo.isSearchEngine || isNonAppWebDocument(cleanDocTitle) || isNonAppWebDocument(titleInfo.rawTitle)) {
        const docName = titleInfo.searchEngine || cleanDocTitle;
        return {
          application: environment?.proc || "Browser",
          document: docName,
          documentType: titleInfo.isSearchEngine ? "search_engine" : "web_page",
          level: EVIDENCE_LEVELS.SUPPORTED,
          isBrowser: true,
          selectedTab: null,
          evidence,
          provenance,
          activeTarget: docName,
          isAppActive: (expected) => normalizeIdentityName(expected) === "browser",
          isCompatibleWith: (expected) => {
            const expNorm = normalizeIdentityName(expected);
            if (expNorm === "whatsapp") return false;
            return expNorm === "browser" || expNorm === procNorm;
          },
        };
      }

      if (/whatsapp/i.test(cleanDocTitle) && !isNonAppWebDocument(cleanDocTitle)) {
        return {
          application: "WhatsApp",
          document: cleanDocTitle,
          documentType: "chat_application",
          level: EVIDENCE_LEVELS.SUPPORTED, // Title only = SUPPORTED, NEVER PROVEN
          isBrowser: true,
          selectedTab: null,
          evidence,
          provenance,
          activeTarget: "WhatsApp",
          isAppActive: (expected) => normalizeIdentityName(expected) === "whatsapp",
          isCompatibleWith: (expected) => normalizeIdentityName(expected) === "whatsapp",
        };
      }
    }
  }

  // 3. Native Application Window Check
  if (!isBrowser && environment?.title) {
    const titleNorm = normalizeIdentityName(environment.title);
    if (/whatsapp/i.test(procNorm) || (/whatsapp/i.test(titleNorm) && !isNonAppWebDocument(titleNorm))) {
      evidence.push({
        source: "native_window",
        indicator: environment.title,
        weight: 0.95,
        level: EVIDENCE_LEVELS.PROVEN,
      });
      return {
        application: "WhatsApp",
        document: environment.title,
        documentType: "native_application",
        level: EVIDENCE_LEVELS.PROVEN,
        isBrowser: false,
        selectedTab: null,
        evidence,
        provenance,
        activeTarget: "WhatsApp",
        isAppActive: (expected) => normalizeIdentityName(expected) === "whatsapp",
        isCompatibleWith: (expected) => normalizeIdentityName(expected) === "whatsapp",
      };
    }
  }

  // 4. OCR / Body / Toast Evidence (Strictly INFERRED, NEVER PROVEN)
  const ocrText = Array.isArray(ocrEvidence)
    ? ocrEvidence.map((l) => (typeof l === "string" ? l : l.text || "")).join(" ")
    : "";

  if (/whatsapp/i.test(ocrText)) {
    evidence.push({
      source: "ocr_text",
      indicator: "Contains 'whatsapp' keyword in visual/OCR stream",
      weight: 0.3,
      level: EVIDENCE_LEVELS.INFERRED,
    });
  }

  // Default / Unknown Identity
  const fallbackApp = environment?.activeApplication || environment?.proc || "unknown";
  return {
    application: fallbackApp,
    document: environment?.title || null,
    documentType: isBrowser ? "web_page" : "window",
    level: fallbackApp !== "unknown" ? EVIDENCE_LEVELS.SUPPORTED : EVIDENCE_LEVELS.UNKNOWN,
    isBrowser,
    selectedTab: null,
    evidence,
    provenance,
    activeTarget: fallbackApp,
    isAppActive: (expected) => normalizeIdentityName(expected) === normalizeIdentityName(fallbackApp),
    isCompatibleWith: (expected) => normalizeIdentityName(expected) === normalizeIdentityName(fallbackApp),
  };
}

/**
 * 391, 392. Identity-aware compatibility verification with explicit reason codes.
 *
 * Evaluates mandatory fields (application) and optional fields (hwnd, pid, proc, class, document, browserTab).
 * A stronger PROVEN identity is not rejected if an optional field is missing,
 * but if an optional field is specified and conflicts, verification fails closed.
 *
 * @param {object} actualIdentity ProvenIdentityResult from resolveProvenIdentity
 * @param {string|object} expectedTarget String or structured expectation
 * @returns {{ compatible: boolean, code: string, reason: string, failedField?: string }}
 */
export function isIdentityCompatible(actualIdentity, expectedTarget) {
  if (!expectedTarget) {
    return {
      compatible: true,
      code: IDENTITY_REASON_CODES.IDENTITY_PROVEN,
      reason: "no_expectation_specified",
    };
  }

  if (!actualIdentity) {
    return {
      compatible: false,
      code: IDENTITY_REASON_CODES.IDENTITY_UNKNOWN,
      reason: "actual_identity_missing",
      failedField: "identity",
    };
  }

  // Parse structured expectation
  const exp =
    typeof expectedTarget === "string"
      ? { application: expectedTarget }
      : { ...expectedTarget };

  const expApp = exp.expectedApplication || exp.application || exp.app || null;
  const expDoc = exp.expectedDocument || exp.document || exp.doc || null;
  const expWindow = exp.expectedWindow || exp.window || null;
  const expBrowser = exp.expectedBrowser !== undefined ? exp.expectedBrowser : exp.browser;
  const expTab = exp.expectedTab || exp.browserTab || exp.tab || null;
  const expHwnd = exp.hwnd || null;
  const expPid = exp.pid || null;
  const expProc = exp.process || exp.proc || null;
  const expClass = exp.windowClass || exp.class || null;

  // Level check: INFERRED and UNKNOWN cannot satisfy a target requirement
  if (actualIdentity.level === EVIDENCE_LEVELS.INFERRED) {
    return {
      compatible: false,
      code: IDENTITY_REASON_CODES.IDENTITY_INFERRED,
      reason: `identity_inferred_only: visual text was observed but identity of '${actualIdentity.application}' cannot be proven`,
      failedField: "evidence_level",
    };
  }

  if (actualIdentity.level === EVIDENCE_LEVELS.UNKNOWN) {
    return {
      compatible: false,
      code: IDENTITY_REASON_CODES.IDENTITY_UNKNOWN,
      reason: "identity_unknown: insufficient evidence to verify environment",
      failedField: "evidence_level",
    };
  }

  // Optional Field Anchor Checks (if provided in expectation, must not conflict)
  if (expHwnd && actualIdentity.provenance?.hwnd && actualIdentity.provenance.hwnd !== "0x0") {
    if (String(actualIdentity.provenance.hwnd).toLowerCase() !== String(expHwnd).toLowerCase()) {
      return {
        compatible: false,
        code: IDENTITY_REASON_CODES.IDENTITY_MISMATCH,
        reason: `hwnd_mismatch: expected '${expHwnd}', actual '${actualIdentity.provenance.hwnd}'`,
        failedField: "hwnd",
      };
    }
  }

  if (expPid && actualIdentity.provenance?.pid) {
    if (Number(actualIdentity.provenance.pid) !== Number(expPid)) {
      return {
        compatible: false,
        code: IDENTITY_REASON_CODES.IDENTITY_MISMATCH,
        reason: `pid_mismatch: expected '${expPid}', actual '${actualIdentity.provenance.pid}'`,
        failedField: "pid",
      };
    }
  }

  if (expProc && actualIdentity.provenance?.proc) {
    const expProcNorm = normalizeIdentityName(expProc);
    const actProcNorm = normalizeIdentityName(actualIdentity.provenance.proc);
    if (expProcNorm !== actProcNorm) {
      return {
        compatible: false,
        code: IDENTITY_REASON_CODES.IDENTITY_MISMATCH,
        reason: `process_mismatch: expected '${expProc}', actual '${actualIdentity.provenance.proc}'`,
        failedField: "process",
      };
    }
  }

  if (expClass && actualIdentity.provenance?.class) {
    if (String(actualIdentity.provenance.class).toLowerCase() !== String(expClass).toLowerCase()) {
      return {
        compatible: false,
        code: IDENTITY_REASON_CODES.IDENTITY_MISMATCH,
        reason: `class_mismatch: expected '${expClass}', actual '${actualIdentity.provenance.class}'`,
        failedField: "windowClass",
      };
    }
  }

  if (expWindow && actualIdentity.provenance?.title) {
    const expWinNorm = normalizeIdentityName(expWindow);
    const actWinNorm = normalizeIdentityName(actualIdentity.provenance.title);
    if (!actWinNorm.includes(expWinNorm) && !expWinNorm.includes(actWinNorm)) {
      return {
        compatible: false,
        code: IDENTITY_REASON_CODES.IDENTITY_MISMATCH,
        reason: `window_mismatch: expected window '${expWindow}', actual title '${actualIdentity.provenance.title}'`,
        failedField: "window",
      };
    }
  }

  if (expBrowser !== undefined && expBrowser !== null) {
    const actIsBrowser = Boolean(actualIdentity.isBrowser);
    if (Boolean(expBrowser) !== actIsBrowser) {
      return {
        compatible: false,
        code: IDENTITY_REASON_CODES.IDENTITY_MISMATCH,
        reason: `browser_mismatch: expected browser=${Boolean(expBrowser)}, actual isBrowser=${actIsBrowser}`,
        failedField: "browser",
      };
    }
  }

  if (expTab && actualIdentity.selectedTab?.name) {
    const expTabNorm = normalizeIdentityName(expTab);
    const actTabNorm = normalizeIdentityName(actualIdentity.selectedTab.name);
    if (!actTabNorm.includes(expTabNorm) && !expTabNorm.includes(actTabNorm)) {
      return {
        compatible: false,
        code: IDENTITY_REASON_CODES.IDENTITY_MISMATCH,
        reason: `browser_tab_mismatch: expected tab '${expTab}', actual active tab '${actualIdentity.selectedTab.name}'`,
        failedField: "browserTab",
      };
    }
  }

  if (expDoc && actualIdentity.document) {
    const expDocNorm = normalizeDocumentName(expDoc);
    const actDocNorm = normalizeDocumentName(actualIdentity.document);
    if (expDocNorm !== actDocNorm) {
      return {
        compatible: false,
        code: IDENTITY_REASON_CODES.IDENTITY_MISMATCH,
        reason: `document_mismatch: expected document '${expDoc}', actual document '${actualIdentity.document}'`,
        failedField: "document",
      };
    }
  }

  // Mandatory Application Target Verification
  if (expApp) {
    if (typeof actualIdentity.isCompatibleWith === "function") {
      const allowed = actualIdentity.isCompatibleWith(expApp);
      if (!allowed) {
        return {
          compatible: false,
          code: IDENTITY_REASON_CODES.IDENTITY_MISMATCH,
          reason: `application_mismatch: expected '${expApp}', but active document is '${actualIdentity.document || actualIdentity.application}' (level: ${actualIdentity.level})`,
          failedField: "application",
        };
      }
    } else if (actualIdentity.application) {
      const expAppNorm = normalizeIdentityName(expApp);
      const actAppNorm = normalizeIdentityName(actualIdentity.application);
      if (expAppNorm !== actAppNorm) {
        return {
          compatible: false,
          code: IDENTITY_REASON_CODES.IDENTITY_MISMATCH,
          reason: `application_mismatch: expected '${expApp}', actual '${actualIdentity.application}'`,
          failedField: "application",
        };
      }
    }
  }

  return {
    compatible: true,
    code: actualIdentity.level === EVIDENCE_LEVELS.PROVEN ? IDENTITY_REASON_CODES.IDENTITY_PROVEN : IDENTITY_REASON_CODES.IDENTITY_SUPPORTED,
    reason: "proven_compatible",
  };
}
