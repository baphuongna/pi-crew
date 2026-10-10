/**
 * U7 (upgrade spec 2026-10-09, §TIER 2): EventsStateSource — the
 * CommittedStateSource adapter over events.jsonl.
 *
 * Contract (spec U7 + durable mount pattern):
 * - SNAPSHOT: creation parses events.jsonl to the CURRENT seq (storage scan,
 *   no replay); a missing log yields an empty snapshot without throwing.
 * - FRAMES: poll() tail-follows via the existing readEventsCursor watermark
 *   cursor — each discovered batch is one frame applied to the state and
 *   fanned out to subscribers; an unchanged log commits zero frames.
 * - OVERFLOW: a poll needing more than `maxBufferedFrames` batches to drain
 *   performs ONE root replacement (fresh snapshot parse) and emits a single
 *   `resync` frame; an exact drain at the cap does NOT resync.
 * - ROOT REPLACEMENT on rewrite: an inode change (rotation's rename+'wx',
 *   compaction's temp+rename) resyncs instead of stranding pre-rewrite events.
 * - REGISTRY: sources are shared per events log (refcounted); zero refs drops
 *   the source. Subscriber errors are non-fatal.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { type EventsStateFrame, eventsStateSource, eventsStateSourceRegistrySize } from "../../../src/ui/events-state-source.ts";

// ── helpers ───────────────────────────────────────────────────────────────

let tmpDir: string;

function eventsPath(): string {
	return path.join(tmpDir, "events.jsonl");
}

function line(seq: number, type = "task.started"): string {
	return `${JSON.stringify({ time: new Date().toISOString(), type, runId: "run-u7", metadata: { seq } })}\n`;
}

/** Append seq-stamped events like the durable writer does. */
function appendEvents(from: number, count: number): void {
	let chunk = "";
	for (let i = 0; i < count; i += 1) chunk += line(from + i);
	fs.appendFileSync(eventsPath(), chunk, "utf-8");
}

/** Rewrite the log under a NEW inode (rotation/compaction shape). */
function rewriteLog(lines: string[]): void {
	const target = eventsPath();
	const archive = `${target}.1234.archive.jsonl`;
	fs.renameSync(target, archive);
	fs.writeFileSync(target, lines.join(""), { flag: "wx" });
}

async function waitFor(ready: () => boolean, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!ready()) {
		if (Date.now() > deadline) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test.beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-u7-source-"));
});

test.afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Snapshot: parse events.jsonl to the current seq ───────────────────────

test("snapshot: creation parses the log to the current seq (storage scan)", () => {
	appendEvents(1, 5);
	const source = eventsStateSource("run-u7", eventsPath());
	const snap = source.snapshot();
	assert.equal(snap.seq, 5);
	assert.equal(snap.events.length, 5);
	assert.equal(snap.events.at(-1)?.metadata?.seq, 5);
	assert.ok(snap.version >= 1, "version is set on the initial root");
	assert.equal(snap.resynced, true, "initial root counts as a root build");
	source.dispose();
});

test("snapshot: window is bounded to recentEvents", () => {
	appendEvents(1, 30);
	const source = eventsStateSource("run-u7", eventsPath(), { recentEvents: 10 });
	const snap = source.snapshot();
	assert.equal(snap.events.length, 10);
	assert.equal(snap.events[0]?.metadata?.seq, 21, "window keeps the newest suffix");
	assert.equal(snap.events.at(-1)?.metadata?.seq, 30);
	source.dispose();
});

test("snapshot: missing log yields an empty snapshot without throwing", () => {
	const source = eventsStateSource("run-u7", eventsPath());
	const snap = source.snapshot();
	assert.equal(snap.seq, 0);
	assert.equal(snap.events.length, 0);
	source.dispose();
});

// ── Frames: tail-follow each event batch ──────────────────────────────────

test("frames: poll delivers one frame per discovered batch", () => {
	appendEvents(1, 5);
	const source = eventsStateSource("run-u7", eventsPath());
	const frames: EventsStateFrame[] = [];
	source.subscribe((frame) => frames.push(frame));
	assert.equal(source.poll(), 0, "unchanged log commits zero frames");
	assert.equal(frames.length, 0);

	appendEvents(6, 3);
	assert.equal(source.poll(), 1);
	assert.equal(frames.length, 1);
	assert.equal(frames[0].resync, false);
	assert.equal(frames[0].fromSeq, 5);
	assert.equal(frames[0].toSeq, 8);
	assert.deepEqual(
		frames[0].events.map((event) => event.metadata?.seq),
		[6, 7, 8],
	);
	const snap = source.snapshot();
	assert.equal(snap.seq, 8);
	assert.equal(snap.resynced, false, "a frame commit is not a resync");
	source.dispose();
});

