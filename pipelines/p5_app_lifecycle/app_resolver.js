/**
 * app_resolver.js — Node.js semantic application name resolution.
 * Tickets 430–434, 444–445.
 *
 * Responsibilities:
 *   - Match natural-language app name to an AppIdentity record (431)
 *   - Rank application candidates (432)
 *   - Reject ambiguous matches (433)
 *   - Confirm target application identity (434)
 *   - Prepare deterministic launch request (445)
 */

/** @typedef {{ path: string, source: string, score: number, running?: boolean, hwnd?: string, pid?: number, aumid?: string, stem?: string, title?: string }} AppCandidate */

/** @typedef {{ name: string, displayName: string, path: string, hwnd?: string, pid?: number, aumid?: string, source: string, score: number, running: boolean }} AppIdentity */

// ── Alias map (ticket 420) — natural language → normalized executable stem ──
const NATURAL_ALIASES = {
  // Browser shortcuts
  "browser":      "chrome",
  "web browser":  "chrome",
  "internet":     "chrome",
  "google":       "chrome",
  "microsoft edge": "edge",
  "ie":           "edge",
  // Microsoft Office
  "docs":         "word",
  "document":     "word",
  "spreadsheet":  "excel",
  "sheets":       "excel",
  "slides":       "powerpoint",
  "presentation": "powerpoint",
  "email":        "outlook",
  "mail":         "outlook",
  // Messaging
  "chat":         "whatsapp",
  "messages":     "whatsapp",
  "wa":           "whatsapp",
  // Media
  "music":        "spotify",
  "player":       "vlc",
  "media player": "vlc",
  // Dev
  "editor":       "vscode",
  "vs code":      "vscode",
  "visual studio code": "vscode",
  "terminal":     "cmd",
  "console":      "cmd",
  "shell":        "powershell",
  // Utilities
  "text editor":  "notepad",
  "paint":        "paint",
  "file manager": "explorer",
  "files":        "explorer",
  "file explorer":"explorer",
};

/**
 * Normalize to lowercase slug for comparison (ticket 419).
 * @param {string} name
 * @returns {string}
 */
export function normalizeName(name) {
  if (!name) return "";
  return name.toLowerCase().trim().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ");
}

/**
 * Resolve natural-language alias to canonical name (ticket 420).
 * @param {string} naturalName
 * @returns {string}
 */
export function resolveAlias(naturalName) {
  const n = normalizeName(naturalName);
  return NATURAL_ALIASES[n] ?? n;
}

/**
 * Score a candidate against the requested name (ticket 432).
 * @param {string} query  normalized, alias-resolved query
 * @param {AppCandidate} candidate
 * @returns {number} 0..1
 */
export function scoreCandidate(query, candidate) {
  const stem  = normalizeName(candidate.stem  ?? "");
  const title = normalizeName(candidate.title ?? "");
  const src   = candidate.source ?? "";

  let score = candidate.score ?? 0;

  // Exact stem match → boost to near 1
  if (stem === query)  score = Math.max(score, 0.98);
  // Title contains query
  if (title.includes(query)) score = Math.max(score, 0.9);
  // Stem contains query
  if (stem.includes(query))  score = Math.max(score, 0.85);
  // Running instance bonus (ticket 435 detection feeds rank)
  if (candidate.running) score = Math.min(score + 0.05, 1.0);
  // Source bonuses
  if (src === "alias" || src.startsWith("alias:")) score = Math.min(score + 0.05, 1.0);
  if (src === "PATH")  score = Math.min(score + 0.02, 1.0);

  return Math.round(score * 1000) / 1000;
}

/**
 * Rank candidates by score descending (ticket 432).
 * @param {string} query  normalized, alias-resolved
 * @param {AppCandidate[]} candidates
 * @returns {AppCandidate[]}
 */
