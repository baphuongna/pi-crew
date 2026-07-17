/**
 * Incremental fingerprinting — detect file changes to skip unchanged work.
 *
 * Pattern origin: Understand-Anything/packages/core/src/fingerprint.ts
 * Content hash + structural signature per file. Change classifier:
 * NONE (unchanged), COSMETIC (whitespace/comments only), STRUCTURAL (code changed).
 * Only STRUCTURAL changes trigger re-analysis.
 */

import { createHash, } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { logInternalError } from "../utils/internal-error.ts";

// ── Types ────────────────────────────────────────────────────────────────

export type ChangeClass = "NONE" | "COSMETIC" | "STRUCTURAL";

export interface FileFingerprint {
	path: string;
	contentHash: string;
	structuralSignature: string;
	lastModified: number; // mtime ms
	changeClass: ChangeClass;
}

export interface FingerprintDelta {
	added: string[];
	removed: string[];
	modified: FileFingerprint[]; // only STRUCTURAL changes
	unchanged: number;
}

// ── Fingerprinting ───────────────────────────────────────────────────────

/**
 * Compute SHA-256 content hash of a file.
 */
export function computeContentHash(filePath: string): string {
	try {
		const content = readFileSync(filePath);
		return createHash("sha256").update(content).digest("hex");
	} catch {
		return "";
	}
}

/**
 * Extract a structural signature from source code.
 *
 * Captures function signatures, class methods, and import specifiers.
 * Ignores whitespace, comments, and string content.
 * Returns a hash of the structural elements.
 */
export function computeStructuralSignature(content: string, filePath: string): string {
	const lines = content.split("\n");
	const structural: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();

		// Skip empty lines and comments
		if (trimmed.length === 0) continue;
		if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;

		// Capture structural lines
		if (
			// Function/method declarations
			/^(export\s+)?(async\s+)?function\s/.test(trimmed) ||
			(/^\w+\s*\(/.test(trimmed) && !/^(if|for|while|switch|return|throw|await)/.test(trimmed)) ||
			// Class declarations
			/^(export\s+)?(abstract\s+)?class\s/.test(trimmed) ||
			/^(public|private|protected|static|readonly|abstract)\s/.test(trimmed) ||
			// Interface/type declarations
			/^(export\s+)?(interface|type)\s/.test(trimmed) ||
			// Import declarations
			/^import\s/.test(trimmed) ||
			// Export declarations
			/^export\s+(default\s+)?(const|let|var|function|class|interface|type|enum)\s/.test(trimmed)
		) {
			structural.push(trimmed);
		}
	}

	return createHash("sha256").update(structural.join("\n")).digest("hex");
}

/**
 * Classify the change between two fingerprints.
 */
export function classifyChange(previous: FileFingerprint | undefined, current: FileFingerprint): ChangeClass {
	if (!previous) return "STRUCTURAL"; // New file

	if (previous.contentHash === current.contentHash) return "NONE";
	if (previous.structuralSignature === current.structuralSignature) return "COSMETIC";
	return "STRUCTURAL";
}

/**
 * Compute fingerprint for a single file.
 */
export function fingerprintFile(filePath: string): FileFingerprint {
	const content = readFileSync(filePath, "utf-8");
	const stat = statSync(filePath);

	return {
		path: filePath,
		contentHash: computeContentHash(filePath),
		structuralSignature: computeStructuralSignature(content, filePath),
		lastModified: stat.mtimeMs,
		changeClass: "NONE", // will be classified during delta computation
	};
}

// ── Fingerprint Store ────────────────────────────────────────────────────

const MAX_FINGERPRINTS = 10000;

/**
 * Load fingerprint baseline from a JSON file.
 */
export function loadFingerprintBaseline(storePath: string): Map<string, FileFingerprint> {
	const map = new Map<string, FileFingerprint>();
	if (!existsSync(storePath)) return map;

	try {
		const data = JSON.parse(readFileSync(storePath, "utf-8")) as FileFingerprint[];
		for (const fp of data) {
			if (map.size >= MAX_FINGERPRINTS) break;
			map.set(fp.path, fp);
		}
	} catch (error) {
		logInternalError("fingerprint.load", error, `storePath=${storePath}`);
	}
	return map;
}

/**
 * Save fingerprint baseline to a JSON file.
 */
export function saveFingerprintBaseline(storePath: string, fingerprints: Map<string, FileFingerprint>): void {
	const entries = [...fingerprints.entries()].slice(0, MAX_FINGERPRINTS).map(([, fp]) => fp);
	writeFileSync(storePath, JSON.stringify(entries, null, 2), "utf-8");
}

/**
 * Compute delta between baseline and current fingerprints.
 *
 * Only returns STRUCTURAL changes in the `modified` field.
 */
export function computeFingerprintDelta(baseline: Map<string, FileFingerprint>, current: Map<string, FileFingerprint>): FingerprintDelta {
	const added: string[] = [];
	const removed: string[] = [];
	const modified: FileFingerprint[] = [];
	let unchanged = 0;

	// Find added and modified
	for (const [path, currentFp] of current) {
		const prev = baseline.get(path);
		const changeClass = classifyChange(prev, currentFp);

		if (!prev) {
			added.push(path);
		} else if (changeClass === "STRUCTURAL") {
			modified.push({ ...currentFp, changeClass: "STRUCTURAL" });
		} else if (changeClass === "COSMETIC") {
			unchanged++; // cosmetic = treated as unchanged for re-analysis
		} else {
			unchanged++;
		}
	}

	// Find removed
	for (const path of baseline.keys()) {
		if (!current.has(path)) {
			removed.push(path);
		}
	}

	return { added, removed, modified, unchanged };
}
