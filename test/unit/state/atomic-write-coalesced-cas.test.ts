/**
 * ASK-PARK CLOBBER FIX (2026-10-31) — flush-time staleness CAS regression.
 *
 * Live incidents team_20261031084714 + adaptive-04 team_20261031045633: the
 * HOST process's coalesced tasks.json flush (per-process pendingAtomicWrites)
 * blindly overwrote the BROKER process's run-locked sync `waiting` park.
 * cancelPendingCoalescedWrite only sees same-process supersessions, so the
 * cross-process sync write could not cancel the host buffer, and its stale
 * pre-park `running` snapshot landed on top — losing the status AND the
 * waiting marker (questionId), making every leader respond reject with
 * "is running, not waiting" until each ask timed out.
 *
 * The fix snapshots the on-disk identity (mtimeMs + size) at QUEUE time and
 * re-stats at FLUSH time: an external write landing between queue and flush
 * (identity change, or the file appearing after a queue-time absence) makes
 * the buffered snapshot stale — it is DISCARDED, never clobbered.
 *
 * External writes are simulated with RAW fs temp+rename. Going through
 * atomicWriteFile would cancel the pending entry in-process — exactly the
 * same-process supersession path this CAS is NOT about.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { atomicWriteJsonCoalesced, flushPendingAtomicWrites, hasPendingCoalescedWrite } from "../../../src/state/atomic-write.ts";
import { cleanupStateRoot } from "../../helpers/rm-retry.ts";

/** Simulate a CROSS-PROCESS sync atomic write: raw temp + rename. */
function externalAtomicWrite(filePath: string, content: string): void {
	const tempPath = `${filePath}.external-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
	fs.writeFileSync(tempPath, content);
	fs.renameSync(tempPath, filePath);
}

function readJson(filePath: string): unknown {
	return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

test("external write between queue and flush drops the stale buffered snapshot (identity change)", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cas-1-"));
	t.after(async () => {
		flushPendingAtomicWrites();
		await cleanupStateRoot(dir);
	});
	const target = path.join(dir, "tasks.json");

	// Pre-park on-disk state (mtime T1, size S1) — the broker's sync write of
	// `waiting` in the incident timeline. Queue AFTER it: the host buffers a
	// fresh `running` snapshot while the file identity is still T1/S1.
	externalAtomicWrite(target, JSON.stringify([{ status: "waiting" }]));
	atomicWriteJsonCoalesced(target, [{ status: "running" }], 60_000, { compact: true });
	assert.ok(hasPendingCoalescedWrite(target), "running snapshot buffered");

	// External (broker) sync write lands: status waiting + questionId marker,
	// file identity now T2/S2 — invisible to this process's cancel path.
	externalAtomicWrite(target, JSON.stringify([{ status: "waiting", waiting: { questionId: "q-1" } }]));

	// Host flush timer fires (scoped flush = same code path as the timer).
	flushPendingAtomicWrites(target);

	// The stale `running` snapshot must have been DISCARDED, not clobbered.
	assert.deepEqual(readJson(target), [{ status: "waiting", waiting: { questionId: "q-1" } }]);
	assert.equal(hasPendingCoalescedWrite(target), false, "dropped entry must not linger for retry");
});

test("control: no external write — flush lands the buffered snapshot (identity unchanged)", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cas-2-"));
	t.after(async () => {
		flushPendingAtomicWrites();
		await cleanupStateRoot(dir);
	});
	const target = path.join(dir, "tasks.json");

	externalAtomicWrite(target, JSON.stringify([{ status: "waiting" }]));
	atomicWriteJsonCoalesced(target, [{ status: "running", checkpoint: 2 }], 60_000, { compact: true });
	flushPendingAtomicWrites(target);

	assert.deepEqual(readJson(target), [{ status: "running", checkpoint: 2 }]);
	assert.equal(hasPendingCoalescedWrite(target), false);
});

test("file appearing after queue-time absence is an external write — drop", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cas-3-"));
	t.after(async () => {
		flushPendingAtomicWrites();
		await cleanupStateRoot(dir);
	});
	const target = path.join(dir, "fresh.json");

	// Queue while the file does not exist yet (queuedMtimeMs = null).
	atomicWriteJsonCoalesced(target, { status: "running" }, 60_000, { compact: true });
	// External creator lands the file between queue and flush.
	externalAtomicWrite(target, JSON.stringify({ status: "waiting", waiting: { questionId: "q-2" } }));
	flushPendingAtomicWrites(target);

	assert.deepEqual(readJson(target), { status: "waiting", waiting: { questionId: "q-2" } });
	assert.equal(hasPendingCoalescedWrite(target), false);
});

test("still-absent at flush: fresh-file coalesced write lands (create path preserved)", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cas-4-"));
	t.after(async () => {
		flushPendingAtomicWrites();
		await cleanupStateRoot(dir);
	});
	const target = path.join(dir, "fresh.json");

	atomicWriteJsonCoalesced(target, { status: "queued" }, 60_000, { compact: true });
	assert.equal(fs.existsSync(target), false, "buffered, not on disk yet");
	flushPendingAtomicWrites(target);

	assert.deepEqual(readJson(target), { status: "queued" });
});
