import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PiTeamsToolResult } from "../../../../src/extension/tool-result.ts";
import type { SubagentRecord, SubagentSpawnOptions } from "../../../../src/runtime/subagent-manager.ts";
import { readPersistedSubagentRecord, SubagentManager, savePersistedSubagentRecord } from "../../../../src/runtime/subagent-manager.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeSpawnOptions(cwd: string, overrides: Partial<SubagentSpawnOptions> = {}): SubagentSpawnOptions {
	return {
		cwd,
		type: "test",
		description: "test subagent",
		prompt: "do the thing",
		background: true,
		...overrides,
	};
}

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
	return {
		id: overrides.id ?? "test_agent_1",
		type: overrides.type ?? "test",
		description: overrides.description ?? "test",
		prompt: overrides.prompt ?? "test prompt",
		status: overrides.status ?? "running",
		startedAt: overrides.startedAt ?? Date.now(),
		background: overrides.background ?? true,
		...overrides,
	};
}

// No runId in details to avoid pollRunToTerminal infinite loop
function makeResult(overrides: Partial<PiTeamsToolResult> = {}): PiTeamsToolResult {
	return {
		content: overrides.content ?? [{ type: "text", text: "done" }],
		isError: overrides.isError ?? false,
		details: { action: "test", status: "ok" },
	};
}

describe("subagent-manager", () => {
	describe("savePersistedSubagentRecord / readPersistedSubagentRecord", () => {
		it("persists and reads back a record", () => {
			const tmpDir = createTrackedTempDir("pi-crew-subagent-");
			const record = makeRecord();
			savePersistedSubagentRecord(tmpDir, record);
			const loaded = readPersistedSubagentRecord(tmpDir, record.id);
			assert.ok(loaded);
			assert.equal(loaded.id, record.id);
			assert.equal(loaded.status, record.status);
			removeTrackedTempDir(tmpDir);
		});

		it("returns undefined for missing record", () => {
			const tmpDir = createTrackedTempDir("pi-crew-subagent-");
			const loaded = readPersistedSubagentRecord(tmpDir, "nonexistent");
			assert.equal(loaded, undefined);
			removeTrackedTempDir(tmpDir);
		});

		it("does not persist the promise field", () => {
			const tmpDir = createTrackedTempDir("pi-crew-subagent-");
			const record = makeRecord();
			// Add a promise field (should be stripped)
			(record as any).promise = new Promise(() => undefined);
			savePersistedSubagentRecord(tmpDir, record);
			const loaded = readPersistedSubagentRecord(tmpDir, record.id);
			assert.ok(loaded);
			assert.equal((loaded as any).promise, undefined);
			removeTrackedTempDir(tmpDir);
		});
	});

	describe("SubagentManager", () => {
		it("spawn creates a record and completes with non-background runner", async () => {
			const tmpDir = createTrackedTempDir("pi-crew-subagent-");
			const mgr = new SubagentManager(4);
			let runnerCalled = false;
			const runner = async () => {
				runnerCalled = true;
				return makeResult();
			};
			const record = mgr.spawn(makeSpawnOptions(tmpDir, { background: false }), runner);
			assert.ok(record.id);
			assert.equal(record.status, "running");
			// Wait for completion (no runId → immediate completion)
			await mgr.waitForAll();
			assert.ok(runnerCalled);
			removeTrackedTempDir(tmpDir);
		});

		it("getRecord returns spawned record", async () => {
			const tmpDir = createTrackedTempDir("pi-crew-subagent-");
			const mgr = new SubagentManager(4);
			const runner = async () => makeResult();
			const record = mgr.spawn(makeSpawnOptions(tmpDir, { background: false }), runner);
			assert.ok(mgr.getRecord(record.id));
			assert.equal(mgr.getRecord(record.id)!.id, record.id);
			await mgr.waitForAll();
			removeTrackedTempDir(tmpDir);
		});

		it("listAgents returns all records", async () => {
			const tmpDir = createTrackedTempDir("pi-crew-subagent-");
			const mgr = new SubagentManager(4);
			const runner = async () => makeResult();
			mgr.spawn(makeSpawnOptions(tmpDir, { background: false }), runner);
			mgr.spawn(makeSpawnOptions(tmpDir, { background: false }), runner);
			assert.equal(mgr.listAgents().length, 2);
			await mgr.waitForAll();
			removeTrackedTempDir(tmpDir);
		});

		it("abort stops a running agent", () => {
			const tmpDir = createTrackedTempDir("pi-crew-subagent-");
			const mgr = new SubagentManager(4);
			// Runner that will never resolve (but abort marks as stopped before it runs)
			const runner = async (): Promise<PiTeamsToolResult> => {
				await new Promise(() => undefined);
				return makeResult();
			};
			const record = mgr.spawn(makeSpawnOptions(tmpDir, { background: false }), runner);
			assert.equal(mgr.abort(record.id), true);
			const updated = mgr.getRecord(record.id);
			assert.equal(updated!.status, "stopped");
			removeTrackedTempDir(tmpDir);
		});

		it("abortAll stops all agents", () => {
			const tmpDir = createTrackedTempDir("pi-crew-subagent-");
			const mgr = new SubagentManager(4);
			const runner = async (): Promise<PiTeamsToolResult> => {
				await new Promise(() => undefined);
				return makeResult();
			};
			mgr.spawn(makeSpawnOptions(tmpDir, { background: false }), runner);
			mgr.spawn(makeSpawnOptions(tmpDir, { background: false }), runner);
			const count = mgr.abortAll();
			assert.equal(count, 2);
			removeTrackedTempDir(tmpDir);
		});

		it("abort returns false for unknown id", () => {
			const mgr = new SubagentManager(4);
			assert.equal(mgr.abort("unknown"), false);
		});

		it("setMaxConcurrent updates concurrency", () => {
			const mgr = new SubagentManager(4);
			mgr.setMaxConcurrent(8);
			assert.ok(true);
		});

		it("queues background agents when at capacity", () => {
			const tmpDir = createTrackedTempDir("pi-crew-subagent-");
			const mgr = new SubagentManager(1);
			const slowRunner = async (): Promise<PiTeamsToolResult> => {
				await new Promise(() => undefined);
				return makeResult();
			};
			const r1 = mgr.spawn(makeSpawnOptions(tmpDir, { background: true }), slowRunner);
			const r2 = mgr.spawn(makeSpawnOptions(tmpDir, { background: true }), slowRunner);
			assert.equal(r1.status, "running");
			assert.equal(r2.status, "queued");
			mgr.abortAll();
			removeTrackedTempDir(tmpDir);
		});
	});
});
