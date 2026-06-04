/**
 * 4-Tier Memory Consolidation System.
 *
 * Pattern origin: agentmemory — Working → Episodic → Semantic → Procedural.
 * Ebbinghaus decay curve: S(t) = e^(-t/s) where s = strength.
 * Frequently accessed memories strengthen. Tier promotion on access count.
 * Token-budgeted injection for context window management.
 *
 * Tiers:
 * - Working: Current run observations (capacity: 50)
 * - Episodic: Recent run summaries (capacity: 200)
 * - Semantic: Extracted patterns/knowledge (capacity: 1000)
 * - Procedural: Learned skills/methods (capacity: 100)
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { logInternalError } from "../utils/internal-error.ts";

// ── Types ────────────────────────────────────────────────────────────────

export type MemoryTier = "working" | "episodic" | "semantic" | "procedural";

export interface Memory {
	id: string;
	tier: MemoryTier;
	content: string;
	strength: number;        // 0.0–1.0
	accessCount: number;
	lastAccessed: number;    // epoch ms
	createdAt: number;       // epoch ms
	tags: string[];
	sourceRunId?: string;
}

export interface MemoryConfig {
	workingCapacity: number;
	episodicCapacity: number;
	semanticCapacity: number;
	proceduralCapacity: number;
	decayRate: number;        // Ebbinghaus parameter (higher = faster decay)
	tokenBudget: number;      // max tokens to inject
}

const DEFAULT_CONFIG: MemoryConfig = {
	workingCapacity: 50,
	episodicCapacity: 200,
	semanticCapacity: 1000,
	proceduralCapacity: 100,
	decayRate: 0.001,         // slow decay
	tokenBudget: 2000,
};

const TIER_CAPACITIES: Record<MemoryTier, keyof MemoryConfig> = {
	working: "workingCapacity",
	episodic: "episodicCapacity",
	semantic: "semanticCapacity",
	procedural: "proceduralCapacity",
};

// ── Memory Operations ────────────────────────────────────────────────────

/**
 * Compute current strength using Ebbinghaus decay.
 * S(t) = strength * e^(-elapsed_ms * decayRate)
 */
export function computeCurrentStrength(memory: Memory, config = DEFAULT_CONFIG): number {
	const elapsedMs = Date.now() - memory.lastAccessed;
	return memory.strength * Math.exp(-elapsedMs * config.decayRate);
}

/**
 * Access a memory — strengthens it and updates access count.
 * After N accesses, memory may be promoted to a higher tier.
 */
export function accessMemory(memory: Memory): Memory {
	const newCount = memory.accessCount + 1;

	// Strengthen: capped at 1.0
	const newStrength = Math.min(1.0, memory.strength + 0.1);

	// Tier promotion thresholds
	let newTier = memory.tier;
	if (newCount >= 10 && memory.tier === "working") newTier = "episodic";
	if (newCount >= 20 && memory.tier === "episodic") newTier = "semantic";
	if (newCount >= 30 && memory.tier === "semantic") newTier = "procedural";

	return {
		...memory,
		strength: newStrength,
		accessCount: newCount,
		lastAccessed: Date.now(),
		tier: newTier,
	};
}

/**
 * Create a new working memory.
 */
export function createMemory(content: string, tags: string[] = [], sourceRunId?: string): Memory {
	return {
		id: `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
		tier: "working",
		content,
		strength: 0.5,
		accessCount: 0,
		lastAccessed: Date.now(),
		createdAt: Date.now(),
		tags,
		sourceRunId,
	};
}

// ── Memory Store ─────────────────────────────────────────────────────────

export class MemoryStore {
	private memories = new Map<string, Memory>();
	private config: MemoryConfig;
	private storePath?: string;

	constructor(config: Partial<MemoryConfig> = {}, storePath?: string) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.storePath = storePath;
		if (storePath && existsSync(storePath)) {
			this.load();
		}
	}

	/**
	 * Add a memory to the store, enforcing capacity limits.
	 */
	add(memory: Memory): void {
		// Evict weakest if at capacity
		const capacity = this.config[TIER_CAPACITIES[memory.tier]];
		const tierMemories = [...this.memories.values()].filter((m) => m.tier === memory.tier);

		if (tierMemories.length >= capacity) {
			// Evict weakest memory in this tier
			const weakest = tierMemories
				.map((m) => ({ id: m.id, strength: computeCurrentStrength(m, this.config) }))
				.sort((a, b) => a.strength - b.strength)[0];
			if (weakest) this.memories.delete(weakest.id);
		}

		this.memories.set(memory.id, memory);
	}

	/**
	 * Search memories by tags, returning strongest matches first.
	 */
	search(query: string, tags: string[] = [], limit = 10): Memory[] {
		const queryLower = query.toLowerCase();

		let results = [...this.memories.values()]
			// Apply decay
			.map((m) => ({ ...m, strength: computeCurrentStrength(m, this.config) }))
			// Filter by minimum strength
			.filter((m) => m.strength > 0.1)
			// Score relevance
			.map((m) => {
				let score = m.strength;
				if (m.content.toLowerCase().includes(queryLower)) score += 0.3;
				if (tags.some((t) => m.tags.includes(t))) score += 0.2;
				return { ...m, strength: score };
			})
			.sort((a, b) => b.strength - a.strength)
			.slice(0, limit);

		// Access side effect: strengthen returned memories
		results = results.map((m) => accessMemory(m));
		for (const m of results) {
			this.memories.set(m.id, m);
		}

		return results;
	}

	/**
	 * Inject memories into a prompt within a token budget.
	 * Returns formatted text block.
	 */
	inject(query: string, tags: string[] = []): string {
		const results = this.search(query, tags, 20);

		if (results.length === 0) return "";

		// Estimate tokens (4 chars ≈ 1 token)
		const budget = this.config.tokenBudget;
		let usedTokens = 0;
		const selected: Memory[] = [];

		for (const memory of results) {
			const tokens = Math.ceil(memory.content.length / 4);
			if (usedTokens + tokens > budget) break;
			selected.push(memory);
			usedTokens += tokens;
		}

		if (selected.length === 0) return "";

		return "## Relevant Context from Previous Runs\n\n" +
			selected.map((m) => `- [${m.tier}] ${m.content}`).join("\n") +
			"\n";
	}

	/**
	 * Get count of memories per tier.
	 */
	get stats(): Record<MemoryTier, number> {
		const counts: Record<MemoryTier, number> = { working: 0, episodic: 0, semantic: 0, procedural: 0 };
		for (const m of this.memories.values()) {
			counts[m.tier]++;
		}
		return counts;
	}

	/**
	 * Persist memories to disk.
	 */
	save(): void {
		if (!this.storePath) return;
		const entries = [...this.memories.values()];
		try {
			mkdirSync(path.dirname(this.storePath), { recursive: true });
			writeFileSync(this.storePath, JSON.stringify(entries, null, 2), "utf-8");
		} catch (error) {
			logInternalError("memory-store.save", error, `path=${this.storePath}`);
		}
	}

	private load(): void {
		if (!this.storePath) return;
		try {
			const data = JSON.parse(readFileSync(this.storePath, "utf-8")) as Memory[];
			for (const m of data) {
				this.memories.set(m.id, m);
			}
		} catch (error) {
			logInternalError("memory-store.load", error, `path=${this.storePath}`);
		}
	}
}

// Need path for mkdirSync in save()
import path from "node:path";
