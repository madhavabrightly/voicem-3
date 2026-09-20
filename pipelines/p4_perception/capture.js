/**
 * P4 Tickets 301, 302, 367: Screen Capture & Deterministic Hash
 *
 *  301. Capture current screen.
 *  302. Detect screen resolution.
 *  367. Store screenshot metadata.
 *  368. Store screen hash.
 */

import { createHash } from "node:crypto";

/**
 * Deterministic hash calculation for screen content.
 * Accepts binary buffer or metadata descriptor.
 */
export function computeCaptureHash(input) {
  if (!input) return null;
  const hasher = createHash("sha256");
  if (Buffer.isBuffer(input)) {
    hasher.update(input);
    return hasher.digest("hex");
  }
  if (typeof input === "string") {
    hasher.update(input, "utf8");
    return hasher.digest("hex");
  }
  if (typeof input === "object") {
    // Deterministic key sort for structured object hashing
    const serialized = JSON.stringify(input, Object.keys(input).sort());
    hasher.update(serialized, "utf8");
    return hasher.digest("hex");
  }
  return null;
}

/**
 * Computes a deterministic semantic state hash.
 * Normalizes element ordering, whitespace, noise, and ignores volatile timestamps and runtime IDs.
 * Preserves selected tab, active application, document, focused element, query, dialog/modal presence, and error/loading states.
 */
export function computeSemanticStateHash({
  application = "",
  document = "",
  screen = "",
  selectedTab = null,
  focusedElement = null,
  searchState = null,
  modalState = false,
  loadingState = false,
  errorState = false,
  elements = [],
} = {}) {
  const normApp = String(application || "").trim().toLowerCase();
  const normDoc = String(document || "").trim().toLowerCase();
  const normScreen = String(screen || "").trim().toLowerCase();
  const normTab = selectedTab
    ? String(typeof selectedTab === "string" ? selectedTab : selectedTab.name || "").trim().toLowerCase()
    : "";
  const normFocused = focusedElement
    ? String(typeof focusedElement === "string" ? focusedElement : focusedElement.name || focusedElement.type || "").trim().toLowerCase()
    : "";
  const normSearch = searchState ? String(searchState).trim().toLowerCase() : "";

  // Check if elements contain modal/dialog/alert or loading states if not explicitly set
  const hasModal =
    Boolean(modalState) ||
    (elements || []).some((e) => /dialog|modal|alert|popup/i.test(e.role || e.type || ""));
  const hasLoading =
    Boolean(loadingState) ||
    (elements || []).some((e) => /spinner|progressbar/i.test(e.role || e.type || "") || /loading|please wait/i.test(e.name || e.text || ""));
  const hasError =
    Boolean(errorState) ||
    (elements || []).some((e) => /error|failed/i.test(e.name || e.text || ""));

  // Normalize, filter noise, and canonically sort elements
  const canonicalElements = (elements || [])
    .filter((e) => e && (e.confidence === undefined || e.confidence >= 0.2))
    .map((e) => {
      const eType = String(e.type || "").trim().toLowerCase();
      const eRole = String(e.role || "").trim().toLowerCase();
      const rawName = e.name || e.text || "";
      const normName = String(rawName).replace(/\s+/g, " ").trim().toLowerCase();
      const x = Math.round(e.bbox?.x ?? e.x ?? 0);
      const y = Math.round(e.bbox?.y ?? e.y ?? 0);
      const w = Math.round(e.bbox?.w ?? e.w ?? 0);
      const h = Math.round(e.bbox?.h ?? e.h ?? 0);
      return {
        type: eType,
        role: eRole,
        name: normName,
        bounds: `${x},${y},${w},${h}`,
        isSelected: Boolean(e.isSelected || e.selected),
        isFocused: Boolean(e.isFocused || e.focused),
      };
    })
    .sort((a, b) => {
      const keyA = `${a.type}:${a.role}:${a.name}:${a.bounds}:${a.isSelected}:${a.isFocused}`;
      const keyB = `${b.type}:${b.role}:${b.name}:${b.bounds}:${b.isSelected}:${b.isFocused}`;
      return keyA.localeCompare(keyB);
    });

  const payload = {
    app: normApp,
    doc: normDoc,
    screen: normScreen,
    tab: normTab,
    focused: normFocused,
    search: normSearch,
    modal: hasModal,
    loading: hasLoading,
    error: hasError,
    elements: canonicalElements,
  };

  const serialized = JSON.stringify(payload);
  const hasher = createHash("sha256");
  hasher.update(serialized, "utf8");
  return hasher.digest("hex");
}

export class ScreenCaptureEngine {
  /**
   * @param {object} [driver] PlatformDriver with capture() capability
   * @param {() => number} [clock]
   */
  constructor({ driver = null, clock = () => Date.now() } = {}) {
    this.driver = driver;
    this.clock = clock;
  }

  /**
   * 301. Capture current screen.
   * 302. Detect screen resolution.
   * 367. Store screenshot metadata.
   *
   * @returns {Promise<{path:string, width:number, height:number, bounds:object, capturedAt:number, hash:string, metadata:object}>}
   */
  async capture() {
    const timestamp = this.clock();
    if (!this.driver || typeof this.driver.capture !== "function") {
      return {
        path: null,
        width: 1920,
        height: 1080,
        bounds: { left: 0, top: 0, width: 1920, height: 1080 },
        capturedAt: timestamp,
        hash: computeCaptureHash(`synthetic_capture_${timestamp}`),
        metadata: { source: "synthetic", timestamp },
      };
    }

    const res = await this.driver.capture();
    const width = res.width || 1920;
    const height = res.height || 1080;
    const path = res.path || null;

    const metadata = {
      path,
      width,
      height,
      capturedAt: timestamp,
      source: "driver",
      driverResult: res.success ? "ok" : "failed",
    };

    const hash = computeCaptureHash({ path, width, height, timestamp: Math.floor(timestamp / 500) });

    return {
      path,
      width,
      height,
      bounds: { left: 0, top: 0, width, height },
      capturedAt: timestamp,
      hash,
      metadata,
    };
  }
}
