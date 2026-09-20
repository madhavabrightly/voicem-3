/**
 * P4 Tickets 305, 391, 392: World State & Proven Identity Resolution
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

export const EVIDENCE_LEVELS = {
  PROVEN: "PROVEN",
  SUPPORTED: "SUPPORTED",
  INFERRED: "INFERRED",
  UNKNOWN: "UNKNOWN",
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
    .trim();
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

  // 1. Process Evidence
  const procNorm = normalizeIdentityName(environment?.proc);
  if (environment?.proc && !isBrowser) {
    evidence.push({
      source: "process",
      indicator: environment.proc,
      weight: 0.9,
      level: EVIDENCE_LEVELS.PROVEN,
    });
  }

  // 2. Browser Target / Tab Evidence
  if (isBrowser) {
    const selectedTab = browserTarget?.activeTab || null;
    const titleInfo = browserTarget?.titleInfo || {};

    if (selectedTab && selectedTab.name) {
      const tabNameNorm = normalizeIdentityName(selectedTab.name);
      evidence.push({
        source: "browser_selected_tab",
        indicator: selectedTab.name,
        weight: 0.95,
        level: browserTarget.proven ? EVIDENCE_LEVELS.PROVEN : EVIDENCE_LEVELS.SUPPORTED,
      });

      // If the selected tab or title is a search engine (e.g. DuckDuckGo, Google)
      if (titleInfo.isSearchEngine || /duckduckgo|google search|bing/i.test(selectedTab.name)) {
        return {
          application: environment?.proc || "Browser",
          document: titleInfo.searchEngine || selectedTab.name,
          documentType: "search_engine",
          level: EVIDENCE_LEVELS.PROVEN,
          isBrowser: true,
          selectedTab,
          evidence,
          provenance,
          activeTarget: titleInfo.searchEngine || "SearchEngine",
          isAppActive: (expected) => {
            const expNorm = normalizeIdentityName(expected);
            return expNorm === "browser" || expNorm === procNorm;
          },
          isCompatibleWith: (expected) => {
            const expNorm = normalizeIdentityName(expected);
            // DuckDuckGo search page is NOT WhatsApp
            if (expNorm === "whatsapp") return false;
            return expNorm === "browser" || expNorm === procNorm;
          },
        };
      }

      // If selected tab matches WhatsApp
      if (/whatsapp/i.test(tabNameNorm)) {
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
        level: EVIDENCE_LEVELS.SUPPORTED,
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

    // Browser with title but no verified tab
    if (titleInfo.cleanDocumentTitle) {
      evidence.push({
        source: "window_title",
        indicator: titleInfo.cleanDocumentTitle,
        weight: 0.6,
        level: EVIDENCE_LEVELS.SUPPORTED,
      });

      if (titleInfo.isSearchEngine) {
        return {
          application: environment?.proc || "Browser",
          document: titleInfo.searchEngine,
          documentType: "search_engine",
          level: EVIDENCE_LEVELS.SUPPORTED,
          isBrowser: true,
          selectedTab: null,
          evidence,
          provenance,
          activeTarget: titleInfo.searchEngine,
          isAppActive: (expected) => normalizeIdentityName(expected) === "browser",
          isCompatibleWith: (expected) => {
            const expNorm = normalizeIdentityName(expected);
            if (expNorm === "whatsapp") return false;
            return expNorm === "browser" || expNorm === procNorm;
          },
        };
      }

      if (/whatsapp/i.test(titleInfo.cleanDocumentTitle)) {
        // Window title contains WhatsApp in browser, without selected tab verification
        return {
          application: "WhatsApp",
          document: titleInfo.cleanDocumentTitle,
          documentType: "chat_application",
          level: EVIDENCE_LEVELS.SUPPORTED,
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
    if (/whatsapp/i.test(procNorm) || /whatsapp/i.test(titleNorm)) {
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

  // 4. OCR Evidence (strictly INFERRED, NEVER PROVEN)
  const ocrText = Array.isArray(ocrEvidence)
    ? ocrEvidence.map((l) => (typeof l === "string" ? l : l.text || "")).join(" ")
    : "";

  if (/whatsapp/i.test(ocrText)) {
    evidence.push({
      source: "ocr_text",
      indicator: "Contains 'whatsapp' in text stream",
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
 * 391, 392. Identity-aware target resolution and compatibility verification.
 * Fail-closed gate: if expected target is provided, actual identity MUST prove compatible.
 */
export function isIdentityCompatible(actualIdentity, expectedTarget) {
  if (!expectedTarget) return { compatible: true, reason: "no_expectation" };
  if (!actualIdentity) return { compatible: false, reason: "no_actual_identity" };

  const expNorm = normalizeIdentityName(expectedTarget);

  // If actual identity provides its own check
  if (typeof actualIdentity.isCompatibleWith === "function") {
    const ok = actualIdentity.isCompatibleWith(expectedTarget);
    if (!ok) {
      return {
        compatible: false,
        reason: `identity_mismatch: expected '${expectedTarget}', but active document is '${actualIdentity.document || actualIdentity.application}' (level: ${actualIdentity.level})`,
      };
    }
  }

  // Check evidence level
  if (actualIdentity.level === EVIDENCE_LEVELS.INFERRED || actualIdentity.level === EVIDENCE_LEVELS.UNKNOWN) {
    return {
      compatible: false,
      reason: `insufficient_evidence: identity for '${actualIdentity.application}' is ${actualIdentity.level} (cannot prove '${expectedTarget}')`,
    };
  }

  return { compatible: true, reason: "proven_compatible" };
}
