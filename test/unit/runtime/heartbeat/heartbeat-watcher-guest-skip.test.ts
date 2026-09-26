import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createMetricRegistry } from "../../../../src/observability/metric-registry.ts";
import { HeartbeatWatcher } from "../../../../src/runtime/heartbeat/heartbeat-watcher.ts";
import { createManifestCache } from "../../../../src/runtime/manifest-cache.ts";
import { createRunManifest, saveRunTasks, updateRunStatus } from "../../../../src/state/stores/state-store.ts";

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

function setupRun(cwd: string) {
	const created = createRunManifest({ cwd, team, workflow, goal: "guest-skip" });
	const manifest = updateRunStatus(created.manifest, "running", "running");
	return { created, manifest };
}

function makeWatcher(cwd: string, notifications: string[]) {
	const cache = createManifestCache(cwd, { watch: false, debounceMs: 0 });
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
	return { watcher, cache };
}

test("guest-child task (agent=delegate, no heartbeat channel) never classified dead", () => {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-hb-guest-skip-"));
	try {
		try {
			const r = fs.realpathSync.native(cwd);
			cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
		} catch {
			/* keep as-is */
		}
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const { manifest, created } = setupRun(cwd);
		// Guest task exactly as the delegate broker records it: agent="delegate",
		// depth 2, status running, NO heartbeat and NO agentProgress.
		saveRunTasks(manifest, [
			{
				...created.tasks[0],
				id: "gc-c7006dc3-probe",
				agent: "delegate",
				depth: 2,
				title: "delegate: probe",
				status: "running" as const,
				heartbeat: undefined,
			},
		]);
		const notifications: string[] = [];
		const { watcher, cache } = makeWatcher(cwd, notifications);
		// Long after "start" — with heartbeatAgeMs(undefined) = Infinity the old
		// code classified dead on the FIRST tick (observed 52ms after admit).
		watcher.tick(Date.parse("2026-01-01T00:30:00.000Z"));
		watcher.tick(Date.parse("2026-01-01T00:30:05.000Z"));
		watcher.tick(Date.parse("2026-01-01T00:30:10.000Z"));
		assert.deepEqual(notifications, []);
		const events = fs.readFileSync(path.join(manifest.stateRoot, "events.jsonl"), "utf-8");
		assert.ok(!events.includes("crew.task.heartbeat_dead"), "guest task must not emit heartbeat_dead");
		watcher.dispose();
		cache.dispose();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("guest skip does NOT suppress dead detection for a real sibling task", () => {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-hb-guest-skip2-"));
	try {
		try {
			const r = fs.realpathSync.native(cwd);
			cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
		} catch {
			/* keep as-is */
		}
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const { manifest, created } = setupRun(cwd);
		saveRunTasks(manifest, [
			{
				...created.tasks[0],
				id: "01_execute",
				status: "running" as const,
				heartbeat: { workerId: "01_execute", lastSeenAt: "2026-01-01T00:00:00.000Z", alive: true },
			},
			{
				...created.tasks[0],
				id: "gc-2ffe1b10-probe",
				agent: "delegate",
				depth: 2,
				title: "delegate: probe",
				status: "running" as const,
				heartbeat: undefined,
			},
		]);
		const notifications: string[] = [];
		const { watcher, cache } = makeWatcher(cwd, notifications);
		watcher.tick(Date.parse("2026-01-01T00:30:00.000Z"));
		watcher.tick(Date.parse("2026-01-01T00:30:05.000Z"));
		// The real sibling (stale heartbeat) still fires exactly once; the guest never.
		const dead = notifications.filter((id) => id.includes("01_execute"));
		assert.equal(dead.length, 1);
		assert.ok(!notifications.some((id) => id.includes("gc-2ffe1b10")));
		watcher.dispose();
		cache.dispose();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
