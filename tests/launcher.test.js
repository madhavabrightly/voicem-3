import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveAppRoot, parseStartArgs, START_ENTRY } from "../voice/app_paths.js";
import { createScriptedVoice } from "../voice/scripted_voice.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

test("launcher: production is the default; simulation must be explicit", () => {
  assert.equal(parseStartArgs([]).simulate, false);
  assert.equal(parseStartArgs(["--debug"]).simulate, false);
  assert.equal(parseStartArgs(["--no-dialog"]).simulate, false);
  assert.equal(parseStartArgs(["--simulate"]).simulate, true);
});

test("launcher: app root resolves from the executable directory, not the cwd", () => {
  const base = mkdtempSync(join(tmpdir(), "screenai-root-"));
  try {
    // Portable dist layout: <dir>/app/voice/start.js
    const appDir = join(base, "app", "voice");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(base, "app", START_ENTRY), "// entry\n");
    assert.equal(resolveAppRoot(base), join(base, "app"));

    // Project directory layout: <dir>/voice/start.js
    const projectDir = join(base, "project");
    mkdirSync(join(projectDir, "voice"), { recursive: true });
    writeFileSync(join(projectDir, START_ENTRY), "// entry\n");
    assert.equal(resolveAppRoot(projectDir), projectDir);

    // Nothing found -> null (launcher reports a clear error)
    const empty = join(base, "empty");
    mkdirSync(empty, { recursive: true });
    assert.equal(resolveAppRoot(empty), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("launcher: production entry refuses to start without ASSEMBLYAI_API_KEY", () => {
  const result = spawnSync(process.execPath, [join(ROOT, "voice", "start.js")], {
    cwd: ROOT,
    env: { ...process.env, ASSEMBLYAI_API_KEY: "" },
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /SCREENAI_FATAL: ASSEMBLYAI_API_KEY is not configured/);
});

test("launcher: production entry never falls into simulation mode by default", () => {
  const result = spawnSync(process.execPath, [join(ROOT, "voice", "start.js")], {
    cwd: ROOT,
    env: { ...process.env, ASSEMBLYAI_API_KEY: "" },
    encoding: "utf8",
    timeout: 60000,
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 2);
  assert.doesNotMatch(output, /simulation mode/i);
  assert.doesNotMatch(output, /scripted transcript/i);
});

test("launcher: simulated voice emits the scripted partials then one final", async () => {
  const voice = createScriptedVoice({ initialDelayMs: 5, stepMs: 5, finalDelayMs: 5 });
  const partials = [];
  let final = null;
  voice.onPartial((t) => partials.push(t));
  voice.onTranscript(async (t) => { final = t; });

  await voice.start();
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.deepEqual(partials, ["Open WhatsApp", "Open WhatsApp and search", "Open WhatsApp and search for Dad"]);
  assert.equal(final, "Open WhatsApp and search for Dad");
  await voice.stop();
});

test("launcher: build inputs exist (exe source + build script + production entry)", () => {
  assert.ok(existsSync(join(ROOT, "scripts", "launcher", "ScreenAiVoice.cs")), "launcher source missing");
  assert.ok(existsSync(join(ROOT, "scripts", "build-exe.ps1")), "build script missing");
  assert.ok(existsSync(join(ROOT, "voice", "start.js")), "production entry missing");
  assert.ok(existsSync(join(ROOT, "ui", "screenai-voice-ui.ps1")), "WPF UI missing");
});
