import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	FileCheckpointStore,
	formatAllCheckpoints,
	formatCheckpoint,
	getCheckpointStore,
	hasCheckpoint,
	listCheckpoints,
	loadCheckpoint,
	saveCheckpoint,
} from "../../src/runtime/recovery/checkpoint.ts";
import { projectCrewRoot } from "../../src/utils/paths.ts";

// Note: the module-level clearCheckpoint/clearCheckpointStores helpers were
// removed (Round 7 R7-3: 0 production callers). Tests now use per-test tmp
// dirs; delete-coverage runs through the LIVE store.delete() path.

function makeTmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "cp-test-"));
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

test("FileCheckpointStore: saves and loads checkpoint", () => {
	const tmp = makeTmp();
	try {
		const store = new FileCheckpointStore(tmp);

		store.save({
			runId: "test_run",
			taskId: "01_explore",
			step: 5,
			context: "Exploring codebase structure",
			progress: "Analyzing files...",
			savedAt: Date.now(),
			agentId: "explorer",
			agentModel: "minimax/MiniMax-M2.7",
		});

		const loaded = store.load("test_run", "01_explore");
		assert.ok(loaded !== null);
		assert.equal(loaded.taskId, "01_explore");
		assert.equal(loaded.step, 5);
		assert.equal(loaded.agentId, "explorer");

		store.delete("test_run", "01_explore");
		assert.ok(!store.hasCheckpoint("test_run", "01_explore"));
	} finally {
		cleanup(tmp);
	}
});

test("FileCheckpointStore: returns null for missing", () => {
	const tmp = makeTmp();
	try {
		const store = new FileCheckpointStore(tmp);
		const result = store.load("nonexistent", "nonexistent");
		assert.equal(result, null);
	} finally {
		cleanup(tmp);
	}
});

test("FileCheckpointStore: deletes checkpoint", () => {
	const tmp = makeTmp();
	try {
		const store = new FileCheckpointStore(tmp);

		store.save({
			runId: "test_del",
			taskId: "01",
			step: 1,
			context: "",
			progress: "",
			savedAt: Date.now(),
			agentId: "test",
		});
		assert.ok(store.hasCheckpoint("test_del", "01"));

		store.delete("test_del", "01");
		assert.ok(!store.hasCheckpoint("test_del", "01"));
	} finally {
		cleanup(tmp);
	}
});

test("FileCheckpointStore: delete is a no-op for missing checkpoint", () => {
	const tmp = makeTmp();
	try {
		const store = new FileCheckpointStore(tmp);
		// Should not throw
		store.delete("no_run", "no_task");
	} finally {
		cleanup(tmp);
	}
});

test("FileCheckpointStore: list returns all checkpoints for run", () => {
	const tmp = makeTmp();
	try {
		const store = new FileCheckpointStore(tmp);

		store.save({
			runId: "test_list",
			taskId: "tl_01",
			step: 1,
			context: "",
			progress: "t1",
			savedAt: Date.now(),
			agentId: "test",
		});
		store.save({
			runId: "test_list",
			taskId: "tl_02",
			step: 2,
			context: "",
			progress: "t2",
			savedAt: Date.now(),
			agentId: "test",
		});
		store.save({
			runId: "other_run",
			taskId: "or_01",
			step: 1,
			context: "",
			progress: "other",
			savedAt: Date.now(),
			agentId: "test",
		});

		const checkpoints = store.list("test_list");
		assert.equal(checkpoints.length, 2);

		store.delete("test_list", "tl_01");
		store.delete("test_list", "tl_02");
		store.delete("other_run", "or_01");
		assert.equal(store.list("test_list").length, 0);
	} finally {
		cleanup(tmp);
	}
});

test("FileCheckpointStore: wrong runId returns null", () => {
	const tmp = makeTmp();
	try {
		const store = new FileCheckpointStore(tmp);

		store.save({
			runId: "run_a",
			taskId: "01",
			step: 1,
			context: "",
			progress: "",
			savedAt: Date.now(),
			agentId: "test",
		});

		const loaded = store.load("run_b", "01");
		assert.equal(loaded, null);

		store.delete("run_a", "01");
	} finally {
		cleanup(tmp);
	}
});

test("getCheckpointStore: returns same store for same stateRoot", () => {
	const tmp = makeTmp();
	try {
		const store1 = getCheckpointStore(tmp);
		const store2 = getCheckpointStore(tmp);
		assert.strictEqual(store1, store2);
	} finally {
		cleanup(tmp);
	}
});

test("getCheckpointStore: returns different stores for different roots", () => {
	const tmp1 = makeTmp();
	const tmp2 = makeTmp();
	try {
		const store1 = getCheckpointStore(tmp1);
		const store2 = getCheckpointStore(tmp2);
		assert.notStrictEqual(store1, store2);
	} finally {
		cleanup(tmp1);
		cleanup(tmp2);
	}
});

test("saveCheckpoint + loadCheckpoint: using cwd-based path", () => {
	const tmp = makeTmp();
	try {
		// cwd passed explicitly to each call — no process.chdir (node:test runs
		// files concurrently; process.chdir mutates global state and corrupts
		// sibling test files like state-store.test.ts).
		saveCheckpoint("test_run", "01", 3, "context summary", "step 3/10", "explorer", "minimax/MiniMax-M2.7", tmp);

		const loaded = loadCheckpoint("test_run", "01", tmp);
		assert.ok(loaded !== null);
		assert.equal(loaded.taskId, "01");
		assert.equal(loaded.step, 3);

		// LIVE delete path: resolve the same state root the module helpers use
		const stateRoot = path.join(projectCrewRoot(tmp), "state", "runs", "test_run");
		const store = getCheckpointStore(stateRoot);
		store.delete("test_run", "01");
		assert.equal(loadCheckpoint("test_run", "01", tmp), null);
	} finally {
		cleanup(tmp);
	}
});

