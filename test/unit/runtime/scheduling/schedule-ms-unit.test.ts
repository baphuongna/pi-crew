import assert from "node:assert/strict";
import test from "node:test";
import { CrewScheduler, nextRunTime, parseSchedule } from "../../../../src/runtime/scheduling/scheduler.ts";

/**
 * Regression (found live 2026-09-21): `team action='schedule' interval=3600000`
 * was IMPOSSIBLE to satisfy. handle-schedule.ts builds the spec string
 * `${params.interval}ms` from the numeric interval param, but both interval
 * parsers (parseIntervalMs, used by the exported parseSchedule; and
 * CrewScheduler.detectSchedule) only accepted s|m|h|d — the "ms" suffix always fell
 * through to the error branch ("Invalid schedule … Use 5m, +10m, ISO, cron")
 * even though the caller had used the only format the schema accepts (a plain
 * ms number).
 */

// biome-ignore lint/suspicious/noTemplateCurlyInString: the `${interval}ms` is documentation of the format under test, not an interpolation
test("parseSchedule accepts the ms unit (handle-schedule's `${interval}ms` round-trip)", () => {
	const r = parseSchedule("3600000ms");
	assert.ok(!("error" in r), `must parse, got error: ${("error" in r && r.error) || ""}`);
	assert.equal((r as { kind: string }).kind, "interval");
});

test("nextRunTime resolves an ms interval to exactly from+intervalMs", () => {
	const from = new Date("2026-09-21T00:00:00.000Z");
	const next = nextRunTime({ kind: "interval", spec: "3600000ms" }, from);
	assert.ok(next instanceof Date, "must resolve, not error");
	assert.equal((next as Date).toISOString(), "2026-09-21T01:00:00.000Z");
});

test("ms stays distinct from s (5000ms = 5s-of-ms, 5000s = 5000000ms)", () => {
	const from = new Date(0);
	const a = nextRunTime({ kind: "interval", spec: "5000ms" }, from) as Date;
	const b = nextRunTime({ kind: "interval", spec: "5000s" }, from) as Date;
	assert.equal(a.getTime(), 5_000);
	assert.equal(b.getTime(), 5_000_000);
});

test("multi-unit intervals and plain units still parse (no regression)", () => {
	const from = new Date(0);
	const multi = nextRunTime({ kind: "interval", spec: "1h30m" }, from) as Date;
	assert.equal(multi.getTime(), 5_400_000);
	const plain = nextRunTime({ kind: "interval", spec: "5m" }, from) as Date;
	assert.equal(plain.getTime(), 300_000);
});

test("CrewScheduler.detectSchedule also accepts the ms unit", () => {
	const r = CrewScheduler.detectSchedule("3600000ms");
	assert.equal(r.type, "interval");
	assert.equal(r.intervalMs, 3_600_000);
});

test("garbage specs still fail", () => {
	const r = parseSchedule("soon");
	assert.ok("error" in r, "non-spec strings must return an error");
});
