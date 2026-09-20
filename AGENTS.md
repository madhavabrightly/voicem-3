# Project Architecture, Skills & Operational Guidelines

## Communication & Workflow

- **Act Decisively**: Act decisively without asking clarifying questions or seeking re-confirmation. You have blanket permission to execute tasks cleanly and directly.
- **Terse & Telegram-Style Communication**: Expect terse, telegram-style specs, numbered checklists, or bare imperative commands (e.g., "push to git"). Infer surrounding context, conventions, and architectural intent independently.
- **Credit & Token Consciousness**: Minimize unnecessary tool calls, verbose chatter, and redundant re-verifications to conserve context and tokens.
- **Manage Bloat**: Clean up agent-managed bloat (old session logs, temp/scratch files, caches) while never deleting project source files.
- **Discipline**: Strictly follow the ACT → OBSERVE → VERIFY lifecycle. Never assume an action succeeded; follow up with real observation and verification.
- **Bounded Recovery**: Employ bounded retries with recovery logic (retry → re-perceive → choose alternative) restoring prior state rather than blindly repeating failed actions.
- **MVP First**: Establish and stabilize the core loop reliably before adding complex or speculative features.
- **Risk Classification**: Classify actions by risk (low/medium/high) and gate genuinely risky actions behind clear checks.
- **Auditability**: Log perception → decision → action → verification steps for a traceable trail.
- **No Fakes / No Mocks as Completion**: Rejects simulated/mock passes as proof of completion. Tasks must demonstrably work against the real environment (e.g., real Windows desktop).
- **Honest Labeling**: Explicitly distinguish between what is "CODE IMPLEMENTED" vs "ACTUALLY TESTED". Mark status as REAL only for components verified on actual hardware/environment.
- **Strictly Minimal Scope**: Never create or modify files beyond what was explicitly asked. No unrequested extras or unprompted edits (e.g., `.gitignore`).
- **No Destructive Reverts**: If a change was already made, leave it as-is — never revert or undo past working edits.
- **Git Commit Etiquette**: 
  - Leave change sets uncommitted unless explicitly instructed to commit.
  - When told to commit/push, include the complete working state (including necessary binaries/models).
  - Never add bot/AI co-author trailers or attribution; commits belong solely to the user.
- **Frozen Prior Pipelines**: Treat previously implemented ranges/pipelines as frozen. Do not duplicate, rewrite, or renumber prior work; delegate and cross-reference instead.
- **End-to-End Coherence**: Deliveries must be cohesive pipelines integrated through existing layers, not detached standalone modules.
- **Structured Verification Reporting**: Provide clear summaries detailing pass/fail counts, runtime/latency impact, unresolved limitations, and git diff/status.
- **Pre-Implementation Inspection**: Inspect and inventory existing repository components first to maximize reuse.
- **Automated Testing**: Deliver automated tests matching numbered tickets/pipelines and keep the existing test suite passing.

---

## UI & Design

- **Floating Assistant Footprint**: Minimal, compact, floating assistant UI: dark, rounded, slightly translucent, quiet borders, futuristic — no heavy dashboard chrome, oversized chat windows, or bloated buttons.
- **Signature Visual Core**: Distinctive signature visual as the primary interaction element (e.g., animated voice core) instead of generic left-to-right waveforms or plain microphone icons.
- **Real-Data Binding**: Every UI visual and signal must be bound to real underlying data (e.g., real audio streams driving animations; no fake thinking, progress, or dummy waveforms).
- **Smooth 60 FPS Motion**: Immediate, interpolated/smoothed 60 FPS motion reacting without perceptible jitter or lag.
- **Lightweight Presentation**: UI presentation layer must never block or interfere with the core pipeline (no audio capture drops, no unprompted continuous OCR overhead, no extraneous network calls).
- **Global Hotkey Interaction**: Single global hotkey trigger with Escape to dismiss/cancel; avoid complex menu navigation.
- **Console-Free Launch**: Clean production launch without lingering CMD/PowerShell windows, redirecting child stdout/stderr cleanly to log files.

