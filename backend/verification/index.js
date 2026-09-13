/**
 * Verification layer. Provides explicit ACT -> OBSERVE -> VERIFY helpers.
 * The orchestrator drives these per-step; this module defines the policy
 * and reusable predicates (e.g. element present, screen changed).
 */

/**
 * Verify that an action's expected effect is visible in a screen model.
 * @param {object} model ScreenModel
 * @param {object} expectation { type?, name?, shouldExist:boolean }
 */
export function verifyModel(model, expectation) {
  const matches = model.find({
    type: expectation.type,
    name: expectation.name,
  });
  const present = matches.length > 0;
  const ok = present === (expectation.shouldExist ?? true);
  return {
    success: ok,
    data: { present, matching: matches.map((m) => m.name), source: model.source },
  };
}

export const verifier = {
  async result(listeners = []) {},
};