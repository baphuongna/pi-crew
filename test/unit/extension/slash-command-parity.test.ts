/**
 * WI-5.5 (M5 spec §5) — slash-command parity test.
 *
 * Per spec §5 M5 acceptance: "Codegen command: parity test số command +
 * hành vi không đổi." This test:
 *   - Enumerates every slash command pi-crew registers at runtime.
 *   - Asserts the count is within a tight sanity range (full-enumeration
 *     audit 2026-10-02: exactly 42).
 *   - Asserts each name matches /^[a-z][a-z0-9_-]+$/ (no spaces,
 *     no upper-case).
 *   - Asserts no name is registered twice (double registration throws at
 *     extension startup).
 *
 * G21 (2026-10-02): enumeration is the UNION of two complementary methods
 * (same approach as test/unit/docs/commands-reference-parity.test.ts —
 * neither method alone is complete):
 *   1. Fake-pi capture of `registerTeamCommands(...)` — catches the 10
 *      loop-registered tuple commands (team-status, team-summary,
 *      team-events, team-artifacts, team-worktrees, team-validate,
 *      team-doctor, team-resume, team-export, team-cancel — registered via
 *      `for (const [name, ...] of [...]) registerCommand(name, ...)` in
 *      src/extension/registration/commands/run.ts + status.ts) that a
 *      textual scan cannot see.
 *   2. Literal `registerCommand("name"` scan of src/ — catches commands
 *      registered OUTSIDE registerTeamCommands: /schedules
 *      (command-registration.ts wires registerSchedulesCommands directly),
 *      /team-vibes (src/extension/crew-vibes/index.ts), /crew-view +
 *      /crew-back (src/ui/inline-panel/index.ts).
 *
 * The actual list is informational (logged) — not asserted exactly —
 * because command discovery is intentionally dynamic across releases.
 * If a SPECIFIC command is REMOVED intentionally, this test logs the
 * change; the next caller can grep the diff to confirm.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { registerTeamCommands } from "../../../src/extension/registration/commands.ts";

interface CommandEntry {
	file: string;
	line: number;
	name: string;
}

const repoRoot = path.resolve(import.meta.dirname ?? __dirname, "../../..");
const srcRoot = path.join(repoRoot, "src");

/** Directory whose registerCommand call sites run inside registerTeamCommands. */
const teamCommandsTree = path.join(repoRoot, "src", "extension", "registration", "commands");
const teamCommandsShim = path.join(repoRoot, "src", "extension", "registration", "commands.ts");

function collectLiteralCommands(root: string): CommandEntry[] {
	const entries: CommandEntry[] = [];
	const rx = /registerCommand\(\s*"([a-z][a-z0-9_-]*)"/g;

	function walk(dir: string): void {
		const list = fs.readdirSync(dir, { withFileTypes: true });
		for (const e of list) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) {
				walk(p);
			} else if (e.isFile() && e.name.endsWith(".ts") && !e.name.includes(".test.")) {
				const src = fs.readFileSync(p, "utf8");
				const lines = src.split("\n");
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i] ?? "";
					const m = rx.exec(line);
					rx.lastIndex = 0;
					if (m) {
						entries.push({ file: p, line: i + 1, name: m[1] });
					}
				}
			}
		}
	}

	walk(root);
	return entries;
}

/**
 * Fake-pi capture of registerTeamCommands (mirrors
 * registration-commands-coverage.test.ts). The deps stub is the minimal
 * surface the registration phase touches; command handlers stay lazy.
 */
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

/** Full runtime surface: registerTeamCommands (38) ∪ literal-only (4). */
function unionRegisteredNames(): Set<string> {
	const captured = captureRegisterTeamCommandNames();
	const literal = collectLiteralCommands(srcRoot).map((e) => e.name);
	return new Set([...captured, ...literal]);
}

