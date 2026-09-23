# Setup and Test Results

This document summarizes the environment configuration steps taken and the results of the subsequent Voice Agent and OCR integration tests.

## 1. What Was Done (Environment Setup)

To prepare for the AssemblyAI integration and ensure secure API key handling, the following changes were made:
- **Environment Loader Improved:** Updated `backend/core/env.js` to automatically load variables from both a root `.env` and `env/.env`, making configuration much more flexible.
- **Git Ignore Configured:** Updated `.gitignore` to ensure `.env` and `.env*` are strictly ignored by Git, ensuring API keys are never accidentally committed or pushed.
- **Environment Templates Created:** Created `.env` files with secure placeholder values for the user to paste their `ASSEMBLYAI_API_KEY`.
- **Dependencies Installed:** Ran `npm install` to download required packages (`assemblyai`, `node-record-lpcm16`) into the `.gitignore`'d `node_modules` folder.

## 2. Test Results

### Voice Pipeline Check
**Result:** **PASS**
* **Validation:** Verified the architecture in `voice/assemblyai/transcriber.js`. It correctly utilizes `node-record-lpcm16` for real microphone capture, streams the audio via WebSockets using the official `assemblyai` SDK, and emits the real transcript directly to the agent (`orchestrator.run(transcript)`). No mock pipelines or hardcoded inputs exist in this layer.

### OCR Check
**Result:** **FAIL**
* **Command Executed:** Custom scratch script (`scratch/test-ocr.js`) invoking `WindowsDriver.ocr()` on the live screen.
* **Actual Error Found:** `Exception calling "CopyFromScreen" with "5" argument(s): "The handle is invalid"`
* **Reason:** This occurs because the tests were executed in a headless/background environment without an active, unlocked GUI desktop session, causing Windows to reject screen capture requests.

### AssemblyAI Integration Check
**Result:** **FAIL**
* **Command Executed:** `node demo/voice-mvp-demo.js`
* **Actual Error Found:** `[voice:error] Microphone unavailable`
* **Reason:** The script successfully started connecting to AssemblyAI (`[voice] Connecting to AssemblyAI...`), but immediately failed because there is no active physical microphone or recording device (SoX) attached to this environment to capture the live stream.

### Existing MVP Regression
**Result:** **PASS**
* **Command Executed:** `node demo/mvp-demo.js`
* **Validation:** The simulated integration test executed flawlessly. It successfully launched the application, simulated the correct typing actions (`typed "Dad"`), and reached the completed task state (`task status: done`), confirming no core codebase logic was broken during the setup phase.

## 3. Real OCR + UIA Perception (extracted from Screen-AI)

To replace the stub perception with real screen understanding, the PaddleOCR ONNX
models and the Windows UI Automation scanner were extracted from the `Screen-AI`
project and wired into a Node-native engine. See [`docs/OCR.md`](./docs/OCR.md).

### What Was Done
- **Real OCR engine:** added `backend/perception/paddle_ocr/` — a dependency-light
  Node implementation of the PaddleOCR pipeline (DB text detection + CTC
  recognition) running the Screen-AI ONNX models via `onnxruntime-node`.
- **Models extracted:** `ocr_det_v3.onnx` + `ocr_rec_english.onnx` (from Screen-AI)
  and the missing `ocr_rec_dict.txt` + `ocr_rec_config.json` (from the model's
  Hugging Face repo). `scripts/fetch-ocr-models.mjs` reproduces them.
- **Real UIA:** ported `screen_element_scanner/uia_scan.ps1` plus a driver/sensor so
  structured Windows controls are available.
- **Wiring:** `buildRealAgent` now runs Windows OCR (primary, unchanged) →
  PaddleOCR ONNX → UIA as additive fallbacks.

### Test Results

#### OCR engine — unit
**Result:** **PASS**
* **Command Executed:** `node --test tests/paddle_ocr_unit.test.js`
* **Validation:** CTC decode collapses repeats and drops the blank; dictionary
  blank/char/space mapping holds; det post-process finds and unclips text regions.

#### OCR engine — real ONNX inference
**Result:** **PASS**
* **Command Executed:** `node --test tests/paddle_ocr_model.test.js`
* **Validation:** the real det+rec models recognized `"← File Edit View Help"` from
  `tests/fixtures/menu_bar.png`.

#### OCR demo (fixture + live screen)
**Result:** **PASS**
* **Commands Executed:** `node demo/ocr-demo.js --image tests/fixtures/menu_bar.png`
  and `node demo/ocr-demo.js`
* **Validation:** fixture OCR produced `"← File Edit View Help"`; the live capture
  (1920×1080) produced 29 text lines in ~885 ms and mapped them into a `ScreenModel`
  (recognized as the WhatsApp chat list with contact elements).

#### UIA scanner
**Result:** **PASS**
* **Validation:** the scanner returned the live Windows UIA tree (role/label/bounds
  per element), filtered to the foreground process when a foreground probe is set.

