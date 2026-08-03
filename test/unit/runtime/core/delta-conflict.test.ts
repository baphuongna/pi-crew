import assert from "node:assert/strict";
import test from "node:test";
import {
	type Conflict,
	type ConflictReport,
	type CurrentState,
	detectImportConflicts,
	detectResumeConflicts,
	type ExistingState,
	type ImportBundle,
	resolveConflict,
	type SuspendedState,
} from "../../../../src/runtime/delta-conflict.ts";

// ── detectImportConflicts ──────────────────────────────────────────────

test("detectImportConflicts returns empty report when no existing state", () => {
	const bundle: ImportBundle = {
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "impl",
			artifacts: [],
		},
		tasks: [{ id: "t1", status: "completed", role: "agent", agent: "default" }],
	};
	const result: ConflictReport = detectImportConflicts(bundle, {});
	assert.equal(result.hasConflicts, false);
	assert.equal(result.conflicts.length, 0);
	assert.equal(result.summary.errors, 0);
	assert.equal(result.summary.warnings, 0);
	assert.equal(result.summary.autoResolvable, 0);
});

test("detectImportConflicts detects schema_drift", () => {
	const bundle: ImportBundle = {
		manifest: {
			schemaVersion: 2,
			runId: "r1",
			team: "impl",
			artifacts: [],
		},
		tasks: [],
	};
	const existing: ExistingState = {
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "impl",
			artifacts: [],
		},
		tasks: [],
	};
	const result = detectImportConflicts(bundle, existing);
	assert.equal(result.hasConflicts, true);
	assert.equal(result.conflicts.length, 1);
	assert.equal(result.conflicts[0].kind, "schema_drift");
	assert.equal(result.conflicts[0].severity, "warning");
	assert.equal(result.conflicts[0].autoResolvable, true);
	assert.equal(result.conflicts[0].existing, "1");
	assert.equal(result.conflicts[0].incoming, "2");
});

test("detectImportConflicts detects file_overwrite for artifact collision", () => {
	const bundle: ImportBundle = {
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "impl",
			artifacts: [
				{
					kind: "result",
					path: "output.txt",
					createdAt: "2025-01-01",
					producer: "test",
					retention: "run",
				},
			],
		},
		tasks: [],
	};
	const existing: ExistingState = {
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "impl",
			artifacts: [
				{
					kind: "result",
					path: "output.txt",
					createdAt: "2025-01-01",
					producer: "test",
					retention: "run",
				},
			],
		},
		tasks: [],
	};
	const result = detectImportConflicts(bundle, existing);
	assert.equal(result.hasConflicts, true);
	const overwriteConflicts = result.conflicts.filter((c) => c.kind === "file_overwrite");
	assert.equal(overwriteConflicts.length, 1);
	assert.equal(overwriteConflicts[0].path, "output.txt");
	assert.equal(overwriteConflicts[0].severity, "warning");
	assert.equal(overwriteConflicts[0].autoResolvable, true);
});

test("detectImportConflicts detects state_mismatch for differing task statuses", () => {
	const bundle: ImportBundle = {
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "impl",
			artifacts: [],
		},
		tasks: [
			{ id: "t1", status: "completed", role: "agent", agent: "default" },
			{ id: "t2", status: "failed", role: "agent", agent: "default" },
		],
	};
	const existing: ExistingState = {
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "impl",
			artifacts: [],
		},
		tasks: [
			{ id: "t1", status: "running", role: "agent", agent: "default" },
			{ id: "t2", status: "failed", role: "agent", agent: "default" },
		],
	};
	const result = detectImportConflicts(bundle, existing);
	assert.equal(result.hasConflicts, true);
	const mismatchConflicts = result.conflicts.filter((c) => c.kind === "state_mismatch");
	assert.equal(mismatchConflicts.length, 1);
	assert.equal(mismatchConflicts[0].path, "tasks/t1");
	assert.equal(mismatchConflicts[0].existing, "running");
	assert.equal(mismatchConflicts[0].incoming, "completed");
	assert.equal(mismatchConflicts[0].severity, "error");
	assert.equal(mismatchConflicts[0].autoResolvable, false);
});

test("detectImportConflicts detects resource_deleted for team mismatch", () => {
	const bundle: ImportBundle = {
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "implementation",
			artifacts: [],
		},
		tasks: [],
	};
	const existing: ExistingState = {
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "review",
			artifacts: [],
		},
		tasks: [],
	};
	const result = detectImportConflicts(bundle, existing);
	const resourceConflicts = result.conflicts.filter((c) => c.kind === "resource_deleted");
	assert.equal(resourceConflicts.length, 1);
	assert.equal(resourceConflicts[0].path, "team/implementation");
	assert.equal(resourceConflicts[0].existing, "review");
	assert.equal(resourceConflicts[0].incoming, "implementation");
});

