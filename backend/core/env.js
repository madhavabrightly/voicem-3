import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal .env loader with zero dependencies.
 *
 * Values already present in process.env take precedence over the file, so a
 * real shell export or CI secret always wins. Lines are KEY=VALUE with `#`
 * comments and optional surrounding quotes. Never overwrites existing vars.
 */
export function loadEnv(filePath) {
  const resolved = filePath ?? join(dirname(fileURLToPath(import.meta.url)), "../../env/.env");
  try {
    const raw = readFileSync(resolved, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No .env file — rely on real environment variables.
  }
  return process.env;
}