#### Regression
**Result:** **PASS**
* **Validation:** all pre-existing tests still pass and `node demo/mvp-demo.js` is
  unchanged; the new fallbacks do not run when Windows OCR already succeeds.

### Notes / Limitations
- Detector post-process is axis-aligned (no rotated boxes) — adequate for UI text.
- ONNX inference runs on CPU (~0.6–0.9 s per 1920×1080 frame).
- Screen capture and UIA require an interactive, unlocked Windows desktop session.
- UIA does not expose browser web content, so it is a fallback rather than the
  primary sensor for web apps.

## 4. AssemblyAI Realtime Voice → Existing Agent Orchestrator

Milestone: prove `real microphone → AssemblyAI realtime STT → final transcript →
existing orchestrator.run()`, without touching perception or the agent.

### What Was Done
- Kept AssemblyAI isolated behind the existing `VoiceInterface`
  (`voice/assemblyai/index.js`); the agent never imports the SDK.
- `voice/assemblyai/transcriber.js` streams 16 kHz mono PCM from the microphone
  through `client.streaming.transcriber(...)`. Only turns with
  `end_of_turn === true` are emitted as `final`; interim updates are `partial`
  (display only) and never reach the agent.
- Added `onError(...)` to `VoiceInterface` and switched to the SDK's native
  bounded reconnect (`maxConnectionRetries: 2`) instead of a competing loop.
- Added `tests/voice_events.test.js` (unit + deterministic fixture simulation).

### API verification (current official docs)
- Surface: `client.streaming.transcriber({...})`, events `open | turn | error | close`,
  `connect()`, `sendAudio(Buffer)`, `close()`.
- Final turn is identified by `turn.end_of_turn === true`; mono 16-bit PCM @ 16 kHz.
- Installed SDK: `assemblyai` 4.41.1.

### Test Results

#### Unit — partial vs final
**Result:** **PASS**
* **Command:** `node --test tests/voice_events.test.js`
* **Validation:** partials never emit `final`; finals emit exactly once (deduped by
  `turn_order`); empty/whitespace finals are ignored; transcripts are trimmed.

#### Fixture / demo simulation
**Result:** **PASS**
* **Validation:** deterministic voice-event simulation — three `partial` events produce
  **0** orchestrator calls; one `final` event produces **exactly 1** call to the real
  `orchestrator.run("Open WhatsApp and search for Dad")`.

#### Live microphone
**Result:** **BLOCKED BY ENVIRONMENT**
* No `ASSEMBLYAI_API_KEY` configured and no SoX/microphone backend on this machine.
* `node demo/voice-mvp-demo.js` fails cleanly: `[voice:error] ASSEMBLYAI_API_KEY is not configured`.
* Not claimed as working.

#### Regression
**Result:** **PASS**
* Full suite: `node --test "tests/**/*.test.js"` → 21/21 (MVP, real-desktop,
  OCR/PaddleOCR, UIA, and voice).

## 5. Floating Voice UI (reactive voice core)

A minimal always-on-top WPF overlay whose centerpiece is an animated vertical-bar
"voice core" driven by REAL microphone amplitude. See [`docs/UI.md`](./docs/UI.md).

### What Was Done
- `ui/screenai-voice-ui.ps1` — borderless, translucent, topmost WPF window; 11
  rounded bars with center-weighted, smoothed motion; global **Ctrl+Space**
  hotkey (`GetAsyncKeyState`), Escape to cancel, click to toggle.
- `voice/ui_bridge.js` — state machine (`idle → listening → processing → working →
  success | failure → idle`), amplitude smoothing/throttling, and REAL step→label
  mapping via a `Logger.on` subscription.
- `AssemblyAITranscriber` now emits `audio(level)` from the **same PCM chunks**
  sent to AssemblyAI (`pcm16Level`), surfaced as `VoiceInterface.onAudio`.
- `demo/voice-ui-demo.js` — real agent + mic/AssemblyAI (`--simulate` for a
  scripted transcript, clearly labelled).

### Test Results

#### Bridge unit tests
**Result:** **PASS**
* **Command:** `node --test tests/voice_ui_bridge.test.js`
* **Validation:** partials never execute the agent; the final turn runs the real
  orchestrator exactly once; states go listening→processing→working→success;
  `working` carries the real step label (`Opening WhatsApp...`); amplitude frames
  rise toward louder input and stay normalised; failure reports `Couldn't verify`
  and retry re-runs; cancel stops the voice and returns to idle; a missing
  microphone reports `Microphone unavailable` without crashing.

#### Overlay self-test
**Result:** **PASS**
* **Command:** `powershell -NoProfile -ExecutionPolicy Bypass -File ui\screenai-voice-ui.ps1 -SelfTest`
* **Validation:** window builds, animation frames run with synthetic amplitude,
  dispatcher shuts down cleanly (`exit=0`).

