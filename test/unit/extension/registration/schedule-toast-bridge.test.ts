/**
 * Tier D (schedules UI): ScheduleChangeEvent → terminal-status toast bridge.
 *
 * Coverage per task packet: fired/error event → notice content, EXACTLY ONE
 * notice per event (bounded, hung-notice pattern), success toast only on a
 * tracked lastStatus TRANSITION, hasUI gating (headless no-op, stale-ctx
 * throw tolerated), and ui.notify failure tolerance (mock ui + injected
 * events — no real scheduler/extension wired).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createScheduleEventNotifier } from "../../../../src/extension/registration/schedule-toast-bridge.ts";
import type { ScheduledJob } from "../../../../src/runtime/scheduling/scheduler.ts";

const T0 = new Date("2026-09-13T05:00:00.000Z");

interface Notice {
	text: string;
	level: "info" | "warning" | "error";
}

function makeHarness(opts?: { hasUI?: () => boolean; throws?: boolean }) {
	const notices: Notice[] = [];
	const ui = {
		notify: (text: string, level: "info" | "warning" | "error"): void => {
			if (opts?.throws) throw new Error("ui down");
			notices.push({ text, level });
		},
	};
	const notifier = createScheduleEventNotifier({
		hasUI: opts?.hasUI ?? (() => true),
		ui,
	});
	return { notices, notifier };
}

function makeJob(overrides?: Partial<ScheduledJob>): ScheduledJob {
	return {
		id: "job-1",
		name: "nightly-digest",
		description: "",
		schedule: "0 3 * * *",
		scheduleType: "cron",
		subagentType: "executor",
		prompt: "{}",
		enabled: true,
		createdAt: T0.toISOString(),
		runCount: 0,
		...overrides,
	};
}

// ── fired / error mapping ─────────────────────────────────────────────

test("fired event → exactly ONE info notice with the spec text", () => {
	const { notices, notifier } = makeHarness();
	notifier({ type: "fired", jobId: "job-1", agentId: "scheduled-job-1-1694584800000", name: "nightly-digest" });
	assert.deepEqual(notices, [{ text: "⏰ nightly-digest fired → scheduled-job-1-1694584800000", level: "info" }]);
});

test("error event → exactly ONE red (error-level) notice carrying jobId + message", () => {
	const { notices, notifier } = makeHarness();
	notifier({ type: "error", jobId: "job-1", error: "Scheduled time 2026-09-13T04:00:00.000Z is in the past" });
	assert.equal(notices.length, 1);
	assert.equal(notices[0].level, "error");
	assert.ok(notices[0].text.includes("job-1"));
	assert.ok(notices[0].text.includes("is in the past"));
});

test("error event: multiline payload → first line only", () => {
	const { notices, notifier } = makeHarness();
	notifier({ type: "error", jobId: "job-1", error: "boom\nstack line 2\nstack line 3" });
	assert.equal(notices.length, 1);
	assert.ok(!notices[0].text.includes("stack line 2"));
	assert.ok(notices[0].text.endsWith("boom"));
});

test("error event: payload clipped to ~200 chars", () => {
	const { notices, notifier } = makeHarness();
	notifier({ type: "error", jobId: "job-1", error: "x".repeat(500) });
	assert.equal(notices.length, 1);
	assert.ok(notices[0].text.length <= 200 + "⏰ scheduled job job-1 failed: ".length, `got ${notices[0].text.length}`);
});

// ── success via tracked lastStatus transition ─────────────────────────

test("updated → success ONLY on a tracked transition; repeated success updates stay silent", () => {
	const { notices, notifier } = makeHarness();
	const job = makeJob({ lastStatus: undefined });
	notifier({ type: "added", job }); // persisted registration — no toast
	notifier({ type: "updated", job: { ...job, lastStatus: "running" } }); // fire() marks running — no toast
	notifier({ type: "updated", job: { ...job, lastStatus: "success" } }); // completion — ONE toast
	notifier({ type: "updated", job: { ...job, lastStatus: "success", enabled: false } }); // patch — silent
	notifier({ type: "updated", job: { ...job, lastStatus: "success", runCount: 3 } }); // patch — silent
	assert.deepEqual(notices, [{ text: "⏰ nightly-digest ✓ succeeded", level: "info" }]);
});

// ── review round 1, MAJOR-2: async failure via the running→error transition ──

test("updated running→error (async executor rejection) → exactly ONE red ✗ failed notice", () => {
	const { notices, notifier } = makeHarness();
	const job = makeJob({ lastStatus: undefined });
	notifier({ type: "added", job });
	notifier({ type: "updated", job: { ...job, lastStatus: "running" } }); // fire() marks running — no toast
	// lifecycle-handlers finalization: async handleTeamTool rejection recorded
	// as an updated event — NO scheduler `error` event is emitted for it.
	notifier({ type: "updated", job: { ...job, lastStatus: "error" } });
	assert.deepEqual(notices, [{ text: "⏰ nightly-digest ✗ failed", level: "error" }]);
});

test("updated → error withOUT a running predecessor stays silent (persisted error re-registration / patches)", () => {
	const { notices, notifier } = makeHarness();
	const job = makeJob({ lastStatus: "error" });
	notifier({ type: "added", job });
	notifier({ type: "updated", job: { ...job, enabled: false } }); // patch on an errored job — silent
	notifier({ type: "updated", job: { ...job, enabled: true } }); // patch — silent
	assert.deepEqual(notices, []);
});

test("sync executor throw (error event AFTER the running→error transition) → still exactly ONE failure notice", () => {
	const { notices, notifier } = makeHarness();
	const job = makeJob({ lastStatus: undefined });
	notifier({ type: "added", job });
	// fire()'s exact sync-throw sequence: running → error-transition, then the
	// scheduler `error` event. The transition claims the attempt; the error
	// event must not double-toast it.
	notifier({ type: "updated", job: { ...job, lastStatus: "running" } });
	notifier({ type: "updated", job: { ...job, lastStatus: "error" } });
	notifier({ type: "error", jobId: "job-1", error: "executor blew up" });
	assert.equal(notices.length, 1);
	assert.equal(notices[0].level, "error");
	assert.ok(notices[0].text.includes("failed"));
});

test("retry after a failure: a new running attempt re-arms the failure notice", () => {
	const { notices, notifier } = makeHarness();
	const job = makeJob({ lastStatus: undefined });
	notifier({ type: "added", job });
	notifier({ type: "updated", job: { ...job, lastStatus: "running" } });
	notifier({ type: "updated", job: { ...job, lastStatus: "error" } }); // attempt 1 fails
	notifier({ type: "updated", job: { ...job, lastStatus: "running" } }); // attempt 2 fires
	notifier({ type: "updated", job: { ...job, lastStatus: "error" } }); // attempt 2 fails again
	assert.equal(notices.length, 2);
	assert.deepEqual(notices[1], { text: "⏰ nightly-digest ✗ failed", level: "error" });
});

test("past-time once-job registration (updated undefined→error THEN error event) → exactly ONE notice, from the error event", () => {
	const { notices, notifier } = makeHarness();
	const job = makeJob({ lastStatus: undefined });
	notifier({ type: "added", job });
	// arm()'s past-time sequence: update({enabled:false, lastStatus:"error"})
	// then a dedicated error event. The transition has NO running predecessor,
	// so only the error event toasts.
	notifier({ type: "updated", job: { ...job, lastStatus: "error", enabled: false } });
	notifier({ type: "error", jobId: "job-1", error: "Scheduled time … is in the past" });
	assert.equal(notices.length, 1);
	assert.ok(notices[0].text.includes("is in the past"));
});

test("updated without a lastStatus transition (enable/disable) never toasts", () => {
	const { notices, notifier } = makeHarness();
	const job = makeJob({ lastStatus: "success" });
	notifier({ type: "added", job });
	notifier({ type: "updated", job: { ...job, enabled: false } });
	notifier({ type: "updated", job: { ...job, enabled: true } });
	assert.deepEqual(notices, []);
});

test("added with a persisted success status never toasts (session re-registration)", () => {
	const { notices, notifier } = makeHarness();
	notifier({ type: "added", job: makeJob({ lastStatus: "success" }) });
	notifier({ type: "updated", job: makeJob({ lastStatus: "success", runCount: 5 }) });
	assert.deepEqual(notices, []);
});

test("removed clears tracking: a later fresh run toasts again", () => {
	const { notices, notifier } = makeHarness();
	const job = makeJob();
	notifier({ type: "added", job });
	notifier({ type: "updated", job: { ...job, lastStatus: "running" } });
	notifier({ type: "updated", job: { ...job, lastStatus: "success" } });
	notifier({ type: "removed", jobId: job.id, spawnedRunIds: [] });
	notifier({ type: "added", job });
	notifier({ type: "updated", job: { ...job, lastStatus: "success" } });
	assert.equal(notices.length, 2);
	assert.deepEqual(notices[1], { text: "⏰ nightly-digest ✓ succeeded", level: "info" });
});

// ── boundedness + gating ──────────────────────────────────────────────

test("exactly one notice per event: N fired events → N notices, no extra drip", () => {
	const { notices, notifier } = makeHarness();
	for (let i = 0; i < 3; i++) notifier({ type: "fired", jobId: "job-1", agentId: `a-${i}`, name: "nightly-digest" });
	assert.equal(notices.length, 3);
});

test("headless (hasUI=false): all events are silent no-ops — no crash", () => {
	const { notices, notifier } = makeHarness({ hasUI: () => false });
	notifier({ type: "fired", jobId: "job-1", agentId: "a", name: "n" });
	notifier({ type: "error", jobId: "job-1", error: "boom" });
	assert.deepEqual(notices, []);
});

test("stale ctx (hasUI getter throws): tolerated as headless — no crash, no notice", () => {
	const { notices, notifier } = makeHarness({
		hasUI: () => {
			throw new Error("stale context");
		},
	});
	notifier({ type: "fired", jobId: "job-1", agentId: "a", name: "n" });
	assert.deepEqual(notices, []);
});

test("ui.notify throwing is swallowed — the bridge never breaks the scheduler path", () => {
	const { notifier } = makeHarness({ throws: true });
	assert.doesNotThrow(() => {
		notifier({ type: "fired", jobId: "job-1", agentId: "a", name: "n" });
		notifier({ type: "error", jobId: "job-1", error: "boom" });
	});
});

test("missing ui object (undefined) is a no-op, not a crash", () => {
	const notifier = createScheduleEventNotifier({ hasUI: () => true, ui: undefined });
	assert.doesNotThrow(() => notifier({ type: "fired", jobId: "job-1", agentId: "a", name: "n" }));
});

// ── security review F-2: control-char stripping on interpolated fields ──

test("fired event: control chars in name/agentId are stripped before notify", () => {
	const { notices, notifier } = makeHarness();
	notifier({ type: "fired", jobId: "job-1", agentId: "a\rX", name: "nightly\nActions: spoof" });
	assert.equal(notices.length, 1);
	assert.ok(!notices[0].text.includes("\n"), "no line-break injection");
	assert.ok(!notices[0].text.includes("\r"), "no carriage-return injection");
	assert.ok(notices[0].text.includes("nightly Actions: spoof"), "payload stays legible after sanitization");
});

test("error event: control chars in jobId/error are stripped before notify", () => {
	const { notices, notifier } = makeHarness();
	notifier({ type: "error", jobId: "job\n1", error: "boom\rsecond-line" });
	assert.equal(notices.length, 1);
	assert.ok(!notices[0].text.includes("\n"));
	assert.ok(!notices[0].text.includes("\r"));
});

test("failure-transition toast: control chars in the job name are stripped", () => {
	const { notices, notifier } = makeHarness();
	const job = makeJob({ id: "job-1", name: "evil\roverwrite", lastStatus: undefined });
	notifier({ type: "added", job });
	notifier({ type: "updated", job: { ...job, lastStatus: "running" } });
	notifier({ type: "updated", job: { ...job, lastStatus: "error" } });
	assert.equal(notices.length, 1);
	assert.ok(!notices[0].text.includes("\r"));
});
