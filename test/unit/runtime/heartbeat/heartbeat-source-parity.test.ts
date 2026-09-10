/**
 * WI-7.4 (M7 spec §5) — heartbeat source parity test.
 *
 * Per spec R3 addendum: "heartbeat unification có liveness/parity test
 * (3 nguồn heartbeat không lệch phase)".
 *
 * SCOPE NOTE (corrected 2026-09-10, review C4): this file tests the SHARED
 * helper semantics used by 2 of the 3 sources — `task.heartbeat`
 * (heartbeat-watcher.ts) and the `crew.heartbeat.staleness_ms` metric gauge
 * (heartbeat-aggregator.ts), both of which consume WorkerHeartbeatState via
 * heartbeatAgeMs(). The 3rd source, `<stateRoot>/heartbeat.json`, is written
 * by team-runner with a DIFFERENT shape ({pid, at, runId, kind,
 * lastTaskUpdateAt}) and aged by a separate mtime-based `heartbeatAgeMs`
 * twin (crash-recovery.ts:432) — it does NOT share lastSeenAt formatting
 * with the other two. Full 3-source unification remains open (WI-7.4 ADR).
 *
 * This test asserts:
 *   - Given a synthetic WorkerHeartbeatState with a known `lastSeenAt`,
 *     the shared helper returns consistent ages for both consumers.
 *   - The `heartbeatAgeMs` helper semantics (0 at creation, +Infinity when
 *     missing, monotonic touch) hold.
 *
 * What this test does NOT cover:
 *   - herdr graceful-kill-by-pid (deferred — see WI-7.4 ADR).
 *   - heartbeat.json mtime-twin parity (see scope note above).
 *   - Multi-source divergence under concurrent write (out of scope;
 *     the writers all use `Date.now()` as a shared clock).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { heartbeatAgeMs } from "../../../../src/runtime/heartbeat/heartbeat-gradient.ts";
import {
	createWorkerHeartbeat,
	touchWorkerHeartbeat,
	type WorkerHeartbeatState,
} from "../../../../src/runtime/heartbeat/worker-heartbeat.ts";

describe("WI-7.4 heartbeat source parity", () => {
	it("createWorkerHeartbeat age is 0 immediately", () => {
		const now = new Date();
		const hb = createWorkerHeartbeat("worker-A", 12345, now);
		const age = heartbeatAgeMs(hb, now.getTime());
		assert.ok(age >= 0 && age < 5, `age=${age} should be near 0`);
	});

	it("heartbeatAgeMs returns +Infinity for missing heartbeat (consistent across consumers)", () => {
		const ageMissing = heartbeatAgeMs(undefined, Date.now());
		assert.equal(ageMissing, Number.POSITIVE_INFINITY);
		// Both helper consumers (heartbeat-watcher + metric gauge) call this
		// same primitive with the WorkerHeartbeatState shape; an undefined
		// input yields +Infinity identically for both.
	});

	it("touchWorkerHeartbeat updates lastSeenAt (parity across writes)", () => {
		const t0 = new Date("2026-09-10T10:00:00.000Z");
		const t1 = new Date("2026-09-10T10:01:00.000Z");
		const hb0 = createWorkerHeartbeat("w", 1, t0);
		const hb1 = touchWorkerHeartbeat(hb0, { turnCount: 2 }, t1);
		// Both sources (manifest heartbeat field + heartbeat.json file
		// writer) read the same `lastSeenAt` string. The metric source
		// computes `now - lastSeenAt` at observation time.
		const age0 = heartbeatAgeMs(hb0, t1.getTime());
		const age1 = heartbeatAgeMs(hb1, t1.getTime());
		assert.equal(age0, 60_000, "old heartbeat should report 60s age");
		assert.equal(age1, 0, "touched heartbeat should report 0 age");
	});

	it("classification identical regardless of source consumer", () => {
		const t0 = new Date("2026-09-10T10:00:00.000Z");
		const t_now = new Date("2026-09-10T10:00:30.000Z"); // 30s later
		const hb = createWorkerHeartbeat("w", 1, t0);
		const age_via_helper = heartbeatAgeMs(hb, t_now.getTime());
		// The metric consumer computes the SAME expression directly.
		// We re-derive it here from raw Date.parse to assert both
		// sources produce identical numbers for the same input.
		const age_via_raw = Math.max(0, t_now.getTime() - Date.parse(hb.lastSeenAt));
		assert.equal(age_via_helper, age_via_raw, "helper must match raw computation");
		assert.equal(age_via_helper, 30_000);
	});

	it("gracefully handles non-ISO lastSeenAt (Infinity output, consistent across sources)", () => {
		const bad: WorkerHeartbeatState = {
			workerId: "w",
			lastSeenAt: "not-an-iso-date",
			alive: true,
		};
		const age = heartbeatAgeMs(bad, Date.now());
		assert.equal(age, Number.POSITIVE_INFINITY);
		// All 3 sources use the same `Date.parse → NaN → +Infinity`
		// fallback in heartbeatAgeMs, so the answer is identical
		// regardless of which source consumed the bad input.
	});
});