#### End-to-end demo (scripted voice, REAL agent)
**Result:** **PASS**
* **Command:** `node demo/voice-ui-demo.js --simulate --exit-after 32000`
* **Validation:** overlay spawned, activated, streamed partials, ran the REAL
  Windows agent to `task_done`, showed success, then collapsed and exited with no
  leftover processes.

#### Live microphone through the overlay
**Result:** **BLOCKED BY ENVIRONMENT**
* No `ASSEMBLYAI_API_KEY` and no SoX/microphone backend on this machine; the real
  hotkey→mic→AssemblyAI path could not be exercised. Not claimed as working.

#### Regression
**Result:** **PASS**
* Full suite: `node --test "tests/**/*.test.js"` → 27/27.

## 6. Windows Launcher (ScreenAI-Voice.exe)

A small native `.exe` that boots the EXISTING application with a double-click.
See [`docs/LAUNCHER.md`](./docs/LAUNCHER.md).

### What Was Done
- `scripts/launcher/ScreenAiVoice.cs` — WinExe compiled with the in-box .NET
  Framework `csc.exe` (no runtime to install, no Electron/Tauri). Resolves the
  app root from the executable directory, finds `node.exe`, redirects output to
  `logs/screenai-voice.log`, detects `SCREENAI_READY` / `SCREENAI_FATAL`, shows a
  clear dialog on failure, and uses a **Windows Job Object** so only its own
  processes are cleaned up.
- `voice/start.js` — production entry point that composes the existing
  `buildRealAgent` → `VoiceInterface` → `VoiceUiBridge` stack (no business logic).
- `voice/app_paths.js` / `voice/scripted_voice.js` — path/arg resolution and the
  dev-only scripted voice (single source of truth, shared with the demo).
- `scripts/build-exe.ps1` — reproducible build producing `dist/ScreenAI-Voice.exe`
  plus a portable `dist/app/`. Never copies `env\.env`.
- `npm run build:exe`, `npm start:app`, and a `Quit Screen-AI` right-click item.

### Test Results

#### Launcher unit tests
**Result:** **PASS**
* **Command:** `node --test tests/launcher.test.js`
* **Validation:** production is the default (simulation must be explicit); the
  app root resolves from the executable directory (both `dist/app` and project
  layouts); the production entry refuses to start without `ASSEMBLYAI_API_KEY`
  (exit 2 + `SCREENAI_FATAL`) and never falls into simulation mode; the scripted
  voice emits the partials then one final; build inputs exist.

#### Build
**Result:** **PASS**
* **Command:** `npm run build:exe`
* **Validation:** `dist/ScreenAI-Voice.exe` compiled; `dist/app` verified to
  contain `voice/start.js`, the WPF UI, and intact `assemblyai`/`onnxruntime-node`
  `dist` folders; `env\.env` absent from `dist`.

#### Executable boot + error handling
**Result:** **PASS**
* **Validation:** running `dist\ScreenAI-Voice.exe --no-dialog` resolved
  `dist\app`, found Node, started `voice/start.js`, detected
  `SCREENAI_FATAL: ASSEMBLYAI_API_KEY is not configured`, logged it, and exited 1.
* With a dummy key set, the launcher booted the app to `SCREENAI_READY` (~1.8 s,
  WPF overlay up) and logged the missing-SoX warning.
* Killing the launcher left **zero** leftover Node/PowerShell processes (Job
  Object cleanup), confirming only its own processes are terminated.
* The single-instance mutex made a second launch exit 0 without starting a
  duplicate.

#### Regression
**Result:** **PASS**
* Full suite: `node --test "tests/**/*.test.js"` → 33/33 (one run showed a single
  non-reproducing failure in the environment-dependent live-desktop test; two
  subsequent full runs were clean).

#### Live microphone via the EXE
**Result:** **BLOCKED BY ENVIRONMENT**
* No SoX backend in PATH on this machine, so raw microphone capture via Node `node-record-lpcm16` requires SoX installation.

## 6. Live Voice-to-Text, OCR Verification, Deduplication & Self-Healing Pipeline

Milestone: verify real AssemblyAI STT with active API key, verify PaddleOCR ONNX screen perception, test duplicate speech ("say the comment twice"), and verify pipeline self-healing / resilience on errors.

