# Floating Voice UI

A tiny, borderless, always-on-top **Windows overlay** whose centerpiece is a
living **voice core** — a cluster of animated vertical bars driven by *real*
microphone amplitude. It is a thin presentation layer over the existing agent.

```
Floating WPF overlay  <-- JSON lines (stdio) -->  VoiceUiBridge
                                                       |
                                                VoiceInterface
                                                       |
                                        AssemblyAITranscriber (mic)
                                                       |
                                            Agent Orchestrator (real)
                                                       |
                                  Screen-AI perception -> ScreenModel -> Tools -> Windows
```

The UI never talks to AssemblyAI, OCR, or Windows tools directly. It sends
activation intents and receives amplitude / transcript / state.

## Files

| File | Role |
|---|---|
| `ui/screenai-voice-ui.ps1` | WPF overlay: bars, states, hotkey, stdio protocol |
| `voice/ui_bridge.js` | State machine, amplitude smoothing, step→label mapping, protocol |
| `demo/voice-ui-demo.js` | Demo: hotkey → mic → AssemblyAI → **real** agent |
| `tests/voice_ui_bridge.test.js` | Bridge unit tests (no window/mic/network) |

## Run

```bash
node demo/voice-ui-demo.js                 # real microphone + AssemblyAI (needs key + SoX)
node demo/voice-ui-demo.js --simulate      # scripted transcript, real agent (no mic/key)
node demo/voice-ui-demo.js --simulate --exit-after 30000
```

## Interaction

| Input | Effect |
|---|---|
| **Ctrl + Space** (global) | Activate while idle / deactivate while active |
| **Escape** | Cancel the current interaction |
| **Click the core** | Toggle activate / deactivate |

The hotkey is polled with `GetAsyncKeyState` (no message hook, works regardless
of focus).

## States

`idle → listening → processing → working → success | failure → idle`

| State | Core motion | Status |
|---|---|---|
| `idle` | small calm breathing | — (collapsed pill) |
| `listening` | **audio-reactive** height/frequency | `Connecting...` / `Listening` |
| `processing` | calm flowing wave | `Understanding...` |
| `working` | faster travelling rhythm | real step label, e.g. `Opening WhatsApp...` |
| `success` | bright burst that decays | `Done` |
| `failure` | red jitter | `Couldn't verify` / `Microphone unavailable` |

`working` is driven by REAL orchestrator step events (`Logger.on` subscription),
not a fake progress animation.

## Animation design

- 11 vertical rounded bars, ~60 FPS (`DispatcherTimer`, 16 ms).
- **Center-weighted envelope** so the bars behave as one entity (taller in the
  middle), not independent equalizer columns.
- Per-state motion functions; each bar has a small phase offset from its
  neighbours.
- Two-stage smoothing: microphone RMS → EMA in the bridge (`smoothing`), then
  per-bar interpolation toward target in the UI (`0.32`). Fluid, no jitter.
- Amplitude comes from the **same PCM chunks** sent to AssemblyAI
  (`pcm16Level` in `transcriber.js`) — never a second microphone capture.

## Protocol (newline-delimited JSON over stdio)

Node → UI:

```json
{"type":"state","state":"listening","label":"Listening"}
{"type":"amplitude","value":0.42}
{"type":"transcript","text":"Open WhatsApp","final":false}
```

UI → Node:

```json
{"type":"activate"} {"type":"deactivate"} {"type":"cancel"} {"type":"retry"} {"type":"ready"}
```

## Performance

- The animation runs entirely in the UI process at 16 ms; it never blocks
  microphone capture, AssemblyAI streaming, or the agent loop.
- The bridge throttles amplitude to ~30 Hz (`throttleMs`) and the UI interpolates
  to 60 FPS.
- No full-screen OCR, no network calls, and no polling of the backend are caused
  by the UI.

## Limitations

- The WPF window needs an interactive, unlocked Windows desktop session.
- The **real** microphone path still requires `ASSEMBLYAI_API_KEY` and SoX; the
  overlay itself can be exercised with `--simulate`.
- `success`/`failure` reflect the orchestrator's verification result — the UI
  never claims success it did not receive.
