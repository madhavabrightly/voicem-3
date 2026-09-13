/**
 * Screen-AI converts the raw screen into a semantic world model.
 * The world model is the source of truth consumed by the orchestrator —
 * NOT raw coordinates or raw OCR strings.
 */

export class ScreenModel {
  /**
   * @param {object} init
   * @param {string} [init.application]
   * @param {string} [init.screen]
   * @param {Array}  [init.elements]
   * @param {string} [init.source] which sensor produced this (uia | ocr | vision ...)
   * @param {number} [init.confidence]
   */
  constructor({ application = "unknown", screen = "unknown", elements = [], source = "unknown", confidence = 0 } = {}) {
    this.application = application;
    this.screen = screen;
    this.elements = elements;
    this.source = source;
    this.confidence = confidence;
  }

  /** Find elements matching a semantic description, e.g. { type:"search" }. */
  find(description = {}) {
    const type = description.type;
    const name = description.name;

    // Semantic aliases so planner/tool vocabulary ("search_box") matches the
    // perception vocabulary ("search" role). Coordinates are never matched —
    // only types, roles, and names.
    const ALIASES = {
      search: ["search", "search_box"],
      search_box: ["search", "search_box"],
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
      screen: this.screen,
      source: this.source,
      confidence: this.confidence,
      elements: this.elements,
    };
  }
}