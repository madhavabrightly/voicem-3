/**
 * P2 tickets 153–164 — COMMAND-level risk classification.
 *
 *  153. Detect unsafe command.          159. Detect file deletion command.
 *  154. Forward unsafe command to risk layer.
 *  155. Detect destructive command.     160. Detect shutdown command.
 *  156. Detect external communication.  161. Detect restart command.
 *  157. Detect financial command.       162. Detect installation command.
 *  158. Detect credential command.      163. Detect permission request.
 *                                       164. Detect confirmation requirement.
 *
 * OWNERSHIP BOUNDARY
 *   COMMAND risk (this module, P2): what the user's *utterance* is asking for.
 *   ACTION risk (`backend/agent/risk.js`): the concrete step an agent is about
 *   to run, classified per step and gated by the orchestrator / P3.
 *
 * This module adds NO new vocabulary for the categories that already exist —
 * it imports `HIGH_RISK_CATEGORIES` and matches the SAME RegExp objects, so a
 * word cannot be dangerous to one layer and harmless to the other. Command-only
 * categories (credentials, file deletion, system control, installation,
 * permission) are additive and deliberately NOT part of the action classifier's
 * union, so action-risk behaviour is unchanged.
 */
import { HIGH_RISK_CATEGORIES } from "../../backend/agent/risk.js";

export const COMMAND_RISK_LEVEL = { NONE: "none", MEDIUM: "medium", HIGH: "high" };

/**
 * Per-category detectors. Shared categories reuse the action classifier's
 * patterns verbatim; command-only categories are declared here because the
 * action layer does not (and should not) classify them.
 */
export const COMMAND_RISK_CATEGORIES = {
  // ---- shared with ACTION risk (same objects, no copies) ----
  external_communications: { level: "high", patterns: HIGH_RISK_CATEGORIES.external_communications },
  financial: { level: "high", patterns: HIGH_RISK_CATEGORIES.financial },
  destructive: { level: "high", patterns: HIGH_RISK_CATEGORIES.destructive },

  // ---- command-only (additive; action-risk union untouched) ----
  credentials: {
    level: "high",
    patterns: [/\bpasswords?\b/i, /\bpasscode\b/i, /\bcredentials?\b/i, /\bapi\s?key\b/i, /\bsecret\b/i, /\btoken\b/i, /\bpin\b/i, /\bcredit\s?card\b/i, /\bcvv\b/i, /\bbank\s?details?\b/i, /\blog\s?in\b/i, /\bsign\s?in\b/i],
  },
  file_deletion: {
    level: "high",
    patterns: [/\b(delete|remove|erase|trash)\b[^.]{0,40}\b(file|folder|document|directory|everything|photos?)\b/i, /\bempty\b[^.]{0,20}\b(recycle bin|trash)\b/i],
  },
  system_control: {
    level: "high",
    patterns: [/\bshut\s?down\b/i, /\brestart\b/i, /\breboot\b/i, /\btask\s?manager\b/i, /\bkill\s+process\b/i, /\bend\s+task\b/i],
  },
  installation: {
    level: "medium",
    patterns: [/\binstall\b/i, /\buninstall\b/i, /\breinstall\b/i, /\bupdate\b/i, /\bupgrade\b/i, /\bset\s?up\b/i],
  },
  permission: {
    level: "medium",
    patterns: [/\badministrator\b/i, /\badmin\b/i, /\bpermissions?\b/i, /\buac\b/i, /\belevate\b/i, /\brun as\b/i, /\bgrant access\b/i, /\ballow access\b/i],
  },
};

/** Categories that always require explicit confirmation. */
export const ALWAYS_CONFIRM = ["external_communications", "financial", "destructive", "credentials", "file_deletion", "system_control", "permission"];

/**
 * @param {string} text original utterance
 * @param {object} [opts]
 * @param {string} [opts.primary] request type (informational requests are never confirmed)
 * @param {string[]} [opts.confirmOn] policy override, e.g. ["medium","high"]
 * @returns {{level:string, categories:Array<{id:string,level:string,matches:Array<{text:string,start:number,end:number}>}>, reasons:string[], permissionRequired:boolean, confirmationRequired:boolean, forwardedToRiskLayer:boolean}}
 */
export function classifyCommandRisk(text, { primary = null, confirmOn = ["high"] } = {}) {
  const raw = String(text ?? "");
  const categories = [];

  for (const [id, definition] of Object.entries(COMMAND_RISK_CATEGORIES)) {
    const matches = [];
    for (const pattern of definition.patterns) {
      const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      let match;
      while ((match = re.exec(raw)) !== null) {
        // Exact span of the utterance that triggered the category.
        matches.push({ text: match[0], start: match.index, end: match.index + match[0].length });
        if (re.lastIndex === match.index) re.lastIndex += 1;
      }
    }
    if (matches.length === 0) continue;
    // Report the first occurrence of each distinct match text, deterministically.
    const seen = new Set();
    const unique = matches.filter((m) => {
      if (seen.has(m.text.toLowerCase())) return false;
      seen.add(m.text.toLowerCase());
      return true;
    });
    categories.push({ id, level: definition.level, matches: unique });
  }

  const level = categories.some((c) => c.level === "high")
    ? COMMAND_RISK_LEVEL.HIGH
    : categories.length > 0
      ? COMMAND_RISK_LEVEL.MEDIUM
      : COMMAND_RISK_LEVEL.NONE;

  const permissionRequired = categories.some((c) => c.id === "permission");
  const mustConfirm = categories.some((c) => ALWAYS_CONFIRM.includes(c.id));
  const levelRequires = confirmOn.includes(level);
  // An informational question is REPORTED as risky but never gated as an action:
  // asking "what's my bank balance" must not require an approval to answer.
  const informational = primary === "question" || primary === "information";

  return {
    level, // 153
    categories,
    reasons: categories.map((c) => `${c.id}: ${c.matches.map((m) => `"${m.text}"`).join(", ")}`),
    permissionRequired, // 163
    confirmationRequired: (mustConfirm || levelRequires) && !informational, // 164
    forwardedToRiskLayer: level === COMMAND_RISK_LEVEL.HIGH, // 154
  };
}

/** True when the command must not run without an explicit approval. */
export function requiresCommandConfirmation(risk) {
  return Boolean(risk?.confirmationRequired);
}

/** Compact human summary for logs. */
export function describeCommandRisk(risk) {
  if (!risk) return "none";
  if (risk.level === COMMAND_RISK_LEVEL.NONE) return "none";
  return `${risk.level} (${risk.categories.map((c) => c.id).join(", ")})`;
}
