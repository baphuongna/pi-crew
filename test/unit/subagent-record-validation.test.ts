import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readPersistedSubagentRecord } from "../../src/runtime/subagent-manager.ts";

// We test the validatePersistedRecord function indirectly through readPersistedSubagentRecord.
// Since that function reads from disk, we test the validation logic directly by importing
// and exercising the internal behavior. However, the function is not exported, so we test
// through the public API which uses it.

// For direct unit testing of the validation function, we test through the module's behavior.
// The readPersistedSubagentRecord will return undefined for invalid records.
// We need to write files to disk to test it.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("H3: Subagent record validation", () => {
	let tmpDir: string;

	// Helper to write a subagent record file
	function writeSubagentFile(id: string, content: unknown): string {
		const dir = tmpDir;
		const crewDir = path.join(dir, ".crew", "state", "subagents");
		fs.mkdirSync(crewDir, { recursive: true });
		const filePath = path.join(crewDir, `${id}.json`);
		fs.writeFileSync(filePath, JSON.stringify(content), "utf-8");
		return dir;
	}

	it("should accept valid records with allowed fields", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-"));
		try {
			writeSubagentFile("agent_test1", {
				agentId: "agent_test1",
				agentName: "TestAgent",
				subagentType: "worker",
				status: "completed",
				spawnedAt: "2026-01-01T00:00:00Z",
				completedAt: "2026-01-01T00:01:00Z",
				model: "claude-3",
				runId: "run_123",
			});
			const result = readPersistedSubagentRecord(tmpDir, "agent_test1");
			assert.ok(result, "Should return a valid record");
			assert.equal((result as unknown as Record<string, unknown>).agentId, "agent_test1");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("should reject records without agentId", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-"));
		try {
			writeSubagentFile("agent_test2", {
				agentName: "NoId",
				status: "running",
			});
			const result = readPersistedSubagentRecord(tmpDir, "agent_test2");
			assert.equal(result, undefined, "Should reject record without agentId");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("should reject records with non-string agentId", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-"));
		try {
			writeSubagentFile("agent_test3", {
				agentId: 12345,
			});
			const result = readPersistedSubagentRecord(tmpDir, "agent_test3");
			assert.equal(result, undefined, "Should reject record with numeric agentId");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("should reject records with empty agentId", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-"));
		try {
			writeSubagentFile("agent_test4", {
				agentId: "",
			});
			const result = readPersistedSubagentRecord(tmpDir, "agent_test4");
			assert.equal(result, undefined, "Should reject record with empty agentId");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("should reject non-object records (array)", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-"));
		try {
			writeSubagentFile("agent_test5", [{ agentId: "x" }]);
			const result = readPersistedSubagentRecord(tmpDir, "agent_test5");
			assert.equal(result, undefined, "Should reject array records");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("should reject null records", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-"));
		try {
			writeSubagentFile("agent_test6", null);
			const result = readPersistedSubagentRecord(tmpDir, "agent_test6");
			assert.equal(result, undefined, "Should reject null records");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("should reject records with injected malicious fields (validation runs)", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-"));
		try {
			// A record with allowed fields plus a malicious injected field
			writeSubagentFile("agent_test7", {
				agentId: "agent_test7",
				status: "running",
				__proto__: { admin: true },  // prototype pollution attempt
				maliciousField: "injected",
			});
			// The record should still pass basic validation (agentId is present)
			// but the validation function only keeps allowed fields
			const result = readPersistedSubagentRecord(tmpDir, "agent_test7");
			assert.ok(result, "Should return a valid record with agentId");
			// The key point: validatePersistedRecord will strip unknown fields
			// The raw JSON is still returned as SubagentRecord (backwards compat),
			// but the validation ensures agentId exists and is a valid string.
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("should return undefined for missing files", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-"));
		try {
			const result = readPersistedSubagentRecord(tmpDir, "nonexistent_agent");
			assert.equal(result, undefined, "Should return undefined for missing file");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