export function rankCandidates(query, candidates) {
  return candidates
    .map((c) => ({ ...c, score: scoreCandidate(query, c) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Reject ambiguous matches (ticket 433).
 * If top two candidates are within the ambiguity margin and neither is running,
 * returns a rejection object.
 * @param {AppCandidate[]} ranked sorted candidates (highest first)
 * @returns {{ ambiguous: boolean, reason?: string }}
 */
export function checkAmbiguity(ranked) {
  if (ranked.length < 2) return { ambiguous: false };
  const [first, second] = ranked;
  // If top candidate is running, it wins unambiguously
  if (first.running) return { ambiguous: false };
  const delta = first.score - second.score;
  if (delta < 0.10 && first.score < 0.95) {
    return {
      ambiguous: true,
      reason: `top candidates '${first.stem ?? first.path}' (${first.score}) and '${second.stem ?? second.path}' (${second.score}) are within ambiguity margin`,
      top:    first,
      second: second,
    };
  }
  return { ambiguous: false };
}

/**
 * Convert raw candidate to AppIdentity record (ticket 434).
 * @param {string} naturalName  original natural name from user
 * @param {AppCandidate} candidate
 * @returns {AppIdentity}
 */
export function confirmTarget(naturalName, candidate) {
  const displayName = candidate.stem ?? candidate.title ?? naturalName;
  return {
    naturalName,
    displayName,
    path:    candidate.path ?? "",
    hwnd:    candidate.hwnd ?? null,
    pid:     candidate.pid ?? null,
    aumid:   candidate.aumid ?? null,
    source:  candidate.source ?? "unknown",
    score:   candidate.score,
    running: candidate.running ?? false,
    resolvedAt: new Date().toISOString(),
  };
}

/**
 * Prepare a deterministic launch request from an AppIdentity (ticket 445).
 * Returns structured params the pipeline feeds to app_engine.ps1 launch_app.
 * @param {AppIdentity} identity
 * @returns {{ launchName: string, identity: AppIdentity, strategy: string }}
 */
export function prepareLaunchRequest(identity) {
  // If already running, strategy is "focus"
  if (identity.running && identity.hwnd) {
    return { launchName: identity.naturalName, identity, strategy: "focus_existing" };
  }
  // Store / AUMID launch
  if (identity.aumid) {
    return { launchName: identity.naturalName, identity, strategy: "store_aumid" };
  }
  // Path-based launch
  if (identity.path) {
    return { launchName: identity.naturalName, identity, strategy: "path_launch" };
  }
  // Name-based (app_engine resolves)
  return { launchName: identity.naturalName, identity, strategy: "name_resolve" };
}

/**
 * Full resolution pipeline: takes a driver + natural name → AppIdentity or rejection.
 * Tickets 430–434, 444–445.
 *
 * @param {import('./app_engine_driver.js').AppEngineDriver} driver
 * @param {string} naturalName
 * @returns {Promise<{ identity?: AppIdentity, ambiguityRejection?: object, error?: string }>}
 */
export async function resolveAppIdentity(driver, naturalName) {
  const canonical  = resolveAlias(naturalName);
  const resolution = await driver.resolveApp(canonical);

  if (!resolution.success) {
    return { error: resolution.error ?? `resolve_app failed for '${naturalName}'` };
  }

  const rawCandidates = resolution.data?.candidates ?? [];
  if (rawCandidates.length === 0) {
    return { error: `no candidates found for '${naturalName}'` };
  }

  // Enrich with normalized stems and rank
  const enriched = rawCandidates.map((c) => ({
    ...c,
    stem: c.stem ?? (c.path ? c.path.replace(/.*[/\\]/, "").replace(/\.[^.]+$/, "") : ""),
  }));

  const ranked = rankCandidates(canonical, enriched);
  const ambiguity = checkAmbiguity(ranked);

  if (ambiguity.ambiguous) {
    return { ambiguityRejection: ambiguity, candidates: ranked };
  }

  const identity = confirmTarget(naturalName, ranked[0]);
  const launchReq = prepareLaunchRequest(identity);

  return { identity, launchRequest: launchReq, allCandidates: ranked };
}
