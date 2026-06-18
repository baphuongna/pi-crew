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
		abortForegroundRun: () => false,
		openLiveSidebar: () => undefined,
		getManifestCache: () => ({ list: () => [] }),
	});
	assert.deepEqual(names.sort(), [
		"crew-brief",
		"skill-create",
		"skill-list",
		"team-api",
		"team-artifacts",
		"team-autonomy",
		"team-cancel",
		"team-cleanup-menu",
		"team-config",
		"team-dashboard",
		"team-doctor",
		"team-events",
		"team-export",
		"team-follow-up",
		"team-forget",
		"team-goal",
		"team-help",
		"team-import",
		"team-imports",
		"team-init",
		"team-invalidate",
		"team-manager",
		"team-mascot",
		"team-metrics",
		"team-prune",
		"team-result",
		"team-respond",
		"team-resume",
		"team-retry",
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