test("frames: multi-batch backlog drains as ordered frames", () => {
	appendEvents(1, 2);
	const source = eventsStateSource("run-u7", eventsPath(), { frameBatchEvents: 5 });
	const frames: EventsStateFrame[] = [];
	source.subscribe((frame) => frames.push(frame));
	appendEvents(3, 12);
	assert.equal(source.poll(), 3, "12 events / batch of 5 = 3 frames");
	assert.deepEqual(
		frames.map((frame) => [frame.fromSeq, frame.toSeq]),
		[
			[2, 7],
			[7, 12],
			[12, 14],
		],
	);
	assert.equal(source.snapshot().seq, 14);
	source.dispose();
});

test("frames: window slides by recentEvents as batches apply", () => {
	appendEvents(1, 2);
	const source = eventsStateSource("run-u7", eventsPath(), { recentEvents: 4, frameBatchEvents: 3 });
	appendEvents(3, 7);
	source.poll();
	const snap = source.snapshot();
	assert.equal(snap.seq, 9);
	assert.equal(snap.events.length, 4, "window bounded");
	assert.equal(snap.events[0]?.metadata?.seq, 6);
	source.dispose();
});

test("frames: a throwing subscriber does not break delivery", () => {
	appendEvents(1, 1);
	const source = eventsStateSource("run-u7", eventsPath());
	let good = 0;
	source.subscribe(() => {
		throw new Error("subscriber boom");
	});
	source.subscribe(() => {
		good += 1;
	});
	appendEvents(2, 1);
	assert.equal(source.poll(), 1);
	assert.equal(good, 1, "second subscriber still notified");
	source.dispose();
});

// ── Overflow: >maxBufferedFrames → root replacement ────────────────────────

test("overflow: backlog beyond maxBufferedFrames resyncs with one root-replacement frame", () => {
	appendEvents(1, 2);
	const source = eventsStateSource("run-u7", eventsPath(), { frameBatchEvents: 2, maxBufferedFrames: 2, recentEvents: 6 });
	const frames: EventsStateFrame[] = [];
	source.subscribe((frame) => frames.push(frame));
	appendEvents(3, 7); // 7 events = 4 batches of 2 > cap of 2
	const committed = source.poll();
	assert.ok(committed >= 3, `poll reports applied frames + the resync (got ${committed})`);
	const resyncFrames = frames.filter((frame) => frame.resync);
	assert.equal(resyncFrames.length, 1, "exactly one root-replacement frame");
	assert.equal(source.stats().resyncs, 1);
	const snap = source.snapshot();
	assert.equal(snap.seq, 9);
	assert.equal(snap.events.length, 6, "resync frame carries the FULL new window");
	assert.equal(snap.resynced, true);
	assert.ok(resyncFrames[0].events.length > 2, "resync frame is not a 2-event delta");
	source.dispose();
});

test("overflow: an exact drain at the cap does NOT resync", () => {
	appendEvents(1, 2);
	const source = eventsStateSource("run-u7", eventsPath(), { frameBatchEvents: 2, maxBufferedFrames: 2 });
	appendEvents(3, 4); // exactly 2 batches
	assert.equal(source.poll(), 2);
	assert.equal(source.stats().resyncs, 0);
	assert.equal(source.snapshot().resynced, false);
	source.dispose();
});

test("overflow: resync() forces a fresh snapshot parse and emits a resync frame", () => {
	appendEvents(1, 3);
	const source = eventsStateSource("run-u7", eventsPath());
	const frames: EventsStateFrame[] = [];
	source.subscribe((frame) => frames.push(frame));
	appendEvents(4, 2);
	const before = source.snapshot().version;
	source.resync();
	assert.equal(source.stats().resyncs, 1);
	assert.equal(frames.length, 1);
	assert.equal(frames[0].resync, true);
	assert.equal(frames[0].toSeq, 5);
	assert.ok(source.snapshot().version > before);
	source.dispose();
});

// ── Root replacement on log rewrite (inode change) ────────────────────────

test("rewrite: inode change (rotation/compaction shape) resyncs the root", () => {
	appendEvents(1, 5);
	const source = eventsStateSource("run-u7", eventsPath(), { recentEvents: 10 });
	rewriteLog([line(1), line(2)]);
	assert.equal(source.snapshot().seq, 5, "pre-rewrite committed state kept");
	assert.equal(source.poll(), 1, "the rewrite resync counts as one frame");
	const snap = source.snapshot();
	// Rotation parity (readEventsCursor full-history semantics): the wide
	// re-read merges the ARCHIVE (pre-rotation seqs 3..5) with the new live
	// file (seqs 1..2, live wins on collision) — the root replacement sees
	// the SAME union a fresh consumer would, never a stranded suffix.
	assert.equal(snap.seq, 5);
	assert.equal(snap.events.length, 5);
	assert.deepEqual(
		snap.events.map((event) => event.metadata?.seq),
		[1, 2, 3, 4, 5],
	);
	assert.equal(snap.resynced, true);
	source.dispose();
});

// ── Registry: shared, refcounted sources ──────────────────────────────────

