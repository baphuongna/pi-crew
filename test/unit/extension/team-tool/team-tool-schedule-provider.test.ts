/**
 * Unit tests for the getScheduledJobs() single-source-of-truth provider (G17)
 * and the subAction='run-now' extension-layer channel.
 * @see src/extension/team-tool/handle-schedule.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	getCrewScheduler,
	getScheduledJobs,
	handleRunNowScheduled,
	handleSchedule,
	registerCrewScheduler,
	unregisterCrewScheduler,
} from "../../../../src/extension/team-tool/handle-schedule.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { CrewScheduler } from "../../../../src/runtime/scheduling/scheduler.ts";
import { saveCrewSettings } from "../../../../src/runtime/settings-store.ts";
import type { TeamToolParamsValue } from "../../../../src/schema/team-tool-schema.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeParams(overrides: Partial<TeamToolParamsValue> = {}): TeamToolParamsValue {
	return { ...overrides };
}

function makeJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "job-1",
		name: "nightly",
		description: "",
		schedule: "0 9 * * *",
		scheduleType: "cron",
		subagentType: "team",
		prompt: "{}",
		enabled: true,
		createdAt: "2026-09-01T00:00:00.000Z",
		runCount: 3,
		...overrides,
	};
}

function writeGlobalFile(dir: string, settings: Record<string, unknown>): string {
	const file = path.join(dir, "global-crew-settings.json");
	fs.writeFileSync(file, JSON.stringify(settings), "utf-8");
	return file;
}

/** Register/unregister the module-scoped scheduler around each test. */
function withScheduler(ref: unknown | undefined, fn: () => void): void {
	const saved = getCrewScheduler();
	if (ref === undefined) unregisterCrewScheduler();
	else registerCrewScheduler(ref as never);
	try {
		fn();
	} finally {
		if (saved) registerCrewScheduler(saved);
		else unregisterCrewScheduler();
	}
}

// ─── getScheduledJobs provider (G17 single source of truth) ──────────────────

