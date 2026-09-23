# Screen-AI Voice Agent: 10-Pipeline Master Catalog (1,000 Tasks)

The Master Execution Flow of the Screen-AI Voice Agent is:
```
VOICE INPUT
  → AUDIO
  → ASSEMBLYAI
  → TRANSCRIPT
  → INTENT
  → TASK
  → SCREEN OBSERVATION
  → SCREEN MODEL
  → PLANNING
  → TOOL SELECTION
  → ACTION
  → OBSERVATION
  → VERIFICATION
  → RECOVERY
  → RESULT
  → VOICE RESPONSE
  → UI STATE
  → LOG/MEMORY
```

The system is decomposed into 10 decoupled pipelines of 100 implementation tickets each:

| Pipeline | Domain | Ticket Range | Implementation Directory | Focus & Responsibility |
|---|---|---|---|---|
| **P1** | **Voice Input Pipeline** | **001–100** | `pipelines/voice_input/` | Hardware capture, hotkey activation, real RMS/EMA amplitude, VAD, resilience, metrics |
| **P2** | **AssemblyAI / Understanding** | **101–200** | `pipelines/p2_assemblyai/` | Realtime transcriber, entity preservation, command grammar, intent structuring |
| **P3** | **Intent + Task Engine** | **201–300** | `pipelines/p3_task_engine/` | Task graphs, action nodes, observation nodes, state machine, deterministic orchestrator |
| **P4** | **Screen Perception** | **301–400** | `pipelines/p4_perception/` | Multi-sensor capture, Windows OCR, UI Automation, Vision fallback, ScreenModel |
| **P5** | **Computer Actions** | **401–500** | `pipelines/p5_actions/` | Windows input driver, click, type, keyboard shortcuts, window & application lifecycle |
| **P6** | **Verification + Recovery** | **501–600** | `pipelines/p6_verification/` | Pre/post diffs, false-success prevention, re-perception, strategy rollback, bounded retry |
| **P7** | **Risk / Safety / Confirmation**| **601–700** | `pipelines/p7_safety/` | Risk tiers (L/M/H), confirmation UI, injection defense, untrusted screen text isolation |
| **P8** | **Memory / Context / Logging** | **701–800** | `pipelines/p8_observability/`| Structured JSONL logging, secret redaction, correlation IDs, traces, latency metrics |
| **P9** | **Voice UI + EXE Experience** | **801–900** | `pipelines/p9_desktop_ui/` | Floating pill UI, 60fps real audio wave, Job Object process supervision, hotkeys |
| **P10**| **End-to-End + Reliability**   | **901–1000**| `pipelines/p10_hackathon/` | Golden demo ("Open WhatsApp and search for Dad"), failover, packaging, shipping |

---

## P1: Voice Input Pipeline (Tickets 001–100)
**Status: Implemented & Wired in `pipelines/voice_input/`**

- **001–004**: Activation & UI State Transition
  - 001. Detect Ctrl+Space activation.
  - 002. Detect Escape cancellation.
  - 003. Prevent duplicate activation.
  - 004. Transition UI IDLE→LISTENING.
- **005–012**: Microphone Capture Engine
  - 005. Initialize microphone capture.
  - 006. Verify microphone availability.
  - 007. Select default input device.
  - 008. Validate microphone sample rate.
  - 009. Configure 16 kHz capture.
  - 010. Configure mono capture.
  - 011. Configure PCM16 audio.
  - 012. Start PCM stream.
- **013–016**: Audio Level & Real Amplitude (Anti-Mock)
  - 013. Calculate audio RMS.
  - 014. Normalize RMS amplitude.
  - 015. Smooth amplitude with EMA.
  - 016. Emit audio-level events.
- **017–027**: Stream Forwarding, Error Handling & Lifecycle
  - 017. Forward PCM to AssemblyAI.
  - 018. Detect microphone capture errors.
  - 019. Detect microphone disconnect.
  - 020. Recover microphone stream.
  - 021. Stop microphone on Escape.
  - 022. Stop microphone after final turn.
  - 023. Prevent duplicate microphone streams.
  - 024. Track microphone lifecycle.
  - 025. Log microphone start.
  - 026. Log microphone stop.
  - 027. Log microphone errors.
- **028–032**: Voice Activity Detection (VAD) & Silence
  - 028. Detect silence.
  - 029. Track silence duration.
  - 030. Detect speech onset.
  - 031. Track speech duration.
  - 032. Detect speech completion.
- **033–048**: AssemblyAI Connection Resilience & Security
  - 033. Handle AssemblyAI connection startup.
  - 034. Handle AssemblyAI connection failure.
  - 035. Handle AssemblyAI reconnect.
  - 036. Bound reconnect attempts.
  - 037. Handle AssemblyAI close event.
  - 038. Handle AssemblyAI error event.
  - 039. Validate AssemblyAI API key.
  - 040. Never log API key.
  - 041. Handle missing API key.
  - 042. Handle invalid API key.
  - 043. Handle network failure.
  - 044. Handle authentication failure.
  - 045. Handle rate limiting.
  - 046. Handle server errors.
  - 047. Track connection state.
  - 048. Expose connection state to UI.
