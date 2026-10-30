/**
 * R15-P1 pin (wave-6 M3-19): the renderTick GATE 3 task read must be COALESCED.
 *
 * Before the fix `renderTick` called `loadTasksWithRecovery` directly — an
 * uncached `readFileSync` + `JSON.parse` of the full task-packet array once per
 * running run per 160 ms tick (measured 14.78 ms/call at 200 tasks ≈ 28% of the
 * tick blocked). `readTasksCoalesced` wraps it in `readJsonFileCoalesced`
 * (stat-gated on mtime+size, LRU-capped, 200 ms TTL).
 *
 * Pins:
 *  1. unchanged file inside the TTL → second read is served from cache (no
 *     re-parse). Reverting the wrap makes this read hit disk and return the
 *     newer status (RED).
 *  2. changed file inside the TTL → mtime invalidation still returns FRESH
 *     content (GATE 3's parked-on-`ask` detection must keep working).
 *  3. the quarantine/reconstruct path is preserved and self-invalidating.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { readTasksCoalesced } from "../../../../src/extension/registration/render-loop.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

const TTL_MS = 200;

function makeRunFixture(): { tasksPath: string; eventsPath: string; runId: string } {
	const dir = createTrackedTempDir("r15p1-tasks-");
	const runId = "run-r15p1";
	const tasksPath = path.join(dir, "tasks.json");
	const eventsPath = path.join(dir, "events.jsonl");
	fs.writeFileSync(eventsPath, "", "utf-8");
	return { tasksPath, eventsPath, runId };
}

function writeTasks(tasksPath: string, status: string): void {
	// N3 loader hardening: entries must carry a plausible TeamTaskState shape
	// (id/runId/role/agent/title/status strings) to survive load validation.
	fs.writeFileSync(
		tasksPath,
		JSON.stringify([{ id: "t1", runId: "run-r15p1", role: "executor", agent: "executor", title: "t1", status }]),
		"utf-8",
	);
}

/** Force a detectable mtime change.
 *
 * Windows CI: NTFS mtime granularity (~10-15 ms) can make two rapid writes land
 * on the SAME mtime tick, and "running"/"waiting" are the same byte length — so
 * a stat-gate (mtimeMs + size) legitimately sees "no change" and serves the
 * cached entry. The production staleness window is bounded by the 200 ms TTL
 * (≈ one extra 160 ms render tick), but the PIN must be deterministic across
 * platforms, so the test advances mtime explicitly. */
function bumpMtime(tasksPath: string): void {
	const future = new Date(Date.now() + 2000);
	fs.utimesSync(tasksPath, future, future);
}

function statuses(tasks: Array<{ status?: string }>): string[] {
	return tasks.map((t) => t.status ?? "?");
}

test("R15-P1: an unchanged tasks.json is served from CACHE inside the TTL (no re-read)", () => {
	const { tasksPath, eventsPath, runId } = makeRunFixture();
	writeTasks(tasksPath, "running");
	assert.deepEqual(statuses(readTasksCoalesced(tasksPath, eventsPath, runId)), ["running"]);

	// Make the file unreadable WITHOUT touching mtime/size: an uncached read
	// (`loadTasksWithRecovery`) swallows the EACCES and returns []; a cache hit
	// still returns the previously parsed tasks. Reverting the coalesced read
	// makes this assertion RED.
	fs.chmodSync(tasksPath, 0o000);
	try {
		assert.deepEqual(statuses(readTasksCoalesced(tasksPath, eventsPath, runId)), ["running"]);
	} finally {
		fs.chmodSync(tasksPath, 0o644);
	}
});

test("R15-P1: a write inside the TTL is NOT hidden by the cache (mtime invalidation keeps GATE 3 fresh)", () => {
	const { tasksPath, eventsPath, runId } = makeRunFixture();
	writeTasks(tasksPath, "running");
	assert.deepEqual(statuses(readTasksCoalesced(tasksPath, eventsPath, runId)), ["running"]);

	// Flip the status on disk — the worker parked on `ask` case GATE 3 exists for.
	writeTasks(tasksPath, "waiting");
	bumpMtime(tasksPath); // Windows: same-size write may share the mtime tick
	// Immediately (no >= TTL sleep): mtime changed → cache miss → fresh read.
	assert.deepEqual(statuses(readTasksCoalesced(tasksPath, eventsPath, runId)), ["waiting"]);
});

test("R15-P1: sandboxed cache — a fresh path is not served a previous run's tasks", () => {
	const a = makeRunFixture();
	const b = makeRunFixture();
	writeTasks(a.tasksPath, "waiting");
	writeTasks(b.tasksPath, "running");

	assert.deepEqual(statuses(readTasksCoalesced(a.tasksPath, a.eventsPath, a.runId)), ["waiting"]);
	assert.deepEqual(statuses(readTasksCoalesced(b.tasksPath, b.eventsPath, b.runId)), ["running"]);
});

test("R15-P1: corrupt tasks.json still quarantines + recovers (cache must not mask corruption)", () => {
	const { tasksPath, eventsPath, runId } = makeRunFixture();
	writeTasks(tasksPath, "running");
	assert.deepEqual(statuses(readTasksCoalesced(tasksPath, eventsPath, runId)), ["running"]);

	// Corrupt the file (SyntaxError) — the recovery path must still run even
	// though a cache entry exists for this path.
	fs.writeFileSync(tasksPath, "[{ this is not json", "utf-8");
	const recovered = readTasksCoalesced(tasksPath, eventsPath, runId);

	assert.deepEqual(recovered, [], "no events → nothing to reconstruct");
	const quarantined = fs.readdirSync(path.dirname(tasksPath)).filter((f) => f.includes(".corrupt-"));
	assert.equal(quarantined.length, 1, "the corrupt file must be quarantined (recovery path preserved)");

	// Self-invalidating: once a valid file lands (new mtime), the read follows it.
	writeTasks(tasksPath, "completed");
	assert.deepEqual(statuses(readTasksCoalesced(tasksPath, eventsPath, runId)), ["completed"]);
});

test("R15-P1: staleness is bounded by the TTL", async () => {
	const { tasksPath, eventsPath, runId } = makeRunFixture();
	writeTasks(tasksPath, "running");
	assert.deepEqual(statuses(readTasksCoalesced(tasksPath, eventsPath, runId)), ["running"]);

	// Wait out the TTL, then rewrite: the expired entry must never mask the new
	// content (belt-and-suspenders with the mtime check above).
	await new Promise((resolve) => setTimeout(resolve, TTL_MS + 100));
	writeTasks(tasksPath, "waiting");
	assert.deepEqual(statuses(readTasksCoalesced(tasksPath, eventsPath, runId)), ["waiting"]);
});
