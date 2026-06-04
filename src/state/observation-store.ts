/**
 * Observation capture and compression system.
 *
 * Pattern origin: claude-mem — captures tool usage across sessions,
 * compresses via AI, injects into future sessions.
 *
 * This module provides the observation store and compression logic.
 * Actual capture hooks into the lifecycle events (Pattern 12).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { logInternalError } from "../utils/internal-error.ts";

// ── Types ────────────────────────────────────────────────────────────────

export interface Observation {
	tool: string;
	input: string;
	output: string;
	filesRead: string[];
	filesModified: string[];
	timestamp: number;
	sessionId: string;
	taskId?: string;
}

export interface CompressedObservation {
	summary: string;
	patterns: string[];
	decisions: string[];
	filesAffected: string[];
	relevanceScore: number;
	timestamp: number;
	sessionId: string;
}

export interface ObservationStoreConfig {
	maxObservations: number;
	maxCompressed: number;
	privacyTags: string[];  // tags to strip before storage
}

const DEFAULT_CONFIG: ObservationStoreConfig = {
	maxObservations: 1000,
	maxCompressed: 200,
	privacyTags: ["<private>", "<secret>", "<credentials>"],
};

// ── Privacy ──────────────────────────────────────────────────────────────

/**
 * Strip privacy-tagged content from a string.
 */
export function stripPrivacyTags(content: string, config = DEFAULT_CONFIG): string {
	let result = content;
	for (const tag of config.privacyTags) {
		const openTag = tag;
		const closeTag = tag.replace("<", "</");
		// Remove everything between open and close tags
		const regex = new RegExp(`${escapeRegex(openTag)}[\\s\\S]*?${escapeRegex(closeTag)}`, "gi");
		result = result.replace(regex, "[REDACTED]");
	}
	return result;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Observation Store ────────────────────────────────────────────────────

export class ObservationStore {
	private observations: Observation[] = [];
	private compressed: CompressedObservation[] = [];
	private config: ObservationStoreConfig;
	private storePath: string;

	constructor(storePath: string, config: Partial<ObservationStoreConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.storePath = storePath;
		if (existsSync(storePath)) {
			this.load();
		}
	}

	/**
	 * Record a new observation.
	 */
	record(observation: Observation): void {
		// Strip privacy
		const sanitized: Observation = {
			...observation,
			input: stripPrivacyTags(observation.input, this.config),
			output: stripPrivacyTags(observation.output, this.config),
		};

		this.observations.push(sanitized);

		// Enforce capacity
		if (this.observations.length > this.config.maxObservations) {
			this.observations = this.observations.slice(-this.config.maxObservations);
		}
	}

	/**
	 * Get recent observations.
	 */
	getRecent(count = 10): Observation[] {
		return this.observations.slice(-count);
	}

	/**
	 * Store a compressed observation.
	 */
	addCompressed(compressed: CompressedObservation): void {
		this.compressed.push(compressed);

		if (this.compressed.length > this.config.maxCompressed) {
			this.compressed = this.compressed.slice(-this.config.maxCompressed);
		}
	}

	/**
	 * Get compressed observations for injection.
	 */
	getCompressed(limit = 5): CompressedObservation[] {
		return this.compressed
			.sort((a, b) => b.relevanceScore - a.relevanceScore)
			.slice(0, limit);
	}

	/**
	 * Format compressed observations for prompt injection.
	 */
	injectCompressed(limit = 5): string {
		const items = this.getCompressed(limit);
		if (items.length === 0) return "";

		return "## Observations from Previous Sessions\n\n" +
			items.map((o) =>
				`### ${o.summary}\n` +
				`Patterns: ${o.patterns.join(", ")}\n` +
				`Decisions: ${o.decisions.join(", ")}\n` +
				`Files: ${o.filesAffected.join(", ")}`,
			).join("\n\n") +
			"\n";
	}

	/**
	 * Persist to disk.
	 */
	save(): void {
		try {
			mkdirSync(this.storePath.substring(0, this.storePath.lastIndexOf("/")), { recursive: true });
			writeFileSync(this.storePath, JSON.stringify({
				observations: this.observations,
				compressed: this.compressed,
			}, null, 2), "utf-8");
		} catch (error) {
			logInternalError("observation-store.save", error, `path=${this.storePath}`);
		}
	}

	get stats(): { observations: number; compressed: number } {
		return { observations: this.observations.length, compressed: this.compressed.length };
	}

	private load(): void {
		try {
			const data = JSON.parse(readFileSync(this.storePath, "utf-8"));
			if (Array.isArray(data.observations)) this.observations = data.observations;
			if (Array.isArray(data.compressed)) this.compressed = data.compressed;
		} catch (error) {
			logInternalError("observation-store.load", error, `path=${this.storePath}`);
		}
	}
}
