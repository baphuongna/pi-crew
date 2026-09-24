import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCompareBundle } from "../../../src/extension/run-compare.ts";
import type { TeamContext } from "../../../src/extension/team-tool/context.ts";
import { handleCompare } from "../../../src/extension/team-tool/lifecycle-actions.ts";
import type { TeamRunManifest, TeamTaskState, UsageState } from "../../../src/state/types.ts";

/**
 * US-021 (2026-09-22): run comparison.
 *  AC-1 self-diff → zero deltas + identical
 *  AC-2 known-delta fixtures → accurate per-field deltas
 *  AC-3 byte-stable output (no wall-clock in the body)
 *  AC-4 missing run id → clear error, NO partial artifact
 *  AC-5 artifact under the FIRST run's artifactsRoot
 *
 * Mutation: drop a delta field from compareRuns (e.g. costDelta) → the
 * known-delta assertions go RED.
 */

const PINNED = new Date("2026-09-15T09:00:00.000Z");

interface RunFixture {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
}

function writeRun(
	cwd: string,
	runId: string,
	opts: {
		status: string;
		tasks: TeamTaskState[];
		eventTypes: string[];
	},
): RunFixture {
	const stateRoot = path.join(cwd, ".crew", "state", "runs", runId);
	const baseRoot = path.resolve(stateRoot, "..", "..", "..");
	const artifactsRoot = path.join(baseRoot, "artifacts", runId);
	fs.mkdirSync(stateRoot, { recursive: true });
	const eventsPath = path.join(stateRoot, "events.jsonl");
	const manifest = {
		runId,
		schemaVersion: 1,
		status: opts.status,
		stateRoot,
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath,
		artifactsRoot,
		team: { name: "default", source: "builtin" },
		workflow: { name: "default", source: "builtin" },
		goal: "US-021 comparison probe",
		createdAt: PINNED.toISOString(),
	} as unknown as TeamRunManifest;
	fs.writeFileSync(path.join(stateRoot, "manifest.json"), JSON.stringify(manifest));
	fs.writeFileSync(path.join(stateRoot, "tasks.json"), JSON.stringify(opts.tasks));
	fs.writeFileSync(
		eventsPath,
		opts.eventTypes
			.map((type, i) => `${JSON.stringify({ time: new Date(PINNED.getTime() + i).toISOString(), type, runId })}\n`)
			.join(""),
	);
	return { manifest, tasks: opts.tasks };
}

function task(id: string, status: string, usage: UsageState | undefined, durationMs: number | undefined, model?: string): TeamTaskState {
	return {
		id,
		role: "executor",
		agent: "executor",
		status,
		dependsOn: [],
		cwd: "/tmp",
		model,
		startedAt: durationMs !== undefined ? PINNED.toISOString() : undefined,
		finishedAt: durationMs !== undefined ? new Date(PINNED.getTime() + durationMs).toISOString() : undefined,
		usage,
	} as unknown as TeamTaskState;
}

function fixtures(): { cwd: string; a: RunFixture; b: RunFixture } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "us021-"));
	const a = writeRun(cwd, "team_us021_base", {
		status: "failed",
		tasks: [
			task("t1", "completed", { input: 10_000, output: 4_000, cost: 0.02 }, 60_000, "anthropic/claude-sonnet-4.5"),
			task("t2", "failed", { input: 2_000, output: 500, cost: 0.01 }, 30_000, "anthropic/claude-haiku-4.5"),
		],
		eventTypes: ["run.started", "task.progress", "run.failed"],
	});
	const b = writeRun(cwd, "team_us021_after", {
		status: "completed",
		tasks: [
			task("t1", "completed", { input: 16_000, output: 8_000, cost: 0.05 }, 90_000, "anthropic/claude-opus-4.6"),
			task("t2", "completed", { input: 3_000, output: 800, cost: 0.02 }, 30_000, "anthropic/claude-haiku-4.5"),
			task("t3", "completed", { input: 1_000, output: 200, cost: 0.005 }, 10_000),
		],
		eventTypes: ["run.started", "task.progress", "run.completed"],
	});
	return { cwd, a, b };
}

