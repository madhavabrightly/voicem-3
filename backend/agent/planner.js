/**
 * Universal Computer Control Planner:
 * Turns natural-language voice commands into ordered, typed steps that
 * the orchestrator executes and verifies against the live screen.
 *
 * Supports:
 *   - App launching: "Open Notepad", "Launch Chrome", "Start Calculator"
 *   - App closing: "Close window", "Close Notepad", "Exit"
 *   - Screen clicking: "Click Submit", "Click File", "Tap Search", "Select Dad"
 *   - Advanced clicking: "Double click Document", "Right click Desktop"
 *   - Text entry: "Type Hello world", "Type mypassword into Password field"
 *   - Search: "Search for weather in Tokyo", "Search Dad"
 *   - Keystrokes: "Press Enter", "Press Escape", "Press Ctrl+C", "Press Alt+F4"
 *   - Navigation & Scrolling: "Scroll down", "Scroll up", "Maximize", "Minimize"
 *   - OCR Screen Reading: "Read screen", "What's on my screen", "Inspect screen"
 *   - Multi-step chains: "Open Notepad and type Hello world"
 *
 * Preserves the canonical MVP pipeline ("Open X and search for Y") verbatim.
 */

/**
 * @param {string} goal
 * @returns {Array<{type:string, target?:string, args?:object, risk:string}>}
 */
export function plan(goal) {
  const g = String(goal || "").trim();
  if (!g) return [];

  // Canonical MVP flow: "Open X and search for Y"
  const openAndSearchMatch = g.match(/^open\s+([^,]+?)\s+(?:and\s+search|search)(?: for)?\s+([^.]+)$/i);
  if (openAndSearchMatch) {
    const app = openAndSearchMatch[1].trim();
    const query = openAndSearchMatch[2].replace(/^for\s+/i, "").trim();
    return [
      { type: "open_app", target: app, risk: "low" },
      { type: "wait", args: { condition: "application_loaded" }, risk: "low" },
      { type: "read_screen", args: { intent: `locate search in ${app}` }, risk: "low" },
      { type: "find_element", target: "search_box", risk: "low" },
      { type: "click", target: "search_box", risk: "low" },
      { type: "type", target: "search_box", args: { text: query }, risk: "medium" },
      { type: "wait", args: { condition: "results_rendered" }, risk: "low" },
      { type: "read_screen", args: { intent: "locate search results" }, risk: "low" },
    ];
  }

  // Split compound sentences: "open notepad and type hello", "click file then click save"
  const clauses = splitCompoundGoal(g);
  const steps = [];

  for (const clause of clauses) {
    const clauseSteps = planSingleClause(clause);
    if (clauseSteps.length > 0) {
      steps.push(...clauseSteps);
    }
  }

  return steps;
}

function splitCompoundGoal(text) {
  // Split on "then", "and then", or "and" followed by an action verb
  const ACTION_VERBS = "open|launch|start|run|close|quit|exit|click|tap|double\\s+click|right\\s+click|type|enter|write|press|hit|scroll|maximize|minimize|read\\s+screen|search|find";
  const regex = new RegExp(`(?:\\s+then\\s+|\\s+and\\s+then\\s+|\\s+and\\s+(?=(?:${ACTION_VERBS})\\b)|,\\s*)`, "i");
  return text.split(regex).map((s) => s.trim()).filter(Boolean);
}

