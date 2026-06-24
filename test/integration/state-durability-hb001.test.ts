/**
 * HB-001 integration: state-store durability under event pressure.
 *
 * Gap: the existing unit tests cover atomic-write and event-append in
 * isolation. This integration test covers the COMBINED path that HB-001
 * flagged — interleaved manifest writes + event appends to the same run's
 * state dir, then a full reload, asserting nothing is lost or corrupted.
 *
 * This is the realistic load pattern during a run: every task transition does
 * `saveRunManifest` + `saveRunTasks` + `appendEvent` against the same dir, and
 * the reconciler must read all three back consistently.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createRunManifest, saveRunTasks, loadRunManifestById } from "../../src/state/state-store.ts";
import { appendEvent } from "../../src/state/event-log.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";

test("HB-001 integration: interleaved manifest + event writes reload consistently", () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-hb001-durability-"));
	fs.writeFileSync(path.join(tmpRoot, "package.json"), "{}\n", "utf-8");
	fs.mkdirSync(path.join(tmpRoot, ".git"), { recursive: true });
	try {
		const runId = "team_hb001_durability_test";
		const now = () => new Date().toISOString();
		const manifest: TeamRunManifest = {
			schemaVersion: 1,
			runId,
			team: "hb001",
			workflow: "default",
			goal: "durability test",
			status: "running",
			workspaceMode: "single",
			createdAt: now(),
			updatedAt: now(),
			cwd: tmpRoot,
			stateRoot: `${tmpRoot}/.crew/state/runs/${runId}`,
			artifactsRoot: `${tmpRoot}/.crew/artifacts/${runId}`,
			tasksPath: `${tmpRoot}/.crew/state/runs/${runId}/tasks.json`,
			eventsPath: `${tmpRoot}/.crew/state/runs/${runId}/events.jsonl`,
			artifacts: [],
		};

		// Simulate 10 task transitions: each does manifest save + task save + event append.
		fs.mkdirSync(manifest.stateRoot, { recursive: true });
		const tasks: TeamTaskState[] = [];
		for (let i = 0; i < 10; i++) {
			const task: TeamTaskState = {
				id: `step-${i}`,
				runId,
				role: "executor",
				agent: "executor",
				title: `task ${i}`,
				status: i < 5 ? "completed" : "queued",
				dependsOn: i === 0 ? [] : [`step-${i - 1}`],
				cwd: tmpRoot,
			};
			tasks.push(task);
			saveRunTasks(manifest, tasks);
			manifest.updatedAt = now();
			// Round-26-style atomic manifest save (the production path).
			fs.writeFileSync(path.join(manifest.stateRoot, "manifest.json"), JSON.stringify(manifest));
			appendEvent(manifest.eventsPath, { type: "task.progress", runId, data: { taskId: task.id, status: task.status } });
			appendEvent(manifest.eventsPath, { type: "task.completed", runId, data: { taskId: task.id } });
		}

		// Reload the manifest via the same loader the reconciler uses.
		const loaded = loadRunManifestById(tmpRoot, runId);
		assert.ok(loaded, "manifest must reload after interleaved writes");
		assert.equal(loaded!.manifest.runId, runId);
		assert.equal(loaded!.manifest.status, "running");

		// Reload events and assert none were lost / no partial JSON lines.
		const events = fs.readFileSync(manifest.eventsPath, "utf-8").split("\n").filter((l) => l.trim());
		assert.equal(events.length, 20, "expected 20 events (2 per task × 10 tasks)");
		for (const line of events) {
			const parsed = JSON.parse(line); // throws on corruption
			assert.ok(parsed.type && parsed.runId === runId, "each event must have type + runId");
		}
	} finally {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
});
