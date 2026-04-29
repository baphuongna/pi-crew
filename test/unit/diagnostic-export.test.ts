import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendEvent } from "../../src/state/event-log.ts";
import { createRunManifest, saveRunTasks } from "../../src/state/state-store.ts";
import { exportDiagnostic, listRecentDiagnostic, redactSecrets } from "../../src/runtime/diagnostic-export.ts";
import { createMetricRegistry } from "../../src/observability/metric-registry.ts";

test("redactSecrets masks sensitive keys recursively", () => {
	assert.deepEqual(redactSecrets({ apiKey: "abc", nested: { password: "pw", ok: "yes" } }), { apiKey: "***", nested: { password: "***", ok: "yes" } });
});

test("exportDiagnostic writes JSON report with redacted task data", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-diag-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const team = { name: "diag", description: "", roles: [{ name: "worker", agent: "worker" }], source: "test", filePath: "builtin" } as never;
		const workflow = { name: "wf", description: "", steps: [{ id: "one", role: "worker" }], source: "test", filePath: "builtin" } as never;
		const created = createRunManifest({ cwd, team, workflow, goal: "diag" });
		saveRunTasks(created.manifest, created.tasks.map((task) => ({ ...task, error: "secret_token=abc", heartbeat: { workerId: task.id, lastSeenAt: created.manifest.createdAt, alive: true } })));
		appendEvent(created.manifest.eventsPath, { type: "task.progress", runId: created.manifest.runId, taskId: "one", data: { token: "abc" } });
		const exported = await exportDiagnostic({ cwd }, created.manifest.runId);
		assert.equal(fs.existsSync(exported.path), true);
		const text = fs.readFileSync(exported.path, "utf-8");
		assert.match(text, /"heartbeat"/);
		assert.doesNotMatch(text, /"abc"/);
		assert.equal(listRecentDiagnostic(path.dirname(exported.path), 60_000) !== undefined, true);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("exportDiagnostic includes redacted metrics snapshot when registry is provided", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-diag-metrics-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const team = { name: "diag", description: "", roles: [{ name: "worker", agent: "worker" }], source: "test", filePath: "builtin" } as never;
		const workflow = { name: "wf", description: "", steps: [{ id: "one", role: "worker" }], source: "test", filePath: "builtin" } as never;
		const created = createRunManifest({ cwd, team, workflow, goal: "diag" });
		const registry = createMetricRegistry();
		registry.counter("crew.run.count", "runs").inc({ auth_token: "abc" });
		const exported = await exportDiagnostic({ cwd }, created.manifest.runId, { registry });
		assert.equal(exported.report.schemaVersion, 2);
		assert.ok(exported.report.metricsSnapshot);
		assert.doesNotMatch(fs.readFileSync(exported.path, "utf-8"), /abc/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("listRecentDiagnostic returns undefined for missing directories", () => {
	assert.equal(listRecentDiagnostic(path.join(os.tmpdir(), "missing-pi-crew-diag"), 60_000), undefined);
});
