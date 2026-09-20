import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import {
	readFileCappedForSnapshot,
	SNAPSHOT_MAX_FILE_BYTES,
	shouldDiscardDirtyWorktree,
	snapshotDirtyWorktree,
	type WorktreeSnapshotResult,
} from "../../../src/worktree/worktree-manager.ts";

/**
 * RR-010 / F01 — snapshot completeness contract (pure parts).
 *
 * AC4: the discard decision is a pure, git-free predicate.
 * AC5: reading an untracked file for the snapshot is allocation-bounded.
 * AC6: a failed tracked diff makes the snapshot incomplete.
 */

function completeResult(): WorktreeSnapshotResult {
	return { complete: true, truncated: [], skipped: [] };
}

test("F01 AC4: shouldDiscardDirtyWorktree — incomplete snapshot blocks discard unless force", () => {
	const incomplete: WorktreeSnapshotResult = {
		complete: false,
		truncated: [{ path: "big.bin", originalSize: 307200 }],
		skipped: [],
	};
	assert.equal(shouldDiscardDirtyWorktree(incomplete, false), false, "incomplete + no force ⇒ preserve (AGENTS.md rule 40)");
	assert.equal(shouldDiscardDirtyWorktree(incomplete, true), true, "incomplete + explicit force ⇒ discard allowed");
	assert.equal(shouldDiscardDirtyWorktree(completeResult(), false), true, "complete snapshot ⇒ discard allowed without force");
});

test("F01 AC4: every incompleteness dimension blocks discard without force", () => {
	const cases: Array<{ name: string; result: WorktreeSnapshotResult }> = [
		{ name: "skipped entry", result: { complete: false, truncated: [], skipped: [{ path: "secret.txt", reason: "EACCES" }] } },
		{
			name: "tracked diff failure",
			result: { complete: false, truncated: [], skipped: [], trackedDiffError: "fatal: not a git repository" },
		},
		{ name: "artifact write failure", result: { complete: false, truncated: [], skipped: [], writeError: "ENOENT" } },
	];
	for (const { name, result } of cases) {
		assert.equal(shouldDiscardDirtyWorktree(result, false), false, `${name} must preserve without force`);
	}
	// Invariant: a complete result carries no incompleteness payload.
	const complete = completeResult();
	assert.equal(complete.truncated.length, 0);
	assert.equal(complete.skipped.length, 0);
	assert.equal(complete.trackedDiffError, undefined);
	assert.equal(complete.writeError, undefined);
});

test("F01 AC5: readFileCappedForSnapshot never reads/allocates more than the cap (64 MiB sparse file)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-f01-cap-"));
	try {
		const sparsePath = path.join(dir, "sparse-64m.bin");
		fs.writeFileSync(sparsePath, Buffer.alloc(0));
		fs.truncateSync(sparsePath, 64 * 1024 * 1024);
		assert.equal(fs.statSync(sparsePath).size, 64 * 1024 * 1024, "fixture precondition: sparse 64 MiB file");

		const { data, originalSize, truncated } = readFileCappedForSnapshot(sparsePath, SNAPSHOT_MAX_FILE_BYTES);
		assert.equal(originalSize, 64 * 1024 * 1024, "originalSize must report the on-disk size");
		assert.ok(
			data.byteLength <= SNAPSHOT_MAX_FILE_BYTES,
			`read must be capped at ${SNAPSHOT_MAX_FILE_BYTES} bytes, got ${data.byteLength}`,
		);
		assert.equal(data.byteLength, SNAPSHOT_MAX_FILE_BYTES, "the capped read should fill up to exactly the cap for a larger file");
		assert.equal(truncated, true, "over-cap file must be flagged truncated");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("F01 AC5: readFileCappedForSnapshot reads small files fully and does not flag truncation", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-f01-small-"));
	try {
		const smallPath = path.join(dir, "small.txt");
		const payload = Buffer.from("small file payload\n", "utf-8");
		fs.writeFileSync(smallPath, payload);

		const { data, originalSize, truncated } = readFileCappedForSnapshot(smallPath, SNAPSHOT_MAX_FILE_BYTES);
		assert.equal(originalSize, payload.byteLength);
		assert.ok(data.equals(payload), "small file must be read fully, byte-identical");
		assert.equal(truncated, false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("F01 AC6: failed tracked-diff capture makes the snapshot incomplete (empty ≠ failed)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-f01-diff-"));
	const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-f01-diffart-"));
	try {
		// NOT a git repository: `git diff HEAD --binary` inside snapshotDirtyWorktree
		// must fail while the small untracked file is still fully capturable.
		const smallPath = path.join(dir, "small.txt");
		fs.writeFileSync(smallPath, "recoverable content\n", "utf-8");

		const manifest = {
			schemaVersion: 1,
			runId: "f01-diff-run",
			team: "test-team",
			workflow: "test-workflow",
			goal: "F01 AC6",
			status: "running" as const,
			workspaceMode: "worktree" as const,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			cwd: dir,
			stateRoot: dir,
			artifactsRoot,
			tasksPath: path.join(dir, "tasks.json"),
			eventsPath: path.join(dir, "events.jsonl"),
			artifacts: [],
		} satisfies TeamRunManifest;
		const task = {
			id: "f01-diff-task",
			runId: "f01-diff-run",
			role: "explorer",
			agent: "explorer",
			title: "F01 AC6 task",
			status: "waiting" as const,
			dependsOn: [],
			cwd: dir,
		} satisfies TeamTaskState;

		const result = snapshotDirtyWorktree(manifest, task, dir, "?? small.txt\n");

		assert.equal(result.complete, false, "failed tracked diff must make the snapshot incomplete");
		assert.ok(
			result.trackedDiffError !== undefined && result.trackedDiffError.length > 0,
			"trackedDiffError must carry the git failure reason",
		);
		assert.deepEqual(result.truncated, []);
		assert.deepEqual(result.skipped, [], "the readable small file must still be captured, not skipped");
		assert.equal(shouldDiscardDirtyWorktree(result, false), false, "diff failure must block discard without force");
		assert.equal(shouldDiscardDirtyWorktree(result, true), true, "force must override the diff failure");
		assert.ok(result.writeError === undefined, "artifact write must still succeed");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(artifactsRoot, { recursive: true, force: true });
	}
});