test("registry: same events log shares one source; zero refs drops it", () => {
	const baseline = eventsStateSourceRegistrySize();
	appendEvents(1, 1);
	const a = eventsStateSource("run-u7", eventsPath());
	const b = eventsStateSource("run-u7", eventsPath());
	assert.equal(a, b, "get-or-create returns the SAME instance");
	assert.equal(eventsStateSourceRegistrySize(), baseline + 1);
	a.dispose();
	appendEvents(2, 1);
	assert.equal(b.poll(), 1, "still live at refs=1");
	assert.equal(eventsStateSourceRegistrySize(), baseline + 1);
	b.dispose();
	assert.equal(eventsStateSourceRegistrySize(), baseline, "zero refs drops the source");
});

test("registry: different logs get different sources", () => {
	const baseline = eventsStateSourceRegistrySize();
	appendEvents(1, 1);
	const other = path.join(tmpDir, "other-events.jsonl");
	fs.writeFileSync(other, line(1), "utf-8");
	const a = eventsStateSource("run-a", eventsPath());
	const b = eventsStateSource("run-b", other);
	assert.notEqual(a, b);
	assert.equal(eventsStateSourceRegistrySize(), baseline + 2);
	a.dispose();
	b.dispose();
	assert.equal(eventsStateSourceRegistrySize(), baseline);
});

test("registry: stats accumulate polls/frames/events", async () => {
	appendEvents(1, 1);
	const source = eventsStateSource("run-u7", eventsPath());
	source.poll();
	appendEvents(2, 2);
	source.poll();
	const stats = source.stats();
	assert.ok(stats.polls >= 2);
	assert.equal(stats.frames, 1);
	assert.equal(stats.eventsDelivered, 2);
	assert.equal(stats.resyncs, 0);
	source.dispose();
	await waitFor(() => true); // keep async helper exercised in this file
});

// ── Review MINOR-1/2 (2026-10-10) ─────────────────────────────────────────

test("resync: a transiently unreadable log KEEPS the committed state (no empty-snapshot beat)", () => {
	appendEvents(1, 2);
	const source = eventsStateSource("run-u7", eventsPath());
	assert.equal(source.poll(), 0, "creation already scanned to the current seq");
	const before = source.snapshot();
	assert.equal(before.seq, 2);

	// Transient disappearance mid-resync (run dir moving / the rename→wx
	// window of rotation): the log is momentarily GONE — readEventsCursor
	// reports that as an EMPTY cursor, which must not wipe the committed state
	// back to the empty root (parity with poll()'s miss-file branch).
	fs.rmSync(eventsPath());
	const afterResync = source.resync();
	assert.equal(afterResync.seq, before.seq, "seq kept on a failed scan");
	assert.equal(afterResync.events.length, before.events.length, "committed window kept on a failed scan");
	assert.equal(source.stats().resyncs, 1, "the resync attempt still counts");

	// The spine reappears (new inode, further ahead) — the next poll must
	// re-detect the rewrite (stamp was NOT consumed by the failed scan) and
	// rebuild the root from the recovered log.
	fs.writeFileSync(eventsPath(), [line(1), line(2), line(3)].join(""), { flag: "wx" });
	assert.equal(source.poll(), 1, "the rewrite resync counts as one frame");
	const recovered = source.snapshot();
	assert.equal(recovered.seq, 3);
	assert.equal(recovered.events.length, 3);
	source.dispose();
});

test("registry: cap eviction FORCE-disposes the oldest entry even while other holders keep refs", () => {
	const baseline = eventsStateSourceRegistrySize();
	appendEvents(1, 2);
	const a1 = eventsStateSource("run-u7", eventsPath());
	const a2 = eventsStateSource("run-u7", eventsPath()); // refs = 2
	assert.equal(a1, a2);

	// Fill the registry to its cap and keep pushing (a handful beyond the cap
	// keeps the eviction deterministic regardless of leftover baseline) — the
	// oldest-registered entries, including `a`, are evicted. The eviction must
	// HARD-dispose the instance: a refcounted dispose() would merely decrement
	// refs on an entry already deleted from the registry, leaving holders with
	// an "undead" source and the next get-or-create a DUPLICATE cursor.
	for (let i = 0; i < 72; i += 1) {
		eventsStateSource(`run-fill-${i}`, path.join(tmpDir, `fill-${i}.events.jsonl`));
	}
	assert.equal(eventsStateSourceRegistrySize(), baseline + 64);

	appendEvents(3, 1);
	assert.equal(a1.poll(), 0, "evicted source is disposed — no more tail-follow");
	assert.equal(a2.poll(), 0, "second holder shares the same disposed instance");

	const fresh = eventsStateSource("run-u7", eventsPath());
	assert.notEqual(fresh, a1, "a NEW source is created after the eviction");
	assert.equal(fresh.snapshot().seq, 3, "the fresh source reparses the log from storage");
	fresh.dispose();
	a2.dispose(); // no-op on the disposed instance; must not throw
	// fresh's own refcount hit zero — its registry entry drops (back below cap).
	assert.equal(eventsStateSourceRegistrySize(), baseline + 63);
});
