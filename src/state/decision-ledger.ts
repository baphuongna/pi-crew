import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface CoherenceMark {
	matchesPrior: boolean;
	matchesRecursive: boolean;
	promotionAllowed: boolean;
	reason: string;
}

export interface RolloutEntry {
	rolloutId: string;
	timestamp: string;
	priorWinner?: string;
	searchSpace: string;
	trialCount: number;
	topCandidates: string[];
	decisionMark: "accept" | "watch" | "reject" | "decay";
	coherenceMark: CoherenceMark;
}

/**
 * Get the ledger file path for a given run ID.
 */
function getLedgerPath(runId: string): string {
	return `.crew/state/runs/${runId}/decision-ledger.jsonl`;
}

/**
 * Compute coherence marks based on existing ledger entries.
 */
function computeCoherence(entry: RolloutEntry, ledger: RolloutEntry[]): CoherenceMark {
	if (ledger.length === 0) {
		return {
			matchesPrior: false,
			matchesRecursive: false,
			promotionAllowed: true,
			reason: "No prior entries - first rollout, promotion allowed",
		};
	}

	const previousEntry = ledger[ledger.length - 1];
	const matchesPrior: boolean =
		entry.decisionMark === previousEntry.decisionMark ||
		Boolean(entry.priorWinner && entry.topCandidates.includes(entry.priorWinner));

	// Check last 3 entries for recursive pattern
	const recentEntries = ledger.slice(-3);
	const recentDecisions = recentEntries.map((e) => e.decisionMark);
	const currentDecision = entry.decisionMark;

	const recursiveMatches = recentDecisions.filter((d) => d === currentDecision).length;
	const matchesRecursive = recursiveMatches >= 2;

	const promotionAllowed = matchesPrior || matchesRecursive;

	let reason: string;
	if (matchesPrior && matchesRecursive) {
		reason = `Matches prior winner and recursive pattern (${recursiveMatches}/3 recent decisions)`;
	} else if (matchesPrior) {
		reason = `Matches prior winner decision`;
	} else if (matchesRecursive) {
		reason = `Matches recursive pattern (${recursiveMatches}/3 recent decisions)`;
	} else {
		reason = `No match with prior or recursive pattern - requires human review`;
	}

	return {
		matchesPrior,
		matchesRecursive,
		promotionAllowed,
		reason,
	};
}

/**
 * Initialize a new decision ledger for a run.
 * Creates the directory and ledger file if they don't exist.
 */
export function initLedger(runId: string): void {
	const ledgerPath = getLedgerPath(runId);
	const dir = dirname(ledgerPath);

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	// Create empty file if it doesn't exist
	if (!existsSync(ledgerPath)) {
		writeFileSync(ledgerPath, "", "utf-8");
	}
}

/**
 * Append a new entry to the decision ledger.
 * Automatically computes and adds coherence marks.
 */
export function appendEntry(runId: string, entry: RolloutEntry): RolloutEntry {
	const ledgerPath = getLedgerPath(runId);

	// Ensure directory exists
	const dir = dirname(ledgerPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	// Get existing entries to compute coherence
	const ledger = getLedger(runId);

	// Compute coherence
	const coherenceMark = computeCoherence(entry, ledger);
	const entryWithCoherence: RolloutEntry = {
		...entry,
		coherenceMark,
	};

	// Append to JSONL file
	const line = JSON.stringify(entryWithCoherence) + "\n";
	writeFileSync(ledgerPath, line, { flag: "a", encoding: "utf-8" });
	return entryWithCoherence;
}

/**
 * Read all entries from the decision ledger.
 */
export function getLedger(runId: string): RolloutEntry[] {
	const ledgerPath = getLedgerPath(runId);

	if (!existsSync(ledgerPath)) {
		return [];
	}

	const content = readFileSync(ledgerPath, "utf-8");
	if (!content.trim()) {
		return [];
	}

	return content
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as RolloutEntry);
}

/**
 * Get the most recent entry from the decision ledger.
 */
export function getLatestDecision(runId: string): RolloutEntry | null {
	const ledger = getLedger(runId);
	if (ledger.length === 0) {
		return null;
	}
	return ledger[ledger.length - 1];
}

/**
 * Generate a human-readable markdown summary of the ledger.
 */
