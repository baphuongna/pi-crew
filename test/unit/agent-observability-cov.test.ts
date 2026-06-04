import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

import {
	readTextTail,
	buildAgentDashboard,
	readAgentOutput,
} from "../../src/runtime/agent-observability.ts";

import type { TextTailResult } from "../../src/runtime/agent-observability.ts";

// ── readTextTail ──

describe("readTextTail", () => {
	it("returns empty result for non-existent file", () => {
		const result = readTextTail("/tmp/nonexistent-agent-obs-test-file.txt");
		assert.deepStrictEqual(result, {
			path: "/tmp/nonexistent-agent-obs-test-file.txt",
			text: "",
			bytes: 0,
			truncated: false,
		} satisfies TextTailResult);
	});

	it("reads entire small file without truncation", () => {
		const dir = createTrackedTempDir("pi-crew-obs-");
		const filePath = path.join(dir, "small.txt");
		fs.writeFileSync(filePath, "hello world", "utf-8");
		try {
			const result = readTextTail(filePath);
			assert.strictEqual(result.text, "hello world");
			assert.strictEqual(result.bytes, 11);
			assert.strictEqual(result.truncated, false);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("truncates large file when exceeding maxBytes", () => {
		const dir = createTrackedTempDir("pi-crew-obs-");
		const filePath = path.join(dir, "large.txt");
		const content = "A".repeat(200);
		fs.writeFileSync(filePath, content, "utf-8");
		try {
			const result = readTextTail(filePath, 100);
			assert.strictEqual(result.bytes, 200);
			assert.strictEqual(result.truncated, true);
			assert.strictEqual(result.text.length, 100);
			assert.strictEqual(result.text, "A".repeat(100));
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("reads tail of file when larger than maxBytes", () => {
		const dir = createTrackedTempDir("pi-crew-obs-");
		const filePath = path.join(dir, "tail.txt");
		fs.writeFileSync(filePath, "0123456789", "utf-8");
		try {
			const result = readTextTail(filePath, 5);
			assert.strictEqual(result.text, "56789");
			assert.strictEqual(result.bytes, 10);
			assert.strictEqual(result.truncated, true);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("handles zero maxBytes gracefully", () => {
		const dir = createTrackedTempDir("pi-crew-obs-");
		const filePath = path.join(dir, "zero.txt");
		fs.writeFileSync(filePath, "data", "utf-8");
		try {
			const result = readTextTail(filePath, 0);
			assert.strictEqual(result.text, "");
			assert.strictEqual(result.bytes, 4);
			assert.strictEqual(result.truncated, true);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ── buildAgentDashboard ──
// Requires a manifest with stateRoot; agent records are stored under stateRoot/agents.json
describe("buildAgentDashboard", () => {
	it("returns dashboard with no agents when agents file is missing", () => {
		const dir = createTrackedTempDir("pi-crew-obs-");
		try {
			const manifest = {
				runId: "run-test-001",
				status: "running",
				team: "test-team",
				workflow: "direct",
				stateRoot: dir,
				eventsPath: path.join(dir, "events.jsonl"),
			} as any;
			const result = buildAgentDashboard(manifest);
			assert.ok(result.text.includes("run-test-001"));
			assert.strictEqual(result.groups.running.length, 0);
			assert.strictEqual(result.groups.queued.length, 0);
			assert.strictEqual(result.groups.recent.length, 0);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("returns dashboard with agents from agents.json", () => {
		const dir = createTrackedTempDir("pi-crew-obs-");
		try {
			const manifest = {
				runId: "run-test-002",
				status: "running",
				team: "team",
				workflow: "wf",
				stateRoot: dir,
				eventsPath: path.join(dir, "events.jsonl"),
			} as any;

			// readCrewAgents expects a flat JSON array at stateRoot/agents.json
			// Each record must have id and taskId strings to pass validation
			const agents = [
				{
					id: "task-01-0",
					taskId: "task-01",
					role: "agent",
					agent: "claude",
					status: "completed",
					runtime: "sync",
					startedAt: "2026-01-01T00:00:00Z",
					completedAt: "2026-01-01T00:01:00Z",
					toolUses: 5,
					progress: { tokens: 1000, turns: 3 },
				},
			];
			fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify(agents), "utf-8");

			const result = buildAgentDashboard(manifest);
			assert.strictEqual(result.groups.recent.length, 1);
			assert.ok(result.text.includes("task-01"));
			assert.ok(result.text.includes("completed"));
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("categorizes agents into running, queued, and recent groups", () => {
		const dir = createTrackedTempDir("pi-crew-obs-");
		try {
			const manifest = {
				runId: "run-test-003",
				status: "running",
				team: "team",
				workflow: "wf",
				stateRoot: dir,
				eventsPath: path.join(dir, "events.jsonl"),
			} as any;

			// readCrewAgents expects a flat JSON array at stateRoot/agents.json
			const agents = [
				{ id: "t-running-0", taskId: "t-running", role: "r", agent: "a", status: "running", runtime: "sync", startedAt: "2026-01-01T00:00:00Z" },
				{ id: "t-queued-0", taskId: "t-queued", role: "r", agent: "a", status: "queued", runtime: "sync" },
				{ id: "t-completed-0", taskId: "t-completed", role: "r", agent: "a", status: "completed", runtime: "sync", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z" },
			];
			fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify(agents), "utf-8");

			const result = buildAgentDashboard(manifest);
			assert.strictEqual(result.groups.running.length, 1);
			assert.strictEqual(result.groups.queued.length, 1);
			assert.strictEqual(result.groups.recent.length, 1);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ── readAgentOutput ──

describe("readAgentOutput", () => {
	it("returns empty result when output file does not exist", () => {
		const dir = createTrackedTempDir("pi-crew-obs-");
		try {
			const manifest = {
				runId: "run-out-001",
				status: "running",
				team: "t",
				workflow: "w",
				stateRoot: dir,
				eventsPath: path.join(dir, "events.jsonl"),
			} as any;

			const result = readAgentOutput(manifest, "task-01");
			assert.strictEqual(result.text, "");
			assert.strictEqual(result.bytes, 0);
			assert.strictEqual(result.truncated, false);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("reads agent output when file exists", () => {
		const dir = createTrackedTempDir("pi-crew-obs-");
		try {
			const manifest = {
				runId: "run-out-002",
				status: "running",
				team: "t",
				workflow: "w",
				stateRoot: dir,
				eventsPath: path.join(dir, "events.jsonl"),
			} as any;

			// Create the output directory and file that agentOutputPath would point to
			// agentOutputPath returns: stateRoot/agents/<taskId>/output.log
			const outputDir = path.join(dir, "agents", "task-02");
			fs.mkdirSync(outputDir, { recursive: true });
			fs.writeFileSync(path.join(outputDir, "output.log"), "Agent completed task successfully", "utf-8");

			const result = readAgentOutput(manifest, "task-02");
			assert.strictEqual(result.text, "Agent completed task successfully");
			assert.strictEqual(result.truncated, false);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("respects maxBytes parameter", () => {
		const dir = createTrackedTempDir("pi-crew-obs-");
		try {
			const manifest = {
				runId: "run-out-003",
				status: "running",
				team: "t",
				workflow: "w",
				stateRoot: dir,
				eventsPath: path.join(dir, "events.jsonl"),
			} as any;

			// agentOutputPath returns: stateRoot/agents/<taskId>/output.log
			const outputDir = path.join(dir, "agents", "task-03");
			fs.mkdirSync(outputDir, { recursive: true });
			fs.writeFileSync(path.join(outputDir, "output.log"), "A".repeat(500), "utf-8");

			const result = readAgentOutput(manifest, "task-03", 50);
			assert.strictEqual(result.truncated, true);
			assert.strictEqual(result.text.length, 50);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});
