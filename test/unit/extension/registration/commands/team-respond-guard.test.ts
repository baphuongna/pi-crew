/**
 * team-respond-guard.test.ts — W1 of the slash-commands fix spec
 * (docs/fixes/slash-commands-fix-spec.md): `/team-respond` must NOT reach
 * `handleTeamTool` when any of `<runId> <taskId|--all> <message>` is missing —
 * it mirrors the `team-follow-up` usage-guard pattern (commands/run.ts) and
 * notifies the usage line instead. The `--all` variant still dispatches with
 * `taskId: undefined` (it is a deliberate omission, not a missing arg).
 *
 * Seams used (same as commands-handler.test.ts):
 *   • `__test__setHandleTeamTool` — recording stub in the lazy-import cache,
 *     so no runtime chain is loaded and we can assert "never invoked".
 *   • captured `registerCommand` definitions + fake ctx whose `ui.notify`
 *     records every notification.
 * @see src/extension/registration/commands/run.ts
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { __test__setHandleTeamTool, registerTeamCommands } from "../../../../../src/extension/registration/commands/index.ts";

type Handler = (args: string, ctx: never) => Promise<void>;

function captureCommands(): {
	pi: { registerCommand: (name: string, def: { handler: Handler }) => void };
	commands: Map<string, Handler>;
} {
	const commands = new Map<string, Handler>();
	const pi = {
		registerCommand: (name: string, def: { handler: Handler }) => {
			commands.set(name, def.handler);
		},
	};
	return { pi, commands };
}

function register(captured: Map<string, Handler>): void {
	registerTeamCommands(
		{
			registerCommand: (name: string, def: { handler: Handler }) => {
				captured.set(name, def.handler);
			},
		} as never,
		{
			startForegroundRun: () => undefined,
			abortForegroundRun: () => false,
			openLiveSidebar: () => undefined,
			getManifestCache: () => ({ list: () => [] }),
		},
	);
}

function fakeCtx(): { ctx: never; notifications: Array<{ text: string; level: string }> } {
	const notifications: Array<{ text: string; level: string }> = [];
	const ctx = {
		cwd: "/tmp/pi-crew-test",
		hasUI: false,
		ui: {
			notify: (text: string, level: string) => {
				notifications.push({ text, level });
			},
		},
	};
	return { ctx: ctx as never, notifications };
}

afterEach(() => {
	__test__setHandleTeamTool(undefined);
});

test("team-respond notifies usage and never calls handleTeamTool when args are missing", async () => {
	const captured = captureCommands();
	register(captured.commands);
	let toolCalls = 0;
	__test__setHandleTeamTool((async () => {
		toolCalls++;
		return { content: [{ type: "text", text: "should-not-happen" }] };
	}) as never);

	const { ctx, notifications } = fakeCtx();
	const handler = captured.commands.get("team-respond")!;
	await handler("", ctx); // nothing at all
	await handler("   ", ctx); // whitespace only
	await handler("run_1", ctx); // runId only
	await handler("run_1 task_2", ctx); // no message
	await handler("run_1 --all", ctx); // --all but no message

	assert.equal(toolCalls, 0, "handleTeamTool must not be invoked for missing args");
	assert.equal(notifications.length, 5);
	for (const notification of notifications) {
		assert.equal(notification.text, "Usage: /team-respond <runId> <taskId|--all> <message>…");
		assert.equal(notification.level, "info");
	}
});

test("team-respond with full args dispatches respond action with parsed fields", async () => {
	const captured = captureCommands();
	register(captured.commands);
	const seen: Array<Record<string, unknown>> = [];
	__test__setHandleTeamTool((async (params: unknown) => {
		seen.push(params as Record<string, unknown>);
		return { content: [{ type: "text", text: "responded" }] };
	}) as never);

	const { ctx, notifications } = fakeCtx();
	const handler = captured.commands.get("team-respond")!;
	await handler("run_abc task_9 yes please proceed", ctx);

	assert.deepEqual(seen, [{ action: "respond", runId: "run_abc", taskId: "task_9", message: "yes please proceed" }]);
	assert.deepEqual(notifications, [{ text: "responded", level: "info" }]);
});

test("team-respond --all variant dispatches with taskId undefined and the joined message", async () => {
	const captured = captureCommands();
	register(captured.commands);
	const seen: Array<Record<string, unknown>> = [];
	__test__setHandleTeamTool((async (params: unknown) => {
		seen.push(params as Record<string, unknown>);
		return { content: [{ type: "text", text: "responded-all" }] };
	}) as never);

	const { ctx } = fakeCtx();
	const handler = captured.commands.get("team-respond")!;
	await handler("run_abc --all ship it everywhere", ctx);

	// taskId is INTENTIONALLY undefined for --all (broadcast), message joined.
	assert.deepEqual(seen, [{ action: "respond", runId: "run_abc", taskId: undefined, message: "ship it everywhere" }]);
});
