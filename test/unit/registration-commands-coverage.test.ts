import test from "node:test";
import assert from "node:assert/strict";
import { registerTeamCommands } from "../../src/extension/registration/commands.ts";

function fakePi(names: string[]): { registerCommand: (name: string, def: unknown) => void } {
	return { registerCommand: (name: string) => names.push(name) };
}

test("registration commands module registers the public slash command set", () => {
	const names: string[] = [];
	registerTeamCommands(fakePi(names) as never, {
		startForegroundRun: () => undefined,
		openLiveSidebar: () => undefined,
		getManifestCache: () => ({ list: () => [] }),
	});
	assert.deepEqual(names.sort(), [
		"team-api",
		"team-artifacts",
		"team-autonomy",
		"team-cancel",
		"team-cleanup",
		"team-config",
		"team-dashboard",
		"team-doctor",
		"team-events",
		"team-export",
		"team-forget",
		"team-help",
		"team-import",
		"team-imports",
		"team-init",
		"team-mascot",
		"team-metrics",
		"team-prune",
		"team-result",
		"team-respond",
		"team-resume",
		"team-run",
		"team-settings",
		"team-status",
		"team-summary",
		"team-transcript",
		"team-validate",
		"team-worktrees",
		"teams",
	].sort());
});
