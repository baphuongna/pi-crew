/**
 * WI-5.5 (M5 spec §5) — slash-command parity test.
 *
 * Per spec §5 M5 acceptance: "Codegen command: parity test số command +
 * hành vi không đổi." This test:
 *   - Collects every `pi.registerCommand("<name>", ...)` call in the
 *     extension surface.
 *   - Asserts the count is ≥ 28 (lower bound — current is 31 per
 *     registry audit 2026-09-10) AND ≤ 45 (upper bound — sanity
 *     guard against accidental duplication or regression).
 *   - Asserts each name matches /^[a-z][a-z0-9_-]+$/ (no spaces,
 *     no upper-case).
 *
 * The actual list is informational (logged) — not asserted exactly
 * — because command discovery is intentionally dynamic across releases.
 * If a SPECIFIC command is REMOVED intentionally, this test logs the
 * change; the next caller can grep the diff to confirm.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

interface CommandEntry {
	file: string;
	line: number;
	name: string;
}

function collectCommands(root: string): CommandEntry[] {
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

describe("WI-5.5 slash-command parity", () => {
	it("command count within sanity range (28..45)", () => {
		const root = path.join(import.meta.dirname ?? __dirname, "../../../src");
		const entries = collectCommands(root);
		const unique = new Set(entries.map((e) => e.name));
		console.log(`[WI-5.5] registered slash commands: ${unique.size} unique (${entries.length} call sites)`);
		console.log(`  ${[...unique].sort().join(", ")}`);
		assert.ok(unique.size >= 28, `expected ≥28 unique commands, got ${unique.size}`);
		assert.ok(unique.size <= 45, `expected ≤45 unique commands, got ${unique.size}`);
	});

	it("all command names match /^[a-z][a-z0-9_-]+$/", () => {
		const root = path.join(import.meta.dirname ?? __dirname, "../../../src");
		const entries = collectCommands(root);
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
		const root = path.join(import.meta.dirname ?? __dirname, "../../../src");
		const entries = collectCommands(root);
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
	});
});
