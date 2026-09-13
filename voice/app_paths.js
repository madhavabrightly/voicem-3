/**
 * Application path + argument resolution for the launcher / production entry.
 *
 * Kept dependency-free and pure so it can be unit-tested and, importantly, so
 * the packaged app never depends on the current working directory.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** Relative path (from an app root) of the production entry point. */
export const START_ENTRY = join("voice", "start.js");

/**
 * Resolve the application root from a launcher/exe directory.
 *
 * Supports both layouts:
 *   - portable dist:  <dir>/app/voice/start.js
 *   - project dir:    <dir>/voice/start.js
 *
 * @param {string} baseDir directory of the executable (or any starting point)
 * @param {{exists?: (path: string) => boolean}} [opts]
 * @returns {string|null} absolute app root, or null if not found
 */
export function resolveAppRoot(baseDir, { exists = existsSync } = {}) {
  const candidates = [join(baseDir, "app"), baseDir, resolve(baseDir, "..")];
  for (const candidate of candidates) {
    if (exists(join(candidate, START_ENTRY))) return candidate;
  }
  return null;
}

/**
 * Parse launcher/CLI flags. Production is the DEFAULT — simulation must be
 * requested explicitly, so a normal launch can never fall into simulated mode.
 * @param {string[]} argv
 */
export function parseStartArgs(argv = []) {
  const args = new Set(argv);
  return {
    simulate: args.has("--simulate"),
    debug: args.has("--debug"),
  };
}
