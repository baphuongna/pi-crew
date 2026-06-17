/**
 * Per-write validator — real-time feedback on file writes/edits (T5).
 *
 * Distilled from pi-lens (apmantza) — the "inline channel": on every
 * `write`/`edit` tool result, run a CHEAP synchronous validator for the file
 * type and, on failure, append a `🔴` blocker block to the tool result the
 * agent sees next. This catches silent-breaking errors (malformed JSON
 * config) at the moment they're introduced instead of at the next load.
 *
 * CRITICAL LATENCY-SAFETY DESIGN (the reason this is a careful slice, not the
 * full pi-lens pipeline): pi-lens runs LSP servers + linters per write. That
 * is expensive and would cause latency storms if naively ported (seconds of
 * spawn per edit, firing in the main session AND every worker). This module's
 * v1 deliberately ships ONLY zero-cost, zero-spawn, synchronous validators:
 *
 *   - `json` → `JSON.parse` (nanoseconds, built-in, no process spawn).
 *
 * The registry is extensible — future validators (`.js` → `node --check`,
 * `.sh` → `bash -n`, `.py` → `py_compile`) are process-spawning and MUST be
 * added behind an explicit opt-in (never default-on) to preserve the
 * latency guarantee. A process-spawning validator would also need to be async
 * and debounced (pi-lens's `inFlightPipelines` / debounce-window pattern),
 * which the current sync contract intentionally avoids.
 *
 * Contract guarantees for v1:
 *   - Synchronous. No `await`, no `spawn`, no disk write.
 *   - One disk READ per validated file (after a cheap extension check, so
 *     non-validated files cost nothing).
 *   - Dedup by content: the same path+content is validated at most once per
 *     process (a repeated identical write doesn't re-report).
 *   - Silent on success; appends exactly one TextContent block on failure.
 *   - Best-effort: any internal error is swallowed (never breaks a write).
 *
 * @module per-write-validator
 */

import { readFileSync } from "node:fs";
import { extname as pathExtname } from "node:path";

/** Outcome of validating a file's content. */
export interface ValidationResult {
	ok: boolean;
	/** Human-readable error message when `ok` is false. */
	error?: string;
}

/** A synchronous validator: content + path → result. */
export type PerWriteValidator = (content: string, filePath: string) => ValidationResult;

// ─────────────────────────────────────────────────────────────────────────
// Validators (zero-cost, synchronous, dependency-free for v1)
// ─────────────────────────────────────────────────────────────────────────

/** JSON: parse with `JSON.parse`. Catches malformed config/manifests instantly. */
export function validateJson(content: string, _filePath: string): ValidationResult {
	if (content.trim() === "") return { ok: true }; // empty file is valid JSON absence, not a parse error
	try {
		JSON.parse(content);
		return { ok: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Invalid JSON: ${message}` };
	}
}

/**
 * Registry of default-on validators, keyed by extension (lowercase, no dot).
 * ONLY zero-cost synchronous validators belong here. Process-spawning
 * validators must be registered via a future opt-in path (see module doc).
 */
const DEFAULT_VALIDATORS: ReadonlyMap<string, PerWriteValidator> = new Map([
	["json", validateJson],
]);

// ─────────────────────────────────────────────────────────────────────────
// Dedup cache (path → last-validated content). Bounded; small.
// ─────────────────────────────────────────────────────────────────────────

const MAX_DEDUP_ENTRIES = 256;
const seenContent = new Map<string, string>();

function rememberSeen(path: string, content: string): void {
	if (seenContent.has(path)) seenContent.delete(path); // refresh LRU position
	seenContent.set(path, content);
	while (seenContent.size > MAX_DEDUP_ENTRIES) {
		const oldest = seenContent.keys().next().value;
		if (oldest === undefined) break;
		seenContent.delete(oldest);
	}
}

/** Test seam: reset the dedup cache between tests. */
export function resetPerWriteValidatorCache(): void {
	seenContent.clear();
}

/**
 * Replace the validator registry (test seam). Production uses
 * DEFAULT_VALIDATORS; tests inject a custom map to exercise specific extensions.
 */
let validators: ReadonlyMap<string, PerWriteValidator> = DEFAULT_VALIDATORS;

export function setPerWriteValidatorsForTest(map: ReadonlyMap<string, PerWriteValidator> | undefined): void {
	validators = map ?? DEFAULT_VALIDATORS;
}

/**
 * Normalise an extension to the registry key form (lowercase, no leading dot).
 * "" for files with no extension.
 */
export function extensionKey(filePath: string): string {
	return pathExtname(filePath).replace(/^\./, "").toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────
// Path extraction from a tool_result event input (defensive — pi-ai types
// aren't exported here, so accept a record and probe common field names).
// ─────────────────────────────────────────────────────────────────────────

const PATH_FIELDS = ["filePath", "path", "file"] as const;

/** Extract the written/edited path from a tool result input, if present. */
export function extractPathFromInput(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	for (const field of PATH_FIELDS) {
		const value = record[field];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Core entry point
// ─────────────────────────────────────────────────────────────────────────

/**
 * Validate a just-written/edited file. Returns `null` when there is nothing
 * to report (no validator for the extension, dedup hit, file unreadable, or
 * the content is valid). Returns a `ValidationResult` with `ok:false` when the
 * content fails validation.
 *
 * Reads the file from disk (it's already written by `tool_result` time) so the
 * logic is uniform across `write` (full content) and `edit` (patch). The disk
 * read happens ONLY after a cheap extension check, so non-validated files cost
 * nothing.
 */
export function validateWrittenFile(filePath: string): ValidationResult | null {
	const key = extensionKey(filePath);
	const validator = validators.get(key);
	if (!validator) return null; // cheap skip: no validator for this file type
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		// Unreadable / missing / permission denied — can't validate; never block.
		return null;
	}
	// Dedup: identical content already validated this process → don't re-report.
	if (seenContent.get(filePath) === content) return null;
	rememberSeen(filePath, content);
	const result = validator(content, filePath);
	return result.ok ? null : result;
}

/**
 * Build the TextContent block to append to a tool_result on validation failure.
 * Uses a strong `🔴` prefix so the agent treats it as a real signal and fixes
 * the file before continuing.
 */
export function buildValidationBlocker(filePath: string, error: string): { type: "text"; text: string } {
	return {
		type: "text",
		text: [
			"",
			"🔴 pi-crew per-write check FAILED",
			`   ${filePath}`,
			`   ${error}`,
			"   The file you just wrote is malformed. Fix it now — a broken file here will",
			"   silently fail the next load/parse. Re-write the file with valid content before continuing.",
		].join("\n"),
	};
}
