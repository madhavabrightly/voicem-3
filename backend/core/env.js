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
  const rootDir = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const candidates = filePath ? [filePath] : [join(rootDir, ".env"), join(rootDir, "env/.env")];

  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, "utf8");
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
      // Ignore if file is missing or unreadable
    }
  }
  return process.env;
}