test("detectImportConflicts detects resource_deleted for workflow mismatch", () => {
	const bundle: ImportBundle = {
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "impl",
			workflow: "default",
			artifacts: [],
		},
		tasks: [],
	};
	const existing: ExistingState = {
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "impl",
			workflow: "review",
			artifacts: [],
		},
		tasks: [],
	};
	const result = detectImportConflicts(bundle, existing);
	const wfConflicts = result.conflicts.filter((c) => c.kind === "resource_deleted" && c.path.startsWith("workflow/"));
	assert.equal(wfConflicts.length, 1);
	assert.equal(wfConflicts[0].incoming, "default");
	assert.equal(wfConflicts[0].existing, "review");
});

test("detectImportConflicts detects resource_deleted for reassigned agent", () => {
	const bundle: ImportBundle = {
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "impl",
			artifacts: [],
		},
		tasks: [
			{
				id: "t1",
				status: "completed",
				role: "agent",
				agent: "new-agent",
			},
		],
	};
	const existing: ExistingState = {
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "impl",
			artifacts: [],
		},
		tasks: [
			{
				id: "t1",
				status: "completed",
				role: "agent",
				agent: "old-agent",
			},
		],
	};
	const result = detectImportConflicts(bundle, existing);
	const agentConflicts = result.conflicts.filter((c) => c.kind === "resource_deleted" && c.path.startsWith("agent/"));
	assert.equal(agentConflicts.length, 1);
	assert.equal(agentConflicts[0].path, "agent/new-agent");
});

test("detectImportConflicts returns multiple conflict types", () => {
	const bundle: ImportBundle = {
		manifest: {
			schemaVersion: 2,
			runId: "r1",
			team: "other-team",
			artifacts: [
				{
					kind: "result",
					path: "shared.txt",
					createdAt: "",
					producer: "",
					retention: "run",
				},
			],
		},
		tasks: [{ id: "t1", status: "completed", role: "agent", agent: "default" }],
	};
	const existing: ExistingState = {
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "impl",
			artifacts: [
				{
					kind: "result",
					path: "shared.txt",
					createdAt: "",
					producer: "",
					retention: "run",
				},
			],
		},
		tasks: [{ id: "t1", status: "running", role: "agent", agent: "default" }],
	};
	const result = detectImportConflicts(bundle, existing);
	assert.equal(result.hasConflicts, true);
	assert.ok(result.conflicts.length >= 3);
	assert.ok(result.conflicts.some((c) => c.kind === "schema_drift"));
	assert.ok(result.conflicts.some((c) => c.kind === "file_overwrite"));
	assert.ok(result.conflicts.some((c) => c.kind === "state_mismatch"));
	assert.ok(result.conflicts.some((c) => c.kind === "resource_deleted"));
});

test("detectImportConflicts summary counts are accurate", () => {
	const bundle: ImportBundle = {
		manifest: {
			schemaVersion: 2,
			runId: "r1",
			team: "other",
			artifacts: [],
		},
		tasks: [{ id: "t1", status: "completed", role: "agent", agent: "default" }],
	};
	const existing: ExistingState = {
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "impl",
			artifacts: [],
		},
		tasks: [{ id: "t1", status: "running", role: "agent", agent: "default" }],
	};
	const result = detectImportConflicts(bundle, existing);
	assert.equal(result.summary.errors, result.conflicts.filter((c) => c.severity === "error").length);
	assert.equal(result.summary.warnings, result.conflicts.filter((c) => c.severity === "warning").length);
	assert.equal(result.summary.autoResolvable, result.conflicts.filter((c) => c.autoResolvable).length);
});

test("detectImportConflicts handles malformed tasks gracefully", () => {
	const bundle: ImportBundle = {
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "impl",
			artifacts: [],
		},
		tasks: [null, "not-an-object", { noId: true }, { id: 123, status: 456 }],
	};
	const existing: ExistingState = {
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "impl",
			artifacts: [],
		},
		tasks: [],
	};
	const result = detectImportConflicts(bundle, existing);
	assert.equal(result.hasConflicts, false);
});

// ── detectResumeConflicts ──────────────────────────────────────────────

test("detectResumeConflicts returns empty when no changes", () => {
	const suspended: SuspendedState = {
		tasks: [{ id: "t1", status: "running" }],
		artifacts: ["output.txt"],
	};
	const current: CurrentState = {
		changedFiles: [],
		taskStatuses: {},
	};
	const result = detectResumeConflicts(suspended, current);
	assert.equal(result.hasConflicts, false);
});

test("detectResumeConflicts detects file_overwrite for changed artifacts", () => {
	const suspended: SuspendedState = {
		tasks: [],
		artifacts: ["output.txt", "log.txt"],
	};
	const current: CurrentState = {
		changedFiles: ["output.txt", "unrelated.txt"],
		taskStatuses: {},
	};
	const result = detectResumeConflicts(suspended, current);
	assert.equal(result.hasConflicts, true);
	const fileConflicts = result.conflicts.filter((c) => c.kind === "file_overwrite");
	assert.equal(fileConflicts.length, 1);
	assert.equal(fileConflicts[0].path, "output.txt");
	assert.equal(fileConflicts[0].severity, "error");
	assert.equal(fileConflicts[0].autoResolvable, false);
});

