/**
 * no-op-writers-no-crew-root.test.ts — RR-020 Fix 2 regression.
 *
 * Session start attaches three "session writers" that used to MATERIALISE
 * `<crewRoot>/` even when they had nothing to record:
 *   1. run-maintenance.appendPruneAudit() — mkdir `<crewRoot>/audit/` + append
 *      a line on every prune, including a prune of zero candidates.
 *   2. observability/metric-sink writeSnapshot() — ensureFd() mkdir'd
 *      `<crewRoot>/state/metrics/` and appended `snapshots: []` every 60s tick.
 *   3. notification-sink write() — mkdir'd `<crewRoot>/state/notifications/`
 *      for ANY notification, and the router calls the sink BEFORE its severity
 *      filter (notification-router.ts), so `info` notices created the root too.
 *
 * Acceptance: for a project with NO crew root, none of these writers may create
 * one. Positive controls (crew root already present) prove the gate does not
 * silently break real writes.
 *
 * Isolation: each case uses a fresh temp project cwd (with a `.git` marker so
 * findRepoRoot resolves INSIDE the temp tree — bug-029 lesson) and asserts on
 * `projectCrewRoot(cwd)` rather than a literal `.crew`/`.pi/teams` path.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
// Side-effect imports of the modules under test (dynamic-style resolution is
// unnecessary here — all three are plain modules).
import { createJsonlSink } from "../../../src/extension/notification-sink.ts";
import { pruneFinishedRuns } from "../../../src/extension/run-maintenance.ts";
import { createMetricRegistry } from "../../../src/observability/metric-registry.ts";
import { createMetricFileSink } from "../../../src/observability/metric-sink.ts";
import { clearProjectRootCache, projectCrewRoot } from "../../../src/utils/paths.ts";

/** Temp project dir with a `.git` marker; NO crew root (that is the point). */
function makeBareProject(prefix: string): string {
	let dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		const real = fs.realpathSync.native(dir);
		dir = real.startsWith("\\\\?\\") ? real.slice(4) : real;
	} catch {
		/* keep as-is */
	}
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	clearProjectRootCache();
	return dir;
}

function cleanup(dir: string): void {
	clearProjectRootCache();
	fs.rmSync(dir, { recursive: true, force: true });
}

test("prune audit: no crew root ⇒ no directory created and no auditPath", () => {
	const project = makeBareProject("pi-crew-noop-prune-");
	try {
		const crewRoot = projectCrewRoot(project);
		assert.equal(fs.existsSync(crewRoot), false, "fixture: project starts without a crew root");

		const result = pruneFinishedRuns(project, 5);

		assert.deepEqual(result.removed, []);
		assert.equal(result.auditPath, undefined, "a no-op prune must not write an audit");
		assert.equal(fs.existsSync(crewRoot), false, "prune must not materialise the crew root");
		assert.equal(fs.existsSync(path.join(project, ".crew")), false, "no .crew/ either");
	} finally {
		cleanup(project);
	}
});

test("prune audit: an existing crew root still gets its audit line (positive control)", () => {
	const project = makeBareProject("pi-crew-noop-prune-pos-");
	try {
		const crewRoot = projectCrewRoot(project);
		fs.mkdirSync(path.join(crewRoot, "state", "runs"), { recursive: true });
		const runsDir = path.join(crewRoot, "state", "runs");
		// One finished run so prune has a candidate (and a real prune to audit).
		const runId = "run-1";
		const stateRoot = path.join(runsDir, runId);
		const artifactsRoot = path.join(crewRoot, "artifacts", runId);
		fs.mkdirSync(stateRoot, { recursive: true });
		fs.mkdirSync(artifactsRoot, { recursive: true });
		const manifest = {
			schemaVersion: 1,
			runId,
			team: "test",
			goal: "test",
			status: "completed",
			workspaceMode: "single",
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			cwd: project,
			stateRoot,
			artifactsRoot,
			tasksPath: path.join(stateRoot, "tasks.json"),
			eventsPath: path.join(stateRoot, "events.jsonl"),
			artifacts: [],
		};
		fs.writeFileSync(path.join(stateRoot, "manifest.json"), JSON.stringify(manifest));
		fs.writeFileSync(path.join(stateRoot, "tasks.json"), "[]");
		fs.writeFileSync(path.join(stateRoot, "events.jsonl"), "");

		const result = pruneFinishedRuns(project, 0);

		assert.deepEqual(result.removed, [runId]);
		assert.equal(typeof result.auditPath, "string", "a real prune still writes its audit");
		assert.ok(fs.existsSync(result.auditPath!), "audit file exists");
	} finally {
		cleanup(project);
	}
});

test("metric sink: a PRODUCTION-shaped snapshot (metrics registered at init) ⇒ no crew root", async () => {
	const project = makeBareProject("pi-crew-noop-metric-");
	try {
		const crewRoot = projectCrewRoot(project);
		// Cold-verify correction: the first version of this test used a BARE
		// registry (snapshot() === []) — but production wires
		// wireEventToMetrics(), which registers ~15 metrics at init, so the
		// snapshot is NEVER empty and the old "skip empty snapshots" guard was
		// dead code. Mirror the production shape: counters/gauges registered,
		// no values recorded.
		const registry = createMetricRegistry();
		registry.counter("crew.run.count", "Total runs by status");
		registry.counter("crew.task.count", "Total tasks by status");
		registry.gauge("crew.heartbeat.staleness_ms", "Heartbeat elapsed since last seen, milliseconds");
		const sink = createMetricFileSink({ crewRoot, registry, intervalMs: 60_000 });
		try {
			const snap = registry.snapshot();
			assert.ok(snap.length > 0, `fixture: production-shaped snapshot (got ${snap.length})`);
			await sink.writeSnapshot(snap);
			await sink.writeSnapshot([]);
			assert.equal(fs.existsSync(crewRoot), false, "non-empty snapshots must not materialise the crew root either");
			assert.equal(fs.existsSync(path.join(crewRoot, "state", "metrics")), false, "no metrics dir");
		} finally {
			sink.dispose();
		}
	} finally {
		cleanup(project);
	}
});