function planSingleClause(clause) {
  const c = clause.trim();
  const steps = [];

  // 1. Read screen / OCR
  if (/^(?:read(?:\s+the)?\s+screen|what(?:'s|\s+is)\s+on(?:\s+the)?\s+screen|inspect(?:\s+the)?\s+screen|see\s+screen)$/i.test(c)) {
    return [{ type: "read_screen", risk: "low" }];
  }

  // 2. Double click / Right click
  const doubleClickMatch = c.match(/^(?:double(?:\s+|-)?click)\s+(?:on\s+)?(?:the\s+)?(.+)$/i);
  if (doubleClickMatch) {
    const target = doubleClickMatch[1].trim();
    return [
      { type: "find_element", target, risk: "low" },
      { type: "double_click", target, risk: "low" },
    ];
  }

  const rightClickMatch = c.match(/^(?:right(?:\s+|-)?click)\s+(?:on\s+)?(?:the\s+)?(.+)$/i);
  if (rightClickMatch) {
    const target = rightClickMatch[1].trim();
    return [
      { type: "find_element", target, risk: "low" },
      { type: "right_click", target, risk: "low" },
    ];
  }

  // 3. Regular Click
  const clickMatch = c.match(/^(?:click|tap|press on|select)\s+(?:on\s+)?(?:the\s+)?(.+)$/i);
  if (clickMatch) {
    const target = clickMatch[1].trim();
    return [
      { type: "find_element", target, risk: "low" },
      { type: "click", target, risk: "low" },
    ];
  }

  // 4. Type into a target: "type hello into search box"
  const typeIntoMatch = c.match(/^(?:type|enter|write)\s+["']?(.+?)["']?\s+(?:in|into|on)\s+(?:the\s+)?(.+)$/i);
  if (typeIntoMatch) {
    const text = typeIntoMatch[1].trim();
    const target = typeIntoMatch[2].trim();
    return [
      { type: "find_element", target, risk: "low" },
      { type: "click", target, risk: "low" },
      { type: "type", target, args: { text }, risk: "medium" },
    ];
  }

  // 5. Type text directly: "type Hello World"
  const typeMatch = c.match(/^(?:type|enter|write)\s+["']?(.+?)["']?$/i);
  if (typeMatch) {
    const text = typeMatch[1].trim();
    return [{ type: "type", args: { text }, risk: "medium" }];
  }

  // 6. Press key: "press enter", "press escape", "press ctrl+c"
  const pressMatch = c.match(/^(?:press|hit|send key)\s+(.+)$/i);
  if (pressMatch) {
    const key = pressMatch[1].trim();
    return [{ type: "press", target: key, risk: "low" }];
  }

  // 7. Scroll: "scroll down", "scroll up"
  const scrollMatch = c.match(/^scroll(?:\s+(up|down))?/i);
  if (scrollMatch) {
    const dir = scrollMatch[1]?.toLowerCase() === "up" ? "up" : "down";
    return [{ type: "scroll", target: dir, args: { direction: dir }, risk: "low" }];
  }

  // 8. Close window / app: "close notepad", "close window", "quit"
  const closeMatch = c.match(/^(?:close|quit|exit)(?:\s+(?:the\s+)?(?:window|app|\S+))?$/i);
  if (closeMatch) {
    return [{ type: "press", target: "alt+f4", risk: "medium" }];
  }

  // 9. Window management: "maximize", "minimize"
  if (/^maximize(?:\s+window)?$/i.test(c)) {
    return [{ type: "press", target: "win+up", risk: "low" }];
  }
  if (/^minimize(?:\s+window)?$/i.test(c)) {
    return [{ type: "press", target: "win+down", risk: "low" }];
  }

  // 10. Open app: "open notepad", "launch chrome"
  const openMatch = c.match(/^(?:open|launch|start|run)\s+(?:the\s+)?(.+)$/i);
  if (openMatch) {
    const app = openMatch[1].trim();
    return [
      { type: "open_app", target: app, risk: "low" },
      { type: "wait", args: { condition: "application_loaded" }, risk: "low" },
      { type: "read_screen", args: { intent: `locate ${app}` }, risk: "low" },
    ];
  }

  // 11. Search: "search for quantum computing"
  const searchMatch = c.match(/^(?:search|find)(?:\s+for)?\s+(.+)$/i);
  if (searchMatch) {
    const query = searchMatch[1].trim();
    return [
      { type: "find_element", target: "search_box", risk: "low" },
      { type: "click", target: "search_box", risk: "low" },
      { type: "type", target: "search_box", args: { text: query }, risk: "medium" },
      { type: "press", target: "enter", risk: "low" },
      { type: "wait", args: { condition: "results_rendered" }, risk: "low" },
      { type: "read_screen", args: { intent: "locate search results" }, risk: "low" },
    ];
  }

  return steps;
}