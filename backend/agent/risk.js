/**
 * Classifies actions by risk so the orchestrator can gate high-risk
 * actions behind explicit user confirmation.
 *
 *    LOW    -> read screen, open application, search, scroll
 *    MEDIUM -> type text, modify settings
 *    HIGH   -> send message, delete data, purchase, financial, external submission
 */

const MEDIUM_ACTIONS = new Set(["type", "set", "modify", "update_settings", "save"]);
const HIGH_PATTERNS = [
  /send/i,
  /message/i,
  /post/i,
  /submit/i,
  /email/i,
  /pay/i,
  /purchase/i,
  /buy/i,
  /order/i,
  /transfer/i,
  /withdraw/i,
  /delete/i,
  /remove/i,
  /kill/i,
  /publish/i,
  /deploy/i,
];

/**
 * @param {object} action Structured action descriptor, e.g. { type:"click", target:"Dad" }.
 * @returns {"low"|"medium"|"high"}
 */
export function classifyRisk(action) {
  const type = String(action?.type || "").toLowerCase();
  const target = String(action?.target || "");
  const label = `${type} ${target}`;

  if (HIGH_PATTERNS.some((re) => re.test(label))) return "high";
  if (MEDIUM_ACTIONS.has(type)) return "medium";
  return "low";
}

/**
 * Policy: risk level must be <= allowedThreshold to proceed without confirmation.
 * @returns {"low"|"medium"|"high"}
 */
export function requiredThresholdFor(action, config = {}) {
  const policy = config?.agent?.requireConfirmationFor || ["high", "medium"];
  return policy;
}

export function requiresConfirmation(action, config = {}) {
  const risk = classifyRisk(action);
  const policy = config?.agent?.requireConfirmationFor || ["high", "medium"];
  return policy.includes(risk) ? risk : null;
}