test("metric sink: crew root EXISTS ⇒ empty tick still writes (HEAD parity)", async () => {
	const project = makeBareProject("pi-crew-noop-metric-parity-");
	try {
		const crewRoot = projectCrewRoot(project);
		fs.mkdirSync(crewRoot, { recursive: true }); // crew root exists (a run happened)
		const registry = createMetricRegistry();
		const sink = createMetricFileSink({ crewRoot, registry, intervalMs: 60_000 });
		try {
			await sink.writeSnapshot([]);
			const metricsDir = path.join(crewRoot, "state", "metrics");
			assert.ok(fs.existsSync(metricsDir), "metrics dir created once the crew root exists");
			const files = fs.readdirSync(metricsDir).filter((f) => f.endsWith(".jsonl"));
			assert.equal(files.length, 1, "exactly one daily file");
			const line = JSON.parse(fs.readFileSync(path.join(metricsDir, files[0]), "utf-8").trim());
			assert.deepEqual(line.snapshots, [], "empty tick still recorded (HEAD parity — not suppressed)");
		} finally {
			sink.dispose();
		}
	} finally {
		cleanup(project);
	}
});

test("metric sink: crew root EXISTS ⇒ real snapshot still writes (positive control)", async () => {
	const project = makeBareProject("pi-crew-noop-metric-pos-");
	try {
		const crewRoot = projectCrewRoot(project);
		fs.mkdirSync(crewRoot, { recursive: true }); // a run happened ⇒ crew root exists
		const registry = createMetricRegistry();
		registry.counter("crew.noop.count", "test").inc({}, 1);
		const sink = createMetricFileSink({ crewRoot, registry, intervalMs: 60_000 });
		try {
			await sink.writeSnapshot(registry.snapshot());
			const metricsDir = path.join(crewRoot, "state", "metrics");
			assert.ok(fs.existsSync(metricsDir), "metrics dir created for a real snapshot");
			const files = fs.readdirSync(metricsDir).filter((f) => f.endsWith(".jsonl"));
			assert.equal(files.length, 1);
			assert.match(fs.readFileSync(path.join(metricsDir, files[0]!), "utf-8"), /crew\.noop\.count/);
		} finally {
			sink.dispose();
		}
	} finally {
		cleanup(project);
	}
});

test("notification sink: no crew root ⇒ nothing created for an info notification", () => {
	const project = makeBareProject("pi-crew-noop-notify-");
	try {
		const crewRoot = projectCrewRoot(project);
		const sink = createJsonlSink(crewRoot, 7);
		// `info` is exactly what the router forwards to the sink before filtering.
		sink.write({ severity: "info", source: "session", title: "session started", timestamp: Date.parse("2026-01-02T00:00:00Z") });
		sink.write({ severity: "warning", source: "session", title: "still nothing to persist to" });
		sink.dispose();

		assert.equal(fs.existsSync(crewRoot), false, "notification sink must not materialise the crew root");
		assert.equal(fs.existsSync(path.join(crewRoot, "state", "notifications")), false, "no notifications dir");
	} finally {
		cleanup(project);
	}
});

test("notification sink: an existing crew root still persists notifications (positive control)", () => {
	const project = makeBareProject("pi-crew-noop-notify-pos-");
	try {
		const crewRoot = projectCrewRoot(project);
		fs.mkdirSync(path.join(crewRoot, "state", "runs"), { recursive: true });
		const sink = createJsonlSink(crewRoot, 7);
		sink.write({ severity: "warning", source: "test", title: "hello", timestamp: Date.parse("2026-01-02T00:00:00Z") });
		sink.dispose();

		const file = path.join(crewRoot, "state", "notifications", "2026-01-02.jsonl");
		assert.ok(fs.existsSync(file), "notification persisted when the crew root exists");
		assert.match(fs.readFileSync(file, "utf-8"), /hello/);
	} finally {
		cleanup(project);
	}
});

// ── RR-020 cold-verify correction: audit parity when the crew root EXISTS ──
// The first version added `finished.length === 0` to the bail-out, which also
// suppressed the audit line for a REAL prune over an existing crew root that
// simply found nothing — a HEAD behavior change beyond the fix's scope.

test("prune audit: crew root EXISTS ⇒ zero-candidate prune still audits (HEAD parity)", () => {
	const project = makeBareProject("pi-crew-noop-prune-parity-");
	try {
		const crewRoot = projectCrewRoot(project);
		fs.mkdirSync(path.join(crewRoot, "state", "runs"), { recursive: true }); // no runs inside
		const result = pruneFinishedRuns(project, 5);
		assert.deepEqual(result.removed, []);
		assert.equal(typeof result.auditPath, "string", "zero-candidate prune over an existing crew root still audits");
		assert.ok(fs.existsSync(result.auditPath!), "audit file exists");
		const line = JSON.parse(fs.readFileSync(result.auditPath!, "utf-8").trim());
		assert.equal(line.action, "prune");
		assert.deepEqual(line.kept, []);
		assert.deepEqual(line.removed, []);
	} finally {
		cleanup(project);
	}
});
