/**
 * Tests for src/extension/run-export.ts
 *
 * exportRunBundle depends on writeArtifact and readEvents which require
 * a proper artifacts directory and events file. These tests set up the
 * filesystem structure needed.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { type ExportedRunBundle, exportRunBundle } from "../../../../src/extension/run-export.ts";
import type { TeamTaskStatus } from "../../../../src/state/contracts.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeManifest(stateRoot: string, artifactsRoot: string, eventsPath: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "export-test-run",
		sessionId: "test-session",
		team: "test-team",
		workflow: "test-workflow",
		goal: "Export test goal",
		status: "completed",
		workspaceMode: "single",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T01:00:00.000Z",
		cwd: stateRoot,
		stateRoot,
		artifactsRoot,
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath,
		artifacts: [
			{
				kind: "result",
				path: "result.txt",
				createdAt: "2026-01-01T00:30:00.000Z",
				producer: "worker",
				retention: "run",
			},
		],
	} as TeamRunManifest;
}

function makeTask(id: string, status: TeamTaskStatus, role: string, agent: string): TeamTaskState {
	return {
		id,
		runId: "export-test-run",
		role,
		agent,
		title: `Task ${id}`,
		status,
		dependsOn: [],
		cwd: os.tmpdir(),
		startedAt: "2026-01-01T00:10:00.000Z",
		finishedAt: status === "completed" ? "2026-01-01T00:20:00.000Z" : undefined,
	} as TeamTaskState;
}

function setupExportWorkspace(): { dir: string; manifest: TeamRunManifest } {
	const dir = createTrackedTempDir("run-export-cov-");
	const stateRoot = path.join(dir, "state");
	const artifactsRoot = path.join(dir, "artifacts");
	fs.mkdirSync(stateRoot, { recursive: true });
	fs.mkdirSync(artifactsRoot, { recursive: true });
	const eventsPath = path.join(stateRoot, "events.jsonl");
	// Write some events
	const events = [
		{
			time: "2026-01-01T00:01:00.000Z",
			type: "run.started",
			runId: "export-test-run",
			message: "Run started",
		},
		{
			time: "2026-01-01T00:30:00.000Z",
			type: "task.completed",
			runId: "export-test-run",
			taskId: "01_task",
			message: "Task done",
		},
	];
	fs.writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
	const manifest = makeManifest(stateRoot, artifactsRoot, eventsPath);
	return { dir, manifest };
}

describe("exportRunBundle creates JSON and Markdown files", () => {
	it("returns paths for both export files", () => {
		const { dir, manifest } = setupExportWorkspace();
		try {
			const tasks = [makeTask("01_task", "completed", "worker", "test-agent")];
			const result = exportRunBundle(manifest, tasks);

			assert.ok(result.jsonPath.endsWith("run-export.json"));
			assert.ok(result.markdownPath.endsWith("run-export.md"));
			assert.ok(fs.existsSync(result.jsonPath));
			assert.ok(fs.existsSync(result.markdownPath));
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("exportRunBundle JSON contains valid bundle", () => {
	it("writes bundle with correct schema version and metadata", () => {
		const { dir, manifest } = setupExportWorkspace();
		try {
			const tasks = [makeTask("01_task", "completed", "worker", "test-agent")];
			const result = exportRunBundle(manifest, tasks);

			const raw = fs.readFileSync(result.jsonPath, "utf-8");
			const bundle = JSON.parse(raw) as ExportedRunBundle;

			assert.equal(bundle.schemaVersion, 1);
			assert.equal(bundle.manifest.runId, "export-test-run");
			assert.equal(bundle.tasks.length, 1);
			assert.equal(bundle.tasks[0].id, "01_task");
			assert.ok(bundle.events.length >= 2);
			assert.ok(bundle.artifactPaths.length >= 1);
			assert.ok(bundle.exportedAt);
			// SHA-256 integrity hash
			assert.ok((bundle.manifest as unknown as Record<string, unknown>).sha256);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("exportRunBundle Markdown contains key fields", () => {
	it("includes run ID, status, team, and tasks in markdown", () => {
		const { dir, manifest } = setupExportWorkspace();
		try {
			const tasks = [makeTask("01_task", "completed", "worker", "agent-a"), makeTask("02_task", "failed", "reviewer", "agent-b")];
			// Add error to the failed task
			tasks[1].error = "Something went wrong";

			const result = exportRunBundle(manifest, tasks);
			const md = fs.readFileSync(result.markdownPath, "utf-8");

			assert.ok(md.includes("export-test-run"), "should include run ID");
			assert.ok(md.includes("completed"), "should include status");
			assert.ok(md.includes("test-team"), "should include team");
			assert.ok(md.includes("test-workflow"), "should include workflow");
			assert.ok(md.includes("01_task"), "should include task ID");
			assert.ok(md.includes("02_task"), "should include task ID");
			assert.ok(md.includes("Something went wrong"), "should include task error");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("exportRunBundle with empty events", () => {
	it("handles empty events file gracefully", () => {
		const { dir, manifest } = setupExportWorkspace();
		try {
			// Overwrite events with empty file
			fs.writeFileSync(manifest.eventsPath, "");
			const tasks: TeamTaskState[] = [];
			const result = exportRunBundle(manifest, tasks);

			const raw = fs.readFileSync(result.jsonPath, "utf-8");
			const bundle = JSON.parse(raw) as ExportedRunBundle;
			assert.equal(bundle.events.length, 0);
			assert.equal(bundle.tasks.length, 0);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("exportRunBundle redacts home paths", () => {
	it("replaces home directory paths with ~ in bundle", () => {
		const { dir, manifest } = setupExportWorkspace();
		try {
			const tasks = [makeTask("01_task", "completed", "worker", "agent-a")];
			const result = exportRunBundle(manifest, tasks);

			const raw = fs.readFileSync(result.jsonPath, "utf-8");
			// The bundle should not contain the raw home dir path in string form
			// (it's replaced with ~)
			const home = os.homedir();
			if (home) {
				// Check that no raw home path remains in the serialized JSON
				// Note: the path might appear in artifactPaths or similar, but
				// redactHomePaths should have replaced them
				assert.ok(!raw.includes(`"${home}`), "home dir paths should be redacted");
			}
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});