- **049–068**: Transcript Processing, Normalization & UI Contract
  - 049. Emit partial transcript.
  - 050. Emit final transcript.
  - 051. Track transcript sequence.
  - 052. Deduplicate transcript events.
  - 053. Detect end-of-turn.
  - 054. Ignore non-final turns for execution.
  - 055. Display partial transcript.
  - 056. Replace partial transcript.
  - 057. Clear transcript on new activation.
  - 058. Preserve final transcript.
  - 059. Normalize transcript whitespace.
  - 060. Normalize punctuation.
  - 061. Preserve user wording.
  - 062. Detect empty transcript.
  - 063. Ignore empty final transcript.
  - 064. Detect unintelligible speech.
  - 065. Display transcription failure.
  - 066. Stop voice session on failure.
  - 067. Reset voice state.
  - 068. Return UI to idle.
- **069–075**: Session Observability & Metrics
  - 069. Record voice session ID.
  - 070. Record voice start timestamp.
  - 071. Record voice end timestamp.
  - 072. Calculate voice latency.
  - 073. Calculate transcription latency.
  - 074. Emit voice metrics.
  - 075. Log voice metrics.
- **076–090**: Automated Unit Tests
  - 076. Test microphone start.
  - 077. Test microphone stop.
  - 078. Test partial transcript.
  - 079. Test final transcript.
  - 080. Test duplicate final transcript.
  - 081. Test cancellation.
  - 082. Test reconnect.
  - 083. Test missing API key.
  - 084. Test invalid API key.
  - 085. Test microphone failure.
  - 086. Test silence.
  - 087. Test rapid activation.
  - 088. Test repeated activation.
  - 089. Test simultaneous callbacks.
  - 090. Test shutdown.
- **091–100**: Pipeline Verification Guarantees
  - 091. Verify no orphan audio process.
  - 092. Verify no duplicate AssemblyAI stream.
  - 093. Verify UI receives real amplitude.
  - 094. Verify UI never generates fake amplitude.
  - 095. Verify partials never execute actions.
  - 096. Verify final transcript executes once.
  - 097. Verify cancellation prevents execution.
  - 098. Verify session cleanup.
  - 099. Verify logs contain no secrets.
  - 100. Verify complete voice-input pipeline.

---

## P2: AssemblyAI / Voice Understanding (Tickets 101–200)
**Status: Implemented in `pipelines/p2_assemblyai/` — P1 → P2 → P3 verified live on the real desktop (`demo/task-engine-demo.js`).**

Ownership boundaries (explicit, so nothing is duplicated or in conflict):

- **101–120 are DELEGATED to the frozen P1 transport.** P2 imports P1's
  `AssemblyAiResilienceManager`, `TranscriptProcessor`, `VoiceMetricsCollector`
  and `VoiceInputPipeline` and creates no second client, stream or deduplicator.
  Mapping and cross-references: `pipelines/p2_assemblyai/p1_transport.js`
  (`P1_TRANSPORT_DELEGATION`), asserted by a delegation test that compares class
  identity.
- **Test-number collision resolved without renumbering anything.** P1's suite
  contains tests labelled "101." and "102."; those are P1 verification
  continuations (dedup, self-healing), *not* P2 tickets 101/102. P1's file is
  untouched, and P2's numbered tests are 185–200 — recorded in
  `TEST_NUMBER_COLLISION` so the ticket↔test map stays unambiguous.
- **COMMAND risk (P2) vs ACTION risk (`backend/agent/risk.js`).** P2 classifies
  what the *utterance* asks for (`command_risk.js`) and reuses the shared RegExp
  vocabulary exported by `risk.js` (`HIGH_RISK_CATEGORIES`) instead of copying
  it. Action risk keeps classifying each concrete step, unchanged.
- **Ambiguity (P2) vs feasibility (P3).** P2 owns "could a human tell what was
  meant?" and produces the clarification question; P3 owns "can this machine do
  it?" and asks *P2's* question rather than inventing a second one.
- **Application vocabulary (P2) vs capability (P3).** P2 recognises application
  *mentions*; P3's `SUPPORTED_APPLICATIONS` stays the authority on what can be
  opened. A seam test asserts P2 can name every application P3 can open.

Implementation map:

- `p1_transport.js` — **101–120** (delegation map, cross-references, collision record).
- `text_scan.js` — shared quote-aware tokens/spans (every span is an exact slice).
- `utterance_hygiene.js` — **121–125**: cancellation, correction, repeat, filler detect/remove.
- `phrase_segmenter.js` — **133–136**: boundaries, multi-step, chained, conditional.
- `entity_preserver.js` — **126–132**: applications, people, quotes, numbers, URLs, shortcuts, directions.
- `request_classifier.js` — **137–148**: multi-label request types, per step.
- `ambiguity_analyzer.js` — **149–152**: ambiguity marking + clarification generation.
- `command_risk.js` — **153–164**: COMMAND risk categories, permission + confirmation requirement.
- `command_schema.js` — **165–167**: StructuredCommand schema, strict validation, rejection.
- `understanding_pipeline.js` — **168–184**: assembly, dispatch, latency/confidence/turn metadata, malformed events, bounded turn waiting, voice failure.
- `integration.js` — the P1 → P2 → StructuredCommand → P3 chain (cancellation routing, informational requests, duplicate refusal).

Flow: `Voice → P1 transport → P2 understanding → StructuredCommand → P3 Task Engine → Planner/Task Graph → ACT → OBSERVE → VERIFY → RECOVERY → RESULT`

