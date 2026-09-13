# ScreenAI-Voice.exe — launcher

A tiny Windows executable that boots the **existing** Screen-AI application with
a double-click. It contains no application logic — it is only an entry point and
process manager.

```
ScreenAI-Voice.exe   (launcher: path resolution, node detection, logging, process job)
        |
        v
voice/start.js       (production entry — composes existing components)
        |
        v
VoiceUiBridge -> VoiceInterface -> AssemblyAI -> Agent Orchestrator
        |                                              |
        v                                              v
floating WPF overlay                        Screen-AI perception -> ScreenModel
                                            -> Windows tools -> Verification
```

## Files

| File | Role |
|---|---|
| `scripts/launcher/ScreenAiVoice.cs` | Launcher source (compiled to a WinExe) |
| `scripts/build-exe.ps1` | Reproducible build |
| `voice/start.js` | Production entry point (composition only) |
| `voice/app_paths.js` | App-root + argument resolution (pure, tested) |
| `voice/scripted_voice.js` | Dev-only scripted voice for `--simulate` |
| `dist/ScreenAI-Voice.exe` | Build output |

## Build

```bash
npm install
npm run build:exe
```

Options:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-exe.ps1 -BundleNode   # also copy node.exe
powershell -ExecutionPolicy Bypass -File scripts/build-exe.ps1 -IncludeEnv   # also copy env\.env (local only)
powershell -ExecutionPolicy Bypass -File scripts/build-exe.ps1 -SkipAppCopy  # rebuild the exe only
```

The launcher is compiled with the **in-box .NET Framework `csc.exe`** — no extra
runtime is installed and no Electron/Tauri is used.

### Output layout

```
dist/
    ScreenAI-Voice.exe      launcher (13 KB)
    app/                    the existing application (Node + WPF UI + node_modules + models)
    runtime/node.exe        only with -BundleNode
    README.txt
```

A true single-file exe is not practical: the application needs the Node runtime,
`node_modules` (including `onnxruntime-node` native binaries) and the OCR models.
Instead this ships a small portable folder. **`env\.env` is never copied** — the
build refuses to ship secrets.

## Run

```text
double-click dist\ScreenAI-Voice.exe
```

Flags:

| Flag | Meaning |
|---|---|
| *(none)* | **Production** — real microphone, AssemblyAI, real agent |
| `--simulate` | Development: scripted transcript, real agent (no mic/API) |
| `--debug` | Run through a visible console (shows live output) |
| `--no-dialog` | Never show dialogs (automation) |

## Dependencies

| Requirement | Notes |
|---|---|
| Windows 10/11 x64 | Uses .NET Framework 4.x (present on Windows) |
| Node.js 18+ | On `PATH`, or bundled via `-BundleNode` |
| Windows PowerShell | Ships with Windows; hosts the WPF overlay |
| SoX | Required for microphone capture (`node-record-lpcm16`) |
| `ASSEMBLYAI_API_KEY` | Environment variable or `app\env\.env` |

Missing SoX produces a warning in the log (and `Microphone unavailable` in the UI
on activation). A missing API key produces a clear dialog:

```
Screen-AI Voice Agent

ASSEMBLYAI_API_KEY is not configured.

Set the API key and restart Screen-AI Voice.
```

## Environment variables

| Variable | Purpose |
|---|---|
| `ASSEMBLYAI_API_KEY` | AssemblyAI key (never hardcoded, never logged) |
| `ASSEMBLYAI_SPEECH_MODEL` | Optional model override (default `universal-3-6-pro`) |
| `VOICE_AGENT_OCR_MODEL_DIR` | Optional OCR model directory override |

Set the key either as a Windows environment variable, or create
`app\env\.env` next to the packaged app.

## Logs

```
dist\app\logs\screenai-voice.log
```

The launcher writes a timestamped session header plus every line of the child's
stdout/stderr. If `app\logs` is not writable it falls back to
`%LOCALAPPDATA%\ScreenAI-Voice\logs\`. The API key is never written.

## Process lifecycle

1. Single-instance guard (named mutex) — a second launch exits instead of
   starting a duplicate.
2. Resolves the app root from the **executable directory** (not the cwd):
   `app/`, then the exe folder, then its parent.
3. Finds `node.exe` in `runtime\`, else on `PATH`.
4. Starts `voice/start.js` in a **Windows Job Object** (kill-on-close) and waits
   for the `SCREENAI_READY` marker.
5. If the child reports `SCREENAI_FATAL: …` or exits before ready, it shows a
   clear dialog and exits non-zero.
6. When the launcher exits, the job closes and terminates **only the processes it
   started** (Node + the WPF PowerShell). No broad `taskkill /IM node.exe`.

Quit the app by right-clicking the floating core and choosing **Quit Screen-AI**.

## Uninstall / cleanup

1. Right-click the floating core → **Quit Screen-AI** (or close via Task Manager).
2. Delete the `dist` folder.

Nothing is written to the registry. The only local state is `app\logs\` and, if
you created it, `app\env\.env`.

## Notes

- The overlay keeps all of its existing behaviour: Ctrl+Space, Escape, click to
  toggle, 11 audio-reactive bars, real transcript/step/success data. The launcher
  does not modify the UI.
- `--simulate` never runs on a normal launch; production is the default
  (enforced by `parseStartArgs` and covered by tests).
