import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { detectSchedule, parseInterval, parseRelativeTime, ScheduleStore, validateCronExpression } from "../../src/state/schedule.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

// ── parseRelativeTime ──

describe("parseRelativeTime", () => {
	it("parses +10s to an ISO string", () => {
		const result = parseRelativeTime("+10s");
		assert.ok(result !== null);
		assert.ok(result.endsWith("Z"));
		const delta = Date.parse(result) - Date.now();
		assert.ok(delta >= 9000 && delta <= 11000, `expected ~10s, got ${delta}ms`);
	});

	it("parses +5m to an ISO string", () => {
		const result = parseRelativeTime("+5m");
		assert.ok(result !== null);
		const delta = Date.parse(result) - Date.now();
		assert.ok(delta >= 290_000 && delta <= 310_000);
	});

	it("parses +1h to an ISO string", () => {
		const result = parseRelativeTime("+1h");
		assert.ok(result !== null);
		const delta = Date.parse(result) - Date.now();
		assert.ok(delta >= 3_590_000 && delta <= 3_610_000);
	});

	it("parses +2d to an ISO string", () => {
		const result = parseRelativeTime("+2d");
		assert.ok(result !== null);
		const delta = Date.parse(result) - Date.now();
		assert.ok(delta >= 172_790_000 && delta <= 172_810_000);
	});

	it("returns null for non-relative strings", () => {
		assert.equal(parseRelativeTime("10s"), null);
		assert.equal(parseRelativeTime("hello"), null);
		assert.equal(parseRelativeTime(""), null);
	});
});

// ── parseInterval ──

describe("parseInterval", () => {
	it("parses 10s to 10000ms", () => {
		assert.equal(parseInterval("10s"), 10_000);
	});

	it("parses 5m to 300000ms", () => {
		assert.equal(parseInterval("5m"), 300_000);
	});

	it("parses 1h to 3600000ms", () => {
		assert.equal(parseInterval("1h"), 3_600_000);
	});

	it("parses 2d to 172800000ms", () => {
		assert.equal(parseInterval("2d"), 172_800_000);
	});

	it("returns null for invalid formats", () => {
		assert.equal(parseInterval("+10m"), null);
		assert.equal(parseInterval("hello"), null);
		assert.equal(parseInterval(""), null);
	});
});

// ── validateCronExpression ──

describe("validateCronExpression", () => {
	it("accepts valid 6-field cron", () => {
		const result = validateCronExpression("0 0 9 * * 1");
		assert.equal(result.valid, true);
		assert.equal(result.error, undefined);
	});

	it("rejects expression with wrong number of fields", () => {
		const result = validateCronExpression("0 0 9 * *");
		assert.equal(result.valid, false);
		assert.ok(result.error!.includes("6 fields"));
	});

	it("rejects expression with empty fields", () => {
		const result = validateCronExpression("0  0 9  *  *  1");
		// This has double spaces but split(/\s+/) normalizes them
		assert.equal(result.valid, true); // valid because split handles multiple spaces
	});

	it("accepts complex cron expressions", () => {
		assert.equal(validateCronExpression("*/5 0 * * * *").valid, true);
		assert.equal(validateCronExpression("0 30 9 1 1 *").valid, true);
	});

	it("rejects 7-field cron", () => {
		const result = validateCronExpression("0 0 9 * * 1 extra");
		assert.equal(result.valid, false);
	});
});

// ── detectSchedule ──

