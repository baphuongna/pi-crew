/**
 * team-goal-metadata.test.ts — W2 of the slash-commands fix spec
 * (docs/fixes/slash-commands-fix-spec.md): `/team-goal`'s description must
 * mention the real sub-actions the handler accepts — including the stop
 * aliases `cancel` and `reset` (team-tool/goal.ts maps stop|cancel|reset to
 * the same handleStop) — and its argument completion must surface those
 * aliases for the first argument only.
 *
 * pi's `getArgumentCompletions(argumentPrefix)` receives the WHOLE argument
 * text (no index parameter), so "past arg 1" is detected as whitespace in the
 * prefix; deeper args return [] (no completion, file fallback at runtime).
 * Handler behavior is intentionally untouched — metadata only.
 * @see src/extension/registration/commands/run.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerTeamCommands } from "../../../../../src/extension/registration/commands/index.ts";

interface CommandDef {
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => Array<{ value: string; label: string; description?: string }> | [];
	handler: (args: string, ctx: never) => Promise<void>;
}

function captureCommandDefs(): Map<string, CommandDef> {
	const commands = new Map<string, CommandDef>();
	registerTeamCommands(
		{
			registerCommand: (name: string, def: CommandDef) => {
				commands.set(name, def);
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

function valuesOf(items: Array<{ value: string }> | [] | null | undefined): string[] {
	return (items ?? []).map((item) => item.value);
}

test("team-goal description mentions the real sub-actions including cancel and reset", () => {
	const commands = captureCommandDefs();
	const def = commands.get("team-goal")!;
	assert.ok(def.description, "team-goal must be registered with a description");
	assert.ok(def.description!.includes("cancel"), "description must mention cancel");
	assert.ok(def.description!.includes("reset"), "description must mention reset");
});

test("team-goal completion with empty prefix suggests cancel and reset", () => {
	const commands = captureCommandDefs();
	const completions = commands.get("team-goal")!.getArgumentCompletions!;
	const values = valuesOf(completions(""));
	assert.ok(values.includes("cancel"));
	assert.ok(values.includes("reset"));
});

test("team-goal completion narrows by prefix: 'c' -> cancel only", () => {
	const commands = captureCommandDefs();
	const completions = commands.get("team-goal")!.getArgumentCompletions!;
	assert.deepEqual(valuesOf(completions("c")), ["cancel"]);
	assert.deepEqual(valuesOf(completions("r")), ["reset"]);
	assert.deepEqual(valuesOf(completions("xyz")), []);
});

test("team-goal completion returns [] once past the first argument", () => {
	const commands = captureCommandDefs();
	const completions = commands.get("team-goal")!.getArgumentCompletions!;
	// pi passes the full argument text: whitespace means the cursor is on a
	// later argument (goalId / flags) — nothing to suggest there.
	assert.deepEqual(valuesOf(completions("start c")), []);
	assert.deepEqual(valuesOf(completions("cancel ")), []);
	assert.deepEqual(valuesOf(completions(" goal_1")), []);
});