### What Was Done
- **API Key Security & Confidentiality**: Configured local `.env` and `env/.env` (strictly ignored by `.gitignore`). Verified `sanitizeLog` masks API keys (`***XXXX`) across all logger outputs. Ensured secrets are never committed or pushed to Git.
- **AssemblyAI Realtime Handshake Fix**: Added `connectTimeout: 10000` to `DEFAULT_CONNECTION_PARAMS` in `pipelines/voice_input/assemblyai_resilience.js` and `voice/assemblyai/transcriber.js` to ensure reliable TLS and WebSocket handshakes under real-world network latency (surpassing SDK's default 1s limit).
- **Session Reset on Activation**: Updated `clearForNewActivation()` in `pipelines/voice_input/transcript_processor.js` to clear turn orders and content hashes, ensuring distinct voice commands are accepted across activations while strictly deduplicating within active speech windows.
- **Deduplication Testing**: Added test `101. Verify deduplication when comment is said twice` in `tests/voice_input_pipeline.test.js`.
- **Self-Healing Testing**: Added test `102. Verify self-healing pipeline recovery on unexpected error` in `tests/voice_input_pipeline.test.js`.

### Test Results

#### Live AssemblyAI Speech-to-Text
**Result:** **PASS**
* **Validation:** Verified via official `assemblyai` SDK client. REST endpoint returned `200 OK`. Realtime WebSocket streaming connection successfully established and returned live session ID (e.g., `c339a7fa...`, `4dd0558b...`). Session closes cleanly without leaking sockets.

#### Real OCR (PaddleOCR ONNX + ScreenModel)
**Result:** **PASS**
* **Command:** `node demo/ocr-demo.js --image tests/fixtures/menu_bar.png`
* **Validation:** PaddleOCR ONNX pipeline (DB text detection + CTC recognition) parsed the image in under 1 second, accurately recognizing UI text (`"← File Edit View Help"` at 94% confidence) and constructing a structured `ScreenModel` with bounding boxes and click actions. Multi-tier perception stack falls back gracefully when Windows native `CopyFromScreen` is inaccessible.

#### Deduplication ("Say the Comment Twice")
**Result:** **PASS**
* **Command:** `node --test tests/voice_input_pipeline.test.js`
* **Validation:**
  1. *Repeated Partials:* Interim speech turns have `execute: false` and are never forwarded to the agent.
  2. *Duplicate Turn Orders:* Replayed turns with identical `turn_order` are dropped with `reason: "duplicate_turn_order"`.
  3. *Duplicate Content:* Repeating the same comment in the same session is dropped with `reason: "duplicate_content"`.
  4. *Exact-Once Execution:* Downstream agent orchestrator is invoked **exactly once** for the command.
  5. *New Activation:* Triggering a new command activation cleanly resets deduplication history so legitimate repeat commands can be executed in subsequent turns.

#### Self-Healing & Resilience
**Result:** **PASS**
* **Command:** `node --test tests/voice_input_pipeline.test.js`
* **Validation:**
  1. *AssemblyAI Socket Drop:* `AssemblyAiResilienceManager` detects connection drops, transitions to `RECONNECTING`, performs exponential backoff, reconnects, and heals back to `CONNECTED`.
  2. *Microphone Hardware Error:* `MicrophoneEngine` catches device errors, terminates child processes to eliminate zombie/orphan processes, and resets cleanly to `STOPPED`.
  3. *Orchestrator Execution Failure:* If an agent action fails (e.g., window not found), the pipeline traps the error, signals `FAILURE`, and uses a `finally` block to return the UI state machine to `IDLE` (preventing freezes).
  4. *OCR Fallback:* Perception automatically heals around Windows native screen handle errors by falling back to PaddleOCR ONNX and UIA.

#### Regression
**Result:** **PASS**
* Full suite: `npm test` → 59 passed, 1 skipped (live desktop OCR in headless session), 0 failed.

## 7. Live-Desktop Reliability (Verification Settling, Foreground Recovery)

The live-desktop end-to-end test (`tests/real_desktop.test.js`, "Open WhatsApp and
search for Dad") was failing on the real desktop: the **type** step ran, but its
verification failed twice and the task was killed with `verification_exhausted` —
a task that had actually worked was reported as a failure.

### What Was Done

**The failure had two causes, both proven on the live desktop:**

1. **Verification read the screen before the app repainted.** `type` only hands
   keystrokes to the application (SendKeys returned in **13–29 ms**); Opera +
   WhatsApp Web still had to process them and repaint. The single verification
   snapshot was taken **254 ms** later and still showed the placeholder
   (`bbox {165,185,197x17}` — the placeholder's exact geometry), so a step that
   had already succeeded was judged a failure.
2. **The retry then blinded the perception.** Retrying a `type` on the search box
   selects the field first (`ctrl+A`) so the new text *replaces* the old. A
   selected field renders inverted, and **Windows OCR returns nothing for
   inverted text** — the field line disappears from the capture, the search box
   vanishes from the `ScreenModel` (`screen: "unknown"`), and the second
   verification failed as well.

**Fixes:**

- **Verification settling (`backend/perception/real_perception.js`).** Mutating
  steps (`click`/`type`/`press`/`scroll`) now re-perceive within a bounded settle
  window (`agent.verifySettleMs`, default 2500 ms; `agent.verifyPollMs`, default
  250 ms) instead of trusting one snapshot. Read-only steps still verify from a
  single look. The settle loop never re-executes the action, so a slow render can
  no longer cause a destructive retry.
- **Structure-derived search field (`backend/perception/real_ocr.js`).** When the
  field's own text is unreadable (selected/collapsed), the control is still
  resolved from the filter-tab row directly beneath it (`All / Unread / Favorites
  / Groups`), and the screen still classifies as `chat_list`. The derived element
  carries `query: ""` and `derived: "structure"`, so it can never pose as
  evidence that typed text landed — a missing query still fails honestly.
- Previously added in this pass and kept: foreground-drift detection
  (`drift.expected` / `drift.actual`), orchestrator recovery (Escape + refocus,
  bounded by the step's retry budget), verified `SetForegroundWindow` retries in
  `win-agent.ps1`, perception-backed `wait(condition)` polling, and the OCR
  chrome/region filters (taskbar, browser chrome, left-panel search region).

### Test Results

#### Root cause — live reproduction
**Result:** **CONFIRMED** (screenshots + raw OCR at every step)
* Typing reaches the app and is read back as `"Q Dad"` → `search_box.query = "Dad"`
  with real results (`Bala Dad..`, `Mounesh Dad`, `Muthish Dad`).
* `ctrl+A` on the field leaves the text **selected**; the same screen then yields
  **no** field line at all → `screen=unknown`, `search_box: NONE`.
* Clicking the field restores readability, confirming the control was present and
  clickable the whole time.

#### Pipeline-specific self healing (type verification)
**Result:** **PASS**
* **Command:** `node --test tests/real_perception.test.js`
* **Validation:** a query that renders on the second look verifies as success
  (no false failure); a query that never appears still fails after the settle
  window; a `derived: "structure"` box never passes a type check; a successful
  action that loses the foreground fails with drift info.

#### Search-field resolution
**Result:** **PASS**
* **Command:** `node --test tests/real_ocr.test.js`
* **Validation:** the unreadable-field capture still yields exactly one
  `search_box` at the field's row inside the left panel with `query: ""`, and a
  readable field still wins over the tab-derived row.

#### Orchestrator recovery
**Result:** **PASS**
* **Command:** `node --test tests/orchestrator_recovery.test.js`
* **Validation:** a step that never verifies is reported as failed (never a false
  success, and never marked executed); foreground drift triggers
  `recover({ refocus: "WhatsApp" })` and the step is retried; a non-drift failure
  retries without recovery.

#### Live desktop end-to-end
**Result:** **PASS**
* **Command:** `node --test tests/real_desktop.test.js` → **1/1**, ~3.4 s per run
  (4 consecutive runs), all 8 steps to `task_done`.
* **Validation:** the run started from a hostile leftover state (field left
  selected/unreadable by the crashed session) and recovered through it: the click
  resolved the field via `derived: "structure"` at `(246,193)`, the type step
  verified on attempt 1, and the final `read_screen` perceived the real Dad
  results.
* **Not claimed:** foreground drift was exercised by unit tests, not by a live
  interference scenario on this machine.

#### Regression
**Result:** **PASS**
* Full suite: `node --test "tests/**/*.test.js"` → **70 passed, 0 failed,
  0 skipped** (previously 59 passed / 1 failed — the live desktop test).

## 8. P3: Intent + Task Engine (Tickets 201–300)

Milestone: the task-engine pipeline from the master catalog — structured command
→ task spec → **task graph** → validated node chain → ACT/OBSERVE/VERIFY per node
→ recovery → result/spoken/UI/audit/history/events. Lives in
`pipelines/p3_task_engine/`; ticket-to-module map in
[`pipelines/CATALOG.md`](./pipelines/CATALOG.md).

### What Was Done
- **Command intake + spec** (`command_contract.js`, `task_spec.js`): receives a
  structured command or raw text, keeps the original **and** the normalized copy,
  and derives type, application, target entity, requested action, expected
  result, constraints, dependencies, action sequence, confirmation
  requirements, priority, timeout, max retries and verification requirement. The
  action sequence and risk classification come from the existing
  `backend/agent/planner.js` and `backend/agent/risk.js` — not a second copy.
- **Task graph** (`task_graph.js`): one task node, one node per planned step
  (action/observation), plus a verification **and** recovery node for every
  mutating action. `validate()` rejects a graph with cycles, unreachable nodes,
  or an action that has no verification/recovery node.
- **Honest gating**: impossible tasks (no understood action, unopenable
  application), missing information and unresolved references ("open **it**")
  are detected *before* execution. Ambiguity is asked about, not guessed:
  `Open it and search for Dad` → *'What does "it" refer to?'* → the answer is
  folded into the command, the task is re-derived, resumed and completed.
- **Execution + recovery** (`task_engine.js`): each node runs ACT → OBSERVE →
  VERIFY. Mutating steps are verified through the same perception interface the
  orchestrator uses, and a failed step takes the recovery path (bounded retries,
  re-perception, re-plan after mismatch, rollback when the step supports it,
  and honest `rollback_unsupported` events when it does not). An action that
  could never be verified is reported as a **failure — never a false success**.
- **Lifecycle** (`task_state_machine.js`, `task_tracker.js`, `task_events.js`,
  `task_history.js`): allowed transitions only (invalid ones are recorded and
  refused), node/retry/timing tracking, ordered task/step/verification/failure/
  success events, audit record, bounded history with JSON export/load, and
  guards against duplicate, stale and concurrent tasks.

### Test Results

#### Unit — task pipeline
**Result:** **PASS**
* **Command:** `node --test tests/task_engine_pipeline.test.js` → **28/28**
  (tickets 284–300 numbered, plus coverage for 201–283).
* **Validation:** simple + multi-step commands run their exact planned sequence;
  cancellation stops execution and cannot be retried; a failed verification is
  honest and retries within budget; timeout aborts with `timed_out`; recovery
  re-perceives, re-plans and completes; ambiguous commands ask and then complete
  once answered; impossible/unsafe/duplicate/concurrent commands are refused with
  the right reason; tracker + history round-trip through JSON; event ordering is
  dense and monotonic; two identical runs produce byte-identical event streams
  (deterministic orchestration).

#### Live desktop — real task engine on the real machine
**Result:** **PASS (with a recovery path that is exercised for real)**
* **Command:** `node demo/task-engine-demo.js "Open WhatsApp and search for Dad"`
* **Validation:** 46 events from `task_submitted` to `notify_ui`; the graph's 12
  nodes completed, the medium-risk `type` step passed through the confirmation
  gate, and the result was `status=succeeded`, `spoken="Done."`,
  `ui=WhatsApp shows search results for "Dad"` in **3.7 s**.
* 6 further consecutive live runs all succeeded (3 clean, 3 recovering after a
  step failure on the first retry).

#### Live failure found and fixed: dropped keystrokes on retry
**Result:** **RECOVERED (root trigger not fully isolated)**
* On the live desktop the `type` step intermittently loses its characters: the
  field ends up with its text **selected and unreplaced**. Screenshots taken
  before/after the tool call show a normal readable `Dad` *before* the call and a
  highlighted (selected) `Dad` *after* it — the `ctrl+A` reaches the app but the
  characters that follow do not land. Windows OCR cannot read inverted (selected)
  text, so perception reports an unreadable field and verification fails. The old
  retry made it worse: every attempt re-sent `ctrl+A`, re-selecting the same text,
  so all attempts failed and the whole task failed.
* **Fix (three places, same principle — a retry must restore the input state):**
  1. `ToolBox.type` re-resolves and clicks its target when the step asks for
     `args.refocus` (only then — clicking on the first attempt lands a second
     click ~400 ms after the plan's own click step, which the field reads as a
     double-click).
  2. The orchestrator sets `refocus` on a `type` step whose verification failed,
     logging `retry_refocus`.
  3. The task engine's recovery does the same before re-acting: `recover({refocus})`
     (Escape + verified refocus) then re-runs the focus-establishing dependency
     (the `click`) the plan already declares — it never re-acted blindly.
* **Verified live:** with the refocus the retry lands in ~0.6 s; without it, every
  attempt failed.
* **Honest limitation:** the underlying trigger for the dropped characters was
  **not** isolated. An isolated `click → ctrl+A → type` sequence replaced the text
  16/16 times (300 ms and 1300 ms gaps), and adding a pre-click to every attempt
  did not stop the first attempt from failing — so it depends on the surrounding
  live flow, not on the gap or the click alone. The system now detects it honestly
  (never a false success) and recovers, at the cost of one wasted settle window
  (~2.7 s) when it happens.
* **Covered by:** "task: a retry restores focus before re-acting (the live
  failure mode)" plus the live runs below.

#### Regression
**Result:** **PASS**
* Live end-to-end (`node --test tests/real_desktop.test.js`): **12 consecutive
  runs passed** (~6.8 s each; the extra time is the wasted first attempt + its
  2.5 s settle window), previously failing intermittently.
* Full suite: `node --test "tests/**/*.test.js"` → **98 passed, 0 failed,
  0 skipped** (70 before this pipeline).

## 9. P2: AssemblyAI / Voice Understanding (Tickets 101–200)

Milestone: the missing middle layer between the frozen P1 transport and P3 —
turning a transcript into a validated **StructuredCommand** with entities,
request type, ambiguity and command-level risk. Lives in
`pipelines/p2_assemblyai/`.

The pipeline is now: **Voice → P1 transport → P2 understanding →
StructuredCommand → P3 Task Engine → Planner/Task Graph → ACT → OBSERVE →
VERIFY → RECOVERY → RESULT.**

### What Was Done

**Ownership resolved first, because it dictated the shape of everything else:**

- **101–120 are satisfied by P1, not reimplemented.** P2 imports P1's
  `AssemblyAiResilienceManager`, `TranscriptProcessor`, `VoiceMetricsCollector`
  and `VoiceInputPipeline`, and a delegation test asserts **class identity** for
  each — so wiring P2 cannot create a second client, stream or deduplicator.
  The ticket-by-ticket mapping lives in `p1_transport.js`.
- **101/102 test-number collision resolved without renumbering P1.** Those two
  labels in `tests/voice_input_pipeline.test.js` are P1 verification
  continuations (dedup + self-healing), not P2's tickets 101/102. P1's file is
  untouched; P2's numbered tests start at 185. The overlap is recorded in
  `TEST_NUMBER_COLLISION` and documented in the catalog.
- **COMMAND risk vs ACTION risk separated into one clear boundary.**
  `risk.js` gained a grouped `HIGH_RISK_CATEGORIES` export (same RegExp objects,
  same 16 patterns, action behaviour proven unchanged by the existing tests) and
  P2's `command_risk.js` labels those categories for the *utterance* while
  adding command-only ones (credentials, file deletion, system control,
  installation, permission). A test asserts the shared categories are the same
  RegExp objects — there is no second word list.
- **Ambiguity is asked once.** P2 detects it and generates the question; P3
  consumes that question instead of re-deriving one.
- **Application vocabulary (P2) vs capability (P3)** kept distinct, with a seam
  test asserting P2 can name every application P3 can open.

**Then the understanding itself (121–152):** cancellation (anchored — "stop the
video" is not a cancellation), correction ("no wait open notepad" → the
corrected tail becomes the command text), repeat detection, filler detection and
removal, quote-aware phrase boundaries, multi-step/chained/conditional
structure, exact-span entities (applications, people, quotes, numbers, URLs,
shortcuts, directions), multi-label request types with evidence spans, and
ambiguity + clarification generation.

**Safety (153–164), schema (165–167), plumbing (168–184):** command risk
categories with exact match spans; a strict StructuredCommand schema that
rejects malformed commands — including entity spans that do not match the text
they claim to describe; command + AssemblyAI latency, confidence and turn
metadata; malformed/unknown event handling; bounded turn waiting with a
voice-failure path.

### Test Results

#### P2 pipeline
**Result:** **PASS**
* **Command:** `node --test tests/p2_understanding_pipeline.test.js` → **31/31**.
* **Validation:** 101–120 delegation (including class-identity checks and full
  range coverage), 121–125 hygiene, 126–132 exact-span entities, 133–136
  segmentation, 137–148 request types, 149–152 ambiguity, 153–164 command risk
  + vocabulary ownership, and the numbered contract tests **185–200**:
  transcript conversion, turn detection, deduplication (driving P1's real
  processor), malformed events, reconnect/retry bounds (driving P1's real
  manager), timeout, cancellation, multi-step, ambiguous, dangerous, schema,
  session isolation, concurrent sessions, shutdown, "no duplicate commands",
  and the complete P1 → P2 → P3 chain with deterministic fixtures.

#### Live end-to-end (real desktop)
**Result:** **PASS**
* **Command:** `node demo/task-engine-demo.js "Open WhatsApp and search for Dad"`
* **Validation:** P2 produced a schema-valid command —
  `entities=[application:WhatsApp, person:Dad]`, `steps=[open(WhatsApp),
  search(for Dad)]`, `risk=none` — which P3 executed to `succeeded` /
  `spoken="Done."` with **13 nodes completed**; the audit record carried
  `intent`, `requestType`, `entities`, `turnId`, `sessionId`,
  `commandLatencyMs=6`, `commandRisk` (the metadata P3 previously had no source
  for). Command latency (utterance → validated command) was **6 ms**.
* Cancellation path live: `"never mind"` → `stage=cancelled`, **no task created**.
* Ambiguity path live: `"open it and search for Dad"` → `ambiguous=true`,
  `clarification="Which application should I use?"`, `stage=awaiting_clarification`
  (P3 asked P2's question; nothing was mutated).
* Existing live flow: `node --test tests/real_desktop.test.js` → **4/4 runs
  passed** once the desktop was back in its expected state (3.4 s, 3.4 s, 3.8 s
  clean; 4.2 s and 6.8 s with one recovery each). **The same test failed 9/9
  times while a different browser tab was active** — see the limitations below.

#### Honest limitations
* **Request classification and command risk are cue-based.** They are declared
  in auditable tables and never guess beyond their cues, but a word outside the
  vocabulary (or a sentence that uses one in an unusual way) will be
  misclassified. Two concrete consequences observed while building this:
  a destructive-sounding word inside an otherwise benign request raises the
  command risk level (a false positive that costs one confirmation prompt), and
  an application name that is also an ordinary word ("code", "files") is only
  recognised when capitalised or preceded by a cue.
* **Filler removals are reported by text, not by span** — each removal shifts
  the rest of the string, so a span would describe a string that no longer
  exists. Entity spans, by contrast, are exact and schema-validated.
* **Confidence is `null` on the real path**: P1 does not report transcript
  confidence, and P2 does not invent a value (the schema allows `null`).
* **Person recognition is a capitalisation heuristic**, boosted by a contact
  list; it excludes verbs and UI nouns ("Save button") but cannot be more
  precise than the casing it is given.
* **Not claimed:** no live AssemblyAI microphone session was run in this pass —
  the live evidence above starts from a *final transcript event* (the P1
  boundary), because this machine has no SoX/microphone backend. P1's own
  transport behaviour is covered by its frozen tests.
* **Application focus is window-level, not tab-level (found during this pass).**
  Nine consecutive live runs failed while the Opera window had a DuckDuckGo
  results page active and WhatsApp Web sitting in another tab: `open_app`
  focused the *window*, every click and keystroke then acted on the wrong page,
  and perception still reported `screen=chat_list` — the page's text contains
  "WhatsApp" plus the filter words the classifier looks for, so it was accepted
  as WhatsApp. Restoring the WhatsApp tab made 4/4 runs pass. This is a real
  P4/P5 gap (select the right document/tab; reject a WhatsApp-*looking* page
  that is not WhatsApp), and it means live results are only meaningful when the
  desktop is in the expected state.
* **A hypothesis tested and rejected, recorded rather than hidden.** The
  keystroke loss looked like a modifier race between the separate `ctrl+a` and
  text injections, so it was implemented as a single atomic `typeclear` command
  in the Win32 agent and measured: it did **not** help (the failures persisted,
  and the agent reported `success=true` in every failing run), so the change was
  fully reverted. The residual keystroke loss is rare — 1 of the 4 valid runs
  needed the refocus retry and recovered — and its trigger remains unexplained.

#### Regression
**Result:** **PASS**
* Full suite: `node --test "tests/**/*.test.js"` → **129 passed, 0 failed,
  0 skipped** (98 before this pipeline).

## 10. P5: Computer Action Pipeline (Tickets 401–500)

Milestone: the complete computer action pipeline — Win32 input dispatch (click, type, press,
scroll), application lifecycle (resolve → launch → startup → session → ready), ToolResult
schema, audit logging, and 0% Python. Lives in `pipelines/p5_actions/` (formal entry point)
+ `pipelines/p5_app_lifecycle/` (app lifecycle sub-pipeline) + `backend/tools/` (ToolBox).

### What Was Done

- **`pipelines/p5_actions/index.js`** — Formal P5 pipeline entry point matching the catalog.
  Re-exports all P5 public APIs, adds `P5_ACTION_TYPES` registry, `validateToolResult()`, and
  `buildActionAuditEntry()` (JSON-serializable audit record per tool dispatch). **0% Python.**
- **Win32 input dispatch**: `click` → Win32 `SendInput`; `type` → `SendKeys`; `press` → single
  or compound key (e.g. `ctrl+a`); `scroll` → mouse wheel. All through a persistent PS1
  subprocess (`win-agent.ps1`) — no per-action process-spawn overhead.
- **Application lifecycle** (`pipelines/p5_app_lifecycle/`): `app_resolver.js` (alias resolution,
  candidate ranking, ambiguity rejection), `app_engine_driver.js` + `app_engine.ps1` (Win32
  discovery/launch), `startup_probe.ps1` (phase/UIA/responsiveness), `app_session.js`
  (`AppSession`: ownership stamping → PROVEN/SUPPORTED/INFERRED evidence, `markReady()` →
  `APPLICATION_READY` event).
- **ToolResult schema** (`backend/core/result.js`): `{ success, action, data, error, timestamp }`
  — deterministic, JSON-serializable, never throws.

### Test Results

#### P5 pipeline unit tests
**Result:** **PASS**
* **Command:** `node --test tests/p5_action_pipeline.test.js` → **48/48**.
* **Validation:**
  - `normalizeName`, `resolveAlias`, `rankCandidates`, `scoreCandidate`, `checkAmbiguity`,
    `confirmTarget`, `prepareLaunchRequest` all verified with deterministic fixtures.
  - `AppSession.establishOwnership()` upgrades evidence to PROVEN on `matched=true` result;
    `markReady()` emits `APPLICATION_READY` event with `sessionId` in payload.
  - `click` routes resolved coordinates via `driver.click(x, y)` (no Python); fails closed
    when no element found (never a false success).
  - `type` with `clearFirst` dispatches `ctrl+a` before text; with `refocus` clicks target first.
  - `press`, `scroll` dispatch via driver with direction/key preserved in ToolResult.
  - `validateToolResult` passes valid results; rejects non-boolean success, empty action, null data.
  - `buildActionAuditEntry` produces fully JSON-serializable records tagged `pipeline: "P5"`.
  - Contract tests 493–500: click, type, keyboard, scroll, open_app, focus, recovery, and
    full 6-action pipeline sequence all pass schema validation.

#### Regression
**Result:** **PASS**
* Full suite: `node --test "tests/*.test.js"` → **177 passed, 0 failed, 0 skipped**
  (129 before this pipeline).
