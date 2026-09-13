/**
 * dashboard-schedule-routing.test.ts — review round 1, MAJOR-1 regression:
 * openTeamDashboard (the PRODUCTION dashboard host in commands/shared.ts)
 * must CONSUME pane-8 schedule-* selections by routing them through the
 * extension channel — handleTeamTool({action:'schedule', subAction, jobId})
 * → handle-schedule.ts — instead of letting them fall into the generic
 * handleTeamTool fall-through, where they dead-ended with an
 * "unknown action" error AND closed the dashboard.
 *
 * Seams used (all sanctioned/production-unchanged):
 *   • __test__setHandleTeamTool — recording stub in the lazy-import cache
 *     (see commands-handler.test.ts for the rationale).
 *   • setTeamCommandsDeps — minimal deps for the module-level depsRef.
 *   • The overlay host is faked: ctx.ui.custom returns scripted selections
 *     (the RunDashboard factory itself is never invoked, so no TUI needed).
 * @see src/extension/registration/commands/shared.ts
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { __test__setHandleTeamTool, openTeamDashboard } from "../../../../../src/extension/registration/commands/index.ts";
import { setTeamCommandsDeps } from "../../../../../src/extension/registration/commands/shared.ts";
import type { RunDashboardSelection } from "../../../../../src/ui/run-dashboard.ts";

interface RecordedCall {
	action: unknown;
	subAction: unknown;
	jobId: unknown;
	runId: unknown;
}

function fakeCtx(scripted: Array<RunDashboardSelection | undefined>): {
	ctx: never;
	notices: Array<{ text: string; level: string }>;
	customCalls: () => number;
} {
	const notices: Array<{ text: string; level: string }> = [];
	let customCalls = 0;
	const ctx = {
		cwd: "/tmp/pi-crew-test",
		hasUI: true,
		ui: {
			notify: (text: string, level: string) => {
				notices.push({ text, level });
			},
			custom: async <T>(): Promise<T> => {
				const selection = scripted[Math.min(customCalls, scripted.length - 1)];
				customCalls++;
				return selection as T;
			},
		},
	};
	return { ctx: ctx as never, notices, customCalls: () => customCalls };
}

function stubHandleTeamTool(calls: RecordedCall[]): void {
	__test__setHandleTeamTool((async (params: Record<string, unknown>) => {
		calls.push({ action: params.action, subAction: params.subAction, jobId: params.jobId, runId: params.runId });
		return { content: [{ type: "text", text: "Scheduled job updated." }], details: {}, isError: false };
	}) as never);
}

afterEach(() => {
	__test__setHandleTeamTool(undefined);
});

for (const [action, subAction] of [
	["schedule-disable", "disable"],
	["schedule-enable", "enable"],
	["schedule-run-now", "run-now"],
	["schedule-remove", "remove"],
] as const) {
	test(`pane-8 ${action} selection routes through the schedule channel and reopens the dashboard`, async () => {
		const calls: RecordedCall[] = [];
		stubHandleTeamTool(calls);
		setTeamCommandsDeps({
			startForegroundRun: () => undefined,
			abortForegroundRun: () => false,
			openLiveSidebar: () => undefined,
			getManifestCache: () => ({ list: () => [] }),
		});
		const { ctx, notices, customCalls } = fakeCtx([{ runId: "", action, jobId: "j1" }, undefined]);

		await openTeamDashboard(ctx);

		// Exactly ONE dispatch, on the schedule channel with the mapped
		// subAction + jobId — never the generic fall-through shape
		// ({action: "schedule-disable", runId: ""} with no subAction).
		assert.equal(calls.length, 1, `expected exactly one dispatch, got ${JSON.stringify(calls)}`);
		assert.deepEqual(calls[0], { action: "schedule", subAction, jobId: "j1", runId: undefined });
		// The result is surfaced at info level (isError=false)…
		assert.ok(
			notices.some((n) => n.text.includes("Scheduled job updated.") && n.level === "info"),
			`expected info notice, got: ${JSON.stringify(notices)}`,
		);
		// …and the dashboard REOPENED after the action instead of closing.
		assert.ok(customCalls() >= 2, `dashboard must reopen after a schedule action (custom called ${customCalls()}x)`);
	});
}

test("pane-8 schedule selection WITHOUT jobId warns and dispatches nothing", async () => {
	const calls: RecordedCall[] = [];
	stubHandleTeamTool(calls);
	setTeamCommandsDeps({
		startForegroundRun: () => undefined,
		abortForegroundRun: () => false,
		openLiveSidebar: () => undefined,
		getManifestCache: () => ({ list: () => [] }),
	});
	const { ctx, notices, customCalls } = fakeCtx([{ runId: "", action: "schedule-remove" }, undefined]);

	await openTeamDashboard(ctx);

	assert.equal(calls.length, 0, "no dispatch without a jobId");
	assert.ok(
		notices.some((n) => n.text.includes("job id") && n.level === "warning"),
		`expected warning notice, got: ${JSON.stringify(notices)}`,
	);
	assert.ok(customCalls() >= 2, "dashboard reopens (graceful, not a crash)");
});

test("schedule result at error level surfaces red (isError honored)", async () => {
	__test__setHandleTeamTool((async () => ({
		content: [{ type: "text", text: "No scheduled job with id 'j1'." }],
		details: {},
		isError: true,
	})) as never);
	setTeamCommandsDeps({
		startForegroundRun: () => undefined,
		abortForegroundRun: () => false,
		openLiveSidebar: () => undefined,
		getManifestCache: () => ({ list: () => [] }),
	});
	const { ctx, notices } = fakeCtx([{ runId: "", action: "schedule-remove", jobId: "j1" }, undefined]);

	await openTeamDashboard(ctx);

	assert.ok(
		notices.some((n) => n.text.includes("No scheduled job") && n.level === "error"),
		`expected error notice, got: ${JSON.stringify(notices)}`,
	);
});
