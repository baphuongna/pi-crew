import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createMetricRegistry } from "../../src/observability/metric-registry.ts";
import { HeartbeatWatcher } from "../../src/runtime/heartbeat/heartbeat-watcher.ts";
import { createManifestCache } from "../../src/runtime/manifest-cache.ts";
import { createRunManifest, saveRunTasks, updateRunStatus } from "../../src/state/stores/state-store.ts";

const team = {
	name: "t",
	description: "",
	source: "test",
	filePath: "t",
	roles: [{ name: "r", agent: "a" }],
} as never;
const workflow = {
	name: "w",
	description: "",
	source: "test",
	filePath: "w",
	steps: [{ id: "s", role: "r", task: "x" }],
} as never;

test("HeartbeatWatcher emits dead notification once and triggers deadletter threshold", () => {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-heartbeat-watcher-"));
	try {
		// Canonicalize to long-name form matching production code
		try {
			const r = fs.realpathSync.native(cwd);
			cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
		} catch {
			/* keep as-is */
		}
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const created = createRunManifest({ cwd, team, workflow, goal: "hb" });
		const manifest = updateRunStatus(created.manifest, "running", "running");
		saveRunTasks(
			manifest,
			created.tasks.map((task) => ({
				...task,
				status: "running" as const,
				heartbeat: {
					workerId: task.id,
					lastSeenAt: "2026-01-01T00:00:00.000Z",
					alive: true,
				},
			})),
		);
		const cache = createManifestCache(cwd, { watch: false, debounceMs: 0 });
		const notifications: string[] = [];
		let deadletters = 0;
		const watcher = new HeartbeatWatcher({
			cwd,
			manifestCache: cache,
			registry: createMetricRegistry(),
			router: {
				enqueue: (n) => {
					notifications.push(n.id ?? "");
					return true;
				},
			},
			deadletterTickThreshold: 3,
			onDeadletterTrigger: () => {
				deadletters += 1;
			},
		});
		watcher.tick(Date.parse("2026-01-01T00:10:00.000Z"));
		watcher.tick(Date.parse("2026-01-01T00:10:05.000Z"));
		watcher.tick(Date.parse("2026-01-01T00:10:10.000Z"));
		assert.equal(new Set(notifications).size, 1);
		assert.equal(deadletters, 1);
		watcher.dispose();
		cache.dispose();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("W8 fix: completion-artifact suppresses false-positive dead when result file exists", () => {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-heartbeat-w8-"));
	try {
		try {
			const r = fs.realpathSync.native(cwd);
			cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
		} catch {
			/* keep as-is */
		}
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const created = createRunManifest({ cwd, team, workflow, goal: "w8" });
		const manifest = updateRunStatus(created.manifest, "running", "running");
		saveRunTasks(
			manifest,
			created.tasks.map((task) => ({
				...task,
				status: "running" as const,
				heartbeat: {
					workerId: task.id,
					lastSeenAt: "2026-01-01T00:00:00.000Z",
					alive: true,
				},
			})),
		);
		// Simulate the exit-before-manifest-update race:
		// task status is still "running" but the result artifact already exists.
		const taskId = created.tasks[0]!.id;
		const resultsDir = path.join(manifest.artifactsRoot, "results");
		fs.mkdirSync(resultsDir, { recursive: true });
		fs.writeFileSync(path.join(resultsDir, `${taskId}.txt`), "task output", "utf-8");

		const cache = createManifestCache(cwd, { watch: false, debounceMs: 0 });
		const notifications: string[] = [];
		const watcher = new HeartbeatWatcher({
			cwd,
			manifestCache: cache,
			registry: createMetricRegistry(),
			router: {
				enqueue: (n) => {
					notifications.push(n.id ?? "");
					return true;
				},
			},
			deadletterTickThreshold: 99,
		});
		const tickTime = Date.parse("2026-01-01T00:10:00.000Z"); // 10 min later → elapsed > deadMs (300s)
		watcher.tick(tickTime);
		// Result file exists → task completed → NO dead notification (downgraded to stale)
		assert.equal(
			notifications.filter((id) => id.startsWith("dead_")).length,
			0,
			"should NOT fire dead when result artifact exists (exit-before-manifest race)",
		);

		// Now remove the result file — simulates a genuine crash (no output produced)
		fs.rmSync(path.join(resultsDir, `${taskId}.txt`));
		notifications.length = 0;
		watcher.tick(tickTime + 10_000);
		// No result file → genuine stuck/crashed worker → dead fires
		assert.equal(
			notifications.filter((id) => id.startsWith("dead_")).length,
			1,
			"should fire dead when no result artifact (genuine crash)",
		);
		watcher.dispose();
		cache.dispose();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
