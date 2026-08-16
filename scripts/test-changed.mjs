#!/usr/bin/env node
// Run only the tests that cover changed source files.
//
// Strategy:
//   1. Compute the changed files via `git diff` against the merge-base of
//      the current branch and origin/main (falls back to HEAD~1 when no
//      upstream is available, e.g. a shallow clone).
//   2. Map each changed `src/<path>.ts` to its candidate test file(s) under
//      `test/unit/` using the basename convention
//      (`src/foo/bar.ts` matches any `bar.test.ts` under test/unit/).
//   3. De-duplicate, filter to existing files, and pass to
//      `scripts/test-runner.mjs`.
//   4. If no test files resolve (e.g. docs-only change), fall back to the
//      `test:critical` glob so the command is never a silent no-op — the
//      operator always gets signal.
//
// Usage:
//   npm run test:changed                 # auto-detect changes vs origin/main
//   npm run test:changed -- <extra-args> # forward args to test-runner.mjs
//   TEST_CHANGED_REF=HEAD~2 npm run test:changed   # override the diff base
//
// Design notes:
//   - This script depends on the git CLI; it exits 0 with a notice if git
//     is unavailable or the worktree is clean (the critical subset still
//     runs as the fallback, so CI never gets a false-green from a no-op).
//   - Mirrors the wrapper conventions of `scripts/test-runner.mjs`:
//     `--test-force-exit` is always injected; `--test-concurrency>2` is
//     clamped to 2 to match the CI-reliability guard.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");

function git(args) {
	try {
		return execSync(`git ${args}`, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

function isGitRepo() {
	return git("rev-parse --is-inside-work-tree") === "true";
}

function changedFiles() {
	const ref = process.env.TEST_CHANGED_REF;
	let diffArgs;
	if (ref) {
		diffArgs = `diff --name-only ${ref}`;
	} else {
		const mergeBase = git("merge-base HEAD origin/main 2>/dev/null || true");
		diffArgs = mergeBase ? `diff --name-only ${mergeBase} HEAD` : `diff --name-only HEAD~1 HEAD`;
	}
	const out = git(diffArgs);
	if (!out) return [];
	return out.split("\n").filter(Boolean);
}

// Map `src/foo/bar.ts` → candidate test paths `test/unit/**/bar.test.ts`.
// Walks test/unit/ once and matches by basename so we catch both
// `bar.test.ts` and `bar-<suffix>.test.ts` variants.
function mapToTests(files) {
	if (files.length === 0) return [];
	const unitRoot = path.join(root, "test", "unit");
	if (!existsSync(unitRoot)) return [];

	const allUnitTests = [];
	(function walk(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".test.ts")) allUnitTests.push(full);
		}
	})(unitRoot);

	const wantedBaseNames = new Set(
		files
			.filter((f) => f.startsWith("src/") && f.endsWith(".ts"))
			.map((f) => {
				const base = path.basename(f, ".ts");
				// Strip `.test` if someone changed a test source directly.
				return base.endsWith(".test") ? base.slice(0, -5) : base;
			}),
	);

	const matched = new Set();
	for (const testPath of allUnitTests) {
		const testBase = path.basename(testPath, ".test.ts");
		// Match exact basename OR `${base}-<suffix>` OR `${base}.<suffix>`.
		if (wantedBaseNames.has(testBase)) {
			matched.add(testPath);
			continue;
		}
		for (const wanted of wantedBaseNames) {
			if (testBase === wanted || testBase.startsWith(`${wanted}-`) || testBase.startsWith(`${wanted}.`)) {
				matched.add(testPath);
				break;
			}
		}
	}
	return [...matched].sort();
}

const userArgs = process.argv.slice(2);

if (!isGitRepo()) {
	console.error("[test:changed] not a git repo — falling back to test:critical subset.");
	const result = spawnSync(process.execPath, ["scripts/test-runner.mjs", ...userArgs, "test/unit/runtime/broker/crew-broker-handshake.test.ts"], {
		cwd: root,
		stdio: "inherit",
		env: process.env,
	});
	process.exit(result.status ?? 0);
}

const changes = changedFiles();
const tests = mapToTests(changes);

let finalArgs;
if (tests.length === 0) {
	console.log(`[test:changed] no changed src files map to a test; running test:critical subset for safety.`);
	console.log(`[test:changed] (changed files: ${changes.length === 0 ? "none (clean tree?)" : changes.join(", ")})`);
	finalArgs = [
		"test/unit/runtime/broker/crew-broker-handshake.test.ts",
		"test/unit/runtime/broker/crew-broker-feature-flag.test.ts",
		"test/unit/runtime/broker/crew-broker-server-gate.test.ts",
		...userArgs,
	];
} else {
	console.log(`[test:changed] running ${tests.length} test file(s) for changed src:`);
	for (const t of tests) console.log(`  ${path.relative(root, t)}`);
	finalArgs = [...tests, ...userArgs];
}

// Forward to the existing wrapper. test-runner.mjs injects --test-force-exit
// and clamps --test-concurrency>2 for CI reliability.
const result = spawnSync(process.execPath, ["scripts/test-runner.mjs", ...finalArgs], {
	cwd: root,
	stdio: "inherit",
	env: process.env,
});
process.exit(result.status ?? 0);
