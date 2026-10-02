/**
 * crew-broker-events-replay.test.ts — Table-driven unit tests for the
 * events.since page-replay handler (src/runtime/broker/protocol/events-replay.ts).
 *
 * Replay/idempotency contract (Phase 1.5): a client that missed live frames
 * resumes from `sinceSeq` and pages forward with `limit` — the handler must
 * answer from the durable log only (read-only), with a structured error for
 * unauthed/manifest-less/unknown-run requests, and never throw out of the
 * handler. Frames here are recorded by fake EventWriterHelpers.
 *
 * Fixture: a real scaffold run (same discipline as crew-broker-mailbox-observer
 * .test.ts) + durable appends via appendEventAsync, whose seq assignments are
 * captured so assertions are anchored to actual seqs, not assumed 1..N.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import type { ServerConnection } from "../../../../src/runtime/broker/protocol/connection-state.ts";
import { type EventWriterHelpers, handleEventsSince } from "../../../../src/runtime/broker/protocol/events-replay.ts";
import type { TeamEvent } from "../../../../src/state/event-log/event-log.ts";
import { appendEventAsync } from "../../../../src/state/event-log/event-log.ts";
import { loadRunManifestById } from "../../../../src/state/stores/state-store.ts";
import { teardownCwd } from "../../../fixtures/teardown-cwd.ts";

interface Recorded {
	errors: Array<{ id: string; code: string; message: string }>;
	results: Array<{ id: string; result: unknown }>;
}

function recordingHelpers(): { helpers: EventWriterHelpers; seen: Recorded } {
	const seen: Recorded = { errors: [], results: [] };
	return {
		seen,
		helpers: {
			sendError: (_conn, id, code, message) => {
				seen.errors.push({ id, code, message });
			},
			sendResult: (_conn, id, result) => {
				seen.results.push({ id, result });
			},
		},
	};
}

function conn(runId?: string): ServerConnection {
	return { runId } as unknown as ServerConnection;
}

interface ReplayFixture {
	cwd: string;
	runId: string;
	eventsPath: string;
	/** seqs of the fixture-appended events, ascending. TeamEvent carries no
	 *  id field — metadata.seq is the replay identity (dedup key). */
	seqs: number[];
}

/** Scaffold a run, then append 6 durable events with captured ids/seqs. */
async function replayFixture(prefix: string): Promise<ReplayFixture> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "events-replay" },
		{ cwd },
	);
	const runId = run.details.runId as string;
	const loaded = loadRunManifestById(cwd, runId)!;
	const eventsPath = loaded.manifest.eventsPath;
	const appended: TeamEvent[] = [];
	for (let i = 0; i < 6; i++) {
		appended.push(
			await appendEventAsync(eventsPath, {
				type: "task.progress",
				runId,
				taskId: loaded.tasks[0]?.id ?? "task-1",
				message: `fixture-event-${i + 1}`,
			}),
		);
	}
	const seqs = appended.map((e) => e.metadata?.seq ?? 0);
	return { cwd, runId, eventsPath, seqs };
}

test("events.since: unauthed connection is rejected with a structured auth error", async () => {
	const { helpers, seen } = recordingHelpers();
	await handleEventsSince(conn(undefined), "req-1", {}, helpers, "/any/cwd");
	assert.deepEqual(seen.errors, [{ id: "req-1", code: "auth", message: "not authed" }]);
	assert.equal(seen.results.length, 0);
});

test("events.since: missing cwd is rejected before any disk access", async () => {
	const { helpers, seen } = recordingHelpers();
	await handleEventsSince(conn("run-x"), "req-2", {}, helpers, undefined);
	assert.equal(seen.errors.length, 1);
	assert.equal(seen.errors[0].code, "no-manifest");
	assert.match(seen.errors[0].message, /no cwd configured/);
	assert.equal(seen.results.length, 0);
});