Tests: `tests/p2_understanding_pipeline.test.js` — tickets **185–200** numbered, plus 101–120 delegation tests and 121–184 coverage. Fixtures: `tests/fixtures/utterances.json`.

101. Initialize AssemblyAI client.
102. Configure realtime transcriber.
103. Configure speech model.
104. Configure sample rate.
105. Connect transcriber.
106. Wait for connection ready.
107. Send PCM chunks.
108. Receive transcript events.
109. Process partial transcript.
110. Process final transcript.
111. Detect turn completion.
112. Track turn order.
113. Deduplicate turn order.
114. Convert final transcript to command.
115. Preserve original transcript.
116. Attach session ID.
117. Attach turn ID.
118. Attach timestamp.
119. Emit command event.
120. Reject empty commands.
121. Detect command cancellation.
122. Detect command correction.
123. Detect repeated command.
124. Detect conversational filler.
125. Remove irrelevant filler.
126. Preserve application names.
127. Preserve person names.
128. Preserve quoted text.
129. Preserve numbers.
130. Preserve URLs.
131. Preserve keyboard shortcuts.
132. Preserve directional commands.
133. Detect command boundaries.
134. Detect multi-step commands.
135. Detect chained actions.
136. Detect conditional commands.
137. Detect verification requests.
138. Detect question commands.
139. Detect information requests.
140. Detect action requests.
141. Detect navigation requests.
142. Detect typing requests.
143. Detect clicking requests.
144. Detect scrolling requests.
145. Detect application requests.
146. Detect browser requests.
147. Detect file requests.
148. Detect system requests.
149. Detect ambiguous commands.
150. Mark ambiguity.
151. Request clarification when necessary.
152. Avoid unnecessary clarification.
153. Detect unsafe command.
154. Forward unsafe command to risk layer.
155. Detect destructive command.
156. Detect external communication command.
157. Detect financial command.
158. Detect credential command.
159. Detect file deletion command.
160. Detect shutdown command.
161. Detect restart command.
162. Detect installation command.
163. Detect permission request.
164. Detect confirmation requirement.
165. Create structured command object.
166. Validate command schema.
167. Reject malformed command.
168. Store command in task state.
169. Send command to orchestrator.
170. Track command latency.
171. Track AssemblyAI latency.
172. Track transcript confidence if available.
173. Log command lifecycle.
174. Handle AssemblyAI timeout.
175. Handle AssemblyAI disconnect.
176. Handle partial transcript timeout.
177. Handle final transcript timeout.
178. Handle malformed event.
179. Handle unknown event.
180. Handle SDK exception.
181. Handle connection retry.
182. Stop retry after limit.
183. Return voice failure.
184. Notify UI of voice failure.
185. Test transcript conversion.
186. Test turn detection.
187. Test deduplication.
188. Test malformed events.
189. Test reconnect.
190. Test timeout.
191. Test cancellation.
192. Test multi-step command.
193. Test ambiguous command.
194. Test dangerous command.
195. Test command schema.
196. Test session isolation.
197. Test concurrent sessions.
198. Test shutdown.
199. Verify no duplicate commands.
200. Verify complete AssemblyAI pipeline.

---

## P3: Intent + Task Engine (Tickets 201–300)
**Status: Implemented in `pipelines/p3_task_engine/` — verified against the real desktop via `demo/task-engine-demo.js`.**

Implementation map:

- `command_contract.js` — **201, 204, 205**: receive a structured command (or raw text), keep the original and the normalized copy, derive the duplicate fingerprint.
- `task_spec.js` — **206–218, 226–228, 230**: command type, application, target entity, requested action, expected result, constraints, dependencies, action sequence (from the deterministic planner), confirmation requirements, priority, timeout, max retries, verification requirement; impossible-task / missing-information / ambiguity detection; clarification application.
- `task_graph.js` — **219–225, 229**: task, action, observation, verification and recovery nodes with dependencies, graph validation (reachability, cycles, every mutating action verified + recoverable), clarification request.
- `task_tracker.js` — **232–243**: current / completed / failed / skipped nodes, retry counts, timestamps, duration, application + screen context, expected screen/element/state.
- `task_state_machine.js` — **272–283**: allowed transitions only, invalid transitions recorded and refused, cancellation / timeout / resume / retry / success / failure / cleanup.
- `task_events.js` — **264–271**: task, step, verification, failure and success events, plus voice / UI / logger notification and the ordered event log.
- `task_history.js` — **262, 263**: audit record and bounded task history (JSON export/load).
- `task_engine.js` — **201–261, 274–283**: submit → spec → graph → validated node chain → ACT/OBSERVE/VERIFY per node → recovery (re-perceive, refocus, re-plan, rollback) → result, spoken response, UI result, events; guards against duplicate, stale and concurrent tasks.

Tests: `tests/task_engine_pipeline.test.js` — tickets **284–300** numbered, plus coverage tests for 201–283.
Live demo: `node demo/task-engine-demo.js "Open WhatsApp and search for Dad"`.

