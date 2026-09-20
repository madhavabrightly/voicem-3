/**
 * Classifies actions by risk so the orchestrator can gate high-risk
 * actions behind explicit user confirmation.
 *
 *    LOW    -> read screen, open application, search, scroll
 *    MEDIUM -> type text, modify settings
 *    HIGH   -> send message, delete data, purchase, financial, external submission
 *
 * OWNERSHIP: this module is the ACTION risk authority — it classifies the
 * concrete steps an agent is about to run (`{ type, target }`). COMMAND risk
 * (what the user's *utterance* asks for) is owned by P2
 * (`pipelines/p2_assemblyai/command_risk.js`), which reuses the vocabulary
 * below instead of defining its own copy. One vocabulary, two scopes.
 */

export const MEDIUM_ACTIONS = new Set(["type", "set", "modify", "update_settings", "save"]);

/**
 * The shared high-risk vocabulary, grouped by what makes a request dangerous.
 * P2's command-level classifier labels these categories; the action classifier
 * below only needs to know whether ANY of them match.
 */
export const HIGH_RISK_CATEGORIES = {
  external_communications: [/send/i, /message/i, /post/i, /submit/i, /email/i, /publish/i],
  financial: [/pay/i, /purchase/i, /buy/i, /order/i, /transfer/i, /withdraw/i],
  destructive: [/delete/i, /remove/i, /kill/i, /deploy/i],
};

/** Flat union used by the action classifier (unchanged set of patterns). */
export const HIGH_RISK_PATTERNS = Object.values(HIGH_RISK_CATEGORIES).flat();

/**
 * @param {object} action Structured action descriptor, e.g. { type:"click", target:"Dad" }.
 * @returns {"low"|"medium"|"high"}
 */
export function classifyRisk(action) {
  const type = String(action?.type || "").toLowerCase();
  const target = String(action?.target || "");
  const label = `${type} ${target}`;

  if (HIGH_RISK_PATTERNS.some((re) => re.test(label))) return "high";
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