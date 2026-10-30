/**
 * N3 regression (security-audit run-1, w9 loader-level hardening): the tasks.json /
 * manifest.json load seam cast worker-writable persisted state straight to
 * TeamTaskState[]/TeamRunManifest, so poisoned fields re-entered resume/recovery
 * dispatch as execution authority (forged role → permissionForRole; forged runKind
 * selected the resume engine). These tests pin the loader contract:
 *
 *  (a) poisoned v0 bare-array tasks.json (foreign-runId entry + shape-invalid
 *      entries) → valid tasks survive, poison DROPPED with anomaly logs;
 *  (b) schemaVersion 999 + known runKind still LOADS (forward compat) and an
 *      UNKNOWN runKind normalizes to "team-run" with a warn anomaly — never a
 *      throw (mirrors the `?? "team-run"` consumer at team-tool.ts:673);
 *  (c) an oversized tasks array truncates at MAX_LOADED_TASKS (DoG guard);
 *  (d) clean legacy v0 + v1 envelopes still load byte-identical (control).
 *
 * Plus the end-to-end loader path (loadRunManifestById) — the same seam
 * team-tool handleResume dispatches from.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
	loadManifestWithRecovery,
	loadTasksWithRecovery,
	loadTasksWithRecoveryAsync,
	MAX_LOADED_TASKS,
	sanitizeLoadedTasks,
} from "../../../src/state/stores/manifest-io.ts";
import { __test__clearManifestCache, createRunManifest, loadRunManifestById } from "../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../src/state/types.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../fixtures/test-tempdir.ts";

/** Spy on console.error (logInternalError sink); returns collected lines. */
function spyConsoleError(): { lines: string[]; restore(): void } {
	const original = console.error;
	const lines: string[] = [];
	console.error = (...args: unknown[]) => {
		lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
	};
	return { lines, restore: () => (console.error = original) };
}