201. Receive structured voice command.
202. Create task ID.
203. Create task state.
204. Store original command.
205. Store normalized command.
206. Determine command type.
207. Determine requested application.
208. Determine target entity.
209. Determine requested action.
210. Determine expected result.
211. Determine constraints.
212. Determine dependencies.
213. Determine action sequence.
214. Determine confirmation requirements.
215. Determine task priority.
216. Determine task timeout.
217. Determine maximum retries.
218. Determine verification requirement.
219. Build task graph.
220. Create initial task node.
221. Add action nodes.
222. Add observation nodes.
223. Add verification nodes.
224. Add recovery nodes.
225. Validate task graph.
226. Detect impossible task.
227. Detect missing information.
228. Detect ambiguity.
229. Request clarification.
230. Store clarification.
231. Resume task.
232. Track current node.
233. Track completed nodes.
234. Track failed nodes.
235. Track skipped nodes.
236. Track retry count.
237. Track task timestamps.
238. Track task duration.
239. Track current application.
240. Track current screen.
241. Track expected screen.
242. Track expected UI element.
243. Track expected state.
244. Generate task step.
245. Select perception method.
246. Select tool.
247. Execute tool.
248. Observe result.
249. Verify result.
250. Continue task.
251. Retry failed step.
252. Re-perceive after failure.
253. Re-plan after mismatch.
254. Roll back when supported.
255. Abort impossible task.
256. Abort unsafe task.
257. Abort timeout.
258. Abort cancellation.
259. Generate task result.
260. Generate spoken response.
261. Generate UI result.
262. Generate audit record.
263. Store task history.
264. Emit task events.
265. Emit step events.
266. Emit verification events.
267. Emit failure events.
268. Emit success event.
269. Notify voice layer.
270. Notify UI layer.
271. Notify logger.
272. Validate state transitions.
273. Prevent invalid transitions.
274. Prevent duplicate execution.
275. Prevent stale task execution.
276. Prevent concurrent conflicting tasks.
277. Support task cancellation.
278. Support task timeout.
279. Support task resume.
280. Support task retry.
281. Support task failure.
282. Support task success.
283. Support task cleanup.
284. Test simple command.
285. Test multi-step command.
286. Test cancellation.
287. Test retry.
288. Test timeout.
289. Test verification failure.
290. Test recovery.
291. Test ambiguous command.
292. Test impossible command.
293. Test unsafe command.
294. Test duplicate command.
295. Test concurrent command.
296. Test task state persistence.
297. Test task event ordering.
298. Test task cleanup.
299. Verify deterministic orchestration.
300. Verify complete task pipeline.

---

## P4: Screen Perception Pipeline (Tickets 301–400)
**Status: Implemented in `pipelines/p4_perception/` — verified against deterministic regression fixtures and the full test suite.**

Core Invariants:
- **OBSERVATION ≠ IDENTITY ≠ INTERPRETATION**: OCR containing an app name is evidence the text exists, not proof the app is the active document.
- **Evidence Levels**: `PROVEN`, `SUPPORTED`, `INFERRED`, `UNKNOWN`.
- **Browser Selected-Tab Resolution**: UIA TabItem + IsSelected first, correlated with window title.
- **Fail-Closed Mutation Gate**: Prevents mutating steps from executing when target identity is incompatible.
- **Ownership Stamping & Staleness**: Elements stamped with hwnd/pid/hash/timestamp.

Implementation map:
- `capture.js` — **301, 302, 367, 368**: Screen capture, resolution detection, metadata, deterministic capture hash.
- `environment_probe.js` — **303–306, 357**: Active window, process, title, class, bounds, canonical application name.
- `browser_target.js` — **336, 383**: Browser detection, selected tab resolution, document title parsing.
- `identity.js` — **305, 391, 392**: Proven identity resolution, evidence levels, fail-closed compatibility check.
- `sensors.js` — **307–355**: Multi-sensor scan (OCR, UIA, Vision), coordinate normalization, deduplication, overlap & label conflict resolution, confidence scoring.
- `model_build.js` — **348–356, 360–366**: ScreenModel building, element ownership stamping.
- `screen_state.js` — **368–384**: Screen change detection, deterministic hash comparison, screen state classification.
- `staleness.js` — **357, 369**: Validity window, staleness detection, environment drift tracking.
- `observer.js` — **385–398**: Semantic target resolution, exact/fuzzy/role matching, low-confidence rejection, multi-sensor retry & fallback.
- `index.js` — Unified P4Perception gateway, preserving the Perception interface.

Tests: `tests/p4_perception_pipeline.test.js` — tickets **385–400** numbered, plus regression fixtures and 301–384 coverage tests.

