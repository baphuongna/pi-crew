import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { piTeamsHelp } from "../../../../src/extension/help.ts";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { firstText } from "../../../fixtures/tool-result-helpers.ts";

const SRC_ROOT = path.join(import.meta.dirname ?? __dirname, "../../../../src");

/**
 * Every command name the extension can actually register: literal
 * `pi.registerCommand("<name>"` calls plus the loop-registered tuples
 * (`["team-resume", "resume", …] as const`) whose array feeds a
 * `registerCommand(name, …)` call in the same file.
 *
 * P1-4 regression guard: `/team-help` used to advertise `/team-cleanup` and
 * `/team-health`, neither of which is registered — typing them fails with an
 * unknown-command error. A help line must never promise a command that does
 * not exist, so the parity assertion below is the durable form of that fix.
 */
function collectRegisteredCommands(root: string): Set<string> {
	const names = new Set<string>();
	const literalRx = /registerCommand\(\s*"([a-z][a-z0-9_-]*)"/g;
	const tupleRx = /^\s*\["([a-z][a-z0-9_-]*)",\s*"/;

	function walk(dir: string): void {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const filePath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(filePath);
			} else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
				const source = fs.readFileSync(filePath, "utf8");
				// Loop-registered names only count in files that actually call
				// registerCommand with the loop variable.
				const hasLoopRegistration = /registerCommand\(\s*name\s*,/.test(source);
				for (const line of source.split("\n")) {
					const literal = literalRx.exec(line);
					literalRx.lastIndex = 0;
					if (literal?.[1]) names.add(literal[1]);
					const tuple = hasLoopRegistration ? tupleRx.exec(line) : null;
					if (tuple?.[1]) names.add(tuple[1]);
				}
			}
		}
	}

	walk(root);
	return names;
}

/** Slash commands advertised by `piTeamsHelp()` (excludes prose like `P0/P1`). */
function advertisedCommands(help: string): string[] {
	const rx = /(?:^|[\s(])\/([a-z][a-z0-9_-]*)/g;
	const names = new Set<string>();
	let match = rx.exec(help);
	while (match) {
		if (match[1]) names.add(match[1]);
		match = rx.exec(help);
	}
	return [...names].sort();
}

test("help includes major commands", async () => {
	const help = piTeamsHelp();
	assert.match(help, /\/team-run/);
	assert.match(help, /\/team-dashboard/);
	assert.match(help, /\/team-transcript/);
	assert.match(help, /\/team-result/);
	assert.match(help, /\/team-export/);
	const result = await handleTeamTool({ action: "help" }, { cwd: process.cwd() });
	assert.equal(result.isError, false);
	assert.match(firstText(result), /pi-crew commands/);
});

// P1-4 (phantom commands): `/team-cleanup` and `/team-health` are NOT
// registered — only the `/team-cleanup-menu` alias is. Help must not advertise
// them. The positive assertion pins the real alias the user should type.
test("help never advertises unregistered /team-cleanup and /team-health", () => {
	const help = piTeamsHelp();
	assert.doesNotMatch(help, /\/team-cleanup\b(?!-menu)/, "only /team-cleanup-menu is registered");
	assert.doesNotMatch(help, /\/team-health/, "no /team-health command exists");
	assert.match(help, /\/team-cleanup-menu/);
	assert.match(help, /\/team-manager/);
});

// Durable form of the P1-4 fix: every command the help text names must exist in
// the registration surface. This is the guard that catches the next phantom
// before a user hits "unknown command".
test("every command advertised by /team-help is actually registered", () => {
	const registered = collectRegisteredCommands(SRC_ROOT);
	// Sanity: the scanner must have found the real surface, not an empty set.
	assert.ok(registered.size >= 25, `scanner found too few commands (${registered.size}) — check SRC_ROOT`);

	const advertised = advertisedCommands(piTeamsHelp());
	assert.ok(advertised.length >= 20, `expected the help text to advertise commands, found ${advertised.length}`);
	const phantoms = advertised.filter((name) => !registered.has(name));
	assert.deepEqual(phantoms, [], `help advertises unregistered commands: ${phantoms.join(", ")}`);

	// The two known-real anchors keep the assertion honest.
	assert.ok(registered.has("team-cleanup-menu"));
	assert.ok(!registered.has("team-health"));
});
