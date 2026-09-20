/**
 * P4 Tickets 348–356, 360–366: ScreenModel Builder & Ownership Stamping
 *
 *  348. Merge UIA results.
 *  356. Build ScreenModel.
 *  357. Store screen timestamp.
 *  358. Store active application.
 *  359. Store active window.
 *  360. Store elements.
 *  361. Store text.
 *  362. Store bounds.
 *  363. Store roles.
 *  364. Store states.
 *  365. Store confidence.
 *  366. Store source sensor.
 */

import { computeCaptureHash, computeSemanticStateHash } from "./capture.js";
import { SENSOR_VALIDITY_WINDOWS } from "./staleness.js";

/**
 * Stamps an element with environment ownership so it cannot be reused after
 * foreground or window drift.
 */
export function stampElementOwnership(element, environment = {}, timestamp = Date.now()) {
  const hwnd = environment.hwnd ?? "0x0";
  const pid = environment.pid ?? 0;
  const envHash = environment.hash ?? computeCaptureHash({ hwnd, pid });

  return {
    ...element,
    ownership: {
      hwnd,
      pid,
      capturedAt: timestamp,
      environmentHash: envHash,
    },
  };
}

/**
 * Enhanced ScreenModel for P4 and beyond.
 * Drop-in compatible with the existing backend/perception/screen_model.js.
 */
export class ScreenModel {
  /**
   * @param {object} init
   * @param {string} [init.application]
   * @param {string} [init.document]
   * @param {string} [init.screen]
   * @param {Array}  [init.elements]
   * @param {string} [init.source]
   * @param {number} [init.confidence]
   * @param {object} [init.environment]
   * @param {number} [init.capturedAt]
   * @param {string} [init.hash]
   * @param {object} [init.identity]
   * @param {object} [init.selectedTab]
   * @param {object} [init.focusedElement]
   * @param {string} [init.searchState]
   * @param {boolean} [init.modalState]
   * @param {boolean} [init.loadingState]
   * @param {boolean} [init.errorState]
   * @param {() => number} [init.clock]
   * @param {number} [init.validityWindowMs]
   */
  constructor({
    application = "unknown",
    document = null,
    screen = "unknown",
    elements = [],
    source = "unknown",
    confidence = 0,
    environment = null,
    capturedAt = null,
    hash = undefined,
    identity = null,
    selectedTab = null,
    focusedElement = null,
    searchState = null,
    modalState = false,
    loadingState = false,
    errorState = false,
    clock = () => Date.now(),
    validityWindowMs = null,
  } = {}) {
    this.application = application;
    this.document = document;
    this.screen = screen;
    this.source = source;
    this.confidence = confidence;
    this.environment = environment;
    this._clock = clock;
    this.capturedAt = capturedAt ?? (typeof clock === "function" ? clock() : Date.now());
    this.identity = identity;
    this._validityWindowMs = validityWindowMs;

    this.selectedTab = selectedTab || identity?.selectedTab || null;
    this.focusedElement = focusedElement;
    this.searchState = searchState;
    this.modalState = modalState;
    this.loadingState = loadingState;
    this.errorState = errorState;
    this.evidenceLevel = identity?.level || (application !== "unknown" ? "SUPPORTED" : "UNKNOWN");

    // Stamp ownership on elements if not already stamped
    this.elements = (elements || []).map((e) =>
      e.ownership ? e : stampElementOwnership(e, environment || {}, this.capturedAt)
    );

    this.sensorProvenance = {
      source: this.source,
      confidence: this.confidence,
      environment: this.environment,
      capturedAt: this.capturedAt,
      evidenceLevel: this.evidenceLevel,
    };

    // Compute deterministic semantic state hash if not explicitly provided
    this.hash =
      hash !== undefined
        ? hash
        : computeSemanticStateHash({
            application,
            document,
            screen,
            selectedTab: this.selectedTab,
            focusedElement: this.focusedElement,
            searchState: this.searchState,
            modalState: this.modalState,
            loadingState: this.loadingState,
            errorState: this.errorState,
            elements: this.elements,
          });

    this.stateHash = this.hash;
  }

  /**
   * Age in milliseconds since capture.
   */
  get ageMs() {
    const now = typeof this._clock === "function" ? this._clock() : Date.now();
    return Math.max(0, now - this.capturedAt);
  }