test("hasCheckpoint: returns true when exists", () => {
	const tmp = makeTmp();
	try {
		saveCheckpoint("has_cp", "01", 1, "ctx", "progress", "agent", undefined, tmp);
		assert.equal(hasCheckpoint("has_cp", "01", tmp), true);
		assert.equal(hasCheckpoint("has_cp", "02", tmp), false);
	} finally {
		cleanup(tmp);
	}
});

test("listCheckpoints: module-level list filters by run", () => {
	const tmp = makeTmp();
	try {
		saveCheckpoint("list_cp", "01", 1, "ctx", "p1", "agent", undefined, tmp);
		saveCheckpoint("list_cp", "02", 2, "ctx", "p2", "agent", undefined, tmp);
		saveCheckpoint("list_other", "03", 1, "ctx", "other", "agent", undefined, tmp);

		const listed = listCheckpoints("list_cp", tmp);
		assert.equal(listed.length, 2);
		assert.deepEqual(listed.map((cp) => cp.taskId).sort(), ["01", "02"]);

		// LIVE delete via the store under the resolved state root
		const stateRoot = path.join(projectCrewRoot(tmp), "state", "runs", "list_cp");
		const store = getCheckpointStore(stateRoot);
		store.delete("list_cp", "01");
		store.delete("list_cp", "02");
		assert.equal(listCheckpoints("list_cp", tmp).length, 0);
	} finally {
		cleanup(tmp);
	}
});

test("formatCheckpoint: produces markdown", () => {
	const formatted = formatCheckpoint({
		runId: "test",
		taskId: "01_explore",
		step: 5,
		context: "Exploring the codebase structure",
		progress: "Analyzing files...",
		savedAt: Date.now(),
		agentId: "explorer",
		agentModel: "minimax/MiniMax-M2.7",
	});

	assert.ok(formatted.includes("## Checkpoint: 01_explore"));
	assert.ok(formatted.includes("**Agent:** explorer"));
	assert.ok(formatted.includes("**Model:** minimax/MiniMax-M2.7"));
	assert.ok(formatted.includes("**Progress:** Analyzing files..."));
	assert.ok(formatted.includes("**Step:** 5"));
});

test("formatAllCheckpoints: shows all checkpoints", () => {
	const tmp = makeTmp();
	try {
		saveCheckpoint("format_all", "01", 1, "ctx", "step 1", "agent", undefined, tmp);
		saveCheckpoint("format_all", "02", 2, "ctx", "step 2", "agent", undefined, tmp);

		const formatted = formatAllCheckpoints("format_all", tmp);
		assert.ok(formatted.includes("# Checkpoints: format_all"));
		assert.ok(formatted.includes("01"));
		assert.ok(formatted.includes("02"));
	} finally {
		cleanup(tmp);
	}
});

test("formatAllCheckpoints: handles empty", () => {
	const formatted = formatAllCheckpoints("nonexistent_run");
	assert.ok(formatted.includes("No checkpoints found"));
});

test("saveCheckpoint: rejects path-traversal runId", () => {
	assert.throws(() => saveCheckpoint("../../../etc/passwd", "01", 1, "ctx", "progress", "agent"), /Invalid runId/);
});

test("saveCheckpoint: rejects path-traversal taskId", () => {
	assert.throws(() => saveCheckpoint("valid_run", "../../../etc/passwd", 1, "ctx", "progress", "agent"), /Invalid taskId/);
});

test("saveCheckpoint: rejects runId with slash", () => {
	assert.throws(() => saveCheckpoint("foo/bar", "01", 1, "ctx", "progress", "agent"), /Invalid runId/);
});

test("saveCheckpoint: rejects runId with backslash", () => {
	assert.throws(() => saveCheckpoint("foo\\bar", "01", 1, "ctx", "progress", "agent"), /Invalid runId/);
});

test("loadCheckpoint: rejects path-traversal runId", () => {
	assert.throws(() => loadCheckpoint("../etc/passwd", "01"), /Invalid runId/);
});

test("loadCheckpoint: rejects path-traversal taskId", () => {
	assert.throws(() => loadCheckpoint("valid_run", "../etc/passwd"), /Invalid taskId/);
});

test("hasCheckpoint: rejects path-traversal IDs", () => {
	assert.throws(() => hasCheckpoint("../etc/passwd", "01"), /Invalid runId/);
	assert.throws(() => hasCheckpoint("valid", "../etc/passwd"), /Invalid taskId/);
});

test("listCheckpoints: rejects path-traversal runId", () => {
	assert.throws(() => listCheckpoints("../etc/passwd"), /Invalid runId/);
});

test("FileCheckpointStore.save: rejects path-traversal taskId", () => {
	const dir = makeTmp();
	try {
		const store = new FileCheckpointStore(dir);
		assert.throws(
			() =>
				store.save({
					runId: "r1",
					taskId: "../etc/passwd",
					step: 1,
					context: "",
					progress: "",
					savedAt: 1,
					agentId: "a",
				}),
			/Invalid taskId/,
		);
	} finally {
		cleanup(dir);
	}
});

test("FileCheckpointStore.load: rejects path-traversal taskId", () => {
	const dir = makeTmp();
	try {
		const store = new FileCheckpointStore(dir);
		assert.throws(() => store.load("r1", "../etc/passwd"), /Invalid taskId/);
	} finally {
		cleanup(dir);
	}
});
