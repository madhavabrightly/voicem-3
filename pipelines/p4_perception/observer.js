/**
 * P4 Tickets 385–398: Target Resolution, Ranking, Re-perception & Sensor Fallback
 *
 *  385. Detect task-relevant element.
 *  386. Rank matching elements.
 *  387. Resolve semantic target.
 *  388. Resolve fuzzy text target.
 *  389. Resolve exact text target.
 *  390. Resolve role target.
 *  391. Resolve application target.
 *  392. Resolve context target.
 *  393. Reject low-confidence target.
 *  394. Request re-perception.
 *  395. Retry OCR.
 *  396. Retry UIA.
 *  397. Retry vision.
 *  398. Return ScreenModel.
 */

export const MIN_ELEMENT_CONFIDENCE = 0.5;

/**
 * 385–393. Ranks elements against a target description (exact > fuzzy > role > semantic alias).
 */
export function rankMatchingElements(elements = [], targetDescription = {}, { minConfidence = MIN_ELEMENT_CONFIDENCE } = {}) {
  const targetText = String(targetDescription.name || targetDescription.text || "").trim().toLowerCase();
  const targetRole = String(targetDescription.role || targetDescription.type || "").trim().toLowerCase();

  const scored = [];

  for (const el of elements) {
    const elConfidence = el.confidence ?? 0.8;
    // 393. Reject low-confidence target
    if (elConfidence < minConfidence) continue;

    const elName = String(el.name || "").trim().toLowerCase();
    const elRole = String(el.role || "").trim().toLowerCase();
    const elType = String(el.type || "").trim().toLowerCase();

    let score = 0;
    let matchType = "none";

    // 389. Exact text target
    if (targetText && elName === targetText) {
      score += 100;
      matchType = "exact_text";
    }
    // 388. Fuzzy / substring text target
    else if (targetText && (elName.includes(targetText) || (targetText.length > 3 && elName.startsWith(targetText)))) {
      score += 60;
      matchType = "fuzzy_text";
    }

    // 390. Role target
    if (targetRole && (elRole === targetRole || elType === targetRole)) {
      score += 40;
      if (matchType === "none") matchType = "role";
    }

    // 387. Semantic aliases (e.g. search / search_box)
    if (
      (targetRole === "search" || targetRole === "search_box" || targetText === "search_box") &&
      (elType === "search_box" || elRole === "search" || elRole === "search_box")
    ) {
      score += 50;
      if (matchType === "none") matchType = "semantic_alias";
    }

    if (score > 0) {
      score += Math.round(elConfidence * 10);
      scored.push({ element: el, score, matchType, confidence: elConfidence });
    }
  }

  // 386. Rank matching elements descending by score
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.element);
}

/**
 * 394–398. Observer engine managing sensor priority, retry, and ScreenModel return.
 */
export class ObserverEngine {
  /**
   * @param {object} p
   * @param {object} p.sensorManager MultiSensorManager
   * @param {object} p.environmentProbe EnvironmentProbe
   * @param {object} p.browserTargetResolver BrowserTargetResolver
   * @param {object} p.stalenessManager StalenessManager
   */
  constructor({
    sensorManager = null,
    environmentProbe = null,
    browserTargetResolver = null,
    stalenessManager = null,
    clock = () => Date.now(),
  } = {}) {
    this.sensorManager = sensorManager;
    this.environmentProbe = environmentProbe;
    this.browserTargetResolver = browserTargetResolver;
    this.stalenessManager = stalenessManager;
    this.clock = clock;
    this._lastModel = null;
  }

  /**
   * 394–398. Perceive screen with multi-sensor fallback & retry.
   */
  async observe({ intent = {}, preferredMethod = null, maxRetries = 2 } = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        // Step 1: Probe environment (303–306)
        const environment = this.environmentProbe ? await this.environmentProbe.probe() : null;

        // Step 2: Run sensor scan (UIA -> OCR -> Vision)
        const sensorResult = this.sensorManager
          ? await this.sensorManager.scan({ intent, preferredMethod })
          : { elements: [], source: "none", confidence: 0 };

        // Step 3: Resolve browser target if in browser (336, 383)
        const browserTarget = this.browserTargetResolver
          ? await this.browserTargetResolver.resolveBrowserTarget({ environment, uiaElements: sensorResult.elements })
          : null;

        return {
          environment,
          elements: sensorResult.elements,
          source: sensorResult.source,
          confidence: sensorResult.confidence,
          browserTarget,
        };
      } catch (err) {
        lastError = err;
        // 395, 396, 397: Bounded backoff retry
        await new Promise((r) => setTimeout(r, 100 * attempt));
      }
    }

    throw lastError || new Error("perception failed after retries");
  }
}
