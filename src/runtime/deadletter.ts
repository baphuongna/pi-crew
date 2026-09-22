import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { projectCrewRoot } from "../utils/paths.ts";

export type DeadletterReason = "max-retries" | "heartbeat-dead" | "manual";

export interface DeadletterEntry {
	taskId: string;
	runId: string;
	reason: DeadletterReason;
	attempts: number;
	lastError?: string;
	attemptId?: string;
	timestamp: string;
	/** US-003 (2026-09-22): richer schema so the entry is self-sufficient for
	 * post-mortem AFTER the run dir is pruned (the project-level index below is
	 * the record that survives; the run-local file dies with the run dir). */
	agent?: string;
	role?: string;
	/** Model-fallback attempt count at give-up time. */
	modelAttempts?: number;
	/** Run manifest status at the time of the write. */
	runStatus?: string;
}

export function deadletterPath(manifest: TeamRunManifest): string {
	return path.join(manifest.stateRoot, "deadletter.jsonl");
}

/**
 * US-003: project-level dead-letter index, `<projectRoot>/.crew/state/deadletter/<runId>.jsonl`.
 * Lives OUTSIDE any run dir, so per-run auto-prune (DP-01 keep=10) cannot delete it —
 * this is the durable out-of-band record for post-mortem analysis.
 */
export function deadletterIndexPath(manifest: TeamRunManifest): string {
	return path.join(projectCrewRoot(manifest.cwd), "state", "deadletter", `${manifest.runId}.jsonl`);
}

export function appendDeadletter(manifest: TeamRunManifest, entry: DeadletterEntry): void {
	try {
		fs.mkdirSync(manifest.stateRoot, { recursive: true });
		fs.appendFileSync(deadletterPath(manifest), `${JSON.stringify(entry)}\n`, "utf-8");
	} catch (error) {
		logInternalError("deadletter.append", error, `taskId=${entry.taskId}`);
	}
	// US-003: project-level index (survives run pruning). Best-effort AFTER the
	// run-local record — appendDeadletter must never throw into the retry path.
	// Honest deviation from the spec's "atomically (both or neither)" wording:
	// cross-file atomicity without a journal is not physically possible; the
	// contract is "both on success, never a caller-visible failure", with each
	// failure logged via logInternalError.
	try {
		const indexPath = deadletterIndexPath(manifest);
		fs.mkdirSync(path.dirname(indexPath), { recursive: true });
		fs.appendFileSync(indexPath, `${JSON.stringify({ ...entry, runStatus: entry.runStatus ?? manifest.status })}\n`, "utf-8");
	} catch (error) {
		logInternalError("deadletter.index-append", error, `taskId=${entry.taskId}`);
	}
}

export function readDeadletter(manifest: TeamRunManifest, maxEntries = 1000): DeadletterEntry[] {
	const filePath = deadletterPath(manifest);
	if (!fs.existsSync(filePath)) return [];
	// Read last maxEntries lines only to limit memory.
	const raw = fs.readFileSync(filePath, "utf-8");
	const lines = raw.split(/\r?\n/).filter(Boolean);
	const tail = lines.slice(-maxEntries);
	return tail.flatMap((line) => {
		try {
			const parsed = JSON.parse(line) as DeadletterEntry;
			return parsed && typeof parsed.taskId === "string" && typeof parsed.runId === "string" ? [parsed] : [];
		} catch {
			return [];
		}
	});
}

/**
 * US-003 AC-3: `handleStatus` surfacing — a Deadletter line, only when entries
 * exist (silent otherwise; a zero line would be noise on every healthy run).
 */
export function deadletterStatusLine(manifest: TeamRunManifest): string | undefined {
	const entries = readDeadletter(manifest);
	if (!entries.length) return undefined;
	const reasons = [...new Set(entries.map((entry) => entry.reason))].join(", ");
	return `Deadletter: ${entries.length} (${reasons}) — ${deadletterPath(manifest)}`;
}