describe("getScheduledJobs", () => {
	it("returns scheduler.list() verbatim when the singleton is registered — no defaults merged", () => {
		const tmp = createTrackedTempDir("sched-provider-");
		try {
			// Persisted settings hold a DIFFERENT job — provider must ignore them.
			saveCrewSettings({ scheduledJobs: [makeJob({ id: "from-settings" })] }, tmp);
			const live = [makeJob({ id: "live-1" }), makeJob({ id: "live-2", enabled: false })];
			const fake = {
				add: () => undefined,
				list: () => live,
				remove: () => false,
				update: () => undefined,
				runNow: () => ({ ok: true as const }),
			};

			withScheduler(fake, () => {
				const out = getScheduledJobs(tmp);
				assert.deepEqual(
					out.map((j) => j.id),
					["live-1", "live-2"],
				);
				assert.equal(out, live, "must be the scheduler's own array (no copy/merge)");
			});
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("falls back to the gated tiers view when no scheduler is registered", () => {
		const tmp = createTrackedTempDir("sched-provider-");
		try {
			saveCrewSettings({ scheduledJobs: [makeJob({ id: "project-1" })] }, tmp);
			const globalFile = writeGlobalFile(tmp, {});

			withScheduler(undefined, () => {
				// No user-tier opt-in → project-tier jobs are gated OUT (parity with
				// the session-start registration loop, Wave B2).
				assert.deepEqual(getScheduledJobs(tmp, globalFile), []);
			});
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("fallback includes project-tier jobs only after user-tier opt-in, user jobs first", () => {
		const tmp = createTrackedTempDir("sched-provider-");
		try {
			saveCrewSettings({ scheduledJobs: [makeJob({ id: "project-1" })] }, tmp);
			const globalFile = writeGlobalFile(tmp, {
				schedulingEnabled: true,
				allowProjectScheduledJobs: true,
				scheduledJobs: [makeJob({ id: "user-1" })],
			});

			withScheduler(undefined, () => {
				assert.deepEqual(
					getScheduledJobs(tmp, globalFile).map((j) => j.id),
					["user-1", "project-1"],
				);
			});
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("fallback filters malformed persisted entries instead of crashing", () => {
		const tmp = createTrackedTempDir("sched-provider-");
		try {
			const globalFile = writeGlobalFile(tmp, {
				scheduledJobs: [
					makeJob({ id: "valid-1" }),
					{ id: "", scheduleType: "cron", enabled: true }, // empty id → invalid
					{ nope: true }, // junk
					"not-an-object",
				],
			});

			withScheduler(undefined, () => {
				assert.deepEqual(
					getScheduledJobs(tmp, globalFile).map((j) => j.id),
					["valid-1"],
				);
			});
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("provider parity: fallback view equals what session-start would register", () => {
		const tmp = createTrackedTempDir("sched-provider-");
		try {
			saveCrewSettings({ scheduledJobs: [makeJob({ id: "project-1", enabled: false })] }, tmp);
			const globalFile = writeGlobalFile(tmp, {
				schedulingEnabled: true,
				allowProjectScheduledJobs: true,
				scheduledJobs: [makeJob({ id: "user-1" })],
			});

			// What the registration loop (lifecycle-handlers) would arm:
			const registrationScheduler = new CrewScheduler();
			registrationScheduler.start({ emit: () => undefined, executor: () => "x", finalizer: () => undefined });

			withScheduler(undefined, () => {
				const providerView = getScheduledJobs(tmp, globalFile);
				for (const job of providerView) registrationScheduler.add(job);
				const registered = registrationScheduler.list();

				assert.deepEqual(
					providerView.map((j) => ({ id: j.id, enabled: j.enabled })),
					registered.map((j) => ({ id: j.id, enabled: j.enabled })),
					"headless read view must match the would-register view",
				);
			});
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── subAction='run-now' extension-layer channel ──────────────────────────────

describe("handleRunNowScheduled", () => {
	it("requires jobId", () => {
		withScheduler(undefined, () => {
			const res = handleRunNowScheduled(makeParams());
			assert.strictEqual(res.isError, true);
			assert.ok(textFromToolResult(res).includes("jobId"));
		});
	});

	it("errors when the scheduler is not running", () => {
		withScheduler(undefined, () => {
			const res = handleRunNowScheduled(makeParams({ subAction: "run-now", jobId: "job-1" }));
			assert.strictEqual(res.isError, true);
			assert.ok(textFromToolResult(res).includes("Scheduler not running"));
		});
	});

	it("routes through the scheduler's runNow (executor reused)", () => {
		const events: Array<{ type: string; jobId?: string }> = [];
		const scheduler = new CrewScheduler();
		scheduler.start({ emit: (e) => events.push(e), executor: () => "agent-now", finalizer: () => undefined });
		scheduler.add(makeJob({ id: "job-1" }) as never);

		withScheduler(scheduler, () => {
			const res = handleRunNowScheduled(makeParams({ subAction: "run-now", jobId: "job-1" }));
			assert.strictEqual(res.isError, false);
			assert.ok(textFromToolResult(res).includes("Scheduled job triggered."));
			assert.ok(events.some((e) => e.type === "fired" && e.jobId === "job-1"));
		});
	});

	it("passes scheduler errors through", () => {
		const scheduler = new CrewScheduler();
		scheduler.start({ emit: () => undefined, executor: () => "x", finalizer: () => undefined });

		withScheduler(scheduler, () => {
			const res = handleRunNowScheduled(makeParams({ subAction: "run-now", jobId: "ghost" }));
			assert.strictEqual(res.isError, true);
			assert.ok(textFromToolResult(res).includes("ghost"));
		});
	});

	it("handleSchedule dispatches subAction='run-now' to the handler", () => {
		const scheduler = new CrewScheduler();
		scheduler.start({ emit: () => undefined, executor: () => "x", finalizer: () => undefined });
		scheduler.add(makeJob({ id: "job-1" }) as never);

		withScheduler(scheduler, () => {
			// No goal given — must NOT hit the create path; run-now routes first.
			const res = handleSchedule(makeParams({ subAction: "run-now", jobId: "job-1" }), { cwd: process.cwd() });
			assert.strictEqual(res.isError, false);
			assert.ok(textFromToolResult(res).includes("Scheduled job triggered."));
		});
	});
});