test("detectResumeConflicts detects state_mismatch for externally changed statuses", () => {
	const suspended: SuspendedState = {
		tasks: [
			{ id: "t1", status: "running" },
			{ id: "t2", status: "queued" },
		],
		artifacts: [],
	};
	const current: CurrentState = {
		changedFiles: [],
		taskStatuses: { t1: "completed" },
	};
	const result = detectResumeConflicts(suspended, current);
	assert.equal(result.hasConflicts, true);
	const mismatches = result.conflicts.filter((c) => c.kind === "state_mismatch");
	assert.equal(mismatches.length, 1);
	assert.equal(mismatches[0].path, "tasks/t1");
	assert.equal(mismatches[0].existing, "completed");
	assert.equal(mismatches[0].incoming, "running");
});

test("detectResumeConflicts reports multiple conflicts together", () => {
	const suspended: SuspendedState = {
		tasks: [{ id: "t1", status: "running" }],
		artifacts: ["out.txt"],
	};
	const current: CurrentState = {
		changedFiles: ["out.txt"],
		taskStatuses: { t1: "failed" },
	};
	const result = detectResumeConflicts(suspended, current);
	assert.equal(result.conflicts.length, 2);
	assert.ok(result.conflicts.some((c) => c.kind === "file_overwrite"));
	assert.ok(result.conflicts.some((c) => c.kind === "state_mismatch"));
	assert.equal(result.summary.errors, 2);
});

// ── resolveConflict ────────────────────────────────────────────────────

test("resolveConflict with skip always resolves", () => {
	const conflict: Conflict = {
		kind: "state_mismatch",
		path: "tasks/t1",
		existing: "running",
		incoming: "completed",
		severity: "error",
		autoResolvable: false,
	};
	const result = resolveConflict(conflict, "skip");
	assert.equal(result.resolved, true);
	assert.ok(result.action.includes("Skipped"));
});

test("resolveConflict with overwrite resolves file_overwrite", () => {
	const conflict: Conflict = {
		kind: "file_overwrite",
		path: "output.txt",
		severity: "warning",
		autoResolvable: true,
	};
	const result = resolveConflict(conflict, "overwrite");
	assert.equal(result.resolved, true);
	assert.ok(result.action.includes("Overwritten"));
});

test("resolveConflict with overwrite resolves schema_drift", () => {
	const conflict: Conflict = {
		kind: "schema_drift",
		path: "manifest.schemaVersion",
		existing: "1",
		incoming: "2",
		severity: "warning",
		autoResolvable: true,
	};
	const result = resolveConflict(conflict, "overwrite");
	assert.equal(result.resolved, true);
});

test("resolveConflict with overwrite does not resolve state_mismatch", () => {
	const conflict: Conflict = {
		kind: "state_mismatch",
		path: "tasks/t1",
		severity: "error",
		autoResolvable: false,
	};
	const result = resolveConflict(conflict, "overwrite");
	assert.equal(result.resolved, false);
});

test("resolveConflict with overwrite does not resolve resource_deleted", () => {
	const conflict: Conflict = {
		kind: "resource_deleted",
		path: "team/impl",
		severity: "warning",
		autoResolvable: true,
	};
	const result = resolveConflict(conflict, "overwrite");
	assert.equal(result.resolved, false);
});

test("resolveConflict with merge resolves state_mismatch", () => {
	const conflict: Conflict = {
		kind: "state_mismatch",
		path: "tasks/t1",
		existing: "running",
		incoming: "completed",
		severity: "error",
		autoResolvable: false,
	};
	const result = resolveConflict(conflict, "merge");
	assert.equal(result.resolved, true);
	assert.ok(result.action.includes("Merged"));
});

test("resolveConflict with merge resolves resource_deleted", () => {
	const conflict: Conflict = {
		kind: "resource_deleted",
		path: "team/impl",
		severity: "warning",
		autoResolvable: true,
	};
	const result = resolveConflict(conflict, "merge");
	assert.equal(result.resolved, true);
});

test("resolveConflict with merge resolves file_overwrite", () => {
	const conflict: Conflict = {
		kind: "file_overwrite",
		path: "output.txt",
		severity: "warning",
		autoResolvable: true,
	};
	const result = resolveConflict(conflict, "merge");
	assert.equal(result.resolved, true);
	assert.ok(result.action.includes("both"));
});

test("resolveConflict with merge resolves schema_drift", () => {
	const conflict: Conflict = {
		kind: "schema_drift",
		path: "manifest.schemaVersion",
		severity: "warning",
		autoResolvable: true,
	};
	const result = resolveConflict(conflict, "merge");
	assert.equal(result.resolved, true);
});
