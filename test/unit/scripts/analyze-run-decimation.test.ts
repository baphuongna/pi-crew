/**
 * Bug fix pin: trajectory decimation in scripts/analyze-run.mjs used an
 * even-stride cap (keep every ceil(n/80)-th index). That is aliasing-prone:
 * a unique single-sample RSS spike (OOM, short-lived tool subprocess) landing
 * between kept indices was dropped from the perf report ENTIRELY — the
 * trajectory chart showed a flat line where the incident happened.
 *
 * The fix is max-decimation (decimateTrajectory): ≤80 index buckets, each
 * bucket keeps its max-by-rssBytes point, output ts strictly increasing.
 *
 * RED pin: `oldEvenStride` below reproduces the shipped buggy cap and is
 * asserted to DROP the spike on the fixture (documents the bug; vacuous if
 * the fixture stops triggering it). GREEN: decimateTrajectory retains it.
 *
 * The CLI main-guard (import.meta.url vs argv[1]) is exercised by the sibling
 * subprocess suite analyze-run-audit.test.ts — CLI behavior must stay identical.
 */
import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error TS7016 — scripts/analyze-run.mjs ships no .d.mts (dev-only
// script, same pattern as shard-partition.test.ts / test-runner-exit.test.ts).
// The runtime import is what matters: this is the REAL decimation used by the
// perf report, imported without executing main() thanks to the CLI main-guard.
import { decimateTrajectory } from "../../../scripts/analyze-run.mjs";

interface Pt {
	ts: number;
	rssBytes: number;
	cpuPct?: number;
	pid?: number;
}

/** The SHIPPED (buggy) even-stride cap, reproduced locally to pin the RED side. */
function oldEvenStride(points: Pt[], cap = 80): Pt[] {
	if (points.length <= cap) return points;
	const step = Math.ceil(points.length / cap);
	return points.filter((_, i) => i % step === 0);
}

/** Flat baseline of n samples at 1s spacing + one unique spike at spikeIdx. */
function fixture(n: number, spikeIdx: number, spikeRss = 900): Pt[] {
	return Array.from({ length: n }, (_, i) => ({ ts: i * 1000, rssBytes: i === spikeIdx ? spikeRss : 10 }));
}

test("RED pin: old even-stride cap drops the unique spike (the bug this fix closes)", () => {
	const pts = fixture(400, 137); // step = ceil(400/80) = 5 → keeps i%5===0; 137%5 = 2
	const old = oldEvenStride(pts);
	assert.equal(old.length, 80, "fixture sanity: even stride keeps exactly 80");
	assert.ok(!old.some((p) => p.rssBytes === 900), "fixture sanity: even stride must drop the spike — otherwise the RED pin is vacuous");
});

test("GREEN: max-decimation retains the spike (400 samples → 80 buckets)", () => {
	const pts = fixture(400, 137);
	const dec = decimateTrajectory(pts, 80) as Pt[];
	assert.ok(
		dec.some((p) => p.rssBytes === 900),
		"the unique spike must survive decimation",
	);
	assert.equal(dec.length, 80, "400 samples fill every bucket exactly");
});

test("spike at the LAST index also survives", () => {
	const dec = decimateTrajectory(fixture(400, 399), 80) as Pt[];
	assert.ok(dec.some((p) => p.rssBytes === 900));
	assert.equal(dec.length, 80);
});

test("default cap is 80", () => {
	const dec = decimateTrajectory(fixture(400, 137)) as Pt[];
	assert.equal(dec.length, 80);
	assert.ok(dec.some((p) => p.rssBytes === 900));
});

test("≤ cap passes through unchanged", () => {
	const exact = fixture(80, 79);
	assert.deepEqual(decimateTrajectory(exact, 80), exact);
	const small = fixture(3, 1);
	assert.deepEqual(decimateTrajectory(small), small);
});

test("exactly cap+1 (81) points decimate to ≤80, spike retained", () => {
	const pts = fixture(81, 1); // bucket 0 = indices {0,1} → keeps the spike
	const dec = decimateTrajectory(pts, 80) as Pt[];
	assert.ok(dec.length <= 80 && dec.length > 0);
	assert.ok(dec.some((p) => p.rssBytes === 900));
});

test("order preserved: output ts strictly increasing (pseudo-random rss)", () => {
	const pts = Array.from({ length: 1000 }, (_, i) => ({ ts: i * 50, rssBytes: ((i * 2654435761) % 9973) + 1 }));
	const dec = decimateTrajectory(pts, 80) as Pt[];
	assert.equal(dec.length, 80);
	for (let i = 1; i < dec.length; i++) {
		assert.ok(dec[i].ts > dec[i - 1].ts, `ts[${i}]=${dec[i].ts} must be strictly greater than ts[${i - 1}]=${dec[i - 1].ts}`);
	}
});

test("duplicate ts across worker/tool PIDs collapses — output still strictly increasing", () => {
	const pts: Pt[] = [];
	for (let i = 0; i < 200; i++) {
		const ts = i * 10;
		pts.push({ ts, rssBytes: 10, pid: 1 });
		pts.push({ ts, rssBytes: 20, pid: 2 }); // same ts, same bucket, higher rss
	}
	const dec = decimateTrajectory(pts, 80) as Pt[];
	for (let i = 1; i < dec.length; i++) {
		assert.ok(dec[i].ts > dec[i - 1].ts, `ts[${i}]=${dec[i].ts} must be strictly greater than ts[${i - 1}]=${dec[i - 1].ts}`);
	}
});

test("deterministic tie-break: equal rssBytes → first index in each bucket wins", () => {
	const pts = Array.from({ length: 160 }, (_, i) => ({ ts: i, rssBytes: 42 })); // 2 per bucket, all equal
	const dec = decimateTrajectory(pts, 80) as Pt[];
	const expected = pts.filter((_, i) => i % 2 === 0); // bucket b = {2b, 2b+1} → 2b wins
	assert.deepEqual(dec, expected);
});

test("empty input → empty output", () => {
	assert.deepEqual(decimateTrajectory([], 80), []);
});
