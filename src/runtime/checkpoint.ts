import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../state/atomic-write.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { projectCrewRoot } from "../utils/paths.ts";
import { assertSafePathId } from "../utils/safe-paths.ts";

export interface Checkpoint {
	runId: string;
	taskId: string;
	step: number;
	context: string;
	progress: string;
	savedAt: number;
	agentId: string;
	agentModel?: string;
}

export interface CheckpointStore {
	save(checkpoint: Checkpoint): void;
	load(runId: string, taskId: string): Checkpoint | null;
	delete(runId: string, taskId: string): void;
	list(runId: string): Checkpoint[];
	hasCheckpoint(runId: string, taskId: string): boolean;
}

interface CheckpointEntry {
	checkpoints: Record<string, Checkpoint>;
}

/**
 * File-based checkpoint store.
 * Saves checkpoints as JSON files in .crew/state/runs/<runId>/checkpoints/
 */
export class FileCheckpointStore implements CheckpointStore {
	private readonly stateRoot: string;

	constructor(stateRoot: string) {
		this.stateRoot = stateRoot;
	}

	private checkpointDir(): string {
		return path.join(this.stateRoot, "checkpoints");
	}

	private checkpointPath(taskId: string): string {
		return path.join(this.checkpointDir(), `${taskId}.json`);
	}

	private ensureDir(): void {
		const dir = this.checkpointDir();
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	save(checkpoint: Checkpoint): void {
		// Validate taskId to prevent path traversal: the taskId is used to
		// build a file path under this.checkpointDir(). Without validation, a
		// malicious or buggy taskId like "../../../etc/passwd" could escape
		// the checkpoints directory.
		assertSafePathId("taskId", checkpoint.taskId);
		this.ensureDir();
		const p = this.checkpointPath(checkpoint.taskId);
		// Atomic write: write to temp file first, then rename, then fsync parent.
		// This guarantees either the old file or the new file, never a partial
		// write, even on network filesystems or certain journal modes.
		//
		// Round 22 (BUG 1): the temp filename MUST be unique per save call.
		// Previously a fixed '.tmp.checkpoint' was shared across ALL concurrent
		// saves; pi-crew's multi-process architecture (main + detached background
		// workers each checkpointing their own tasks) made this realistic: two
		// processes writing '.tmp.checkpoint' at once → one's rename picks up the
		// other's data (silent corruption) and the second rename hits ENOENT
		// (silent data loss). Including taskId + pid + timestamp guarantees
		// uniqueness across processes and across tasks.
		// atomicWriteFile handles temp + write + fsync(data) + rename + fsync(parent)
		// with a UUID-based unique temp name (cross-process safe). The previous
		// hand-rolled version missed data-fsync (ST-5), risking empty/stale content
		// after power loss.
		atomicWriteFile(p, JSON.stringify(checkpoint, null, 2));
	}

	load(runId: string, taskId: string): Checkpoint | null {
		assertSafePathId("taskId", taskId);
		const p = this.checkpointPath(taskId);
		if (!fs.existsSync(p)) return null;

		try {
			const data = JSON.parse(fs.readFileSync(p, "utf-8")) as Checkpoint;
			// Verify it's for the correct run
			if (data.runId !== runId) return null;
			return data;
		} catch {
			// File existed but JSON was corrupt — log and rename for later inspection
			logInternalError("checkpoint-load", new Error("JSON parse failed"), `file=${p}`);
			try {
				fs.renameSync(p, `${p}.corrupt.${Date.now()}`);
			} catch {
				// Best effort — ignore rename failure
			}
			return null;
		}
	}

	delete(runId: string, taskId: string): void {
		assertSafePathId("taskId", taskId);
		const p = this.checkpointPath(taskId);
		if (fs.existsSync(p)) {
			try {
				const data = JSON.parse(fs.readFileSync(p, "utf-8")) as Checkpoint;
				if (data.runId === runId) {
					fs.unlinkSync(p);
				}
			} catch {
				// File existed but couldn't read — delete it anyway
				try {
					fs.unlinkSync(p);
				} catch {
					/* ignore */
				}
			}
		}
	}

	list(runId: string): Checkpoint[] {
		const dir = this.checkpointDir();
		if (!fs.existsSync(dir)) return [];

		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				try {
					return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as Checkpoint;
				} catch {
					return null;
				}
			})
			.filter((c): c is Checkpoint => c !== null && c.runId === runId);
	}

	hasCheckpoint(runId: string, taskId: string): boolean {
		return this.load(runId, taskId) !== null;
	}
}

const MAX_STORES = 100;
const _stores = new Map<string, FileCheckpointStore>();

/**
 * Get checkpoint store for a run's state root.
 * Uses LRU eviction when the store exceeds MAX_STORES entries.
 */
