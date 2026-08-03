import assert from "node:assert/strict";
import test from "node:test";
import { humanizeSchedule, nextRunTime, parseSchedule } from "../../src/runtime/scheduling/scheduler.ts";

test("parseSchedule detects ISO datetime for once kind", () => {
	const result = parseSchedule("2026-05-15T10:30:00.000Z");
	assert.equal((result as { kind: string }).kind, "once");
	assert.equal((result as { spec: string }).spec, "2026-05-15T10:30:00.000Z");
});

test("parseSchedule detects relative formats +5m / +1h / +30s", () => {
	const r1 = parseSchedule("+5m");
	assert.equal((r1 as { kind: string }).kind, "once");
	assert.equal((r1 as { spec: string }).spec, "+5m");

	const r2 = parseSchedule("+1h");
	assert.equal((r2 as { kind: string }).kind, "once");
	assert.equal((r2 as { spec: string }).spec, "+1h");

	const r3 = parseSchedule("+30s");
	assert.equal((r3 as { kind: string }).kind, "once");
	assert.equal((r3 as { spec: string }).spec, "+30s");
});

test("parseSchedule detects interval format like 5m and 1h30m", () => {
	const r1 = parseSchedule("5m");
	assert.equal((r1 as { kind: string }).kind, "interval");
	assert.equal((r1 as { spec: string }).spec, "5m");

	const r2 = parseSchedule("1h30m");
	assert.equal((r2 as { kind: string }).kind, "interval");
	assert.equal((r2 as { spec: string }).spec, "1h30m");
});

test("parseSchedule detects cron format (5 space-separated fields)", () => {
	const result = parseSchedule("0 12 * * *");
	assert.equal((result as { kind: string }).kind, "cron");
	assert.equal((result as { spec: string }).spec, "0 12 * * *");
});

test("parseSchedule returns error for invalid input", () => {
	const result = parseSchedule("totally invalid");
	assert.ok("error" in result);
	assert.ok(typeof (result as { error: string }).error === "string");
});

test("nextRunTime from ISO once returns that exact time", () => {
	const spec = { kind: "once" as const, spec: "2026-06-01T08:00:00.000Z" };
	const result = nextRunTime(spec);
	assert.ok(result instanceof Date);
	assert.equal((result as Date).toISOString(), "2026-06-01T08:00:00.000Z");
});

test("nextRunTime from relative +10m returns ~10 minutes in future", () => {
	const from = new Date("2026-05-10T10:00:00.000Z");
	const spec = { kind: "once" as const, spec: "+10m" };
	const result = nextRunTime(spec, from);
	assert.ok(result instanceof Date);
	assert.equal((result as Date).toISOString(), "2026-05-10T10:10:00.000Z");
});

test("nextRunTime from interval returns the next tick after from", () => {
	const from = new Date("2026-05-10T10:00:00.000Z");

	const spec1 = { kind: "interval" as const, spec: "5m" };
	const result1 = nextRunTime(spec1, from);
	assert.ok(result1 instanceof Date);
	assert.equal((result1 as Date).toISOString(), "2026-05-10T10:05:00.000Z");

	const spec2 = { kind: "interval" as const, spec: "1h30m" };
	const result2 = nextRunTime(spec2, from);
	assert.ok(result2 instanceof Date);
	assert.equal((result2 as Date).toISOString(), "2026-05-10T11:30:00.000Z");
});

test("nextRunTime from cron returns correct next occurrence", () => {
	const from = new Date("2026-05-10T10:00:00.000Z");
	const spec = { kind: "cron" as const, spec: "0 12 * * *" };
	const result = nextRunTime(spec, from);
	assert.ok(result instanceof Date);
	assert.equal((result as Date).toISOString(), "2026-05-10T12:00:00.000Z");
});

test("humanizeSchedule produces human-readable labels", () => {
	assert.equal(humanizeSchedule({ kind: "once", spec: "2026-05-15T10:00:00Z" }), "once at 2026-05-15T10:00:00Z");
	assert.equal(humanizeSchedule({ kind: "once", spec: "+10m" }), "once in 10m");
	assert.equal(humanizeSchedule({ kind: "interval", spec: "5m" }), "every 5m");
	assert.equal(humanizeSchedule({ kind: "interval", spec: "1h30m" }), "every 1h30m");
	assert.equal(humanizeSchedule({ kind: "cron", spec: "0 12 * * *" }), "cron 0 12 * * *");
});
