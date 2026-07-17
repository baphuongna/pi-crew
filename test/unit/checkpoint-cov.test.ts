import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type Checkpoint,
	clearCheckpointStores,
	FileCheckpointStore,
	formatCheckpoint,
	getCheckpointStore,
} from "../../src/runtime/checkpoint.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
	return {
		runId: "run-cp-001",
		taskId: "task-01",
		step: 1,
		context: "Test context for checkpoint",
		progress: "50% complete",
		savedAt: Date.now(),
		agentId: "agent-001",
		agentModel: "claude-3.5",
		...overrides,
	};
}

// ── FileCheckpointStore.save / load ──

describe("FileCheckpointStore", () => {
	it("saves and loads a checkpoint", () => {
		const dir = createTrackedTempDir("pi-crew-cp-");
		try {
			const store = new FileCheckpointStore(dir);
			const cp = makeCheckpoint();
			store.save(cp);

			const loaded = store.load("run-cp-001", "task-01");
			assert.ok(loaded);
			assert.strictEqual(loaded.taskId, "task-01");
			assert.strictEqual(loaded.runId, "run-cp-001");
			assert.strictEqual(loaded.progress, "50% complete");
			assert.strictEqual(loaded.agentModel, "claude-3.5");
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("returns null when loading non-existent checkpoint", () => {
		const dir = createTrackedTempDir("pi-crew-cp-");
		try {
			const store = new FileCheckpointStore(dir);
			assert.strictEqual(store.load("run-no", "task-no"), null);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("returns null when runId does not match", () => {
		const dir = createTrackedTempDir("pi-crew-cp-");
		try {
			const store = new FileCheckpointStore(dir);
			store.save(makeCheckpoint({ runId: "run-A", taskId: "task-01" }));
			assert.strictEqual(store.load("run-B", "task-01"), null);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("deletes a checkpoint", () => {
		const dir = createTrackedTempDir("pi-crew-cp-");
		try {
			const store = new FileCheckpointStore(dir);
			store.save(makeCheckpoint({ runId: "run-del", taskId: "task-del" }));
			assert.ok(store.hasCheckpoint("run-del", "task-del"));
			store.delete("run-del", "task-del");
			assert.strictEqual(store.hasCheckpoint("run-del", "task-del"), false);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("delete is no-op for non-existent checkpoint", () => {
		const dir = createTrackedTempDir("pi-crew-cp-");
		try {
			const store = new FileCheckpointStore(dir);
			// Should not throw
			store.delete("run-no", "task-no");
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("lists checkpoints for a run", () => {
		const dir = createTrackedTempDir("pi-crew-cp-");
		try {
			const store = new FileCheckpointStore(dir);
			store.save(makeCheckpoint({ runId: "run-list", taskId: "task-a" }));
			store.save(makeCheckpoint({ runId: "run-list", taskId: "task-b" }));
			store.save(makeCheckpoint({ runId: "run-other", taskId: "task-c" }));

			const listed = store.list("run-list");
			assert.strictEqual(listed.length, 2);
			const ids = listed.map((c) => c.taskId).sort();
			assert.deepStrictEqual(ids, ["task-a", "task-b"]);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("hasCheckpoint returns boolean correctly", () => {
		const dir = createTrackedTempDir("pi-crew-cp-");
		try {
			const store = new FileCheckpointStore(dir);
			assert.strictEqual(store.hasCheckpoint("run-hc", "task-hc"), false);
			store.save(makeCheckpoint({ runId: "run-hc", taskId: "task-hc" }));
			assert.strictEqual(store.hasCheckpoint("run-hc", "task-hc"), true);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("save rejects path traversal in taskId", () => {
		const dir = createTrackedTempDir("pi-crew-cp-");
		try {
			const store = new FileCheckpointStore(dir);
			assert.throws(() => {
				store.save(makeCheckpoint({ taskId: "../../../etc/passwd" }));
			});
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("load rejects path traversal in taskId", () => {
		const dir = createTrackedTempDir("pi-crew-cp-");
		try {
			const store = new FileCheckpointStore(dir);
			assert.throws(() => {
				store.load("run-1", "../../../etc/passwd");
			});
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ── getCheckpointStore / clearCheckpointStores ──

describe("getCheckpointStore", () => {
	it("returns same store for same stateRoot", () => {
		clearCheckpointStores();
		const dir = createTrackedTempDir("pi-crew-cp-");
		try {
			const s1 = getCheckpointStore(dir);
			const s2 = getCheckpointStore(dir);
			assert.strictEqual(s1, s2);
		} finally {
			clearCheckpointStores();
			removeTrackedTempDir(dir);
		}
	});

	it("returns different stores for different roots", () => {
		clearCheckpointStores();
		const dir1 = createTrackedTempDir("pi-crew-cp-");
		const dir2 = createTrackedTempDir("pi-crew-cp-");
		try {
			const s1 = getCheckpointStore(dir1);
			const s2 = getCheckpointStore(dir2);
			assert.notStrictEqual(s1, s2);
		} finally {
			clearCheckpointStores();
			removeTrackedTempDir(dir1);
			removeTrackedTempDir(dir2);
		}
	});

	it("clearCheckpointStores resets cache", () => {
		clearCheckpointStores();
		const dir = createTrackedTempDir("pi-crew-cp-");
		try {
			const s1 = getCheckpointStore(dir);
			clearCheckpointStores();
			const s2 = getCheckpointStore(dir);
			assert.notStrictEqual(s1, s2);
		} finally {
			clearCheckpointStores();
			removeTrackedTempDir(dir);
		}
	});
});

// ── formatCheckpoint ──

describe("formatCheckpoint", () => {
	it("formats checkpoint with all fields", () => {
		const cp = makeCheckpoint();
		const text = formatCheckpoint(cp);
		assert.ok(text.includes("task-01"));
		assert.ok(text.includes("agent-001"));
		assert.ok(text.includes("claude-3.5"));
		assert.ok(text.includes("50% complete"));
		assert.ok(text.includes("Step:** 1"));
	});

	it("formats checkpoint without agentModel", () => {
		const cp = makeCheckpoint();
		cp.agentModel = undefined;
		const text = formatCheckpoint(cp);
		assert.ok(!text.includes("Model:"));
	});

	it("truncates long context to 300 chars", () => {
		const cp = makeCheckpoint({ context: "A".repeat(500) });
		const text = formatCheckpoint(cp);
		assert.ok(text.includes("..."));
		// The context part should end with ...
		const ctxLine = text.split("\n").find((l) => l.includes("Context:"));
		assert.ok(ctxLine);
		assert.ok(ctxLine!.includes("..."));
	});
});
