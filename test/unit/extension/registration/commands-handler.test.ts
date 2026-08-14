/**
 * commands-handler.test.ts — STEP 1.9a: handler-level coverage for
 * src/extension/registration/commands.ts (Phase 2.1 blind-move gate, review
 * finding T-1).
 *
 * The module exports only `registerTeamCommands(pi, deps)`; all 30 handlers
 * are private. Handlers delegate to `handleTeamTool` (module-private,
 * lazy-imports team-tool.ts — a 1.4s+ runtime chain). `mock.module` cannot
 * reliably intercept ESM dynamic imports (see task-runner-prestep-guard.test.ts
 * + stringenum-fallback-composition.test.ts notes), so commands.ts exposes a
 * MINIMAL test seam — `__test__setHandleTeamTool` — that substitutes a
 * recording stub into the lazy-import cache WITHOUT any production behavior
 * change. Handlers are invoked via the captured `registerCommand` definitions.
 *
 * Covers (per plan row 1.9a): parseRunArgs dispatch (direct + through the
 * team-run handler), team-config/team-autonomy/team-prune/team-export arg
 * paths, notifyCommandResult error path, and command-utils units
 * (parseScalar, pushUnset, setNestedConfig, commandText).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	commandText,
	notifyCommandResult,
	parseRunArgs,
	parseScalar,
	pushUnset,
	setNestedConfig,
} from "../../../../src/extension/registration/command-utils.ts";
import { __test__setHandleTeamTool, registerTeamCommands } from "../../../../src/extension/registration/commands.ts";

type Handler = (args: string, ctx: never) => Promise<void>;

function captureCommands(): {
	pi: { registerCommand: (name: string, def: { handler: Handler }) => void; appendEntry: () => void };
	commands: Map<string, Handler>;
} {
	const commands = new Map<string, Handler>();
	const pi = {
		registerCommand: (name: string, def: { handler: Handler }) => {
			commands.set(name, def.handler);
		},
		appendEntry: () => undefined,
	};
	return { pi, commands };
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

afterEach(() => {
	__test__setHandleTeamTool(undefined);
});

// ─── command-utils units ───────────────────────────────────────────────────

test("parseScalar coerces booleans, integers, comma lists; leaves other strings as-is", () => {
	assert.equal(parseScalar("true"), true);
	assert.equal(parseScalar("false"), false);
	assert.equal(parseScalar("42"), 42);
	assert.equal(parseScalar("-3"), -3);
	assert.deepEqual(parseScalar("a,b, c"), ["a", "b", "c"]);
	assert.equal(parseScalar("hello"), "hello");
	assert.equal(parseScalar("3.14"), "3.14");
});

test("pushUnset creates the unset array and appends keys", () => {
	const config: Record<string, unknown> = {};
	pushUnset(config, "a.b");
	pushUnset(config, "c");
	assert.deepEqual(config.unset, ["a.b", "c"]);
});

test("setNestedConfig builds nested objects and overwrites scalars with objects", () => {
	const config: Record<string, unknown> = {};
	setNestedConfig(config, "team.model", "deepseek");
	setNestedConfig(config, "team.retries", 3);
	assert.deepEqual(config, { team: { model: "deepseek", retries: 3 } });

	// scalar at an intermediate path is replaced by an object
	const config2: Record<string, unknown> = { agent: "scalar" };
	setNestedConfig(config2, "agent.parallelism", 4);
	assert.deepEqual(config2, { agent: { parallelism: 4 } });

	// empty/no-op key leaves config untouched
	const config3: Record<string, unknown> = {};
	setNestedConfig(config3, "", 1);
	assert.deepEqual(config3, {});
});

test("commandText joins content items with newlines and falls back to empty string", () => {
	assert.equal(
		commandText({
			content: [
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			],
		}),
		"a\nb",
	);
	assert.equal(commandText({ content: [] }), "");
	assert.equal(commandText({}), "");
});

test("notifyCommandResult routes text to ctx.ui.notify with info level and truncates >800 chars", async () => {
	const { ctx, notifications } = fakeCtx();
	await notifyCommandResult(ctx, "hello");
	assert.deepEqual(notifications, [{ text: "hello", level: "info" }]);

	const longText = "x".repeat(810);
	await notifyCommandResult(ctx, longText);
	assert.equal(notifications[1]!.text.length, 800);
	assert.equal(notifications[1]!.text, `${"x".repeat(797)}...`);
});

// ─── parseRunArgs dispatch ─────────────────────────────────────────────────

test("parseRunArgs defaults to run action and captures positional team + goal", () => {
	assert.deepEqual(parseRunArgs(""), { action: "run", goal: undefined });
	assert.deepEqual(parseRunArgs("explore the repo"), { action: "run", team: "explore", goal: "the repo" });
});

test("parseRunArgs maps flags and --key=value options", () => {
	assert.deepEqual(parseRunArgs("--async fix the bug"), { action: "run", async: true, team: "fix", goal: "the bug" });
	assert.deepEqual(parseRunArgs("--worktree --team=core --workflow=impl --agent=alpha --role=dev ship it"), {
		action: "run",
		workspaceMode: "worktree",
		team: "core",
		workflow: "impl",
		agent: "alpha",
		role: "dev",
		goal: "ship it",
	});
});

test("parseRunArgs preserves quoted tokens", () => {
	assert.deepEqual(parseRunArgs('"quoted team" with "spaces in goal"'), {
		action: "run",
		team: "quoted team",
		goal: "with spaces in goal",
	});
});

// ─── handler-level: dispatch through the captured registerCommand surface ──

test("team-run handler dispatches parseRunArgs output to handleTeamTool and notifies", async () => {
	const captured = captureCommands();
	register(captured.commands);
	const seen: Array<Record<string, unknown>> = [];
	__test__setHandleTeamTool((async (params: unknown) => {
		seen.push(params as Record<string, unknown>);
		return { content: [{ type: "text", text: `ok:${(params as Record<string, unknown>).action}` }] };
	}) as never);

	const { ctx, notifications } = fakeCtx();
	const handler = captured.commands.get("team-run")!;
	await handler("--async build the feature", ctx);

	assert.deepEqual(seen, [{ action: "run", async: true, team: "build", goal: "the feature" }]);
	assert.deepEqual(notifications, [{ text: "ok:run", level: "info" }]);
});

test("team-config handler builds scope + nested key=value config", async () => {
	const captured = captureCommands();
	register(captured.commands);
	const seen: Array<Record<string, unknown>> = [];
	__test__setHandleTeamTool((async (params: unknown) => {
		seen.push(params as Record<string, unknown>);
		return { content: [{ type: "text", text: "config-ok" }] };
	}) as never);

	const { ctx } = fakeCtx();
	const handler = captured.commands.get("team-config")!;
	await handler("team.model=deepseek --project", ctx);
	await handler("retries=3 --unset=agent.parallelism", ctx);
	await handler("", ctx);
	await handler("team.model=unset", ctx);

	assert.deepEqual(seen[0], { action: "config", config: { scope: "project", team: { model: "deepseek" } } });
	assert.deepEqual(seen[1], { action: "config", config: { scope: "user", retries: 3, unset: ["agent.parallelism"] } });
	assert.deepEqual(seen[2], { action: "config" });
	assert.deepEqual(seen[3], { action: "config", config: { scope: "user", unset: ["team.model"] } });
});

test("team-autonomy handler maps on/off/profile modes to policy config", async () => {
	const captured = captureCommands();
	register(captured.commands);
	const seen: Array<Record<string, unknown>> = [];
	__test__setHandleTeamTool((async (params: unknown) => {
		seen.push(params as Record<string, unknown>);
		return { content: [{ type: "text", text: "autonomy-ok" }] };
	}) as never);

	const { ctx } = fakeCtx();
	const handler = captured.commands.get("team-autonomy")!;
	await handler("on", ctx);
	await handler("off", ctx);
	await handler("suggested", ctx);
	await handler("status", ctx);

	assert.deepEqual(seen[0], {
		action: "autonomy",
		config: { profile: "suggested", enabled: true, injectPolicy: true },
	});
	assert.deepEqual(seen[1], { action: "autonomy", config: { profile: "manual", enabled: false } });
	assert.deepEqual(seen[2], {
		action: "autonomy",
		config: { profile: "suggested", enabled: true, injectPolicy: true },
	});
	assert.deepEqual(seen[3], {
		action: "autonomy",
		config: { preferAsyncForLongTasks: undefined, allowWorktreeSuggestion: undefined },
	});
});

test("team-prune handler parses --keep= and --confirm", async () => {
	const captured = captureCommands();
	register(captured.commands);
	const seen: Array<Record<string, unknown>> = [];
	__test__setHandleTeamTool((async (params: unknown) => {
		seen.push(params as Record<string, unknown>);
		return { content: [{ type: "text", text: "prune-ok" }] };
	}) as never);

	const { ctx } = fakeCtx();
	const handler = captured.commands.get("team-prune")!;
	await handler("--keep=5 --confirm", ctx);
	await handler("--confirm", ctx);

	assert.deepEqual(seen[0], { action: "prune", keep: 5, confirm: true });
	assert.deepEqual(seen[1], { action: "prune", keep: undefined, confirm: true });
});

test("team-export handler passes trimmed runId (loop-registered run commands)", async () => {
	const captured = captureCommands();
	register(captured.commands);
	const seen: Array<Record<string, unknown>> = [];
	__test__setHandleTeamTool((async (params: unknown) => {
		seen.push(params as Record<string, unknown>);
		return { content: [{ type: "text", text: "export-ok" }] };
	}) as never);

	const { ctx } = fakeCtx();
	const handler = captured.commands.get("team-export")!;
	await handler("run_abc123", ctx);
	await handler("", ctx);

	assert.deepEqual(seen[0], { action: "export", runId: "run_abc123" });
	assert.deepEqual(seen[1], { action: "export", runId: undefined });
});

// ─── notifyCommandResult error path ────────────────────────────────────────

test("handler routes an error-flagged tool result through notifyCommandResult without throwing", async () => {
	const captured = captureCommands();
	register(captured.commands);
	__test__setHandleTeamTool((async () => {
		return { content: [{ type: "text", text: "boom: task failed" }], isError: true };
	}) as never);

	const { ctx, notifications } = fakeCtx();
	const handler = captured.commands.get("team-status")!;
	await handler("run_deadbeef", ctx);

	assert.deepEqual(notifications, [{ text: "boom: task failed", level: "info" }]);
	// commandText extracts the error text unchanged (no swallowing of the message)
	assert.equal(commandText({ content: [{ type: "text", text: "boom: task failed" }] }), "boom: task failed");
});
