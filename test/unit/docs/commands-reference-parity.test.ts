/**
 * commands-reference-parity.test.ts — W9 (docs/fixes/slash-commands-fix-spec.md).
 *
 * Docs↔code parity lock: the command table in docs/commands-reference.md must
 * list EXACTLY the set of slash commands pi-crew registers — no phantom
 * entries (docs rows for commands that are not registered) and no missing
 * ones (registered commands absent from the docs).
 *
 * How the registered set is enumerated (union of two complementary methods,
 * because neither alone is complete):
 *   1. Fake-pi capture of `registerTeamCommands(...)` — the same approach as
 *      test/unit/extension/registration/registration-commands-coverage.test.ts.
 *      Catches loop-registered commands (team-status, team-resume, ...) that a
 *      textual scan cannot see.
 *   2. Literal `registerCommand("name"` scan of src/ — the same helper
 *      approach as test/unit/extension/slash-command-parity.test.ts. Catches
 *      commands registered OUTSIDE registerTeamCommands (/schedules,
 *      /team-vibes, /crew-view, /crew-back) that the fake-pi capture cannot
 *      see.
 *
 * Docs parsing reads only the FIRST column of the "## Main Commands" table
 * (one command per row) so prose mentions and the intentional "Removed:"
 * historical note cannot create phantom entries.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { registerTeamCommands } from "../../../src/extension/registration/commands.ts";

const repoRoot = path.resolve(import.meta.dirname ?? __dirname, "../../..");
const docsPath = path.join(repoRoot, "docs", "commands-reference.md");
const srcRoot = path.join(repoRoot, "src");

/** Literal-scan helper (mirrors slash-command-parity.test.ts collectCommands). */
function scanLiteralRegisterCommandNames(root: string): Set<string> {
	const names = new Set<string>();
	const rx = /registerCommand\(\s*"([a-z][a-z0-9_-]*)"/g;

	function walk(dir: string): void {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(p);
			} else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
				const src = fs.readFileSync(p, "utf8");
				rx.lastIndex = 0;
				let match = rx.exec(src);
				while (match) {
					names.add(match[1] as string);
					match = rx.exec(src);
				}
			}
		}
	}

	walk(root);
	return names;
}

/** Fake-pi capture (mirrors registration-commands-coverage.test.ts). */
function captureRegisterTeamCommandNames(): Set<string> {
	const names = new Set<string>();
	registerTeamCommands(
		{
			registerCommand: (name: string) => {
				names.add(name);
			},
		} as never,
		{
			startForegroundRun: () => undefined,
			abortForegroundRun: () => false,
			openLiveSidebar: () => undefined,
			getManifestCache: () => ({ list: () => [] }),
		},
	);
	return names;
}

/** Parse the first column of the "## Main Commands" table; return one /name per row. */
function parseDocsCommandNames(): string[] {
	const lines = fs.readFileSync(docsPath, "utf8").split("\n");
	const names: string[] = [];
	let inMainSection = false;
	for (const line of lines) {
		if (line.startsWith("## ")) {
			inMainSection = line.startsWith("## Main Commands");
			continue;
		}
		if (!inMainSection || !/^\s*\|/.test(line)) continue;
		// Split on UNESCAPED pipes so `\|` inside a cell (e.g. [on\|off]) stays put.
		const firstColumn = (line.split(/(?<!\\)\|/)[1] ?? "").trim();
		const match = firstColumn.match(/\/([a-z][a-z0-9_-]+)/);
		if (match) names.push(match[1] as string);
	}
	return names;
}

function sorted(values: Iterable<string>): string[] {
	return [...values].sort();
}

test("docs/commands-reference.md lists exactly the registered command set (set equality)", () => {
	const docsNames = parseDocsCommandNames();
	assert.ok(docsNames.length > 0, "no command rows parsed from docs — parser or doc layout broke");

	const docsSet = new Set(docsNames);
	assert.equal(
		docsSet.size,
		docsNames.length,
		`docs table has duplicate command rows: ${docsNames.filter((n, i) => docsNames.indexOf(n) !== i).join(", ")}`,
	);

	const registered = new Set<string>([...captureRegisterTeamCommandNames(), ...scanLiteralRegisterCommandNames(srcRoot)]);

	const missing = sorted([...registered].filter((name) => !docsSet.has(name)));
	const phantom = sorted([...docsSet].filter((name) => !registered.has(name)));

	assert.deepEqual(
		{ missing, phantom },
		{ missing: [], phantom: [] },
		`docs/commands-reference.md is out of sync with the registered commands.\n` +
			`  missing (registered but not documented): ${missing.join(", ") || "—"}\n` +
			`  phantom (documented but not registered): ${phantom.join(", ") || "—"}`,
	);
});
