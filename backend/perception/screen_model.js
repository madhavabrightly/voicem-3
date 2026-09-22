/**
 * Screen-AI converts the raw screen into a semantic world model.
 * The world model is the source of truth consumed by the orchestrator —
 * NOT raw coordinates or raw OCR strings.
 *
 * CONSOLIDATION: The canonical ScreenModel is defined in
 * pipelines/p4_perception/model_build.js with ownership stamping,
 * staleness tracking, evidence levels, and deterministic hashing.
 * This module re-exports it so all existing imports continue to work.
 */

export { ScreenModel } from "../../pipelines/p4_perception/model_build.js";