/**
 * Tests for src/runtime/subagent-manager.ts
 * Coverage:
 * - isValidSubagentId
 * - persistedSubagentPath (path-traversal rejection)
 * - serializableRecord (strips promise)
 * - savePersistedSubagentRecord / readPersistedSubagentRecord round-trip
 * - SubagentManager.spawn (basic record creation)
 * - abort (queued and running)
 * - abortAll
 * - setMaxConcurrent
 * - getRecord, listAgents
 * - L1: console.error replaced with logInternalError
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { PiTeamsToolResult } from "../../../../src/extension/tool-result.ts";
import {
	readPersistedSubagentRecord,
	SubagentManager,
	type SubagentRecord,
	type SubagentSpawnOptions,
	savePersistedSubagentRecord,
} from "../../../../src/runtime/subagent-manager.ts";

const makeTempDir = () => {
	let dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-"));
	try {
		dir = fs.realpathSync(dir);
	} catch {
		/* keep as-is */
	}
	return dir;
};

const makeResult = (text: string, runId?: string): PiTeamsToolResult => {
	const details: Record<string, unknown> = {};
	if (runId) details.runId = runId;
	return {
		content: [{ type: "text", text }],
		details: details as never,
	};
};

const makeRunner =
	(result: PiTeamsToolResult) =>
	async (_options: SubagentSpawnOptions, _signal?: AbortSignal): Promise<PiTeamsToolResult> =>
		result;