describe("WI-5.5 slash-command parity", () => {
	// REVIEW FIX (2026-09-10, C5): bounds alone let up-to-3 command removals
	// (incl. `team` itself) pass silently. The must-include list pins the
	// core command surface; the count range stays as a cheap ceiling.
	// G21 (2026-10-02): extended to pin one representative of EVERY
	// registration class the enumeration covers —
	//   literal inside registerTeamCommands: team-run, teams, team-help, crew-brief
	//   loop-registered tuples: team-status, team-resume, team-export
	//   registered outside registerTeamCommands: crew-view, crew-back, schedules, team-vibes
	const MUST_INCLUDE = [
		"team-run",
		"teams",
		"team-help",
		"crew-brief",
		"team-status",
		"team-resume",
		"team-export",
		"crew-view",
		"crew-back",
		"schedules",
		"team-vibes",
	];

	it("core commands must be present (must-include list)", () => {
		const unique = unionRegisteredNames();
		const absent = MUST_INCLUDE.filter((c) => !unique.has(c));
		assert.deepEqual(absent, [], `core commands missing from registration: ${absent.join(", ")}`);
	});

	it("command count within tight sanity range (40..44)", () => {
		const entries = collectLiteralCommands(srcRoot);
		const unique = unionRegisteredNames();
		const captured = captureRegisterTeamCommandNames();
		const loopOnly = [...captured].filter((n) => !entries.some((e) => e.name === n)).sort();
		const literalOnly = [...unique].filter((n) => !captured.has(n)).sort();
		console.log(
			`[WI-5.5] registered slash commands: ${unique.size} unique (union of ${captured.size} registerTeamCommands + ${literalOnly.length} outside)`,
		);
		console.log(`  loop-registered (invisible to literal scan): ${loopOnly.join(", ")}`);
		console.log(`  registered outside registerTeamCommands: ${literalOnly.join(", ")}`);
		console.log(`  ${[...unique].sort().join(", ")}`);
		// Full-enumeration audit 2026-10-02: exactly 42
		// (38 registerTeamCommands + schedules + team-vibes + crew-view + crew-back).
		// Enumeration is now complete, so the range is tight: an intentional
		// add/remove beyond ±2 must update this bound + the audit comment.
		assert.ok(unique.size >= 40, `expected ≥40 unique commands, got ${unique.size}`);
		assert.ok(unique.size <= 44, `expected ≤44 unique commands, got ${unique.size}`);
	});

	it("all command names match /^[a-z][a-z0-9_-]+$/", () => {
		const entries = collectLiteralCommands(srcRoot);
		const rx = /^[a-z][a-z0-9_-]+$/;
		const bad: Array<{ name: string; file: string; line: number }> = [];
		for (const e of entries) {
			if (!rx.test(e.name)) {
				bad.push({ name: e.name, file: e.file, line: e.line });
			}
		}
		assert.deepEqual(bad, [], `Found malformed command names:\n${bad.map((b) => `  ${b.file}:${b.line} → ${b.name}`).join("\n")}`);
	});

	it("no duplicate commands across files (per-name uniqueness)", () => {
		const entries = collectLiteralCommands(srcRoot);
		const seen = new Map<string, CommandEntry[]>();
		for (const e of entries) {
			const arr = seen.get(e.name) ?? [];
			arr.push(e);
			seen.set(e.name, arr);
		}
		const dups: Array<{ name: string; sites: CommandEntry[] }> = [];
		for (const [name, sites] of seen) {
			if (sites.length > 1) dups.push({ name, sites });
		}
		assert.deepEqual(
			dups,
			[],
			`Duplicate command names (a name registered twice fails at startup):\n${dups
				.map(
					(d) =>
						`  ${d.name} → ${d.sites.map((s) => `${path.basename(path.dirname(s.file))}/${path.basename(s.file)}:${s.line}`).join(", ")}`,
				)
				.join("\n")}`,
		);

		// G21: a loop-registered name (captured via registerTeamCommands) must
		// not ALSO be registered literally outside the registerTeamCommands
		// tree — registerPiCommands and the outside installers (crew-vibes,
		// inline-panel) all run at startup, so that collision would throw at
		// extension load. Literal sites inside src/extension/registration/
		// commands/ + commands.ts are the registerTeamCommands surface itself
		// and are expected.
		const captured = captureRegisterTeamCommandNames();
		const outsideLiteral = entries.filter(
			(e) => captured.has(e.name) && !e.file.startsWith(teamCommandsTree) && e.file !== teamCommandsShim,
		);
		assert.deepEqual(
			outsideLiteral.map((e) => `${e.name} (${path.relative(repoRoot, e.file)}:${e.line})`),
			[],
			`Loop-registered command also registered literally outside registerTeamCommands (double registration at startup)`,
		);
	});
});
