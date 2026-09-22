import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	PRUNE_AUDIT_MAX_BYTES,
	pruneFinishedRuns,
	resolveAutoPruneAgeFloorMs,
	resolveAutoPruneKeep,
} from "../../../src/extension/run-maintenance.ts";
import { createRunManifest, loadRunManifestById, updateRunStatus } from "../../../src/state/stores/state-store.ts";

/**
 * DP-01 (2026-09-22): session-start auto-prune guards. Three data-loss
 * incidents in one session motivated this — the biggest was a morning of
 * battery evidence deleted by the next session start (keep=10, no age floor).
 *
 * Covered here: env keep resolution (valid/invalid), age floor protecting
 * young runs, failed-run reason preservation, and audit rotation.
 */

const team = { name: "t", description: "", source: "builtin" as const, filePath: "t", roles: [] };
const workflow = {
	name: "w",
	description: "",
	source: "builtin" as const,
	filePath: "w",
	steps: [{ id: "s1", role: "executor", task: "x" }],
};

function makeProjectCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dp01-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

/** Create N finished runs with distinct, controlled updatedAt timestamps. */
function seedFinishedRuns(cwd: string, count: number, ageMs: (i: number) => number): string[] {
	const ids: string[] = [];
	for (let i = 0; i < count; i += 1) {
		const created = createRunManifest({ cwd, team, workflow, goal: `run ${i}` });
		// updateRunStatus returns a NEW manifest (does not mutate its input).
		const running = updateRunStatus(created.manifest, "running", "test");
		const manifest = updateRunStatus(running, "completed", "test");
		// Rewrite manifest with a controlled updatedAt (newest = highest i).
		const manifestPath = path.join(manifest.stateRoot, "manifest.json");
		const loaded = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
		loaded.updatedAt = new Date(Date.now() - ageMs(i)).toISOString();
		loaded.createdAt = loaded.updatedAt;
		fs.writeFileSync(manifestPath, JSON.stringify(loaded));
		ids.push(manifest.runId);
	}
	return ids;
}

test("DP-01: resolveAutoPruneKeep — valid, invalid, and empty", () => {
	assert.equal(resolveAutoPruneKeep(() => "25"), 25);
	assert.equal(resolveAutoPruneKeep(() => "0"), 0);
	assert.equal(resolveAutoPruneKeep(() => undefined), 10, "unset → historical default");
	assert.equal(resolveAutoPruneKeep(() => ""), 10);
	assert.equal(resolveAutoPruneKeep(() => "abc"), 10, "garbage → default, never a crash");
	assert.equal(resolveAutoPruneKeep(() => "-5"), 10, "negative → default");
});

test("DP-01: resolveAutoPruneAgeFloorMs — default 24h, 0 disables, invalid → 24h", () => {
	assert.equal(resolveAutoPruneAgeFloorMs(() => undefined), 24 * 60 * 60 * 1000);
	assert.equal(resolveAutoPruneAgeFloorMs(() => "0"), 0);
	assert.equal(resolveAutoPruneAgeFloorMs(() => "1"), 60 * 60 * 1000);
	assert.equal(resolveAutoPruneAgeFloorMs(() => "nope"), 24 * 60 * 60 * 1000);
});

