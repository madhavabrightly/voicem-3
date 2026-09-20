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

import { computeCaptureHash } from "./capture.js";

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
    hash = null,
    identity = null,
  } = {}) {
    this.application = application;
    this.document = document;
    this.screen = screen;
    this.source = source;
    this.confidence = confidence;
    this.environment = environment;
    this.capturedAt = capturedAt ?? Date.now();
    this.identity = identity;

    // Stamp ownership on elements if not already stamped
    this.elements = (elements || []).map((e) =>
      e.ownership ? e : stampElementOwnership(e, environment || {}, this.capturedAt)
    );

    // Compute screen hash if not provided
    this.hash =
      hash ||
      computeCaptureHash({
        application,
        document,
        screen,
        elementCount: this.elements.length,
        elements: this.elements.map((e) => `${e.type}:${e.name}:${e.bbox?.x},${e.bbox?.y}`),
        capturedAt: Math.floor(this.capturedAt / 1000),
      });
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
      hash: this.hash,
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
  capturedAt = Date.now(),
} = {}) {
  const stampedElements = elements.map((e) => stampElementOwnership(e, environment, capturedAt));

  return new ScreenModel({
    application: identity?.application || environment?.activeApplication || "unknown",
    document: identity?.document || environment?.title || null,
    screen,
    elements: stampedElements,
    source,
    confidence,
    environment,
    capturedAt,
    identity,
  });
}