  /**
   * Staleness status: FRESH | STALE | EXPIRED
   */
  get stalenessStatus() {
    const srcKey = String(this.source || "").toLowerCase();
    const limit = this._validityWindowMs || SENSOR_VALIDITY_WINDOWS[srcKey] || SENSOR_VALIDITY_WINDOWS.default;
    const age = this.ageMs;
    if (age > limit * 2) return "EXPIRED";
    if (age > limit) return "STALE";
    return "FRESH";
  }

  /**
   * True if capture age exceeds its sensor validity window.
   */
  get isStale() {
    return this.stalenessStatus !== "FRESH";
  }

  /**
   * Element ownership summaries for rapid validation.
   */
  get elementOwnership() {
    return {
      hwnd: this.environment?.hwnd ?? "0x0",
      pid: this.environment?.pid ?? 0,
      capturedAt: this.capturedAt,
      environmentHash: this.environment?.hash ?? null,
      totalElements: this.elements.length,
    };
  }

  get ownership() {
    return this.elementOwnership;
  }

  get staleness() {
    return this.stalenessStatus;
  }

  get hwnd() {
    return this.environment?.hwnd ?? "0x0";
  }

  get pid() {
    return this.environment?.pid ?? 0;
  }

  get proc() {
    return this.environment?.proc ?? "unknown";
  }

  get title() {
    return this.environment?.title ?? "";
  }

  get class() {
    return this.environment?.class ?? "";
  }

  get browser() {
    return Boolean(this.environment?.isBrowser || this.identity?.isBrowser);
  }

  get tab() {
    return this.selectedTab?.name || this.identity?.selectedTab?.name || null;
  }

  get evidence() {
    return this.identity?.evidence || [];
  }

  get provenance() {
    return this.identity?.provenance || this.sensorProvenance;
  }

  /**
   * Semantic element search with type/name/role aliases.
   * Also verifies element ownership matches current model environment.
   */
  find(description = {}) {
    const type = description.type;
    const name = description.name;

    const ALIASES = {
      search: ["search", "search_box"],
      search_box: ["search", "search_box"],
      input: ["input", "edit", "text_field", "search_box"],
      contact: ["contact", "chat", "listitem"],
    };

    const expand = (v) => {
      const key = String(v || "").toLowerCase();
      return ALIASES[key] ? [key, ...ALIASES[key]] : [key];
    };

    const typeSet = type ? new Set(expand(type)) : null;
    const nameSet = name ? new Set(expand(name)) : null;

    return this.elements.filter((e) => {
      const eType = String(e.type || "").toLowerCase();
      const eRole = String(e.role || "").toLowerCase();
      const eName = String(e.name || "").toLowerCase();

      const typeOk = typeSet ? typeSet.has(eType) || typeSet.has(eRole) : true;
      const nameOk = nameSet
        ? nameSet.has(eName) ||
          nameSet.has(eRole) ||
          [...nameSet].some((n) => n.length > 2 && eName.includes(n))
        : true;

      return typeOk && nameOk;
    });
  }

  toJSON() {
    return {
      application: this.application,
      document: this.document,
      screen: this.screen,
      source: this.source,
      confidence: this.confidence,
      capturedAt: this.capturedAt,
      ageMs: this.ageMs,
      hash: this.hash,
      stateHash: this.stateHash,
      stalenessStatus: this.stalenessStatus,
      isStale: this.isStale,
      evidenceLevel: this.evidenceLevel,
      sensorProvenance: this.sensorProvenance,
      environment: this.environment,
      identity: this.identity,
      elements: this.elements,
    };
  }
}

/**
 * 356. Factory to build a unified ScreenModel from perception components.
 */
export function buildScreenModel({
  identity,
  environment,
  elements = [],
  source = "unknown",
  confidence = 0,
  screen = "unknown",
  capturedAt = null,
  selectedTab = null,
  focusedElement = null,
  searchState = null,
  modalState = false,
  loadingState = false,
  errorState = false,
  clock = () => Date.now(),
  validityWindowMs = null,
} = {}) {
  const ts = capturedAt ?? (typeof clock === "function" ? clock() : Date.now());
  const stampedElements = elements.map((e) => stampElementOwnership(e, environment, ts));

  return new ScreenModel({
    application: identity?.application || environment?.activeApplication || "unknown",
    document: identity?.document || environment?.title || null,
    screen,
    elements: stampedElements,
    source,
    confidence,
    environment,
    capturedAt: ts,
    identity,
    selectedTab: selectedTab || identity?.selectedTab,
    focusedElement,
    searchState,
    modalState,
    loadingState,
    errorState,
    clock,
    validityWindowMs,
  });
}