test("DP-01: age floor protects young finished runs beyond top-keep (the incident)", () => {
	const cwd = makeProjectCwd();
	try {
		// 14 finished runs ALL younger than the floor (1 minute old each) — the
		// 2026-09-21 battery evidence shape. keep=10 alone would delete 4.
		const ids = seedFinishedRuns(cwd, 14, () => 60_000);
		const { removed, kept } = pruneFinishedRuns(cwd, 10, {
			ageFloorMs: 24 * 60 * 60 * 1000,
			intent: "session-start-auto",
		});
		assert.equal(removed.length, 0, `age floor must protect all young runs; removed=${removed.join(",")}`);
		assert.equal(kept.length, 10);
		for (const id of ids) {
			assert.ok(loadRunManifestById(cwd, id), `run ${id} must still exist`);
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("DP-01: age floor still lets OLD runs be pruned (guard is not a no-op)", () => {
	const cwd = makeProjectCwd();
	try {
		// 14 runs, all 48h old → beyond the 24h floor → 4 removed (keep=10).
		seedFinishedRuns(cwd, 14, () => 48 * 60 * 60 * 1000);
		const { removed } = pruneFinishedRuns(cwd, 10, { ageFloorMs: 24 * 60 * 60 * 1000 });
		assert.equal(removed.length, 4, "old runs beyond top-keep must still be pruned");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("DP-01: mixed shape (12 young + 3 old, keep=10) — young protected, old pruned (live-verified)", () => {
	const cwd = makeProjectCwd();
	try {
		// The exact 2026-09-21 incident shape: more finished runs than keep,
		// most of them YOUNG (a morning of evidence). Pre-DP-01 this deleted 5
		// evidence runs; the floor must protect all 12 young and still prune the
		// 3 genuinely old ones.
		const young = seedFinishedRuns(cwd, 12, () => 60_000);
		const old = seedFinishedRuns(cwd, 3, () => 48 * 60 * 60 * 1000);
		const { removed } = pruneFinishedRuns(cwd, 10, { ageFloorMs: 24 * 60 * 60 * 1000 });
		for (const id of young) assert.ok(loadRunManifestById(cwd, id), `young run ${id} must survive`);
		for (const id of old) assert.equal(loadRunManifestById(cwd, id), undefined, `old run ${id} must be pruned`);
		assert.equal(removed.length, 3, "exactly the 3 old runs are removed");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("DP-01: ageFloorMs=0 (manual prune) keeps the old unguarded behavior", () => {
	const cwd = makeProjectCwd();
	try {
		seedFinishedRuns(cwd, 14, () => 60_000);
		const { removed } = pruneFinishedRuns(cwd, 10, { ageFloorMs: 0 });
		assert.equal(removed.length, 4, "manual prune (no floor) removes beyond top-keep as before");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("DP-01: a pruned FAILED run leaves a recoverable reason in the durable index", () => {
	const cwd = makeProjectCwd();
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "doomed goal" });
		const running = updateRunStatus(created.manifest, "running", "test");
		const manifest = updateRunStatus(running, "failed", "boom: the reason that must survive");
		// Make it old so the floor does not protect it.
		const manifestPath = path.join(manifest.stateRoot, "manifest.json");
		const loaded = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
		loaded.updatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
		fs.writeFileSync(manifestPath, JSON.stringify(loaded));

		// Add a second, newer run so the failed one is beyond top-keep=1.
		seedFinishedRuns(cwd, 1, () => 60_000);

		const { removed } = pruneFinishedRuns(cwd, 1, { ageFloorMs: 24 * 60 * 60 * 1000 });
		assert.ok(removed.includes(manifest.runId), "the old failed run must be pruned");

		const indexPath = path.join(cwd, ".crew", "state", "pruned-failures.jsonl");
		assert.ok(fs.existsSync(indexPath), "pruned-failure index must exist");
		const lines = fs.readFileSync(indexPath, "utf-8").trim().split("\n").filter(Boolean);
		const entry = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
		assert.equal(entry.runId, manifest.runId);
		assert.equal(entry.status, "failed");
		assert.match(String(entry.summary), /the reason that must survive/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("DP-01: prune audit rotates when it exceeds the size cap", () => {
	const cwd = makeProjectCwd();
	try {
		// Seed a run so the crew root + audit path exist.
		seedFinishedRuns(cwd, 1, () => 60_000);
		const auditPath = path.join(cwd, ".crew", "audit", "prune.jsonl");
		fs.mkdirSync(path.dirname(auditPath), { recursive: true });
		fs.writeFileSync(auditPath, "x".repeat(PRUNE_AUDIT_MAX_BYTES + 10));

		pruneFinishedRuns(cwd, 10, { ageFloorMs: 0, intent: "session-start-auto" });

		assert.ok(fs.existsSync(`${auditPath}.1`), "oversized audit must rotate to .1");
		const rotated = fs.statSync(`${auditPath}.1`).size;
		assert.ok(rotated > PRUNE_AUDIT_MAX_BYTES, "the rotated generation keeps the old content");
		const fresh = fs.readFileSync(auditPath, "utf-8");
		assert.ok(fresh.length < PRUNE_AUDIT_MAX_BYTES, "the new audit file starts small");
		assert.match(fresh, /session-start-auto/, "new entries carry the intent attribution");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