export function getCheckpointStore(stateRoot: string): CheckpointStore {
	if (!_stores.has(stateRoot)) {
		if (_stores.size >= MAX_STORES) {
			// Evict the oldest entry (first in insertion order)
			const oldestKey = _stores.keys().next().value;
			if (oldestKey !== undefined) {
				_stores.delete(oldestKey);
			}
		}
		_stores.set(stateRoot, new FileCheckpointStore(stateRoot));
	}
	return _stores.get(stateRoot)!;
}

/**
 * Clear all checkpoint stores (for testing).
 */
export function clearCheckpointStores(): void {
	_stores.clear();
}

/**
 * Save a checkpoint during agent execution.
 */
export function saveCheckpoint(
	runId: string,
	taskId: string,
	step: number,
	context: string,
	progress: string,
	agentId: string,
	agentModel?: string,
	cwd?: string,
): void {
	// Validate both runId and taskId to prevent path traversal: these are
	// used to build the file path under <crewRoot>/state/runs/<runId>/checkpoints/<taskId>.json.
	assertSafePathId("runId", runId);
	assertSafePathId("taskId", taskId);
	const checkpoint: Checkpoint = {
		runId,
		taskId,
		step,
		context,
		progress,
		savedAt: Date.now(),
		agentId,
		agentModel,
	};

	// State root is parent of checkpoints dir. Use projectCrewRoot() so the
	// path lands in .pi/teams/state/runs/ for .pi-based projects (issue #29).
	const stateRoot = path.join(projectCrewRoot(cwd ?? process.cwd()), "state", "runs", runId);
	const store = getCheckpointStore(stateRoot);
	store.save(checkpoint);
}

/**
 * Load a checkpoint for resuming.
 */
export function loadCheckpoint(runId: string, taskId: string, cwd?: string): Checkpoint | null {
	assertSafePathId("runId", runId);
	assertSafePathId("taskId", taskId);
	const stateRoot = path.join(projectCrewRoot(cwd ?? process.cwd()), "state", "runs", runId);
	const store = getCheckpointStore(stateRoot);
	return store.load(runId, taskId);
}

/**
 * Delete a checkpoint after successful completion.
 */
export function clearCheckpoint(runId: string, taskId: string, cwd?: string): void {
	assertSafePathId("runId", runId);
	assertSafePathId("taskId", taskId);
	const stateRoot = path.join(projectCrewRoot(cwd ?? process.cwd()), "state", "runs", runId);
	const store = getCheckpointStore(stateRoot);
	store.delete(runId, taskId);
}

/**
 * Check if a checkpoint exists for a task.
 */
export function hasCheckpoint(runId: string, taskId: string, cwd?: string): boolean {
	assertSafePathId("runId", runId);
	assertSafePathId("taskId", taskId);
	const stateRoot = path.join(projectCrewRoot(cwd ?? process.cwd()), "state", "runs", runId);
	const store = getCheckpointStore(stateRoot);
	return store.hasCheckpoint(runId, taskId);
}

/**
 * List all checkpoints for a run.
 */
export function listCheckpoints(runId: string, cwd?: string): Checkpoint[] {
	assertSafePathId("runId", runId);
	const stateRoot = path.join(projectCrewRoot(cwd ?? process.cwd()), "state", "runs", runId);
	const store = getCheckpointStore(stateRoot);
	return store.list(runId);
}

/**
 * Format a checkpoint for display.
 */
export function formatCheckpoint(checkpoint: Checkpoint): string {
	return [
		`## Checkpoint: ${checkpoint.taskId}`,
		"",
		`**Agent:** ${checkpoint.agentId}`,
		checkpoint.agentModel ? `**Model:** ${checkpoint.agentModel}` : "",
		"",
		`**Progress:** ${checkpoint.progress}`,
		"",
		`**Step:** ${checkpoint.step}`,
		`**Saved:** ${new Date(checkpoint.savedAt).toISOString()}`,
		"",
		`**Context:** ${checkpoint.context.slice(0, 300)}${checkpoint.context.length > 300 ? "..." : ""}`,
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * Format all checkpoints for a run.
 */
export function formatAllCheckpoints(runId: string, cwd?: string): string {
	const checkpoints = listCheckpoints(runId, cwd);
	if (checkpoints.length === 0) {
		return `No checkpoints found for run ${runId}`;
	}

	return [
		`# Checkpoints: ${runId}`,
		"",
		...checkpoints.map((cp, i) => `${i + 1}. **${cp.taskId}** — ${cp.progress} (${new Date(cp.savedAt).toLocaleString()})`),
		"",
		`Use \`team action='resume' runId=${runId} taskId=<taskId>\` to resume.`,
	].join("\n");
}
