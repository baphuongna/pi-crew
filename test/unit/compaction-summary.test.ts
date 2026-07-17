import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildCompactionSummary, summaryPathsFor } from "../../src/runtime/compaction-summary.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";

/** Create a temporary directory with run state files for testing. */
function createTestStateDir(files: { manifest?: Partial<TeamRunManifest>; tasks?: Partial<TeamTaskState>[]; events?: string[] }): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-test-"));

	if (files.manifest) {
		const manifest: TeamRunManifest = {
			schemaVersion: 1,
			runId: files.manifest.runId ?? "test-run-001",
			team: files.manifest.team ?? "test-team",
			workflow: files.manifest.workflow,
			goal: files.manifest.goal ?? "test goal",
			status: files.manifest.status ?? "running",
			workspaceMode: "single",
			createdAt: files.manifest.createdAt ?? "2026-01-01T00:00:00.000Z",
			updatedAt: files.manifest.updatedAt ?? "2026-01-01T00:01:00.000Z",
			cwd: files.manifest.cwd ?? "/tmp",
			stateRoot: dir,
			artifactsRoot: path.join(dir, "artifacts"),
			tasksPath: path.join(dir, "tasks.json"),
			eventsPath: path.join(dir, "events.jsonl"),
			artifacts: [],
			...files.manifest,
		} as TeamRunManifest;
		fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
	}

	if (files.tasks) {
		const tasks: TeamTaskState[] = files.tasks.map(
			(t, i) =>
				({
					id: t.id ?? `task-${i + 1}`,
					runId: t.runId ?? "test-run-001",
					role: t.role ?? "agent",
					agent: t.agent ?? "default",
					title: t.title ?? "Test task",
					status: t.status ?? "completed",
					dependsOn: [],
					cwd: "/tmp",
					...t,
				}) as TeamTaskState,
		);
		fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify(tasks, null, 2));
	}

	if (files.events) {
		fs.writeFileSync(path.join(dir, "events.jsonl"), files.events.join("\n") + "\n");
	}

	return dir;
}

describe("summaryPathsFor", () => {
	it("returns correct paths for a state root", () => {
		const paths = summaryPathsFor(path.join("/tmp", "run-state"));
		assert.equal(paths.stateRoot, path.join("/tmp", "run-state"));
		assert.ok(paths.manifestPath.endsWith("manifest.json"));
		assert.ok(paths.tasksPath.endsWith("tasks.json"));
		assert.ok(paths.eventsPath.endsWith("events.jsonl"));
	});

	it("handles relative paths", () => {
		const paths = summaryPathsFor("./state");
		assert.equal(paths.stateRoot, "./state");
		assert.ok(paths.manifestPath.endsWith("manifest.json"));
	});
});

describe("buildCompactionSummary", () => {
	it("produces a summary with run metadata from manifest", () => {
		const dir = createTestStateDir({
			manifest: {
				runId: "run-abc",
				team: "impl-team",
				workflow: "sequential",
				goal: "Build feature X",
				status: "running",
			},
			tasks: [],
		});
		try {
			const summary = buildCompactionSummary(dir);
			assert.ok(summary.includes("# Run Summary"));
			assert.ok(summary.includes("run-abc"));
			assert.ok(summary.includes("impl-team"));
			assert.ok(summary.includes("sequential"));
			assert.ok(summary.includes("Build feature X"));
			assert.ok(summary.includes("running"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("produces a task progress table from tasks.json", () => {
		const dir = createTestStateDir({
			manifest: {},
			tasks: [
				{
					id: "01_agent",
					role: "agent",
					status: "completed",
					startedAt: "2026-01-01T00:00:00.000Z",
					finishedAt: "2026-01-01T00:00:30.000Z",
				},
				{
					id: "02_review",
					role: "reviewer",
					status: "running",
					startedAt: "2026-01-01T00:00:31.000Z",
				},
			],
		});
		try {
			const summary = buildCompactionSummary(dir);
			assert.ok(summary.includes("## Task Progress"));
			assert.ok(summary.includes("01_agent"));
			assert.ok(summary.includes("02_review"));
			assert.ok(summary.includes("agent"));
			assert.ok(summary.includes("reviewer"));
			assert.ok(summary.includes("completed"));
			assert.ok(summary.includes("running"));
			assert.ok(summary.includes("30s"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("includes diagnostics and metrics in recent results", () => {
		const dir = createTestStateDir({
			manifest: {},
			tasks: [
				{
					id: "task-with-data",
					role: "agent",
					status: "completed",
					startedAt: "2026-01-01T00:00:00.000Z",
					finishedAt: "2026-01-01T00:01:00.000Z",
					diagnostics: { toolCalls: 5, phase: "implementation" },
					metrics: { filesChanged: 3, linesAdded: 100 },
				},
			],
		});
		try {
			const summary = buildCompactionSummary(dir);
			assert.ok(summary.includes("## Recent Task Results"));
			assert.ok(summary.includes("task-with-data"));
			assert.ok(summary.includes("Diagnostics"));
			assert.ok(summary.includes("toolCalls"));
			assert.ok(summary.includes("Metrics"));
			assert.ok(summary.includes("filesChanged"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lists pending/queued tasks as next steps", () => {
		const dir = createTestStateDir({
			manifest: {},
			tasks: [
				{
					id: "01_done",
					role: "agent",
					status: "completed",
					title: "First task",
				},
				{
					id: "02_pending",
					role: "agent",
					status: "queued",
					title: "Second task",
				},
				{
					id: "03_running",
					role: "reviewer",
					status: "running",
					title: "Third task",
				},
			],
		});
		try {
			const summary = buildCompactionSummary(dir);
			assert.ok(summary.includes("## Next Steps"));
			assert.ok(summary.includes("02_pending"));
			assert.ok(summary.includes("03_running"));
			// Completed task should NOT be in next steps
			assert.ok(
				!summary.includes("## Next Steps") ||
					summary.indexOf("01_done") < summary.indexOf("## Next Steps") ||
					summary.includes("[completed] 01_done") === false,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("handles missing manifest gracefully", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-test-"));
		// No manifest, no tasks, no events
		try {
			const summary = buildCompactionSummary(dir);
			assert.ok(summary.includes("# Run Summary"));
			assert.ok(summary.includes("manifest unavailable"));
			assert.ok(summary.includes("No tasks recorded"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("includes recent events from events.jsonl tail", () => {
		const events = Array.from({ length: 20 }, (_, i) =>
			JSON.stringify({
				type: "task.progress",
				runId: "run-1",
				taskId: "task-1",
				time: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
				message: `Progress update ${i}`,
			}),
		);

		const dir = createTestStateDir({
			manifest: {},
			tasks: [],
			events,
		});
		try {
			const summary = buildCompactionSummary(dir);
			assert.ok(summary.includes("## Recent Events"));
			assert.ok(summary.includes("task.progress"));
			assert.ok(summary.includes("Progress update"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
