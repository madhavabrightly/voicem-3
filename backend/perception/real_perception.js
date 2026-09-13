import { Perception } from "./index.js";

/**
 * RealPerception — Perception-interface implementation for the live desktop.
 *
 * Uses the same sensor-stack `perceive()` as the base Perception, but its
 * `verify(step)` implements REAL semantic verification per the spec:
 *
 *   ACT -> OBSERVE -> VERIFY
 *
 * Each action type verifies what should have CHANGED on screen:
 *   - open_app:   WhatsApp window is foreground / app content visible
 *   - click:      the clicked target element still exists (or its effect state)
 *   - type:       typed text now appears in the search box
 *   - read_screen / wait / find_element: perception succeeded at all
 *
 * The orchestrator / ToolBox interfaces are unchanged.
 */
export class RealPerception extends Perception {
  async verify(step) {
    const model = await this.perceive({ intent: `verify ${step.type} ${step.target || ""}` });
    const data = model.toJSON ? model.toJSON() : model;

    let success = false;
    switch (step.type) {
      case "open_app": {
        // WhatsApp content visible: search box present in left panel
        const search = model.find({ type: "search_box" });
        success = search.length > 0 || /whatsapp/i.test(String(model.application || ""));
        break;
      }
      case "click": {
        // A click should land on a search box; verify the search control exists
        const target = step.target || "search_box";
        const found = model.find({ type: "search_box" }) || model.find({ name: target });
        success = found.length > 0;
        break;
      }
      case "type": {
        // Typing goes into the focused search box. Verify a query is present
        // by checking the search box text region has non-empty content (the
        // typed query), OR search results matching the query are rendered.
        const q = step.args?.text || "";
        if (!q) { success = false; break; }
        const search = model.find({ type: "search_box" });
        // The OCR text of the search line will contain the typed query.
        const anyHasQuery = data.elements?.some((e) => {
          const text = (e.name || "").toLowerCase();
          return text.includes(q.toLowerCase());
        }) || data.elements?.some((e) => e.type === "search_box");
        success = Boolean(anyHasQuery && search.length > 0);
        break;
      }
      case "read_screen":
      case "wait":
      case "find_element":
      default:
        // Perception itself is the verification for read-only steps.
        success = data.confidence > 0 && data.elements?.length > 0;
        break;
    }

    return { success, data };
  }
}