301. Capture current screen.
302. Detect screen resolution.
303. Detect active window.
304. Detect active process.
305. Detect active application.
306. Detect foreground window title.
307. Run Windows OCR.
308. Extract OCR text.
309. Extract OCR bounding boxes.
310. Extract OCR confidence.
311. Run PaddleOCR when required.
312. Load detection model.
313. Load recognition model.
314. Load OCR dictionary.
315. Detect text regions.
316. Recognize text regions.
317. Map OCR classes.
318. Generate OCR objects.
319. Run UI Automation scan.
320. Extract UI elements.
321. Extract UI names.
322. Extract UI roles.
323. Extract UI states.
324. Extract UI bounds.
325. Extract UI automation IDs.
326. Extract UI patterns.
327. Detect buttons.
328. Detect text fields.
329. Detect checkboxes.
330. Detect lists.
331. Detect menus.
332. Detect tabs.
333. Detect links.
334. Detect windows.
335. Detect dialogs.
336. Detect browser controls.
337. Detect search controls.
338. Detect navigation controls.
339. Detect application controls.
340. Run vision fallback.
341. Detect visual objects.
342. Detect icons.
343. Detect image regions.
344. Detect semantic labels.
345. Detect coordinate candidates.
346. Normalize coordinates.
347. Merge OCR results.
348. Merge UIA results.
349. Merge vision results.
350. Remove duplicates.
351. Resolve overlapping elements.
352. Resolve conflicting labels.
353. Calculate semantic confidence.
354. Calculate element confidence.
355. Calculate screen confidence.
356. Build ScreenModel.
357. Store screen timestamp.
358. Store active application.
359. Store active window.
360. Store elements.
361. Store text.
362. Store bounds.
363. Store roles.
364. Store states.
365. Store confidence.
366. Store source sensor.
367. Store screenshot metadata.
368. Store screen hash.
369. Compare previous screen.
370. Detect screen change.
371. Detect application change.
372. Detect window change.
373. Detect element change.
374. Detect text change.
375. Detect loading state.
376. Detect dialog appearance.
377. Detect modal state.
378. Detect popup state.
379. Detect error state.
380. Detect success state.
381. Detect search state.
382. Detect login state.
383. Detect browser state.
384. Detect desktop state.
385. Detect task-relevant element.
386. Rank matching elements.
387. Resolve semantic target.
388. Resolve fuzzy text target.
389. Resolve exact text target.
390. Resolve role target.
391. Resolve application target.
392. Resolve context target.
393. Reject low-confidence target.
394. Request re-perception.
395. Retry OCR.
396. Retry UIA.
397. Retry vision.
398. Return ScreenModel.
399. Test perception pipeline.
400. Verify complete perception pipeline.

---

## P5: Computer Action Pipeline (Tickets 401–500)
**Status: Implemented — verified against deterministic unit fixtures and the full test suite.**

Core Invariants:
- **WIN32 NATIVE ONLY**: All input dispatch (click, type, press, scroll) routes through Win32 `user32.dll` via `win-agent.ps1` (`SendInput`, `SendKeys`, `mouse_event`). Zero Python.
- **FAIL-CLOSED**: A failed action returns a failure `ToolResult`, never a false success.
- **DETERMINISTIC STRUCTURED OUTPUT**: Every tool call returns a JSON-serializable `ToolResult` with `{ success, action, data, error, timestamp }`.
- **SCHEMA-VALIDATED**: `validateToolResult()` rejects malformed payloads at pipeline boundaries.
- **DELEGATION NOT DUPLICATION**: P5 imports P4's perception interface for target resolution; never duplicates perception logic.

Implementation map:
- `backend/tools/index.js` — `ToolBox`: `open_app`, `click`, `type`, `press`, `scroll`, `read_screen`, `wait`, `verify`, `recover` (tickets 401–492)
- `backend/tools/mouse.js` — `Mouse.click()`, `Mouse.scroll()` — Win32 `SendInput` / `mouse_event` (tickets 409–422)
- `backend/tools/keyboard.js` — `Keyboard.type()`, `Keyboard.press()` — Win32 `SendKeys` / `SendInput` (tickets 411–416)
- `backend/tools/applications.js` — `Applications.open()`, `Applications.focus()`, `Applications.close()` (tickets 401–406, 459–468)
- `backend/tools/screen.js` — `Screen.wait()` — perception-backed condition polling (tickets 443–450)
- `backend/tools/win/win_driver.js` — `WindowsDriver`: persistent PowerShell subprocess for all Win32 ops (tickets 401–492)
- `backend/core/result.js` — `ToolResult` schema: `ok()` / `fail()` (tickets 491–492)
- `pipelines/p5_app_lifecycle/` — Application lifecycle sub-pipeline: resolve → launch → startup probe → session → ready (tickets 418–500)
  - `app_resolver.js` — alias resolution, candidate ranking, ambiguity rejection, launch request (tickets 418–445)
  - `app_engine_driver.js` — Node.js driver for app_engine.ps1 + startup_probe.ps1 (tickets 401–496)
  - `app_session.js` — ownership, evidence levels, state machine, `markReady()`, `APPLICATION_READY` event (tickets 479–500)
  - `startup_classifier.js` — startup phase detection, stability calculation, recovery (tickets 451–488)
- `pipelines/p5_actions/index.js` — Formal P5 pipeline entry point: re-exports all P5 modules, `P5_ACTION_TYPES`, `validateToolResult`, `buildActionAuditEntry` (tickets 489–500)
- `native/app_engine/app_engine.ps1` — PS1 native agent: Win32 app discovery, launch, foreground (tickets 401–449)
- `native/app_engine/startup_probe.ps1` — PS1 startup probe: startup phase, UIA readiness, dialog detection (tickets 451–496)

Tests: `tests/p5_action_pipeline.test.js` — tickets **493–500** numbered, plus full coverage for 401–492.