test("US-021 AC-2: known-delta fixtures produce accurate per-field deltas", () => {
	const { a, b } = fixtures();
	try {
		const { comparison } = runCompareBundle(a.manifest, a.tasks, b.manifest, b.tasks);
		assert.equal(comparison.status.a, "failed");
		assert.equal(comparison.status.b, "completed");
		assert.equal(comparison.identical, false);
		const t1 = comparison.tasks.find((t) => t.id === "t1");
		assert.ok(t1);
		assert.equal(t1.statusA, "completed");
		assert.equal(t1.statusB, "completed");
		assert.equal(t1.durationDeltaMs, 30_000);
		assert.equal(t1.tokensDelta, 16_000 + 8_000 - (10_000 + 4_000));
		assert.ok(Math.abs((t1.costDelta ?? 0) - 0.03) < 1e-9);
		const t2 = comparison.tasks.find((t) => t.id === "t2");
		assert.ok(t2);
		assert.equal(t2.statusA, "failed");
		assert.equal(t2.statusB, "completed");
		const t3 = comparison.tasks.find((t) => t.id === "t3");
		assert.ok(t3);
		assert.equal(t3.statusA, undefined, "task only in b has no a-side status");
		assert.deepEqual(comparison.tasksOnlyInA, []);
		assert.deepEqual(comparison.tasksOnlyInB, ["t3"]);
		assert.deepEqual(comparison.events.addedTypes, ["run.completed"]);
		assert.deepEqual(comparison.events.removedTypes, ["run.failed"]);
		assert.equal(comparison.models.length, 1, "only t1 changed model");
		assert.equal(comparison.models[0].taskId, "t1");
		assert.equal(comparison.models[0].modelA, "anthropic/claude-sonnet-4.5");
		assert.equal(comparison.models[0].modelB, "anthropic/claude-opus-4.6");
		// Totals: A = 16.5k tokens / $0.03; B = 29k tokens / $0.075
		assert.equal(comparison.usage.tokensDelta, 29_000 - 16_500);
		assert.ok(Math.abs(comparison.usage.costDelta - 0.045) < 1e-9);
	} finally {
		fs.rmSync(a.manifest.stateRoot, { recursive: true, force: true });
		fs.rmSync(b.manifest.stateRoot, { recursive: true, force: true });
	}
});

test("US-021 AC-1: self-comparison is identical with zero deltas", () => {
	const { a, b } = fixtures();
	try {
		const { comparison, markdownPath } = runCompareBundle(a.manifest, a.tasks, a.manifest, a.tasks);
		assert.equal(comparison.identical, true);
		assert.ok(comparison.tasks.every((t) => t.statusA === t.statusB && (t.durationDeltaMs ?? 0) === 0 && (t.tokensDelta ?? 0) === 0));
		assert.equal(comparison.usage.tokensDelta, 0);
		assert.equal(comparison.usage.costDelta, 0);
		const md = fs.readFileSync(markdownPath, "utf-8");
		assert.ok(md.includes("Comparison: identical"), md);
		assert.match(md, /Δtok=0/);
	} finally {
		fs.rmSync(a.manifest.stateRoot, { recursive: true, force: true });
		fs.rmSync(b.manifest.stateRoot, { recursive: true, force: true });
	}
});

test("US-021 AC-3: repeated comparisons are byte-identical", () => {
	const { a, b } = fixtures();
	try {
		const first = runCompareBundle(a.manifest, a.tasks, b.manifest, b.tasks);
		const firstBytes = fs.readFileSync(first.markdownPath, "utf-8");
		const second = runCompareBundle(a.manifest, a.tasks, b.manifest, b.tasks);
		const secondBytes = fs.readFileSync(second.markdownPath, "utf-8");
		assert.equal(firstBytes, secondBytes, "comparison markdown must be byte-stable (no wall-clock)");
		assert.ok(firstBytes.includes("Δdur=+30.0s"), firstBytes);
		assert.ok(firstBytes.includes("Only in b: t3"), firstBytes);
	} finally {
		fs.rmSync(a.manifest.stateRoot, { recursive: true, force: true });
		fs.rmSync(b.manifest.stateRoot, { recursive: true, force: true });
	}
});

test("US-021 AC-4/AC-5: handleCompare — missing id errors with no partial artifact; valid call writes under run A", () => {
	const { cwd, a, b } = fixtures();
	const ctx = { cwd } as TeamContext;
	try {
		const missing = handleCompare({ action: "compare", runIds: [a.manifest.runId, "team_us021_missing"] }, ctx);
		assert.equal(missing.isError, true);
		const missingText = missing.content?.[0];
		assert.match((missingText as { text?: string } | undefined)?.text ?? "", /team_us021_missing' not found/);
		assert.equal(fs.existsSync(path.join(a.manifest.artifactsRoot, "compare")), false, "no partial artifact on missing id");

		const ok = handleCompare({ action: "compare", runIds: [a.manifest.runId, b.manifest.runId] }, ctx);
		assert.equal(ok.isError === true, false);
		const expected = path.join(a.manifest.artifactsRoot, "compare", `${a.manifest.runId}__${b.manifest.runId}.md`);
		assert.equal(fs.existsSync(expected), true, `artifact must sit under the FIRST run's artifactsRoot: ${expected}`);

		const badParams = handleCompare({ action: "compare", runIds: [a.manifest.runId] }, ctx);
		assert.equal(badParams.isError, true);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
