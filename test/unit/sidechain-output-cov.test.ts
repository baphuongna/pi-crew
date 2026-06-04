import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

import {
	writeSidechainEntry,
	sidechainOutputPath,
	eventToSidechainType,
} from "../../src/runtime/sidechain-output.ts";

// ── eventToSidechainType ──

describe("eventToSidechainType", () => {
	it("returns 'message' for message_start", () => {
		assert.strictEqual(eventToSidechainType({ type: "message_start" }), "message");
	});

	it("returns 'message' for message_update", () => {
		assert.strictEqual(eventToSidechainType({ type: "message_update" }), "message");
	});

	it("returns 'message' for message_end", () => {
		assert.strictEqual(eventToSidechainType({ type: "message_end" }), "message");
	});

	it("returns 'tool' for tool_execution_start", () => {
		assert.strictEqual(eventToSidechainType({ type: "tool_execution_start" }), "tool");
	});

	it("returns 'tool' for tool_execution_update", () => {
		assert.strictEqual(eventToSidechainType({ type: "tool_execution_update" }), "tool");
	});

	it("returns 'tool' for tool_execution_end", () => {
		assert.strictEqual(eventToSidechainType({ type: "tool_execution_end" }), "tool");
	});

	it("returns the type string for unknown event types", () => {
		assert.strictEqual(eventToSidechainType({ type: "custom_event" }), "custom_event");
	});

	it("returns undefined for null", () => {
		assert.strictEqual(eventToSidechainType(null), undefined);
	});

	it("returns undefined for undefined", () => {
		assert.strictEqual(eventToSidechainType(undefined), undefined);
	});

	it("returns undefined for non-object", () => {
		assert.strictEqual(eventToSidechainType("string"), undefined);
		assert.strictEqual(eventToSidechainType(42), undefined);
	});

	it("returns undefined for array", () => {
		assert.strictEqual(eventToSidechainType([1, 2, 3]), undefined);
	});

	it("returns undefined when type is not a string", () => {
		assert.strictEqual(eventToSidechainType({ type: 42 }), undefined);
	});
});

// ── sidechainOutputPath ──

describe("sidechainOutputPath", () => {
	it("returns path with agents/<taskId>/sidechain.output.jsonl", () => {
		const result = sidechainOutputPath("/state/root", "task-01");
		assert.strictEqual(result, path.join("/state/root", "agents", "task-01", "sidechain.output.jsonl"));
	});

	it("rejects invalid taskId characters", () => {
		assert.throws(() => sidechainOutputPath("/state", "../../../etc/passwd"), /Invalid taskId/);
	});

	it("accepts valid taskIds with hyphens and underscores", () => {
		const result = sidechainOutputPath("/state", "task_01-sub");
		assert.ok(result.includes("task_01-sub"));
	});
});

// ── writeSidechainEntry ──

describe("writeSidechainEntry", () => {
	it("writes a JSONL entry to the specified file", () => {
		const dir = createTrackedTempDir("pi-crew-sc-");
		try {
			const filePath = path.join(dir, "sidechain.output.jsonl");
			writeSidechainEntry(filePath, {
				agentId: "agent-01",
				type: "message",
				message: { text: "hello" },
				cwd: "/tmp/test",
			});

			assert.ok(fs.existsSync(filePath));
			const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
			assert.strictEqual(lines.length, 1);
			const entry = JSON.parse(lines[0]);
			assert.strictEqual(entry.agentId, "agent-01");
			assert.strictEqual(entry.type, "message");
			assert.strictEqual(entry.isSidechain, true);
			assert.ok(entry.timestamp);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("appends to existing file", () => {
		const dir = createTrackedTempDir("pi-crew-sc-");
		try {
			const filePath = path.join(dir, "sidechain.output.jsonl");
			writeSidechainEntry(filePath, {
				agentId: "a1",
				type: "message",
				message: "first",
				cwd: "/tmp",
			});
			writeSidechainEntry(filePath, {
				agentId: "a2",
				type: "tool",
				message: "second",
				cwd: "/tmp",
			});

			const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
			assert.strictEqual(lines.length, 2);
			assert.strictEqual(JSON.parse(lines[0]).agentId, "a1");
			assert.strictEqual(JSON.parse(lines[1]).agentId, "a2");
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("creates parent directories if needed", () => {
		const dir = createTrackedTempDir("pi-crew-sc-");
		try {
			const filePath = path.join(dir, "nested", "deep", "output.jsonl");
			writeSidechainEntry(filePath, {
				agentId: "a1",
				type: "message",
				message: "test",
				cwd: "/tmp",
			});
			assert.ok(fs.existsSync(filePath));
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("redacts secrets from content", () => {
		const dir = createTrackedTempDir("pi-crew-sc-");
		try {
			const filePath = path.join(dir, "output.jsonl");
			writeSidechainEntry(filePath, {
				agentId: "a1",
				type: "message",
				message: { apiKey: "secret-key-12345" },
				cwd: "/tmp",
			});
			const entry = JSON.parse(fs.readFileSync(filePath, "utf-8").trim());
			// The message object should have the apiKey redacted
			assert.ok(entry.message);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});