402. Detect target application.
403. Open application.
404. Verify application launch.
405. Activate application.
406. Focus application.
407. Find target element.
408. Validate target element.
409. Click target.
410. Verify click.
411. Type text.
412. Verify typed text.
413. Press keyboard key.
414. Verify key action.
415. Send keyboard shortcut.
416. Verify shortcut result.
417. Move mouse.
418. Verify mouse position.
419. Scroll up.
420. Verify scroll.
421. Scroll down.
422. Verify scroll.
423. Drag element.
424. Verify drag.
425. Double-click element.
426. Verify double-click.
427. Right-click element.
428. Verify context menu.
429. Select menu item.
430. Verify menu selection.
431. Open browser.
432. Navigate browser.
433. Verify browser navigation.
434. Focus address bar.
435. Type URL.
436. Submit URL.
437. Verify URL.
438. Open file.
439. Verify file opened.
440. Save file.
441. Verify save.
442. Create file.
443. Verify creation.
444. Rename file.
445. Verify rename.
446. Move file.
447. Verify move.
448. Delete file.
449. Require deletion confirmation.
450. Verify deletion.
451. Copy text.
452. Verify clipboard.
453. Paste text.
454. Verify paste.
455. Clear input.
456. Verify input cleared.
457. Select text.
458. Verify selection.
459. Switch application.
460. Verify application switch.
461. Minimize window.
462. Verify minimize.
463. Maximize window.
464. Verify maximize.
465. Restore window.
466. Verify restore.
467. Close application.
468. Verify application closed.
469. Open Start menu.
470. Verify Start menu.
471. Open settings.
472. Verify settings.
473. Handle permission dialog.
474. Handle confirmation dialog.
475. Handle browser popup.
476. Handle unexpected popup.
477. Handle blocked action.
478. Handle disabled control.
479. Handle unavailable element.
480. Handle stale element.
481. Re-find stale element.
482. Recalculate coordinates.
483. Retry action.
484. Limit retries.
485. Stop on unsafe action.
486. Request confirmation.
487. Execute confirmed action.
488. Cancel rejected action.
489. Log tool call.
490. Log tool result.
491. Return structured ToolResult.
492. Validate ToolResult schema.
493. Test click.
494. Test typing.
495. Test keyboard.
496. Test scrolling.
497. Test application launch.
498. Test application switching.
499. Test failure recovery.
500. Verify complete action pipeline.

---

## P6: Verification + Recovery (Tickets 501–600)
501. Capture post-action screen.
502. Compare pre-action screen.
503. Detect expected change.
504. Verify application state.
505. Verify window state.
506. Verify target element.
507. Verify text.
508. Verify input value.
509. Verify button state.
510. Verify navigation.
511. Verify dialog state.
512. Verify search results.
513. Verify selected result.
514. Verify opened chat.
515. Verify opened document.
516. Verify browser URL.
517. Verify file existence.
518. Verify file contents.
519. Verify process state.
520. Verify task state.
521. Calculate verification confidence.
522. Detect verification mismatch.
523. Detect false success.
524. Detect no-op action.
525. Detect partial action.
526. Detect unexpected change.
527. Trigger re-perception.
528. Rebuild ScreenModel.
529. Re-evaluate target.
530. Retry action.
531. Change perception method.
532. Change tool strategy.
533. Re-plan step.
534. Re-plan task.
535. Roll back action.
536. Abort task.
537. Return failure.
538. Explain failure.
539. Ask user for help.
540. Ask user for confirmation.
541. Resume after confirmation.
542. Resume after clarification.
543. Handle timeout.
544. Handle application crash.
545. Handle application freeze.
546. Handle screen transition.
547. Handle loading delay.
548. Handle animation delay.
549. Wait for stable screen.
550. Detect stable screen.
551. Detect changing screen.
552. Bound waiting time.
553. Bound retry count.
554. Bound recovery count.
555. Prevent infinite loops.
556. Track recovery history.
557. Track failed strategies.
558. Avoid repeated failed strategy.
559. Store successful strategy.
560. Generate verification event.
561. Generate recovery event.
562. Generate failure event.
563. Generate success event.
564. Send result to orchestrator.
565. Send result to UI.
566. Send result to voice.
567. Log verification.
568. Log recovery.
569. Log failure.
570. Test successful verification.
571. Test false success.
572. Test mismatch.
573. Test retry.
574. Test re-perception.
575. Test re-planning.
576. Test timeout.
577. Test application crash.
578. Test stale element.
579. Test unexpected popup.
580. Test loading state.
581. Test cancellation.
582. Test recovery limit.
583. Test rollback.
584. Test confirmation.
585. Test user rejection.
586. Test resume.
587. Verify no infinite loops.
588. Verify no false success.
589. Verify real verification data.
590. Verify bounded recovery.
591. Verify deterministic failure.
592. Verify task cleanup.
593. Verify event ordering.
594. Verify audit trail.
595. Verify latency.
596. Verify recovery latency.
597. Verify confidence.
598. Verify success criteria.
599. Verify complete recovery pipeline.
600. Verify complete verification pipeline.

---

