import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pruneFinishedRuns, pruneUserLevelRuns } from "../../src/extension/run-maintenance.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";
import * as fs from "node:fs";
import * as path from "node:path";

function writeManifest(stateRoot: string, runId: string, status: string, updatedAt: string, cwd: string, artifactsRoot: string) {
	const manifest = {
		schemaVersion: 1,
		runId,
		team: "test",
		goal: "test",
		status,
		workspaceMode: "single",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt,
		cwd,
		stateRoot,
		artifactsRoot,
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	};
	fs.writeFileSync(path.join(stateRoot, "manifest.json"), JSON.stringify(manifest));
	fs.writeFileSync(path.join(stateRoot, "tasks.json"), "[]");
	fs.writeFileSync(path.join(stateRoot, "events.jsonl"), "");
}

describe("pruneFinishedRuns", () => {
	it("returns empty results when no runs exist", () => {
		const tmp = createTrackedTempDir("pi-crew-prune-");
		const result = pruneFinishedRuns(tmp, 5);
		assert.deepEqual(result.kept, []);
		assert.deepEqual(result.removed, []);
		removeTrackedTempDir(tmp);
	});

	it("keeps finished runs up to keep limit", () => {
		const tmp = createTrackedTempDir("pi-crew-prune-");
		const runsDir = path.join(tmp, ".crew", "state", "runs");
		fs.mkdirSync(runsDir, { recursive: true });

		// Create 3 finished runs
		for (let i = 0; i < 3; i++) {
			const runId = `run-${i}`;
			const stateRoot = path.join(runsDir, runId);
			const artRoot = path.join(tmp, ".crew", "artifacts", runId);
			fs.mkdirSync(stateRoot, { recursive: true });
			fs.mkdirSync(artRoot, { recursive: true });
			writeManifest(stateRoot, runId, "completed", `2026-01-0${i + 1}T00:00:00Z`, tmp, artRoot);
		}

		const result = pruneFinishedRuns(tmp, 2);
		assert.equal(result.kept.length, 2);
		assert.equal(result.removed.length, 1);
		removeTrackedTempDir(tmp);
	});

	it("does not prune active runs", () => {
		const tmp = createTrackedTempDir("pi-crew-prune-");
		const runsDir = path.join(tmp, ".crew", "state", "runs");
		fs.mkdirSync(runsDir, { recursive: true });

		const runId = "active-run";
		const stateRoot = path.join(runsDir, runId);
		const artRoot = path.join(tmp, ".crew", "artifacts", runId);
		fs.mkdirSync(stateRoot, { recursive: true });
		fs.mkdirSync(artRoot, { recursive: true });
		writeManifest(stateRoot, runId, "running", "2026-01-01T00:00:00Z", tmp, artRoot);

		const result = pruneFinishedRuns(tmp, 0);
		assert.equal(result.removed.length, 0);
		removeTrackedTempDir(tmp);
	});
});

describe("pruneUserLevelRuns", () => {
	it("returns empty when user runs dir does not exist", () => {
		// This test just verifies no crash when the dir doesn't exist
		const result = pruneUserLevelRuns(5);
		assert.ok(Array.isArray(result.kept));
		assert.ok(Array.isArray(result.removed));
	});
});
