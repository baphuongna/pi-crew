/**
 * Phase-gated intermediate store — persist workflow step outputs to disk.
 *
 * Pattern origin: Understand-Anything 7-phase pipeline where each phase
 * writes structured JSON to intermediate/ directory. Phase N reads Phase N-1
 * output from disk (not context). Enables:
 * - Context isolation between steps
 * - Incremental re-runs (skip completed phases)
 * - Debugging (inspect intermediate outputs)
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { logInternalError } from "../utils/internal-error.ts";
import { isSafePathId } from "../utils/safe-paths.ts";

// ── Types ────────────────────────────────────────────────────────────────

export interface IntermediateOutput {
	phase: string;
	stepId: string;
	timestamp: string;
	data: unknown;
}

export interface IntermediateStoreConfig {
	/** Root directory for intermediates (e.g., ".crew/intermediate/") */
	intermediateDir: string;
	/** File patterns to preserve across runs (e.g., ["scan-result.json"]) */
	preservePatterns: string[];
}

// ── Store Operations ─────────────────────────────────────────────────────

const DEFAULT_CONFIG: IntermediateStoreConfig = {
	intermediateDir: ".crew/intermediate",
	preservePatterns: [],
};

/**
 * Ensure the intermediate directory exists.
 */
export function ensureIntermediateDir(config: Partial<IntermediateStoreConfig> = {}): string {
	const dir = config.intermediateDir ?? DEFAULT_CONFIG.intermediateDir;
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Write an intermediate output for a phase.
 *
 * @param config - Store configuration
 * @param phase - Phase name (e.g., "explore", "analyze")
 * @param stepId - Step ID for correlation
 * @param data - Phase output data
 * @returns Path to the written file
 */
export function writeIntermediate(
	config: Partial<IntermediateStoreConfig>,
	phase: string,
	stepId: string,
	data: unknown,
): string {
	const dir = ensureIntermediateDir(config);
	const filename = `${phase}-${stepId}.json`;
	const filePath = path.join(dir, filename);

	const output: IntermediateOutput = {
		phase,
		stepId,
		timestamp: new Date().toISOString(),
		data,
	};

	writeFileSync(filePath, JSON.stringify(output, null, 2), "utf-8");
	return filePath;
}

/**
 * Read an intermediate output for a phase.
 *
 * @param config - Store configuration
 * @param phase - Phase name
 * @param stepId - Step ID
 * @returns Parsed intermediate output, or undefined if not found
 */
export function readIntermediate(
	config: Partial<IntermediateStoreConfig>,
	phase: string,
	stepId: string,
): IntermediateOutput | undefined {
	// M-2 fix (code-review 2026-06-23): validate phase/stepId before building the
	// filename to prevent path traversal via a poisoned stepId.
	if (!isSafePathId(phase) || !isSafePathId(stepId)) return undefined;
	const dir = config.intermediateDir ?? DEFAULT_CONFIG.intermediateDir;
	const filename = `${phase}-${stepId}.json`;
	const filePath = path.join(dir, filename);

	if (!existsSync(filePath)) return undefined;

	try {
		const content = readFileSync(filePath, "utf-8");
		return JSON.parse(content) as IntermediateOutput;
	} catch (error) {
		logInternalError("intermediate-store.read", error, `filePath=${filePath}`);
		return undefined;
	}
}

/**
 * Read the most recent intermediate output for any phase.
 *
 * Useful when you don't know the exact stepId but want the latest
 * output from a phase (e.g., for incremental re-runs).
 */
export function readLatestIntermediate(
	config: Partial<IntermediateStoreConfig>,
	phase: string,
): IntermediateOutput | undefined {
	const dir = config.intermediateDir ?? DEFAULT_CONFIG.intermediateDir;
	if (!existsSync(dir)) return undefined;

	const files = readdirSync(dir)
		.filter((f) => f.startsWith(`${phase}-`) && f.endsWith(".json"))
		.sort()
		.reverse(); // most recent first

	if (files.length === 0) return undefined;

	try {
		const content = readFileSync(path.join(dir, files[0]!), "utf-8");
		return JSON.parse(content) as IntermediateOutput;
	} catch {
		return undefined;
	}
}

/**
 * Clean up intermediate files, preserving specified patterns.
 *
 * @param config - Store configuration
 * @returns Number of files removed
 */
export function cleanupIntermediates(config: Partial<IntermediateStoreConfig> = {}): number {
	const dir = config.intermediateDir ?? DEFAULT_CONFIG.intermediateDir;
	const preserve = config.preservePatterns ?? DEFAULT_CONFIG.preservePatterns;

	if (!existsSync(dir)) return 0;

	const files = readdirSync(dir);
	let removed = 0;

	for (const file of files) {
		const shouldPreserve = preserve.some((pattern) => file.includes(pattern));
		if (!shouldPreserve) {
			try {
				unlinkSync(path.join(dir, file));
				removed++;
			} catch (error) {
				logInternalError("intermediate-store.cleanup", error, `file=${file}`);
			}
		}
	}

	return removed;
}

/**
 * Check if a phase has completed (intermediate exists).
 */
export function hasPhaseCompleted(
	config: Partial<IntermediateStoreConfig>,
	phase: string,
	stepId: string,
): boolean {
	return readIntermediate(config, phase, stepId) !== undefined;
}