## P7: Risk / Safety / Confirmation (Tickets 601–700)
601. Define LOW risk actions.
602. Define MEDIUM risk actions.
603. Define HIGH risk actions.
604. Classify tool risk.
605. Classify task risk.
606. Detect destructive actions.
607. Detect financial actions.
608. Detect external communication.
609. Detect credential operations.
610. Detect personal-data operations.
611. Detect file deletion.
612. Detect application installation.
613. Detect system configuration.
614. Detect shutdown.
615. Detect restart.
616. Detect browser submission.
617. Detect message sending.
618. Detect email sending.
619. Detect form submission.
620. Detect purchase.
621. Detect transfer.
622. Detect account changes.
623. Require confirmation.
624. Display confirmation UI.
625. Read confirmation response.
626. Accept confirmation.
627. Reject confirmation.
628. Timeout confirmation.
629. Cancel task after rejection.
630. Continue task after approval.
631. Record approval.
632. Record rejection.
633. Record timestamp.
634. Record requested action.
635. Record risk level.
636. Prevent hidden execution.
637. Prevent silent high-risk execution.
638. Prevent confirmation bypass.
639. Prevent duplicate approval.
640. Prevent stale approval.
641. Bind approval to task ID.
642. Bind approval to action ID.
643. Bind approval to parameters.
644. Expire approval.
645. Detect changed action.
646. Request new approval.
647. Display action summary.
648. Display target application.
649. Display target data.
650. Display consequence.
651. Display cancellation option.
652. Test low-risk action.
653. Test medium-risk action.
654. Test high-risk action.
655. Test approval.
656. Test rejection.
657. Test timeout.
658. Test changed parameters.
659. Test stale approval.
660. Test duplicate approval.
661. Test cancellation.
662. Test malicious instruction.
663. Test prompt injection.
664. Test webpage instruction.
665. Ignore untrusted webpage commands.
666. Separate user intent from screen text.
667. Mark screen text untrusted.
668. Mark external content untrusted.
669. Prevent tool execution from OCR text.
670. Validate planner output.
671. Validate tool arguments.
672. Validate target application.
673. Validate target element.
674. Validate file path.
675. Validate URL.
676. Validate command scope.
677. Restrict destructive tools.
678. Restrict system tools.
679. Restrict credential tools.
680. Restrict network tools.
681. Restrict file tools.
682. Audit security decisions.
683. Audit confirmation decisions.
684. Audit blocked actions.
685. Audit rejected actions.
686. Audit approved actions.
687. Test security boundaries.
688. Test injection resistance.
689. Test unsafe command.
690. Test malicious screen text.
691. Test malicious webpage.
692. Test confirmation bypass.
693. Test parameter mutation.
694. Test tool validation.
695. Test risk escalation.
696. Test risk downgrade prevention.
697. Test session isolation.
698. Test permission expiration.
699. Verify safety pipeline.
700. Verify confirmation pipeline.

---

## P8: Memory / Context / Logging (Tickets 701–800)
701. Create session memory.
702. Create task memory.
703. Create screen context.
704. Store active application.
705. Store active window.
706. Store current task.
707. Store previous action.
708. Store previous observation.
709. Store verification result.
710. Store failure reason.
711. Store successful action.
712. Store successful target.
713. Store task duration.
714. Store command transcript.
715. Store user confirmation.
716. Store user cancellation.
717. Store session timestamp.
718. Generate session ID.
719. Generate task ID.
720. Generate action ID.
721. Generate observation ID.
722. Generate verification ID.
723. Generate correlation ID.
724. Add structured logs.
725. Add log levels.
726. Add debug logging.
727. Add warning logging.
728. Add error logging.
729. Add security logging.
730. Add task logging.
731. Add voice logging.
732. Add perception logging.
733. Add tool logging.
734. Add verification logging.
735. Add recovery logging.
736. Redact API keys.
737. Redact passwords.
738. Redact credentials.
739. Redact sensitive tokens.
740. Redact sensitive screen text where required.
741. Rotate logs.
742. Limit log size.
743. Detect corrupted log.
744. Flush logs on shutdown.
745. Preserve crash logs.
746. Generate task trace.
747. Generate performance trace.
748. Generate voice trace.
749. Generate perception trace.
750. Generate action trace.
751. Generate verification trace.
752. Correlate all traces.
753. Calculate end-to-end latency.
754. Calculate perception latency.
755. Calculate action latency.
756. Calculate verification latency.
757. Calculate voice latency.
758. Calculate retry count.
759. Calculate failure rate.
760. Calculate success rate.
761. Calculate false-success rate.
762. Calculate task completion time.
763. Detect repeated failures.
764. Detect repeated commands.
765. Detect repeated application targets.
766. Clear expired memory.
767. Limit memory size.
768. Persist useful task history.
769. Load task context.
770. Restore interrupted task where safe.
771. Reject unsafe task restoration.
772. Test memory creation.
773. Test memory retrieval.
774. Test memory cleanup.
775. Test log rotation.
776. Test redaction.
777. Test crash logging.
778. Test task trace.
779. Test correlation IDs.
780. Test performance metrics.
781. Test session isolation.
782. Test concurrent sessions.
783. Test shutdown persistence.
784. Test corrupted state.
785. Test recovery.
786. Verify logs contain real events.
787. Verify no fake progress logs.
788. Verify no secrets.
789. Verify trace completeness.
790. Verify task history.
791. Verify memory limits.
792. Verify retention policy.
793. Verify auditability.
794. Verify debugging usefulness.
795. Verify performance metrics.
796. Verify crash diagnosis.
797. Verify session lifecycle.
798. Verify task lifecycle.
799. Verify complete memory pipeline.
800. Verify complete logging pipeline.

---

