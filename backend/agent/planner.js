/**
 * Deterministic planner: turns a high-level goal into an ordered list of
 * steps the orchestrator can execute and verify one by one.
 *
 * This is intentionally rule-based for the MVP ("Open X and search for Y").
 * It lives behind an interface so a learned/LLM planner can replace it later
 * without rewriting the orchestrator.
 */

/**
 * @param {string} goal
 * @returns {Array<{type:string, target?:string, args?:object, risk:string}>}
 */
export function plan(goal) {
  const g = goal.trim();
  const steps = [];

  const openMatch = g.match(/open\s+([^,]+?)(?:\s+and|,|\s*$)/i);
  if (openMatch && /open/i.test(g)) {
    const app = openMatch[1].trim();
    steps.push({ type: "open_app", target: app, risk: "low" });
    steps.push({ type: "wait", args: { condition: "application_loaded" }, risk: "low" });
    steps.push({ type: "read_screen", args: { intent: `locate search in ${app}` }, risk: "low" });
  }

  const searchMatch = g.match(/search(?: for)?\s+([^.]+)$/i);
  if (searchMatch) {
    const query = searchMatch[1]
      .replace(/(?:and\s+)?open\s+[^,]+?\s*$/i, "")
      .trim();
    steps.push({ type: "find_element", target: "search_box", risk: "low" });
    steps.push({ type: "click", target: "search_box", risk: "low" });
    steps.push({ type: "type", target: "search_box", args: { text: query }, risk: "medium" });
    steps.push({ type: "wait", args: { condition: "results_rendered" }, risk: "low" });
    steps.push({ type: "read_screen", args: { intent: "locate search results" }, risk: "low" });
  }

  return steps;
}