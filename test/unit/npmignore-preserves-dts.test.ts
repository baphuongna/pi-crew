// QA-11 regression guard.
//
// BUG: .npmignore excluded "src all .d.ts", but those are hand-written type
// declaration shims (e.g. src/types/diff.d.ts), NOT strip-types companions.
// clean-strip-types.mjs states they "must be preserved". Excluding them from
// the published package would strip type declarations and break TS consumers.
//
// This test asserts that every .d.ts file under src/ would be INCLUDED in an
// npm pack tarball (i.e. NOT ignored by .npmignore), while the genuine
// strip-types companions (.js / .js.map) remain excluded.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const NPMIGNORE_PATH = join(ROOT, ".npmignore");

// Inline `resolve` to avoid an extra import only for one call.
function resolve(...parts: string[]): string {
	let p = parts.join(sep);
	return p;
}

interface IgnoreRule {
	negated: boolean;
	regex: RegExp;
	raw: string;
}

/**
 * Convert a gitignore/npmignore glob pattern into a RegExp.
 * Supports `*` (non-segment), `**` (any depth), `?`, and literal escaping.
 * Mirrors the semantics npm-packlist uses for `.npmignore`.
 */
function globToRegExp(pattern: string): RegExp {
	let p = pattern.replace(/^\//, "");
	let re = "^";
	for (let i = 0; i < p.length; i++) {
		const c = p[i];
		if (c === "*") {
			if (p[i + 1] === "*") {
				i++; // consume second '*'
				if (p[i + 1] === "/") {
					// `**/` matches zero-or-more leading path segments
					re += "(?:.*/)?";
					i++; // consume '/'
				} else {
					re += ".*";
				}
			} else {
				re += "[^/]*"; // single '*' — does not cross '/'
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if ("\\^$.|+()[]{}".includes(c)) {
			re += "\\" + c;
		} else {
			re += c;
		}
	}
	return new RegExp(re + "$");
}

function parseNpmignore(content: string): IgnoreRule[] {
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
		.map((line) => {
			const negated = line.startsWith("!");
			const pattern = negated ? line.slice(1) : line;
			return { negated, regex: globToRegExp(pattern), raw: line };
		});
}

/**
 * Apply ignore rules gitignore-style: last matching rule wins (negation
 * un-ignores). Returns true if the path would be excluded from the pack.
 */
function isIgnored(relPath: string, rules: IgnoreRule[]): boolean {
	let ignored = false;
	for (const rule of rules) {
		if (rule.regex.test(relPath)) {
			ignored = !rule.negated;
		}
	}
	return ignored;
}

function toPosix(p: string): string {
	return p.split(sep).join("/");
}

function listDtsFiles(dir: string, base: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			out.push(...listDtsFiles(join(dir, entry.name), base));
		} else if (entry.name.endsWith(".d.ts")) {
			out.push(toPosix(relative(base, join(dir, entry.name))));
		}
	}
	return out;
}

test("QA-11: .npmignore exists", () => {
	assert.ok(existsSync(NPMIGNORE_PATH), ".npmignore must exist");
});

test("QA-11: no src/**/*.d.ts file is excluded by .npmignore", () => {
	assert.ok(existsSync(NPMIGNORE_PATH), ".npmignore must exist");
	const rules = parseNpmignore(readFileSync(NPMIGNORE_PATH, "utf-8"));

	const dtsFiles = listDtsFiles(join(ROOT, "src"), ROOT);
	assert.ok(
		dtsFiles.length > 0,
		"expected at least one src/**/*.d.ts file to test against",
	);

	for (const file of dtsFiles) {
		assert.equal(
			isIgnored(file, rules),
			false,
			`src/**/*.d.ts file "${file}" must NOT be excluded by .npmignore ` +
				"(it is a hand-written type shim, not a strip-types companion)",
		);
	}
});

test("QA-11: .npmignore still excludes genuine strip-types companions (.js/.js.map)", () => {
	// Regression guard — the real exclusions must remain intact.
	const rules = parseNpmignore(readFileSync(NPMIGNORE_PATH, "utf-8"));
	assert.equal(isIgnored("src/runtime/team-runner.js", rules), true);
	assert.equal(isIgnored("src/runtime/team-runner.js.map", rules), true);
});
