/**
 * Hash-based task ID generation with adaptive length and hierarchical decomposition.
 *
 * Pattern origin: beads/internal/idgen/hash.go — SHA-256 → base36 encoding
 * with birthday-paradox collision probability adaptation.
 *
 * IDs look like: `pc-a1b2` (prefix + base36 hash)
 * Hierarchical: `pc-a1b2.1` (parent.child)
 */

import { createHash } from "node:crypto";

// ── Configuration ────────────────────────────────────────────────────────

const DEFAULT_PREFIX = "pc";
const BASE36_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";

interface AdaptiveIDConfig {
	maxCollisionProbability: number;
	minLength: number;
	maxLength: number;
}

const DEFAULT_CONFIG: AdaptiveIDConfig = {
	maxCollisionProbability: 0.25,
	minLength: 3,
	maxLength: 8,
};

// ── Core Functions ───────────────────────────────────────────────────────

/**
 * Generate a hash-based ID using SHA-256 → base36 encoding.
 *
 * @param content - String content to hash
 * @param length - Desired hash length (3–8 chars)
 * @returns Base36 hash string
 */
export function hashToBase36(content: string, length: number): string {
	const hash = createHash("sha256").update(content).digest();
	let result = "";
	for (let i = 0; i < hash.length && result.length < length; i++) {
		const byte = hash[i]!;
		// Use modulo to map byte to base36
		result += BASE36_CHARS[byte % 36]!;
	}
	return result.padEnd(length, "0").slice(0, length);
}

/**
 * Calculate adaptive hash length based on existing ID count.
 *
 * Uses birthday-paradox formula: P(collision) ≈ 1 - e^(-n² / (2 * 36^L))
 *
 * @param existingCount - Number of existing IDs with the same prefix
 * @param config - Adaptive configuration
 * @returns Recommended hash length
 */
export function calculateAdaptiveLength(
	existingCount: number,
	config: AdaptiveIDConfig = DEFAULT_CONFIG,
): number {
	for (let length = config.minLength; length <= config.maxLength; length++) {
		const totalPossibilities = Math.pow(36, length);
		const probability = 1 - Math.exp(-(existingCount * existingCount) / (2 * totalPossibilities));
		if (probability <= config.maxCollisionProbability) {
			return length;
		}
	}
	return config.maxLength;
}

/**
 * Generate a deterministic hash-based task ID.
 *
 * @param parts - Content parts to hash (title, description, etc.)
 * @param prefix - ID prefix (default: "pc")
 * @param existingCount - Number of existing IDs (for adaptive length)
 * @returns Hash-based ID like "pc-a1b2"
 */
export function generateTaskHashId(
	parts: string[],
	prefix = DEFAULT_PREFIX,
	existingCount = 0,
): string {
	const content = parts.join("|");
	const length = calculateAdaptiveLength(existingCount);
	const hash = hashToBase36(content, length);
	return `${prefix}-${hash}`;
}

// ── Hierarchical IDs ────────────────────────────────────────────────────

export interface ParsedHierarchicalId {
	parentId: string;
	childNum: number;
	isHierarchical: boolean;
}

/**
 * Parse a hierarchical ID into parent and child number.
 *
 * Example: "pc-a1b2.3" → { parentId: "pc-a1b2", childNum: 3, isHierarchical: true }
 */
export function parseHierarchicalId(id: string): ParsedHierarchicalId {
	const dotIndex = id.lastIndexOf(".");
	if (dotIndex === -1 || dotIndex < 3) {
		return { parentId: id, childNum: 0, isHierarchical: false };
	}

	const parentId = id.slice(0, dotIndex);
	const childStr = id.slice(dotIndex + 1);
	const childNum = Number.parseInt(childStr, 10);

	if (!Number.isFinite(childNum) || childNum < 1) {
		return { parentId: id, childNum: 0, isHierarchical: false };
	}

	return { parentId, childNum, isHierarchical: true };
}

/**
 * Generate a child ID from a parent ID and child number.
 *
 * Example: childId("pc-a1b2", 3) → "pc-a1b2.3"
 */
export function childId(parentId: string, childNum: number): string {
	return `${parentId}.${childNum}`;
}

// ── Dependency Types ─────────────────────────────────────────────────────

/**
 * Rich dependency types for task relationships.
 *
 * Pattern origin: beads/internal/types/types.go — 19 DependencyType constants
 * Only "blocks" and "parent-child" affect execution ordering.
 */
export type DependencyType =
	| "blocks"              // A must complete before B starts
	| "parent-child"        // Hierarchical relationship
	| "conditional-blocks"  // B runs only if A fails
	| "waits-for"           // Fanout gate: wait for dynamic children
	| "related"             // Association only (no ordering)
	| "supersedes"          // A replaces B
	| "duplicates"          // A duplicates B
	| "delegated-from"      // A was delegated from B
	| "validates";          // A validates B's output
