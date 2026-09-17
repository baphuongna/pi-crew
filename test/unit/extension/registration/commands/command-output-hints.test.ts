/**
 * command-output-hints.test.ts — slash-commands fix spec W10 (executor E2):
 * handler-level coverage for the output-hint work items.
 *
 *   • W5: notifyCommandResult appends an explicit truncation marker whenever
 *     it clips, total stays ≤ 800 (cap unchanged), and an optional footer
 *     pointer (/team-events on-disk log path) rides inside the same cap.
 *   • W4: /team-dashboard with a headless ctx (hasUI:false) notifies a
 *     UI-session hint and opens nothing; /team-mascot headless stays a
 *     documented silent no-op.
 *
 * Seams (same as commands-handler.test.ts / dashboard-schedule-routing.test.ts):
 *   • __test__setHandleTeamTool — recording stub in the lazy-import cache
 *     (avoids the 1.4s runtime chain for the dispatch assertions).
 *   • registerTeamCommands driven with a fake `pi` object; handlers invoked
 *     directly from the captured registerCommand map.
 *   • fakeCtx — hasUI flag + recording ui.notify / ui.custom.
 *
 * The /team-events footer test additionally creates a REAL run fixture via
 * createRunManifest so manifest.eventsPath resolves on disk exactly the way
 * the events team action (inspect.ts) derives it: locateRunCwd +
 * loadRunManifestById → manifest.eventsPath.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { NOTIFY_TEXT_CAP, notifyCommandResult, TRUNCATION_MARKER } from "../../../../../src/extension/registration/command-utils.ts";
import { __test__setHandleTeamTool, registerTeamCommands } from "../../../../../src/extension/registration/commands/index.ts";
import { createRunManifest } from "../../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../../src/workflows/workflow-config.ts";

type Handler = (args: string, ctx: never) => Promise<void>;

function registerAll(): Map<string, Handler> {
	const commands = new Map<string, Handler>();
	registerTeamCommands(
		{
			registerCommand: (name: string, def: { handler: Handler }) => {
				commands.set(name, def.handler);
			},
		} as never,
		{
			startForegroundRun: () => undefined,
			abortForegroundRun: () => false,
			openLiveSidebar: () => undefined,
			getManifestCache: () => ({ list: () => [] }),
		},
	);
	return commands;
}

function fakeCtx(
	hasUI: boolean,
	cwd = "/tmp/pi-crew-command-hints-test",
): {
	ctx: never;
	notifications: Array<{ text: string; level: string }>;
	customCalls: () => number;
} {
	const notifications: Array<{ text: string; level: string }> = [];
	let customCalls = 0;
	const ctx = {
		cwd,
		hasUI,
		ui: {
			notify: (text: string, level: string) => {
				notifications.push({ text, level });
			},
			custom: async <T>(): Promise<T> => {
				customCalls++;
				return undefined as T;
			},
		},
	};
	return { ctx: ctx as never, notifications, customCalls: () => customCalls };
}

function stubTeamToolText(text: string): void {
	__test__setHandleTeamTool((async () => ({ content: [{ type: "text", text }] })) as never);
}

/** Temp dir with a `.git` marker so createRunManifest keeps state inside <dir>/.crew (project scope). */
function makeProjectDir(): string {
	const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-crew-command-hints-"));
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	return dir;
}

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
};

afterEach(() => {
	__test__setHandleTeamTool(undefined);
});

// ─── W5: notifyCommandResult truncation marker ─────────────────────────────

test("notifyCommandResult appends the explicit truncation marker when >800 chars and total stays ≤800", async () => {
	const { ctx, notifications } = fakeCtx(false);
	await notifyCommandResult(ctx, "x".repeat(810));
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]!.level, "info");
	assert.ok(notifications[0]!.text.includes("[truncated]"), "explicit marker missing");
	assert.ok(
		notifications[0]!.text.endsWith(TRUNCATION_MARKER),
		`must end with marker: ${JSON.stringify(notifications[0]!.text.slice(-40))}`,
	);
	assert.equal(notifications[0]!.text.length, NOTIFY_TEXT_CAP, "clipped text should use the full 800 budget");
});

test("notifyCommandResult leaves short and exactly-at-cap text unchanged (no marker)", async () => {
	const { ctx, notifications } = fakeCtx(false);
	await notifyCommandResult(ctx, "hello");
	await notifyCommandResult(ctx, "y".repeat(NOTIFY_TEXT_CAP));
	assert.equal(notifications[0]!.text, "hello");
	assert.equal(notifications[1]!.text, "y".repeat(NOTIFY_TEXT_CAP));
	assert.ok(!notifications[1]!.text.includes("[truncated]"), "no marker at exactly the cap");
});

