/**
 * Barrel re-exports for the compact-stages module.
 *
 * Callers import from `../../runtime/compaction/compact-stages/index.ts` (or just
 * `../../runtime/compaction/compact-stages/`) rather than reaching into individual
 * stage files, so internal refactors do not break the public surface.
 */
export { ANSI_STRIP_STAGE, AnsiStripStage } from "./ansi-strip-stage.ts";
export {
	BLANK_COLLAPSE_STAGE,
	BlankCollapseStage,
} from "./blank-collapse-stage.ts";
export { DEDUPLICATE_STAGE, DeduplicateStage } from "./deduplicate-stage.ts";
export { HeadSnapStage, type HeadSnapStageConfig } from "./head-snap-stage.ts";
export {
	TAIL_CAPTURE_STREAM_STAGE,
	TailCaptureStage,
	type TailCaptureStageConfig,
} from "./tail-capture-stage.ts";
export {
	type TruncationMarkerConfig,
	TruncationStage,
} from "./truncation-stage.ts";
