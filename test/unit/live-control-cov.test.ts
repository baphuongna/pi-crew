import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	liveAgentControlPath,
	appendLiveAgentControlRequest,
	readLiveAgentControlRequests,
	applyLiveAgentControlRequest,
} from "../../src/runtime/live-agent-control.ts";
import type { LiveAgentControlRequest } from "../../src/runtime/live-agent-control.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

function makeManifest(tmp: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "run-test",
		team: "default",
		workflow: "default",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: tmp,
		stateRoot: path.join(tmp, ".crew", "state"),
		artifactsRoot: path.join(tmp, ".crew", "artifacts"),
		tasksPath: path.join(tmp, "tasks.json"),
		eventsPath: path.join(tmp, "events.jsonl"),
		artifacts: [],
	};
}

describe("liveAgentControlPath", () => {
	it("returns a path containing the taskId", () => {
		const tmp = createTrackedTempDir("pi-crew-lc-");
		try {
			const manifest = makeManifest(tmp);
			const result = liveAgentControlPath(manifest, "task1");
			assert.ok(result.includes("task1"));
			assert.ok(result.endsWith("live-control.jsonl"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

describe("appendLiveAgentControlRequest", () => {
	it("writes a control request to the file", () => {
		const tmp = createTrackedTempDir("pi-crew-lc-");
		try {
			const manifest = makeManifest(tmp);
			const request = appendLiveAgentControlRequest(manifest, {
				taskId: "task1",
				operation: "steer",
				message: "report status",
			});
			assert.ok(request.id.startsWith("ctrl_"));
			assert.equal(request.runId, manifest.runId);
			assert.equal(request.taskId, "task1");
			assert.equal(request.operation, "steer");
			assert.equal(request.message, "report status");
			assert.ok(request.createdAt);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("appends multiple requests to the same file", () => {
		const tmp = createTrackedTempDir("pi-crew-lc-");
		try {
			const manifest = makeManifest(tmp);
			const r1 = appendLiveAgentControlRequest(manifest, { taskId: "task1", operation: "steer" });
			const r2 = appendLiveAgentControlRequest(manifest, { taskId: "task1", operation: "stop" });
			assert.notEqual(r1.id, r2.id);
			const { requests } = readLiveAgentControlRequests(manifest, "task1");
			assert.equal(requests.length, 2);
			assert.equal(requests[0]!.operation, "steer");
			assert.equal(requests[1]!.operation, "stop");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("includes agentId when provided", () => {
		const tmp = createTrackedTempDir("pi-crew-lc-");
		try {
			const manifest = makeManifest(tmp);
			const request = appendLiveAgentControlRequest(manifest, {
				taskId: "task1",
				agentId: "agent-1",
				operation: "follow-up",
				message: "continue",
			});
			assert.equal(request.agentId, "agent-1");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

describe("readLiveAgentControlRequests", () => {
	it("returns empty array when no file exists", () => {
		const tmp = createTrackedTempDir("pi-crew-lc-");
		try {
			const manifest = makeManifest(tmp);
			const { requests, cursor } = readLiveAgentControlRequests(manifest, "task1");
			assert.equal(requests.length, 0);
			assert.equal(cursor.offset, 0);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("supports cursor-based pagination", () => {
		const tmp = createTrackedTempDir("pi-crew-lc-");
		try {
			const manifest = makeManifest(tmp);
			appendLiveAgentControlRequest(manifest, { taskId: "task1", operation: "steer" });
			appendLiveAgentControlRequest(manifest, { taskId: "task1", operation: "stop" });
			const page1 = readLiveAgentControlRequests(manifest, "task1", { offset: 0 });
			assert.equal(page1.requests.length, 2);
			assert.equal(page1.cursor.offset, 2);
			// Read with cursor past first entry
			const page2 = readLiveAgentControlRequests(manifest, "task1", { offset: 1 });
			assert.equal(page2.requests.length, 1);
			assert.equal(page2.requests[0]!.operation, "stop");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("filters requests by runId and taskId", () => {
		const tmp = createTrackedTempDir("pi-crew-lc-");
		try {
			const manifest = makeManifest(tmp);
			appendLiveAgentControlRequest(manifest, { taskId: "task1", operation: "steer" });
			// Corrupt the file with a line that has wrong runId
			const controlPath = liveAgentControlPath(manifest, "task1");
			const badRequest: LiveAgentControlRequest = {
				id: "ctrl_bad",
				runId: "wrong-run",
				taskId: "task1",
				operation: "steer",
				createdAt: new Date().toISOString(),
			};
			fs.appendFileSync(controlPath, `${JSON.stringify(badRequest)}\n`, "utf-8");
			const { requests } = readLiveAgentControlRequests(manifest, "task1");
			assert.equal(requests.length, 1);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

describe("applyLiveAgentControlRequest", () => {
	it("calls steer for steer operation", async () => {
		const steered: string[] = [];
		const request: LiveAgentControlRequest = {
			id: "ctrl_steer",
			runId: "run",
			taskId: "task1",
			operation: "steer",
			message: "wrap up",
			createdAt: new Date().toISOString(),
		};
		const applied = await applyLiveAgentControlRequest({
			request,
			taskId: "task1",
			agentId: "task1",
			session: {
				steer: async (text) => { steered.push(text); },
			},
		});
		assert.equal(applied, true);
		assert.deepEqual(steered, ["wrap up"]);
	});

	it("calls abort for stop operation", async () => {
		let aborted = false;
		const request: LiveAgentControlRequest = {
			id: "ctrl_stop",
			runId: "run",
			taskId: "task1",
			operation: "stop",
			createdAt: new Date().toISOString(),
		};
		await applyLiveAgentControlRequest({
			request,
			taskId: "task1",
			agentId: "task1",
			session: { abort: async () => { aborted = true; } },
		});
		assert.equal(aborted, true);
	});

	it("skips request when agentId does not match", async () => {
		const request: LiveAgentControlRequest = {
			id: "ctrl_skip",
			runId: "run",
			taskId: "task1",
			agentId: "other-agent",
			operation: "steer",
			createdAt: new Date().toISOString(),
		};
		const applied = await applyLiveAgentControlRequest({
			request,
			taskId: "task1",
			agentId: "my-agent",
			session: {},
		});
		assert.equal(applied, false);
	});

	it("skips already-seen request IDs", async () => {
		const seen = new Set<string>(["ctrl_seen"]);
		const request: LiveAgentControlRequest = {
			id: "ctrl_seen",
			runId: "run",
			taskId: "task1",
			operation: "steer",
			createdAt: new Date().toISOString(),
		};
		const applied = await applyLiveAgentControlRequest({
			request,
			taskId: "task1",
			agentId: "task1",
			session: {},
			seenRequestIds: seen,
		});
		assert.equal(applied, false);
	});
});
