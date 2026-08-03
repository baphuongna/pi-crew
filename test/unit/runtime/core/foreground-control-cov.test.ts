import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	foregroundControlPath,
	readForegroundControlStatus,
	writeForegroundInterruptRequest,
} from "../../../../src/runtime/foreground-control.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeManifest(stateRoot: string, overrides: Partial<TeamRunManifest> = {}): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "run-fg-test",
		team: "test",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: "/tmp",
		stateRoot,
		artifactsRoot: path.join(stateRoot, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
		...overrides,
	};
}

describe("foregroundControlPath", () => {
	it("returns path inside stateRoot", () => {
		const manifest = makeManifest("/tmp/test-state");
		const p = foregroundControlPath(manifest);
		assert.equal(p, path.join("/tmp/test-state", "foreground-control.json"));
	});
});

describe("readForegroundControlStatus", () => {
	it("returns status with no running tasks or agents", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const manifest = makeManifest(stateRoot);
			const status = readForegroundControlStatus(manifest, []);
			assert.equal(status.runId, "run-fg-test");
			assert.equal(status.status, "running");
			assert.equal(status.active, true);
			assert.deepEqual(status.runningTasks, []);
			assert.deepEqual(status.runningAgents, []);
			assert.equal(status.lastRequest, undefined);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("filters running tasks from the task list", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const manifest = makeManifest(stateRoot);
			const tasks: TeamTaskState[] = [
				{
					id: "t1",
					runId: "run-fg-test",
					stepId: "s1",
					role: "agent",
					agent: "a",
					title: "T1",
					status: "running",
					dependsOn: [],
					cwd: "/tmp",
				},
				{
					id: "t2",
					runId: "run-fg-test",
					stepId: "s2",
					role: "agent",
					agent: "a",
					title: "T2",
					status: "completed",
					dependsOn: [],
					cwd: "/tmp",
				},
			];
			const status = readForegroundControlStatus(manifest, tasks);
			assert.deepEqual(status.runningTasks, ["t1"]);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("reports active=true for running status", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const manifest = makeManifest(stateRoot, { status: "running" });
			const status = readForegroundControlStatus(manifest, []);
			assert.equal(status.active, true);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("reports active=false for completed status", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const manifest = makeManifest(stateRoot, { status: "completed" });
			const status = readForegroundControlStatus(manifest, []);
			assert.equal(status.active, false);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("includes asyncAlive when async pid is present", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const manifest = makeManifest(stateRoot, {
				async: {
					pid: process.pid,
					logPath: "/tmp/log",
					spawnedAt: new Date().toISOString(),
				},
			});
			const status = readForegroundControlStatus(manifest, []);
			assert.equal(status.asyncPid, process.pid);
			assert.equal(status.asyncAlive, true);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

describe("writeForegroundInterruptRequest", () => {
	it("writes a valid interrupt request", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const eventsPath = path.join(stateRoot, "events.jsonl");
			fs.writeFileSync(eventsPath, "", "utf-8");
			const manifest = makeManifest(stateRoot, { eventsPath });
			const req = writeForegroundInterruptRequest(manifest, "test interrupt");
			assert.equal(req.type, "interrupt");
			assert.equal(req.acknowledged, false);
			assert.equal(req.reason, "test interrupt");
			assert.ok(req.id);
			assert.ok(req.createdAt);

			// Verify file was written
			const controlPath = foregroundControlPath(manifest);
			assert.ok(fs.existsSync(controlPath));
			const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8"));
			assert.ok(parsed.requests.length >= 1);
			assert.equal(parsed.requests[0].id, req.id);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("appends to existing requests", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const eventsPath = path.join(stateRoot, "events.jsonl");
			fs.writeFileSync(eventsPath, "", "utf-8");
			const manifest = makeManifest(stateRoot, { eventsPath });

			const req1 = writeForegroundInterruptRequest(manifest, "first");
			const req2 = writeForegroundInterruptRequest(manifest, "second");

			const controlPath = foregroundControlPath(manifest);
			const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8"));
			assert.equal(parsed.requests.length, 2);
			assert.equal(parsed.requests[0].id, req1.id);
			assert.equal(parsed.requests[1].id, req2.id);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("uses default reason when none provided", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const eventsPath = path.join(stateRoot, "events.jsonl");
			fs.writeFileSync(eventsPath, "", "utf-8");
			const manifest = makeManifest(stateRoot, { eventsPath });
			const req = writeForegroundInterruptRequest(manifest);
			assert.ok(req.reason.includes("User requested foreground interrupt"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("lastRequest is populated by readForegroundControlStatus after write", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const eventsPath = path.join(stateRoot, "events.jsonl");
			fs.writeFileSync(eventsPath, "", "utf-8");
			const manifest = makeManifest(stateRoot, { eventsPath });
			writeForegroundInterruptRequest(manifest, "check-last");
			const status = readForegroundControlStatus(manifest, []);
			assert.ok(status.lastRequest);
			assert.equal(status.lastRequest!.type, "interrupt");
			assert.equal(status.lastRequest!.reason, "check-last");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