test("events.since: unknown run answers no-manifest with the run id named", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-replay-unknown-"));
	try {
		const { helpers, seen } = recordingHelpers();
		await handleEventsSince(conn("run-does-not-exist"), "req-3", {}, helpers, dir);
		assert.equal(seen.errors.length, 1);
		assert.equal(seen.errors[0].code, "no-manifest");
		assert.match(seen.errors[0].message, /run-does-not-exist/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("events.since: full replay from before the first fixture event (valid input)", async () => {
	const fx = await replayFixture("pi-crew-replay-full-");
	try {
		const { helpers, seen } = recordingHelpers();
		await handleEventsSince(conn(fx.runId), "req-4", { sinceSeq: fx.seqs[0] - 1 }, helpers, fx.cwd);
		assert.equal(seen.errors.length, 0);
		assert.equal(seen.results.length, 1);
		const result = seen.results[0].result as { events: TeamEvent[]; nextSeq: number; hasMore: boolean };
		const gotSeqs = result.events.map((e) => e.metadata?.seq ?? 0);
		for (const seq of fx.seqs) assert.ok(gotSeqs.includes(seq), `fixture event seq=${seq} must replay`);
		assert.equal(result.hasMore, false, "everything fit in one page");
		assert.equal(result.nextSeq, fx.seqs[5], "nextSeq = max delivered seq");
	} finally {
		teardownCwd(fx.cwd);
	}
});

test("events.since: paging honors limit and nextSeq continuation (idempotency: no duplicates)", async () => {
	const fx = await replayFixture("pi-crew-replay-page-");
	try {
		const page1Helpers = recordingHelpers();
		await handleEventsSince(conn(fx.runId), "req-5a", { sinceSeq: fx.seqs[0] - 1, limit: 3 }, page1Helpers.helpers, fx.cwd);
		const page1 = page1Helpers.seen.results[0].result as { events: TeamEvent[]; nextSeq: number; hasMore: boolean };
		assert.equal(page1.events.length, 3);
		assert.equal(page1.hasMore, true, "3 of 6 delivered — more remain");
		assert.equal(page1.nextSeq, fx.seqs[2], "nextSeq is the max seq DELIVERED, never a watermark past undelivered events");

		const page2Helpers = recordingHelpers();
		await handleEventsSince(conn(fx.runId), "req-5b", { sinceSeq: page1.nextSeq, limit: 3 }, page2Helpers.helpers, fx.cwd);
		const page2 = page2Helpers.seen.results[0].result as { events: TeamEvent[]; nextSeq: number; hasMore: boolean };
		assert.equal(page2.events.length, 3);
		assert.equal(page2.hasMore, false);
		assert.equal(page2.nextSeq, fx.seqs[5]);

		const page1Seqs = page1.events.map((e) => e.metadata?.seq ?? 0);
		const page2Seqs = page2.events.map((e) => e.metadata?.seq ?? 0);
		for (const seq of page2Seqs) assert.ok(!page1Seqs.includes(seq), "continuation must never re-deliver a page-1 event");
		assert.deepEqual([...page1Seqs, ...page2Seqs].sort(), [...fx.seqs].sort(), "both pages together = exactly the fixture events");
	} finally {
		teardownCwd(fx.cwd);
	}
});

test("events.since: boundary — sinceSeq at the last event yields an empty page", async () => {
	const fx = await replayFixture("pi-crew-replay-tail-");
	try {
		const { helpers, seen } = recordingHelpers();
		await handleEventsSince(conn(fx.runId), "req-6", { sinceSeq: fx.seqs[5] }, helpers, fx.cwd);
		const result = seen.results[0].result as { events: TeamEvent[]; nextSeq: number; hasMore: boolean };
		const gotSeqs = result.events.map((e) => e.metadata?.seq ?? 0);
		for (const seq of fx.seqs) assert.ok(!gotSeqs.includes(seq), "nothing new after the last seq");
		assert.equal(result.hasMore, false);
		assert.equal(result.nextSeq, fx.seqs[5], "nextSeq echoes the anchor when the page is empty");
	} finally {
		teardownCwd(fx.cwd);
	}
});

test("events.since: adversarial params degrade to defaults instead of throwing", async () => {
	const fx = await replayFixture("pi-crew-replay-adv-");
	try {
		for (const params of ["garbage-string", 42, [1, 2, 3], null]) {
			const { helpers, seen } = recordingHelpers();
			await handleEventsSince(conn(fx.runId), `req-7-${JSON.stringify(params)}`, params, helpers, fx.cwd);
			assert.equal(seen.errors.length, 0, `params=${JSON.stringify(params)} must not error`);
			const result = seen.results[0].result as { events: TeamEvent[] };
			const gotSeqs = result.events.map((e) => e.metadata?.seq ?? 0);
			for (const seq of fx.seqs) assert.ok(gotSeqs.includes(seq), "default replay still returns every fixture event");
		}
	} finally {
		teardownCwd(fx.cwd);
	}
});

test("events.since: sinceSeq/limit normalization table (negative→0, float→floor, limit<1→1)", async () => {
	const fx = await replayFixture("pi-crew-replay-norm-");
	try {
		// sinceSeq normalization: -7 → 0 still replays everything (>= fixture).
		const negHelpers = recordingHelpers();
		await handleEventsSince(conn(fx.runId), "req-8-neg", { sinceSeq: -7 }, negHelpers.helpers, fx.cwd);
		const neg = negHelpers.seen.results[0].result as { events: TeamEvent[] };
		for (const seq of fx.seqs)
			assert.ok(
				neg.events.some((e) => (e.metadata?.seq ?? 0) === seq),
				"negative sinceSeq clamps to 0",
			);

		// float sinceSeq floors: seqs[0]-0.5 → seqs[0]-1 → all 6 events.
		const floatHelpers = recordingHelpers();
		await handleEventsSince(conn(fx.runId), "req-8-float", { sinceSeq: fx.seqs[0] - 0.5 }, floatHelpers.helpers, fx.cwd);
		const flt = floatHelpers.seen.results[0].result as { events: TeamEvent[] };
		const fltSeqs = flt.events.map((e) => e.metadata?.seq ?? 0);
		assert.equal(fx.seqs.filter((seq) => fltSeqs.includes(seq)).length, 6, "floored anchor replays all fixture events");

		// limit normalization: 0 → 1 page; 2.9 → 2.
		const zeroHelpers = recordingHelpers();
		await handleEventsSince(conn(fx.runId), "req-8-zero", { sinceSeq: fx.seqs[0] - 1, limit: 0 }, zeroHelpers.helpers, fx.cwd);
		const zero = zeroHelpers.seen.results[0].result as { events: TeamEvent[]; hasMore: boolean };
		assert.equal(zero.events.length, 1, "limit 0 clamps up to 1 (a page is never empty by cap)");
		assert.equal(zero.hasMore, true);

		const fracHelpers = recordingHelpers();
		await handleEventsSince(conn(fx.runId), "req-8-frac", { sinceSeq: fx.seqs[0] - 1, limit: 2.9 }, fracHelpers.helpers, fx.cwd);
		const frac = fracHelpers.seen.results[0].result as { events: TeamEvent[] };
		assert.equal(frac.events.length, 2, "limit floors to 2");
	} finally {
		teardownCwd(fx.cwd);
	}
});
