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
  ensureAudioPath(rootDir);
  return process.env;
}

/**
 * Auto-discover SoX binary and ensure it is in process.env.PATH.
 */
function ensureAudioPath(rootDir) {
  if (process.platform !== "win32") return;
  const localAppData = process.env.LOCALAPPDATA || "";
  const soxCandidates = [
    join(rootDir, "runtime", "sox"),
    join(rootDir, "app", "runtime", "sox"),
    join(rootDir, "../runtime", "sox"),
    join(localAppData, "Microsoft", "WinGet", "Packages", "ChrisBagwell.SoX_Microsoft.Winget.Source_8wekyb3d8bbwe", "sox-14.4.2"),
    join(localAppData, "Microsoft", "WindowsApps"),
    "C:\\ProgramData\\chocolatey\\bin",
    "C:\\Program Files (x86)\\sox-14-4-2",
    "C:\\Program Files\\sox-14-4-2",
  ];

  for (const dir of soxCandidates) {
    try {
      const soxExe = join(dir, "sox.exe");
      if (readFileSync(soxExe)) {
        if (!process.env.PATH.includes(dir)) {
          process.env.PATH = `${dir};${process.env.PATH}`;
        }
        break;
      }
    } catch {
      // not in this candidate directory
    }
  }
}
