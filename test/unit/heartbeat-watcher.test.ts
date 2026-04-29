import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMetricRegistry } from "../../src/observability/metric-registry.ts";
import { HeartbeatWatcher } from "../../src/runtime/heartbeat-watcher.ts";
import { createRunManifest, saveRunTasks, updateRunStatus } from "../../src/state/state-store.ts";
import { createManifestCache } from "../../src/runtime/manifest-cache.ts";

const team = { name: "t", description: "", source: "test", filePath: "t", roles: [{ name: "r", agent: "a" }] } as never;
const workflow = { name: "w", description: "", source: "test", filePath: "w", steps: [{ id: "s", role: "r", task: "x" }] } as never;

test("HeartbeatWatcher emits dead notification once and triggers deadletter threshold", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-heartbeat-watcher-"));
	try {
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const created = createRunManifest({ cwd, team, workflow, goal: "hb" });
		const manifest = updateRunStatus(created.manifest, "running", "running");
		saveRunTasks(manifest, created.tasks.map((task) => ({ ...task, status: "running" as const, heartbeat: { workerId: task.id, lastSeenAt: "2026-01-01T00:00:00.000Z", alive: true } })));
		const cache = createManifestCache(cwd, { watch: false, debounceMs: 0 });
		const notifications: string[] = [];
		let deadletters = 0;
		const watcher = new HeartbeatWatcher({ cwd, manifestCache: cache, registry: createMetricRegistry(), router: { enqueue: (n) => { notifications.push(n.id ?? ""); return true; } }, deadletterTickThreshold: 3, onDeadletterTrigger: () => { deadletters += 1; } });
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