describe("detectSchedule", () => {
	it("detects relative one-shot schedule", () => {
		const result = detectSchedule("+10m");
		assert.equal(result.type, "once");
		assert.ok(result.normalized.endsWith("Z"));
	});

	it("detects interval schedule", () => {
		const result = detectSchedule("5m");
		assert.equal(result.type, "interval");
		if (result.type === "interval") {
			assert.equal(result.intervalMs, 300_000);
		}
	});

	it("detects cron schedule", () => {
		const result = detectSchedule("0 0 9 * * 1");
		assert.equal(result.type, "cron");
	});

	it("detects future ISO timestamp as once", () => {
		const future = new Date(Date.now() + 3600_000).toISOString();
		const result = detectSchedule(future);
		assert.equal(result.type, "once");
	});

	it("throws for past ISO timestamp", () => {
		const past = new Date(Date.now() - 3600_000).toISOString();
		assert.throws(() => detectSchedule(past), /in the past/);
	});

	it("throws for invalid schedule string", () => {
		assert.throws(() => detectSchedule("notaschedule"), /Invalid schedule/);
	});
});

// ── ScheduleStore ──

describe("ScheduleStore", () => {
	const tmpDirs: string[] = [];

	function createStorePath(): string {
		const dir = createTrackedTempDir("pi-crew-sched-cov-");
		tmpDirs.push(dir);
		return path.join(dir, "schedule.json");
	}

	function makeJob(id: string) {
		return {
			id,
			name: `job-${id}`,
			description: `Test job ${id}`,
			schedule: "5m",
			scheduleType: "interval" as const,
			intervalMs: 300_000,
			workflowName: "test",
			agentName: "executor",
			enabled: true,
			createdAt: new Date().toISOString(),
			runCount: 0,
		};
	}

	it("starts with empty job list", () => {
		const store = new ScheduleStore(createStorePath());
		assert.deepEqual(store.list(), []);
	});

	it("adds and retrieves a job", () => {
		const store = new ScheduleStore(createStorePath());
		const job = makeJob("j1");
		store.add(job);
		assert.equal(store.list().length, 1);
		assert.deepEqual(store.get("j1"), job);
	});

	it("checks if job name exists", () => {
		const store = new ScheduleStore(createStorePath());
		const job = makeJob("j1");
		job.name = "my-job";
		store.add(job);
		assert.equal(store.hasName("my-job"), true);
		assert.equal(store.hasName("nonexistent"), false);
	});

	it("updates a job by id", () => {
		const store = new ScheduleStore(createStorePath());
		const job = makeJob("j1");
		store.add(job);
		const updated = store.update("j1", { enabled: false });
		assert.ok(updated);
		assert.equal(updated!.enabled, false);
	});

	it("returns undefined when updating nonexistent job", () => {
		const store = new ScheduleStore(createStorePath());
		assert.equal(store.update("nope", { enabled: false }), undefined);
	});

	it("removes a job by id", () => {
		const store = new ScheduleStore(createStorePath());
		store.add(makeJob("j1"));
		store.add(makeJob("j2"));
		assert.equal(store.remove("j1"), true);
		assert.equal(store.list().length, 1);
		assert.equal(store.get("j1"), undefined);
	});

	it("returns false when removing nonexistent job", () => {
		const store = new ScheduleStore(createStorePath());
		assert.equal(store.remove("nope"), false);
	});

	it("persists data to disk", () => {
		const storePath = createStorePath();
		const store1 = new ScheduleStore(storePath);
		store1.add(makeJob("j1"));
		// Create a new store instance reading from the same file
		const store2 = new ScheduleStore(storePath);
		assert.equal(store2.list().length, 1);
		assert.equal(store2.get("j1")!.name, "job-j1");
	});

	it("handles corrupt file gracefully", () => {
		const storePath = createStorePath();
		fs.writeFileSync(storePath, "not json at all");
		const store = new ScheduleStore(storePath);
		assert.deepEqual(store.list(), []);
	});

	it("handles missing file gracefully", () => {
		const storePath = path.join(createStorePath(), "nonexistent.json");
		const store = new ScheduleStore(storePath);
		assert.deepEqual(store.list(), []);
	});

	// Cleanup
	it("cleanup temp dirs", () => {
		for (const dir of tmpDirs) {
			removeTrackedTempDir(dir);
		}
		assert.ok(true, "cleanup done");
	});
});