test("notifyCommandResult includes the truncatedFooter inside the cap when clipping", async () => {
	const { ctx, notifications } = fakeCtx(false);
	const footer = " Full log: /tmp/pi-crew/state/runs/team_x/events.jsonl";
	await notifyCommandResult(ctx, "z".repeat(2000), { truncatedFooter: footer });
	const text = notifications[0]!.text;
	assert.ok(text.includes("[truncated]"), "marker missing");
	assert.ok(text.endsWith(footer), "footer must terminate the message");
	assert.ok(text.length <= NOTIFY_TEXT_CAP, `total must stay ≤ ${NOTIFY_TEXT_CAP}, got ${text.length}`);
});

test("notifyCommandResult ignores the truncatedFooter when the text fits", async () => {
	const { ctx, notifications } = fakeCtx(false);
	await notifyCommandResult(ctx, "short", { truncatedFooter: " Full log: /nope" });
	assert.deepEqual(notifications, [{ text: "short", level: "info" }]);
});

// ─── W5: /team-events truncated output points at the on-disk log ───────────

test("team-events truncated listing ends with the on-disk events log path and stays ≤800", async () => {
	const commands = registerAll();
	stubTeamToolText(`Events for run:\n${"evt-line\n".repeat(200)}`);

	const cwd = makeProjectDir();
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "test" });
		const { ctx, notifications, customCalls } = fakeCtx(false, cwd);
		await commands.get("team-events")!(created.manifest.runId, ctx);

		assert.equal(customCalls(), 0, "no overlay may open from a status command");
		assert.equal(notifications.length, 1);
		const text = notifications[0]!.text;
		assert.ok(text.length <= NOTIFY_TEXT_CAP, `total must stay ≤ ${NOTIFY_TEXT_CAP}, got ${text.length}`);
		assert.ok(text.includes(TRUNCATION_MARKER), "explicit truncation marker missing");
		assert.ok(
			text.endsWith(` Full log: ${created.paths.eventsPath}`),
			`expected footer with ${created.paths.eventsPath}, got tail: ${JSON.stringify(text.slice(-160))}`,
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("team-events short output passes through unchanged (no marker, no footer)", async () => {
	const commands = registerAll();
	stubTeamToolText("Events for run:\n(none)");
	const { ctx, notifications } = fakeCtx(false);
	await commands.get("team-events")!("team_nonexistent", ctx);
	assert.deepEqual(notifications, [{ text: "Events for run:\n(none)", level: "info" }]);
});

// ─── W4: dashboard headless feedback / mascot documented no-op ─────────────

test("team-dashboard with a headless ctx (hasUI:false) notifies the UI-session hint and opens nothing", async () => {
	const commands = registerAll();
	stubTeamToolText("unused");
	const { ctx, notifications, customCalls } = fakeCtx(false);
	await commands.get("team-dashboard")!("", ctx);

	assert.equal(customCalls(), 0, "dashboard overlay must not open headless");
	assert.equal(notifications.length, 1, `expected exactly one notification, got ${JSON.stringify(notifications)}`);
	assert.equal(notifications[0]!.level, "info");
	assert.match(notifications[0]!.text, /UI session/);
	assert.match(notifications[0]!.text, /\/team-status/);
});

test("team-mascot with a headless ctx stays a silent no-op", async () => {
	const commands = registerAll();
	const { ctx, notifications, customCalls } = fakeCtx(false);
	await commands.get("team-mascot")!("", ctx);
	assert.equal(customCalls(), 0, "mascot must not open headless");
	assert.equal(notifications.length, 0, "mascot must stay silent headless");
});

// ─── W3 (lead): team-metrics empty-output observability hint ──────────────

test("team-metrics with an empty snapshot appends the observability hint", async () => {
	const commands = registerAll();
	stubTeamToolText("");
	const { ctx, notifications } = fakeCtx(false);
	await commands.get("team-metrics")!("", ctx);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]!.text, /observability: true/);
	assert.match(notifications[0]!.text, /may be disabled/);
});

test("team-metrics with a literal `[]` snapshot also gets the hint", async () => {
	const commands = registerAll();
	stubTeamToolText("[]");
	const { ctx, notifications } = fakeCtx(false);
	await commands.get("team-metrics")!("", ctx);
	assert.match(notifications[0]!.text, /observability: true/);
});

test("team-metrics with real data passes through without the hint", async () => {
	const commands = registerAll();
	stubTeamToolText("runs_total 12\ntasks_total 40");
	const { ctx, notifications } = fakeCtx(false);
	await commands.get("team-metrics")!("", ctx);
	assert.deepEqual(notifications, [{ text: "runs_total 12\ntasks_total 40", level: "info" }]);
});