## P9: Voice UI / EXE / Desktop Experience (Tickets 801–900)
801. Launch ScreenAI-Voice.exe.
802. Resolve application root.
803. Resolve app directory.
804. Resolve Node runtime.
805. Resolve PowerShell runtime.
806. Validate required files.
807. Validate OCR models.
808. Validate node_modules.
809. Validate environment.
810. Validate API key.
811. Start Node process.
812. Start WPF process.
813. Create Windows Job Object.
814. Attach child processes.
815. Redirect stdout.
816. Redirect stderr.
817. Create application log.
818. Detect SCREENAI_READY.
819. Detect SCREENAI_FATAL.
820. Detect SCREENAI_WARN.
821. Detect child process failure.
822. Show startup error.
823. Prevent duplicate instance.
824. Create single-instance mutex.
825. Handle second launch.
826. Handle launcher shutdown.
827. Kill owned children on shutdown.
828. Avoid killing unrelated processes.
829. Handle launcher crash.
830. Handle child crash.
831. Show idle pill.
832. Expand voice UI.
833. Animate voice bars.
834. Use real amplitude.
835. Smooth amplitude.
836. Maintain 60 FPS.
837. Handle LISTENING state.
838. Handle PROCESSING state.
839. Handle WORKING state.
840. Handle SUCCESS state.
841. Handle FAILURE state.
842. Handle CANCEL state.
843. Display partial transcript.
844. Hide stale transcript.
845. Display current step.
846. Display final result.
847. Auto-collapse after success.
848. Auto-collapse after failure.
849. Collapse after cancellation.
850. Handle Ctrl+Space.
851. Handle Escape.
852. Handle click toggle.
853. Add right-click Quit.
854. Stop voice on Quit.
855. Stop agent on Quit.
856. Close WPF cleanly.
857. Close Node cleanly.
858. Flush logs.
859. Test animation.
860. Test amplitude.
861. Test state transitions.
862. Test hotkey.
863. Test Escape.
864. Test click.
865. Test quit.
866. Test startup.
867. Test shutdown.
868. Test duplicate launch.
869. Test missing API key.
870. Test missing Node.
871. Test missing SoX.
872. Test missing model.
873. Test broken app directory.
874. Test debug mode.
875. Test simulation mode.
876. Test production mode.
877. Test portable distribution.
878. Test build script.
879. Test required-file manifest.
880. Test secret exclusion.
881. Test log output.
882. Test Job Object cleanup.
883. Test orphan process prevention.
884. Test Windows 10.
885. Test Windows 11.
886. Test locked desktop behavior.
887. Test unlocked desktop behavior.
888. Test display scaling.
889. Test high-DPI display.
890. Test multiple monitors.
891. Test resolution changes.
892. Test dark desktop.
893. Test light desktop.
894. Test startup latency.
895. Test memory usage.
896. Test CPU usage.
897. Test animation CPU usage.
898. Test UI responsiveness.
899. Verify complete desktop UI pipeline.
900. Verify complete EXE pipeline.

---

## P10: End-to-End + Demo + Hackathon Reliability (Tickets 901–1000)
901. Define MVP command.
902. Define MVP success criteria.
903. Define MVP failure criteria.
904. Test "Open WhatsApp".
905. Verify WhatsApp detection.
906. Verify WhatsApp launch.
907. Detect WhatsApp window.
908. Scan WhatsApp screen.
909. Detect search control.
910. Verify search control.
911. Click search.
912. Verify search focus.
913. Type "Dad".
914. Verify typed "Dad".
915. Scan search results.
916. Detect Dad result.
917. Verify Dad result.
918. Click Dad result if required.
919. Verify target chat.
920. Generate success result.
921. Generate spoken response.
922. Display success UI.
923. Collapse UI.
924. Clean task state.
925. Clean voice session.
926. Log complete trace.
927. Measure total latency.
928. Measure transcription latency.
929. Measure perception latency.
930. Measure action latency.
931. Measure verification latency.
932. Test repeated WhatsApp command.
933. Test command cancellation.
934. Test wrong target.
935. Test missing WhatsApp.
936. Test WhatsApp closed.
937. Test WhatsApp loading.
938. Test search unavailable.
939. Test Dad unavailable.
940. Test OCR failure.
941. Test UIA failure.
942. Test vision fallback.
943. Test action failure.
944. Test verification failure.
945. Test recovery.
946. Test timeout.
947. Test AssemblyAI disconnect.
948. Test microphone disconnect.
949. Test network loss.
950. Test application crash.
951. Test unexpected popup.
952. Test permission dialog.
953. Test user cancellation.
954. Test high-risk command.
955. Test malicious screen content.
956. Test prompt injection.
957. Test duplicate command.
958. Test simultaneous activation.
959. Test rapid commands.
960. Test long command.
961. Test multi-step command.
962. Test ambiguous command.
963. Test clarification.
964. Test clarification response.
965. Test task resume.
966. Test task abort.
967. Test full shutdown.
968. Test full restart.
969. Test clean startup.
970. Test clean shutdown.
971. Record demo video.
972. Record voice UI reaction.
973. Record real microphone amplitude.
974. Record AssemblyAI transcript.
975. Record Screen-AI perception.
976. Record actual Windows action.
977. Record verification.
978. Record success response.
979. Prepare architecture diagram.
980. Prepare pipeline diagram.
981. Prepare technical explanation.
982. Prepare hackathon README.
983. Prepare installation instructions.
984. Prepare API setup instructions.
985. Prepare demo instructions.
986. Prepare troubleshooting guide.
987. Prepare performance metrics.
988. Prepare reliability metrics.
989. Prepare security explanation.
990. Prepare originality explanation.
991. Prepare business-value explanation.
992. Prepare presentation slides.
993. Prepare demo script.
994. Prepare backup demo.
995. Verify GitHub repository.
996. Verify reproducible build.
997. Verify clean checkout.
998. Verify full test suite.
999. Verify live end-to-end demo.
1000. **Ship Screen-AI Voice Agent MVP.**
