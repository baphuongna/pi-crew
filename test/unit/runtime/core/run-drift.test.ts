import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { DriftContext } from "../../../../src/runtime/run-drift.ts";
import {
	detectMissingTimestamps,
	detectOrphanedClaim,
	detectOrphanedWorktree,
	detectStatusDivergence,
	detectUnregisteredRun,
	runDriftDetection,
} from "../../../../src/runtime/run-drift.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeCtx(overrides: Partial<DriftContext> & { crewRoot: string }): DriftContext {
	return {
		activeRunIds: new Set(),
		...overrides,
	};
}

describe("run-drift: detectOrphanedClaim", () => {
	it("returns null when no claims directory exists", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const ctx = makeCtx({ crewRoot: dir });
		const result = detectOrphanedClaim(ctx);
		assert.equal(result, null);
		removeTrackedTempDir(dir);
	});

	it("returns null when claim matches a task in manifest", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const claimsDir = path.join(dir, "state", "task-claims");
		fs.mkdirSync(claimsDir, { recursive: true });
		fs.writeFileSync(path.join(claimsDir, "claim-1.json"), JSON.stringify({ runId: "run-1", taskId: "task-a" }));
		const ctx = makeCtx({
			crewRoot: dir,
			manifest: {
				runId: "run-1",
				status: "running",
				cwd: "/tmp",
				tasks: [{ id: "task-a" }],
			},
		});
		const result = detectOrphanedClaim(ctx);
		assert.equal(result, null);
		removeTrackedTempDir(dir);
	});

	it("detects orphaned claim referencing non-existent task", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const claimsDir = path.join(dir, "state", "task-claims");
		fs.mkdirSync(claimsDir, { recursive: true });
		fs.writeFileSync(path.join(claimsDir, "claim-1.json"), JSON.stringify({ runId: "run-1", taskId: "nonexistent-task" }));
		const ctx = makeCtx({
			crewRoot: dir,
			manifest: {
				runId: "run-1",
				status: "running",
				cwd: "/tmp",
				tasks: [{ id: "task-a" }],
			},
		});
		const result = detectOrphanedClaim(ctx);
		assert.ok(result);
		assert.equal(result!.kind, "orphaned-claim");
		assert.ok(result!.details.includes("nonexistent-task"));
		removeTrackedTempDir(dir);
	});

	it("returns null when manifest is undefined", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const ctx = makeCtx({ crewRoot: dir });
		const result = detectOrphanedClaim(ctx);
		assert.equal(result, null);
		removeTrackedTempDir(dir);
	});

	it("skips malformed claim files", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const claimsDir = path.join(dir, "state", "task-claims");
		fs.mkdirSync(claimsDir, { recursive: true });
		fs.writeFileSync(path.join(claimsDir, "bad.json"), "not valid json{{{");
		const ctx = makeCtx({
			crewRoot: dir,
			manifest: {
				runId: "run-1",
				status: "running",
				cwd: "/tmp",
				tasks: [],
			},
		});
		const result = detectOrphanedClaim(ctx);
		assert.equal(result, null);
		removeTrackedTempDir(dir);
	});
});

describe("run-drift: detectOrphanedWorktree", () => {
	it("returns null when no worktrees directory exists", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const ctx = makeCtx({ crewRoot: dir });
		const result = detectOrphanedWorktree(ctx);
		assert.equal(result, null);
		removeTrackedTempDir(dir);
	});

	it("detects worktree with no active run", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const wtDir = path.join(dir, "worktrees", "stale-dir");
		fs.mkdirSync(wtDir, { recursive: true });
		const ctx = makeCtx({
			crewRoot: dir,
			activeRunIds: new Set(["other-run"]),
		});
		const result = detectOrphanedWorktree(ctx);
		assert.ok(result);
		assert.equal(result!.kind, "orphaned-worktree");
		removeTrackedTempDir(dir);
	});

	it("returns null when worktree belongs to active run", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const wtDir = path.join(dir, "worktrees", "active-run-01");
		fs.mkdirSync(wtDir, { recursive: true });
		const ctx = makeCtx({
			crewRoot: dir,
			activeRunIds: new Set(["active-run-01"]),
		});
		const result = detectOrphanedWorktree(ctx);
		assert.equal(result, null);
		removeTrackedTempDir(dir);
	});
});

describe("run-drift: detectMissingTimestamps", () => {
	it("returns null when manifest has timestamps", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const ctx = makeCtx({
			crewRoot: dir,
			manifest: {
				runId: "run-1",
				status: "running",
				cwd: "/tmp",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		});
		const result = detectMissingTimestamps(ctx);
		assert.equal(result, null);
		removeTrackedTempDir(dir);
	});

	it("detects missing timestamps", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const stateDir = path.join(dir, "state");
		fs.mkdirSync(stateDir, { recursive: true });
		const ctx = makeCtx({
			crewRoot: dir,
			manifest: { runId: "run-1", status: "running", cwd: "/tmp" },
		});
		const result = detectMissingTimestamps(ctx);
		assert.ok(result);
		assert.equal(result!.kind, "missing-timestamps");
		removeTrackedTempDir(dir);
	});

	it("returns null when manifest is undefined", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const ctx = makeCtx({ crewRoot: dir });
		const result = detectMissingTimestamps(ctx);
		assert.equal(result, null);
		removeTrackedTempDir(dir);
	});
});