export function summarizeLedger(runId: string): string {
	const ledger = getLedger(runId);

	if (ledger.length === 0) {
		return "# Decision Ledger Summary\n\n*No entries recorded yet.*";
	}

	const lines: string[] = [
		"# Decision Ledger Summary",
		"",
		`Run ID: ${runId}`,
		`Total Entries: ${ledger.length}`,
		"",
		"## Entries",
		"",
	];

	for (let i = 0; i < ledger.length; i++) {
		const entry = ledger[i];
		lines.push(`### ${i + 1}. ${entry.rolloutId}`);
		lines.push("");
		lines.push(`- **Timestamp**: ${entry.timestamp}`);
		lines.push(`- **Search Space**: ${entry.searchSpace}`);
		lines.push(`- **Trial Count**: ${entry.trialCount}`);
		lines.push(`- **Decision**: ${entry.decisionMark}`);

		if (entry.priorWinner) {
			lines.push(`- **Prior Winner**: ${entry.priorWinner}`);
		}

		lines.push(`- **Top Candidates**: ${entry.topCandidates.join(", ") || "(none)"}`);
		lines.push("");
		lines.push("#### Coherence");
		lines.push(`- **Matches Prior**: ${entry.coherenceMark.matchesPrior ? "✓" : "✗"}`);
		lines.push(`- **Matches Recursive**: ${entry.coherenceMark.matchesRecursive ? "✓" : "✗"}`);
		lines.push(`- **Promotion Allowed**: ${entry.coherenceMark.promotionAllowed ? "✓" : "✗"}`);
		lines.push(`- **Reason**: ${entry.coherenceMark.reason}`);
		lines.push("");
	}

	// Summary statistics
	const decisions = ledger.map((e) => e.decisionMark);
	const acceptCount = decisions.filter((d) => d === "accept").length;
	const watchCount = decisions.filter((d) => d === "watch").length;
	const rejectCount = decisions.filter((d) => d === "reject").length;
	const decayCount = decisions.filter((d) => d === "decay").length;

	lines.push("## Summary");
	lines.push("");
	lines.push(`| Decision | Count |`);
	lines.push(`|----------|-------|`);
	lines.push(`| Accept   | ${acceptCount} |`);
	lines.push(`| Watch    | ${watchCount} |`);
	lines.push(`| Reject   | ${rejectCount} |`);
	lines.push(`| Decay    | ${decayCount} |`);
	lines.push("");

	const promotedCount = ledger.filter((e) => e.coherenceMark.promotionAllowed).length;
	lines.push(`**Promotion Rate**: ${promotedCount}/${ledger.length} (${((promotedCount / ledger.length) * 100).toFixed(1)}%)`);

	return lines.join("\n");
}

/**
 * Override the coherence mark of the last entry in the ledger.
 * FIX: This preserves all previous entries while updating just the last one.
 * Previously this would truncate the entire ledger!
 */
function overrideLastEntry(runId: string, coherenceMark: import("./types.js").CoherenceMark): RolloutEntry {
	const ledger = getLedger(runId);
	if (ledger.length === 0) {
		throw new Error(`No ledger entries found for run ${runId}`);
	}
	// Update the last entry with the new coherence mark
	const lastIndex = ledger.length - 1;
	ledger[lastIndex] = { ...ledger[lastIndex], coherenceMark };
	// Rewrite entire ledger to preserve all entries
	const ledgerPath = getLedgerPath(runId);
	writeFileSync(ledgerPath, ledger.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
	return ledger[lastIndex];
}

/**
 * Promote a candidate by marking it as accepted with proper coherence.
 */
export function promoteCandidate(runId: string, candidate: string): RolloutEntry {
	const latestDecision = getLatestDecision(runId);

	// Get existing entries to compute proper coherence
	const ledger = getLedger(runId);

	// Create entry without coherence first
	const entryWithoutCoherence = {
		rolloutId: `promote-${Date.now()}`,
		timestamp: new Date().toISOString(),
		priorWinner: latestDecision?.topCandidates[0],
		searchSpace: latestDecision?.searchSpace || "unknown",
		trialCount: (latestDecision?.trialCount || 0) + 1,
		topCandidates: [candidate],
		decisionMark: "accept" as const,
	};

	// Compute coherence (empty ledger = no matches)
	const coherenceMark = computeCoherence(entryWithoutCoherence as RolloutEntry, ledger);

	// Manual promotion always allows further promotion
	coherenceMark.promotionAllowed = true;
	coherenceMark.reason = "Manual promotion - promotion allowed";

	// Create full entry with coherence
	const entry: RolloutEntry = {
		...entryWithoutCoherence,
		coherenceMark,
	};

	// Update last entry in memory if there are existing entries
	if (ledger.length > 0) {
		const lastIndex = ledger.length - 1;
		ledger[lastIndex] = entry;
	} else {
		// No existing entries - just write this one
		ledger.push(entry);
	}

	// Rewrite entire ledger to preserve all entries
	const ledgerPath = getLedgerPath(runId);
	const dir = dirname(ledgerPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(ledgerPath, ledger.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

	return entry;
}

/**
 * Decay a candidate by marking it as decayed with proper coherence.
 */
export function decayCandidate(runId: string, candidate: string): RolloutEntry {
	const latestDecision = getLatestDecision(runId);

	// Get existing entries to compute proper coherence
	const ledger = getLedger(runId);

	// Create entry without coherence first
	const entryWithoutCoherence = {
		rolloutId: `decay-${Date.now()}`,
		timestamp: new Date().toISOString(),
		priorWinner: latestDecision?.topCandidates[0],
		searchSpace: latestDecision?.searchSpace || "unknown",
		trialCount: (latestDecision?.trialCount || 0) + 1,
		topCandidates: [candidate],
		decisionMark: "decay" as const,
	};

	// Compute coherence (empty ledger = no matches)
	const coherenceMark = computeCoherence(entryWithoutCoherence as RolloutEntry, ledger);

	// Manual decay never allows promotion
	coherenceMark.promotionAllowed = false;
	coherenceMark.reason = "Manual decay - promotion not allowed";

	// Create full entry with coherence
	const entry: RolloutEntry = {
		...entryWithoutCoherence,
		coherenceMark,
	};

	// Update last entry in memory if there are existing entries
	if (ledger.length > 0) {
		const lastIndex = ledger.length - 1;
		ledger[lastIndex] = entry;
	} else {
		// No existing entries - just write this one
		ledger.push(entry);
	}

	// Rewrite entire ledger to preserve all entries
	const ledgerPath = getLedgerPath(runId);
	const dir = dirname(ledgerPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(ledgerPath, ledger.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

	return entry;
}