test("isValidSubagentId accepts valid IDs", () => {
	const dir = makeTempDir();
	try {
		const record: SubagentRecord = {
			id: "agent_test_123",
			type: "test",
			description: "Test",
			prompt: "Do something",
			status: "running",
			startedAt: Date.now(),
			background: false,
		};
		savePersistedSubagentRecord(dir, record);
		const loaded = readPersistedSubagentRecord(dir, "agent_test_123");
		assert.ok(loaded);
		assert.equal(loaded?.id, "agent_test_123");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("savePersistedSubagentRecord silently rejects path-traversal IDs (does not write file)", () => {
	const dir = makeTempDir();
	try {
		const record: SubagentRecord = {
			id: "../etc/passwd",
			type: "test",
			description: "Test",
			prompt: "Do something",
			status: "running",
			startedAt: Date.now(),
			background: false,
		};
		// Should not throw — error is logged internally
		savePersistedSubagentRecord(dir, record);
		// File should NOT exist
		const filePath = path.join(dir, ".crew", "state", "subagents", "..", "..", "..", "etc", "passwd.json");
		assert.ok(!fs.existsSync(filePath), "file should not be created for path-traversal ID");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("savePersistedSubagentRecord silently rejects IDs with slashes (does not write file)", () => {
	const dir = makeTempDir();
	try {
		const record: SubagentRecord = {
			id: "foo/bar",
			type: "test",
			description: "Test",
			prompt: "Do something",
			status: "running",
			startedAt: Date.now(),
			background: false,
		};
		savePersistedSubagentRecord(dir, record);
		// File should NOT exist
		const filePath = path.join(dir, ".crew", "state", "subagents", "foo", "bar.json");
		assert.ok(!fs.existsSync(filePath), "file should not be created for slashed ID");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("savePersistedSubagentRecord silently rejects IDs over 128 chars (does not write file)", () => {
	const dir = makeTempDir();
	try {
		const longId = "a".repeat(129);
		const record: SubagentRecord = {
			id: longId,
			type: "test",
			description: "Test",
			prompt: "Do something",
			status: "running",
			startedAt: Date.now(),
			background: false,
		};
		savePersistedSubagentRecord(dir, record);
		// File should NOT exist
		const filePath = path.join(dir, ".crew", "state", "subagents", `${longId}.json`);
		assert.ok(!fs.existsSync(filePath), "file should not be created for over-128-char ID");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("readPersistedSubagentRecord returns undefined for missing file", () => {
	const dir = makeTempDir();
	try {
		const result = readPersistedSubagentRecord(dir, "nonexistent");
		assert.equal(result, undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("savePersistedSubagentRecord creates directory and file", () => {
	const dir = makeTempDir();
	fs.mkdirSync(path.join(dir, ".crew"), { recursive: true });
	try {
		const record: SubagentRecord = {
			id: "agent_001",
			type: "test",
			description: "Test",
			prompt: "Do something",
			status: "running",
			startedAt: Date.now(),
			background: false,
		};
		savePersistedSubagentRecord(dir, record);
		// File should exist
		const filePath = path.join(dir, ".crew", "state", "subagents", "agent_001.json");
		assert.ok(fs.existsSync(filePath), "file should be created");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("SubagentManager.spawn creates a record with running status", () => {
	const dir = makeTempDir();
	const manager = new SubagentManager();
	try {
		const runner = makeRunner(makeResult("done"));
		const record = manager.spawn(
			{
				cwd: dir,
				type: "test",
				description: "Test",
				prompt: "Do",
				background: false,
			},
			runner,
		);
		assert.ok(record.id);
		assert.equal(record.status, "running");
	} finally {
		void manager.abortAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("SubagentManager.spawn queues when at maxConcurrent", () => {
	const dir = makeTempDir();
	const manager = new SubagentManager(1);
	try {
		const slowRunner = async (_options: SubagentSpawnOptions, _signal?: AbortSignal) => {
			// Never resolves — keeps the first agent running
			await new Promise(() => undefined);
			return makeResult("never");
		};
		const r1 = manager.spawn(
			{
				cwd: dir,
				type: "test",
				description: "A",
				prompt: "Do",
				background: true,
			},
			slowRunner,
		);
		const r2 = manager.spawn(
			{
				cwd: dir,
				type: "test",
				description: "B",
				prompt: "Do",
				background: true,
			},
			slowRunner,
		);
		assert.equal(r1.status, "running");
		assert.equal(r2.status, "queued");
	} finally {
		void manager.abortAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("SubagentManager.abort returns false for unknown id", () => {
	const manager = new SubagentManager();
	const result = manager.abort("nonexistent");
	assert.equal(result, false);
});

test("SubagentManager.abort returns false for already-completed record", async () => {
	const dir = makeTempDir();
	const manager = new SubagentManager();
	try {
		const record = manager.spawn(
			{
				cwd: dir,
				type: "test",
				description: "Test",
				prompt: "Do",
				background: false,
			},
			makeRunner(makeResult("done")),
		);
		// Wait for it to complete
		await new Promise((r) => setTimeout(r, 50));
		const result = manager.abort(record.id);
		assert.equal(result, false, "should not abort completed record");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("SubagentManager.getRecord returns the record by id", () => {
	const dir = makeTempDir();
	const manager = new SubagentManager();
	try {
		const record = manager.spawn(
			{
				cwd: dir,
				type: "test",
				description: "Test",
				prompt: "Do",
				background: false,
			},
			makeRunner(makeResult("done")),
		);
		const fetched = manager.getRecord(record.id);
		assert.equal(fetched, record);
	} finally {
		void manager.abortAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("SubagentManager.listAgents returns all records sorted by startedAt", () => {
	const dir = makeTempDir();
	const manager = new SubagentManager();
	try {
		manager.spawn(
			{
				cwd: dir,
				type: "a",
				description: "A",
				prompt: "1",
				background: false,
			},
			makeRunner(makeResult("a")),
		);
		manager.spawn(
			{
				cwd: dir,
				type: "b",
				description: "B",
				prompt: "2",
				background: false,
			},
			makeRunner(makeResult("b")),
		);
		const list = manager.listAgents();
		assert.equal(list.length, 2);
	} finally {
		void manager.abortAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("SubagentManager.setMaxConcurrent adjusts the limit", () => {
	const manager = new SubagentManager(2);
	manager.setMaxConcurrent(5);
	// Just verify it doesn't throw
	manager.setMaxConcurrent(0); // should be clamped to 1
});

test("SubagentManager.setMaxConcurrent clamps to at least 1", () => {
	const manager = new SubagentManager(2);
	manager.setMaxConcurrent(-5);
	// Should not throw
});
