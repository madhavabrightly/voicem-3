import { ScreenModel } from "./screen_model.js";
import { UiaDriver } from "../tools/win/uia_driver.js";

/**
 * RealUiaSensor — highest-priority Perception sensor backed by the live
 * Windows UI Automation tree. Maps native controls into the same semantic
 * element vocabulary the rest of the stack uses (type/name/role/bbox/center).
 *
 * Elements are filtered to the foreground process when a `foreground()` probe
 * is supplied, so a desktop-wide scan does not leak controls from other apps.
 */
const SEARCH_RE = /search/i;

function roleToType(role, label, automationId) {
  const haystack = `${label || ""} ${automationId || ""}`;
  if (SEARCH_RE.test(haystack)) return "search_box";
  switch (role) {
    case "button":
    case "splitbutton":
      return "button";
    case "edit":
    case "document":
      return "input";
    case "hyperlink":
      return "link";
    case "checkbox":
      return "checkbox";
    case "radiobutton":
      return "radio";
    case "combobox":
      return "combobox";
    case "listitem":
    case "dataitem":
      return "listitem";
    case "menuitem":
      return "menuitem";
    case "tabitem":
      return "tab";
    default:
      return role || "element";
  }
}

export class RealUiaSensor {
  constructor({ driver = new UiaDriver(), foreground = null, maxDepth = 8, maxElements = 2000 } = {}) {
    this.name = "uia";
    this.driver = driver;
    this.foreground = foreground;
    this.maxDepth = maxDepth;
    this.maxElements = maxElements;
  }

  canHandle() {
    return true;
  }

  async read() {
    const empty = new ScreenModel({ source: "uia", confidence: 0, elements: [] });

    const res = await this.driver.scan({ maxDepth: this.maxDepth, maxElements: this.maxElements });
    let raw = res.ok ? res.elements || [] : [];
    if (!raw.length) return empty;

    const fg = this.foreground ? await this.foreground().catch(() => null) : null;
    if (fg?.pid) {
      const scoped = raw.filter((e) => e.process_id === fg.pid);
      if (scoped.length) raw = scoped;
    }

    const elements = raw
      .map((el) => {
        const [x1, y1, x2, y2] = el.bounds || [0, 0, 0, 0];
        const name = el.label || el.automation_id || "";
        const states = [];
        if (el.is_enabled) states.push('enabled');
        if (el.is_keyboard_focusable) states.push('focusable');
        if (el.has_keyboard_focus) states.push('focused');
        if (el.is_selected) states.push('selected');
        if (el.is_expanded) states.push('expanded');

        const out = {
          type: roleToType(el.role, el.label, el.automation_id),
          role: el.role,
          name,
          bbox: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
          coordinates: el.center
            ? { x: el.center[0], y: el.center[1] }
            : { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) },
          confidence: el.confidence ?? 0.9,
          action: "click",
          states,
          patterns: el.patterns || [],
        };

        if (el.toggle_state !== undefined) out.toggleState = el.toggle_state;
        if (el.value !== undefined) out.value = el.value;
        if (el.is_selected !== undefined) out.isSelected = el.is_selected;

        return out;
      })
      .filter((e) => e.bbox.w > 0 && e.bbox.h > 0);

    if (!elements.length) return empty;

    return new ScreenModel({
      application: fg?.proc || fg?.title || "unknown",
      screen: "desktop",
      elements,
      source: "uia",
      confidence: 0.9,
    });
  }
}