describe("run-drift: detectStatusDivergence", () => {
	it("returns null when status file matches manifest", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const stateDir = path.join(dir, "state");
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "run-1.status"), "running");
		const ctx = makeCtx({
			crewRoot: dir,
			manifest: { runId: "run-1", status: "running", cwd: "/tmp" },
		});
		const result = detectStatusDivergence(ctx);
		assert.equal(result, null);
		removeTrackedTempDir(dir);
	});

	it("detects divergence between manifest and status file", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const stateDir = path.join(dir, "state");
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "run-1.status"), "completed");
		const ctx = makeCtx({
			crewRoot: dir,
			manifest: { runId: "run-1", status: "running", cwd: "/tmp" },
		});
		const result = detectStatusDivergence(ctx);
		assert.ok(result);
		assert.equal(result!.kind, "status-divergence");
		assert.ok(result!.details.includes("running"));
		assert.ok(result!.details.includes("completed"));
		removeTrackedTempDir(dir);
	});

	it("returns null when no status file exists", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const ctx = makeCtx({
			crewRoot: dir,
			manifest: { runId: "run-1", status: "running", cwd: "/tmp" },
		});
		const result = detectStatusDivergence(ctx);
		assert.equal(result, null);
		removeTrackedTempDir(dir);
	});

	it("returns null when manifest is undefined", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const ctx = makeCtx({ crewRoot: dir });
		const result = detectStatusDivergence(ctx);
		assert.equal(result, null);
		removeTrackedTempDir(dir);
	});
});

describe("run-drift: detectUnregisteredRun", () => {
	it("returns null when no runs directory exists", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const ctx = makeCtx({ crewRoot: dir });
		const result = detectUnregisteredRun(ctx);
		assert.equal(result, null);
		removeTrackedTempDir(dir);
	});

	it("returns null when all run dirs are in activeRunIds", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const runsDir = path.join(dir, "runs", "active-run-1");
		fs.mkdirSync(runsDir, { recursive: true });
		fs.writeFileSync(path.join(runsDir, "manifest.json"), JSON.stringify({ runId: "active-run-1" }));
		// Make it old enough (>1 hour)
		const oneHourAgo = Date.now() - 61 * 60 * 1000;
		fs.utimesSync(path.join(runsDir, "manifest.json"), new Date(oneHourAgo), new Date(oneHourAgo));

		const ctx = makeCtx({
			crewRoot: dir,
			activeRunIds: new Set(["active-run-1"]),
		});
		const result = detectUnregisteredRun(ctx);
		assert.equal(result, null);
		removeTrackedTempDir(dir);
	});

	it("detects unregistered run with old manifest", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const runDir = path.join(dir, "runs", "old-run-1");
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({ runId: "old-run-1" }));
		// Make it old enough (>1 hour)
		const oneHourAgo = Date.now() - 61 * 60 * 1000;
		fs.utimesSync(path.join(runDir, "manifest.json"), new Date(oneHourAgo), new Date(oneHourAgo));

		const ctx = makeCtx({
			crewRoot: dir,
			activeRunIds: new Set(["other-run"]),
		});
		const result = detectUnregisteredRun(ctx);
		assert.ok(result);
		assert.equal(result!.kind, "unregistered-run");
		assert.equal(result!.runId, "old-run-1");
		removeTrackedTempDir(dir);
	});

	it("ignores recently created unregistered runs", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const runDir = path.join(dir, "runs", "fresh-run-1");
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({ runId: "fresh-run-1" }));

		const ctx = makeCtx({
			crewRoot: dir,
			activeRunIds: new Set(["other-run"]),
		});
		const result = detectUnregisteredRun(ctx);
		assert.equal(result, null);
		removeTrackedTempDir(dir);
	});
});

describe("run-drift: runDriftDetection", () => {
	it("returns empty array when no drift is detected", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const ctx = makeCtx({ crewRoot: dir });
		const reports = runDriftDetection(ctx);
		assert.ok(Array.isArray(reports));
		assert.equal(reports.length, 0);
		removeTrackedTempDir(dir);
	});

	it("collects multiple drift reports", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const stateDir = path.join(dir, "state");
		fs.mkdirSync(stateDir, { recursive: true });

		// Trigger missing-timestamps
		// Trigger status-divergence
		fs.writeFileSync(path.join(stateDir, "run-1.status"), "completed");

		const ctx = makeCtx({
			crewRoot: dir,
			manifest: { runId: "run-1", status: "running", cwd: "/tmp" },
		});
		const reports = runDriftDetection(ctx);
		assert.ok(reports.length >= 1);
		const kinds = reports.map((r) => r.kind);
		assert.ok(kinds.includes("status-divergence"));
		removeTrackedTempDir(dir);
	});

	it("respects maxPasses parameter", () => {
		const dir = createTrackedTempDir("pi-crew-drift-");
		const ctx = makeCtx({ crewRoot: dir });
		// Run with maxPasses=0 — should return empty
		const reports = runDriftDetection(ctx, 0);
		assert.equal(reports.length, 0);
		removeTrackedTempDir(dir);
	});
});
