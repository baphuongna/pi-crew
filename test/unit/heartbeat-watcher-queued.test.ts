import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMetricRegistry } from "../../src/observability/metric-registry.ts";
import { HeartbeatWatcher } from "../../src/runtime/heartbeat-watcher.ts";
import { createManifestCache } from "../../src/runtime/manifest-cache.ts";
import { createRunManifest, saveRunTasks, updateRunStatus } from "../../src/state/state-store.ts";

const team = { name: "t", description: "", source: "test", filePath: "t", roles: [{ name: "r", agent: "a" }] } as never;
const workflow = { name: "w", description: "", source: "test", filePath: "w", steps: [{ id: "s", role: "r", task: "x" }] } as never;

test("HeartbeatWatcher ignores queued tasks without worker heartbeat", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-heartbeat-queued-"));
	try {
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const created = createRunManifest({ cwd, team, workflow, goal: "queued" });
		const manifest = updateRunStatus(created.manifest, "running", "running");
		saveRunTasks(manifest, created.tasks.map((task) => ({ ...task, status: "queued" as const, heartbeat: undefined })));
		const cache = createManifestCache(cwd, { watch: false, debounceMs: 0 });
		let notifications = 0;
		let deadletters = 0;
		const watcher = new HeartbeatWatcher({ cwd, manifestCache: cache, registry: createMetricRegistry(), router: { enqueue: () => { notifications += 1; return true; } }, deadletterTickThreshold: 1, onDeadletterTrigger: () => { deadletters += 1; } });
		watcher.tick(Date.parse("2026-01-01T00:10:00.000Z"));
		assert.equal(notifications, 0);
		assert.equal(deadletters, 0);
		watcher.dispose();
		cache.dispose();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