---

## Architecture

- **Integration Over Refactoring**: Make minimal changes necessary to connect new components into the existing design. Never redesign, refactor, or replace existing architectural layers (orchestrator, planner, perception, tools).
- **Layered Isolation**: Strict module isolation behind abstract interfaces (voice, screen perception, computer action execution) allowing modular swaps without touching core logic.
- **Extensible Interfaces**: Keep abstractions clean so future features (memory, learning, autonomous loops) hook in without core rewrites.
- **Brain Decoupled from Hardware**: Orchestrator depends on abstract interfaces, independent of concrete OS/hardware mechanisms.
- **Screen Perception Stack**: Strictly adhere to priority hierarchy:
  1. Structured UI Automation
  2. OCR
  3. Vision / Image Analysis
  4. Raw Coordinate Fallback (last resort only)
- **Explicit Task State & Recovery**: Orchestrator maintains state to enable recovery from mid-task failures instead of blind resets.
- **Finalized Signal Execution**: Trigger pipeline actions only on complete, finalized user signals (e.g., finalized speech turns reach orchestrator exactly once; interim transcripts are display-only).
- **Thin Bootstrappers**: Launchers and executables only bootstrap paths, spawn processes, and manage lifecycle; keep business intelligence inside application core.
- **Single Source of Truth**: Never duplicate functionality or maintain parallel implementations.
- **Explicit Boundary Ownership**: Clear boundaries between module responsibilities (e.g., command-level risk vs action-level risk) with shared types imported from owning modules.

---

## Coding Standards

- **Deterministic Structured Output**: All tools and actions must return structured, JSON-serializable result objects.
- **Sensors vs Intelligence**: Treat sub-systems (like OCR or audio capture) as sensors feeding semantic state, not autonomous intelligence layers.
- **Semantic Domain Modeling**: Work with structured, semantic world representations rather than hard-coded coordinates or ad-hoc magic numbers. Logical resolution at runtime.
- **Secrets & Credentials Management**:
  - Store secrets in gitignored `env/.env` (with tracked `.env.example`).
  - Load via existing project loaders where real environment variables take precedence.
  - Never print or log credentials anywhere in output, error logs, or final reports.
- **Module System Consistency**: Maintain existing module format (CommonJS / ES Modules) consistently without mixing incompatible styles.
- **Inspect Real APIs First**: Always read the existing codebase APIs before calling them — never guess, hallucinate, or assume function signatures.
- **Reuse Existing Infrastructure**: Reuse existing project utilities, env loaders, and lightweight shells rather than pulling redundant dependencies or heavy frameworks.
- **Real Functioning Implementations**: Implement working models and inference; do not use placeholders or dummy stubs.
- **Official SDK Verification**: Verify third-party SDKs and APIs against current documentation for model names, events, and lifecycles.
- **Native Library Mechanisms**: Leverage built-in reconnects and lifecycles instead of building duplicate wrapper layers.
- **Path Resolution**: Resolve application root and resources relative to executable/application directory, never assuming current working directory (`cwd`).
- **Narrow Process Supervision**: Supervise and terminate only spawned child processes (e.g., via Windows Job Objects), never using sweeping process kills (like `taskkill /F /IM node.exe`).
- **Scripted Builds & Packaging**: Expose reproducible build scripts via `package.json` scripts (e.g., `npm run build:exe`) with honest packaging.
- **Prerequisite Validation**: Startup must validate runtime, dependencies, and configuration, failing fast with actionable error messages.
- **Preserve User Text**: Do not mutate user-supplied text; emit structured semantic spans referencing exact slices (`text === original.slice(start, end)`).
- **Boundary Validation**: Enforce strict schema validation at layer boundaries, rejecting malformed payloads early.
- **Deterministic Orchestration**: Ensure orchestration with injected clock/IDs generates deterministic, reproducible event streams.