const team: TeamConfig = {
	name: "n3-team",
	description: "N3 load-validation fixture team",
	source: "builtin",
	filePath: "n3.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

const singleStepWorkflow: WorkflowConfig = {
	name: "n3-workflow",
	description: "N3 load-validation fixture workflow",
	source: "builtin",
	filePath: "n3.workflow.md",
	steps: [{ id: "step1", role: "executor", task: "Do N3 thing" }],
};

function validTask(runId: string, id: string): TeamTaskState {
	return {
		id,
		runId,
		stepId: "step1",
		role: "executor",
		agent: "executor",
		title: `Task ${id}`,
		description: "fixture task",
		status: "failed",
		dependsOn: [],
		cwd: "/tmp/n3-fixture-cwd",
	};
}

// ── (a) poisoned v0 bare array: poison dropped, valid tasks survive ──────────

test("N3 (a): poisoned v0 bare-array tasks.json — foreign-runId + shape-invalid entries are dropped, valid tasks survive", async () => {
	const dir = createTrackedTempDir("n3-poison-");
	try {
		const runId = "team_n3_poison_run";
		const tasksPath = path.join(dir, "tasks.json");
		const eventsPath = path.join(dir, "events.jsonl");
		fs.writeFileSync(eventsPath, "", "utf-8");
		fs.writeFileSync(
			tasksPath,
			JSON.stringify([
				validTask(runId, "01_ok"), // survives
				{ ...validTask("team_FOREIGN_run", "02_foreign"), role: "executor", cwd: "/outside/repo" }, // foreign runId → dropped
				{ ...validTask(runId, "03_bad_role"), role: 42 }, // role not a string → dropped
				{ id: "04_no_fields" }, // missing runId/role/agent/title/status → dropped
				{ ...validTask(runId, "05_bad_depends"), dependsOn: "not-an-array" }, // dependsOn not array → dropped
				{ ...validTask(runId, "06_bad_cwd"), cwd: 1234 }, // cwd not a string → dropped
				"just a string", // not an object → dropped
				null, // null → dropped
				validTask(runId, "09_ok"), // survives
			]),
			"utf-8",
		);

		const spy = spyConsoleError();
		try {
			const loaded = loadTasksWithRecovery(tasksPath, eventsPath, runId);
			assert.deepEqual(
				loaded.map((t) => t.id),
				["01_ok", "09_ok"],
				"only the two well-formed, run-bound tasks survive",
			);
			assert.equal(loaded[0].role, "executor");
			assert.equal(loaded[0].dependsOn.length, 0);
		} finally {
			spy.restore();
		}
		// Anomaly logs fired (fail-closed drops are observable, not silent).
		assert.match(spy.lines.join("\n"), /N3: .*failed shape validation and were DROPPED/, "shape anomaly logged");
		assert.match(spy.lines.join("\n"), /foreign runId and was DROPPED/, "foreign-runId anomaly logged");
		// The file was NOT rewritten (drop is in-memory; poison preserved for forensics).
		const onDisk = JSON.parse(fs.readFileSync(tasksPath, "utf-8")) as unknown[];
		assert.equal(onDisk.length, 9, "tasks.json untouched by the drop");
	} finally {
		await removeTrackedTempDir(dir);
	}
});

// ── (b) manifest: forward compat + unknown runKind normalization ─────────────

test("N3 (b): schemaVersion 999 + KNOWN runKind 'goal-loop' still LOADS (forward compat — no drop, no throw)", () => {
	const dir = createTrackedTempDir("n3-compat-");
	try {
		const manifestPath = path.join(dir, "manifest.json");
		const manifest = {
			schemaVersion: 999,
			runId: "team_n3_compat",
			team: "n3-team",
			goal: "compat test",
			status: "failed",
			cwd: dir,
			runKind: "goal-loop",
		};
		fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");
		const spy = spyConsoleError();
		try {
			const loaded = loadManifestWithRecovery(manifestPath, "team_n3_compat");
			assert.ok(loaded, "future-version + known-runKind manifest must still load");
			assert.equal(loaded.runKind, "goal-loop", "known runKind preserved verbatim");
			assert.equal(loaded.schemaVersion, 999, "forged/future schemaVersion passes through (warn-only)");
		} finally {
			spy.restore();
		}
	} finally {
		removeTrackedTempDir(dir);
	}
});

test("N3 (b): UNKNOWN runKind normalizes to 'team-run' with a warn anomaly — never a throw", () => {
	const dir = createTrackedTempDir("n3-runkind-");
	try {
		const manifestPath = path.join(dir, "manifest.json");
		for (const poison of ["exec-loop", "", 42, null, { evil: true }]) {
			fs.writeFileSync(manifestPath, JSON.stringify({ runId: "team_n3_rk", status: "failed", runKind: poison }), "utf-8");
			const spy = spyConsoleError();
			try {
				const loaded = loadManifestWithRecovery(manifestPath, "team_n3_rk");
				assert.ok(loaded, "unknown runKind must not hide the run");
				assert.equal(loaded.runKind, "team-run", `runKind ${JSON.stringify(poison)} normalized to team-run`);
			} finally {
				spy.restore();
			}
			assert.match(spy.lines.join("\n"), /is not a known run kind/, "warn anomaly logged");
		}
	} finally {
		removeTrackedTempDir(dir);
	}
});

test("N3 (b): manifest without runKind (legacy) passes through unchanged with no anomaly", () => {
	const dir = createTrackedTempDir("n3-legacy-");
	try {
		const manifestPath = path.join(dir, "manifest.json");
		fs.writeFileSync(manifestPath, JSON.stringify({ runId: "team_n3_legacy", status: "completed" }), "utf-8");
		const spy = spyConsoleError();
		try {
			const loaded = loadManifestWithRecovery(manifestPath, "team_n3_legacy");
			assert.ok(loaded);
			assert.equal("runKind" in loaded, false, "absent runKind stays absent (consumer defaults it)");
		} finally {
			spy.restore();
		}
		assert.equal(spy.lines.length, 0, "no anomaly for a legacy manifest");
	} finally {
		removeTrackedTempDir(dir);
	}
});

test("N3: loadManifestWithRecovery fails closed on a non-object payload (null/42/array) — quarantined, not cast", () => {
	const dir = createTrackedTempDir("n3-nonobj-");
	try {
		for (const payload of ["null", "42", '"a string"', "[1,2,3]"]) {
			const manifestPath = path.join(dir, "manifest.json");
			fs.writeFileSync(manifestPath, payload, "utf-8");
			const spy = spyConsoleError();
			try {
				const loaded = loadManifestWithRecovery(manifestPath, "team_n3_nonobj");
				assert.equal(loaded, undefined, `${payload} is not a manifest — fail closed`);
			} finally {
				spy.restore();
			}
			assert.match(spy.lines.join("\n"), /not a JSON object/, "fail-closed anomaly logged");
			assert.ok(
				fs.readdirSync(dir).some((f) => f.startsWith("manifest.json.corrupt-")),
				"non-object payload quarantined",
			);
			fs.rmSync(path.join(dir, "manifest.json"), { force: true });
			for (const f of fs.readdirSync(dir)) {
				if (f.startsWith("manifest.json.corrupt-")) fs.rmSync(path.join(dir, f));
			}
		}
	} finally {
		removeTrackedTempDir(dir);
	}
});

// ── (c) oversized array truncates at the DoG cap ─────────────────────────────

test("N3 (c): oversized tasks array truncates at MAX_LOADED_TASKS with an anomaly log", async () => {
	const dir = createTrackedTempDir("n3-dog-");
	try {
		const runId = "team_n3_dog";
		const tasksPath = path.join(dir, "tasks.json");
		const eventsPath = path.join(dir, "events.jsonl");
		fs.writeFileSync(eventsPath, "", "utf-8");
		const oversized = Array.from({ length: MAX_LOADED_TASKS + 5 }, (_, i) => validTask(runId, `task_${i}`));
		fs.writeFileSync(tasksPath, JSON.stringify(oversized), "utf-8");

		const spy = spyConsoleError();
		try {
			const loaded = loadTasksWithRecovery(tasksPath, eventsPath, runId);
			assert.equal(loaded.length, MAX_LOADED_TASKS, "truncated at the cap");
			assert.equal(loaded[0].id, "task_0");
			assert.equal(loaded[MAX_LOADED_TASKS - 1].id, `task_${MAX_LOADED_TASKS - 1}`);
		} finally {
			spy.restore();
		}
		assert.match(spy.lines.join("\n"), new RegExp(`beyond the ${MAX_LOADED_TASKS} loader cap`), "DoG anomaly logged");
	} finally {
		await removeTrackedTempDir(dir);
	}
});

// ── (d) control: clean legacy v0 + v1 envelopes load byte-identical ──────────

test("N3 (d) control: clean legacy v0 bare array loads byte-identical with NO anomaly", async () => {
	const dir = createTrackedTempDir("n3-v0-");
	try {
		const runId = "team_n3_v0";
		const tasksPath = path.join(dir, "tasks.json");
		const eventsPath = path.join(dir, "events.jsonl");
		fs.writeFileSync(eventsPath, "", "utf-8");
		const written = [
			validTask(runId, "01_step"),
			{ ...validTask(runId, "02_step"), dependsOn: ["01_step"], status: "queued", title: "Legacy title with üñïçødé" },
		];
		fs.writeFileSync(tasksPath, JSON.stringify(written, null, 2), "utf-8");

		const spy = spyConsoleError();
		try {
			const loaded = loadTasksWithRecovery(tasksPath, eventsPath, runId);
			assert.deepEqual(loaded, written, "v0 entries round-trip verbatim");
		} finally {
			spy.restore();
		}
		assert.equal(spy.lines.length, 0, "clean v0 load emits no anomaly");

		// Same through the async twin.
		const asyncSpy = spyConsoleError();
		try {
			const asyncLoaded = await loadTasksWithRecoveryAsync(tasksPath, eventsPath, runId);
			assert.deepEqual(asyncLoaded, written, "async twin round-trips verbatim");
		} finally {
			asyncSpy.restore();
		}
		assert.equal(asyncSpy.lines.length, 0);
	} finally {
		await removeTrackedTempDir(dir);
	}
});

test("N3 (d) control: clean v1 envelope loads byte-identical with NO anomaly", () => {
	const dir = createTrackedTempDir("n3-v1-");
	try {
		const runId = "team_n3_v1";
		const tasksPath = path.join(dir, "tasks.json");
		const eventsPath = path.join(dir, "events.jsonl");
		fs.writeFileSync(eventsPath, "", "utf-8");
		const written = [validTask(runId, "01_step")];
		fs.writeFileSync(tasksPath, JSON.stringify({ schemaVersion: 1, tasks: written }, null, 2), "utf-8");

		const spy = spyConsoleError();
		try {
			const loaded = loadTasksWithRecovery(tasksPath, eventsPath, runId);
			assert.deepEqual(loaded, written, "v1 envelope entries round-trip verbatim");
		} finally {
			spy.restore();
		}
		assert.equal(spy.lines.length, 0, "clean v1 load emits no anomaly (current schemaVersion)");
	} finally {
		removeTrackedTempDir(dir);
	}
});

test("N3 (d) control: sanitizeLoadedTasks returns the SAME array reference for clean input", () => {
	const runId = "team_n3_ref";
	const clean = [validTask(runId, "a"), validTask(runId, "b")];
	assert.ok(sanitizeLoadedTasks(clean, runId) === clean, "clean input returned unchanged (no copy, no mutation)");
});

// ── end-to-end: the loader seam handleResume dispatches from ────────────────

test("N3 e2e: loadRunManifestById drops poisoned task entries and normalizes an unknown runKind", async () => {
	const cwd = createTrackedTempDir("n3-e2e-");
	try {
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow: singleStepWorkflow, goal: "N3 e2e" });
		const runId = manifest.runId;

		// Poison tasks.json the way a worker-writable state file would be: one
		// legit entry, one foreign-runId entry, one shape-invalid entry.
		const poisoned = [tasks[0], { ...tasks[0], id: "99_foreign", runId: "team_FOREIGN" }, { ...tasks[0], id: "98_bad", role: 42 }];
		fs.writeFileSync(manifest.tasksPath, JSON.stringify(poisoned), "utf-8");

		// Poison manifest.json with an unknown runKind (everything else valid).
		const manifestPath = path.join(manifest.stateRoot, "manifest.json");
		const onDisk = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
		fs.writeFileSync(manifestPath, JSON.stringify({ ...onDisk, runKind: "exec-loop" }), "utf-8");

		__test__clearManifestCache();
		const spy = spyConsoleError();
		try {
			const loaded = loadRunManifestById(cwd, runId);
			assert.ok(loaded, "run still loads (identity checks pass)");
			assert.deepEqual(
				loaded.tasks.map((t) => t.id),
				[tasks[0].id],
				"only the run-bound, well-formed task survives to dispatch",
			);
			assert.equal(loaded.manifest.runKind, "team-run", "unknown runKind normalized to the default engine");
		} finally {
			spy.restore();
		}
		assert.match(spy.lines.join("\n"), /failed shape validation/, "shape anomaly logged");
		assert.match(spy.lines.join("\n"), /foreign runId/, "runId-binding anomaly logged");
		assert.match(spy.lines.join("\n"), /not a known run kind/, "runKind anomaly logged");
	} finally {
		__test__clearManifestCache();
		await removeTrackedTempDir(cwd);
	}
});
