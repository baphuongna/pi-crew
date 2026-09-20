#!/usr/bin/env node
// Run only the tests that cover changed files.
//
// Modes (F18 / RR-015 — the two modes differ in WHICH changes they can see):
//   - **Branch/CI mode** (`TEST_CHANGED_REF` set, or `CI`/`GITHUB_ACTIONS` set):
//     diffs the current branch against the merge-base with origin/main (or
//     `HEAD~1` when there is no upstream, e.g. a shallow clone). A CI checkout
//     is a committed tree, so committed-range diffing is the correct signal.
//   - **Local mode** (default): the developer is working with an UNCOMMITTED
//     tree, so the committed range alone is useless — before this fix a staged
//     or unstaged edit produced "(changed files: none (clean tree?))" and the
//     script silently ran an unrelated fallback. Local mode unions:
//       1. committed changes vs the merge-base (keeps feature-branch parity),
//       2. `git diff --name-only HEAD`  → staged + unstaged edits,
//       3. `git ls-files --others`      → untracked (brand-new) files.
//
// Test selection:
//   1. Changed TEST files (`test/**/*.test.ts`, `*.smoke.ts`) are run DIRECTLY —
//      a brand-new test file is run because it changed, not because some src
//      basename happens to match it.
//   2. Changed `src/**/*.ts` are mapped to candidate tests under `test/unit/`
//      by basename (`src/foo/bar.ts` → `bar.test.ts`, `bar-<suffix>.test.ts`).
//   3. Everything is de-duplicated and filtered to files that exist.
//
// Fallback (F18): if nothing resolves, run the REAL `test:critical` gate read
// from package.json — previously this ran 3 hand-copied broker files while the
// gate has 14, and the message called those 3 "the test:critical subset" as if
// they were the whole thing. If the script cannot be read, the message says
// explicitly that a SUBSET is running and names how many files the gate has.
//
// Usage:
//   npm run test:changed                            # auto-detect mode
//   npm run test:changed -- <extra-args>            # forward args to test-runner.mjs
//   TEST_CHANGED_REF=HEAD~2 npm run test:changed    # force branch mode w/ explicit base
//   TEST_CHANGED_DRY_RUN=1 npm run test:changed     # print the plan, run nothing
//
// Design notes:
//   - This script depends on the git CLI; in a non-git directory there is no
//     diff to compute, so it runs the full critical gate (never a 1-file no-op).
//   - Mirrors the wrapper conventions of `scripts/test-runner.mjs`:
//     `--test-force-exit` is always injected; `--test-concurrency>2` is
//     clamped to 2 by the wrapper for CI reliability.
//   - The child exit code goes through `resolveExitCode` (F05) so a signalled
//     or failed spawn cannot report success.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolveExitCode } from "./test-runner.mjs";

const root = path.resolve(import.meta.dirname, "..");


/** Run git and return trimmed stdout, or null when the command fails. */
function git(args) {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

/** Run git with NUL-separated output; returns [] on failure. */
function gitZ(args) {
	try {
		const out = execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
		return out.split("\0").filter(Boolean);
	} catch {
		return [];
	}
}

function isGitRepo() {
	return git(["rev-parse", "--is-inside-work-tree"]) === "true";
}

/** True when running against a committed tree (CI) or an explicit diff base. */
function isBranchMode() {
	if (process.env.TEST_CHANGED_REF) return true;
	return Boolean(process.env.CI) || Boolean(process.env.GITHUB_ACTIONS);
}

/** Split a newline-separated git listing, dropping empty entries. */
function lines(out) {
	return out ? out.split("\n").filter(Boolean) : [];
}

/** Committed-range diff: merge-base..HEAD, or HEAD~1..HEAD without an upstream. */
function committedChanges() {
	const mergeBase = git(["merge-base", "HEAD", "origin/main"]);
	if (mergeBase) return lines(git(["diff", "--name-only", mergeBase, "HEAD"]));
	return lines(git(["diff", "--name-only", "HEAD~1", "HEAD"]));
}

/**
 * Compute changed files for the active mode.
 * @returns {{files: string[], sources: string[]}} files + which probes found them
 */
function changedFiles(branchMode) {
	const ref = process.env.TEST_CHANGED_REF;
	if (ref) {
		// Explicit base: keep the historical semantics (diff base..worktree) so
		// existing TEST_CHANGED_REF callers see no change.
		return { files: lines(git(["diff", "--name-only", ref])), sources: [`diff --name-only ${ref}`] };
	}
	if (branchMode) {
		return { files: committedChanges(), sources: ["committed range (merge-base..HEAD or HEAD~1..HEAD)"] };
	}

	// Local mode: committed range ∪ staged+unstaged ∪ untracked.
	const committed = committedChanges();
	const workingTree = lines(git(["diff", "--name-only", "HEAD"])); // staged + unstaged
	const untracked = gitZ(["ls-files", "-z", "--others", "--exclude-standard"]);
	const files = [...new Set([...committed, ...workingTree, ...untracked])].sort();
	return {
		files,
		sources: [
			`committed range (${committed.length})`,
			`git diff --name-only HEAD — staged + unstaged (${workingTree.length})`,
			`git ls-files --others — untracked (${untracked.length})`,
		],
	};
}

/** True for a test file the wrapper can execute directly. */
function isTestFile(rel) {
	return (rel.endsWith(".test.ts") || rel.endsWith(".smoke.ts")) && rel.split(path.sep).join("/").startsWith("test/");
}

/**
 * Map `src/foo/bar.ts` → candidate test paths `test/unit/**\/bar.test.ts`.
 * Walks test/unit/ once and matches by basename so we catch both
 * `bar.test.ts` and `bar-<suffix>.test.ts` variants.
 */
function mapToTests(files) {
	const srcFiles = files.filter((f) => f.startsWith("src/") && f.endsWith(".ts"));
	if (srcFiles.length === 0) return [];
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
		srcFiles.map((f) => {
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

/**
 * Select the test files to run.
 * Changed TEST files win (run directly); changed src files map by basename.
 * @returns {{tests: string[], directTests: string[], mappedTests: string[]}}
 */
function selectTests(changes) {
	const directTests = changes.filter((f) => isTestFile(f) && existsSync(path.join(root, f))).map((f) => path.join(root, f));
	const mappedTests = mapToTests(changes);
	const tests = [...new Set([...directTests, ...mappedTests])].sort();
	return { tests, directTests: [...new Set(directTests)].sort(), mappedTests };
}

/**
 * Read the real `test:critical` command from package.json and return the
 * wrapper args (everything after `node scripts/test-runner.mjs`).
 * @returns {{args: string[], files: string[]}|null}
 */
function criticalGate() {
	try {
		const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));
		const raw = pkg?.scripts?.["test:critical"];
		if (typeof raw !== "string") return null;
		const tokens = raw.split(/\s+/).filter(Boolean);
		const runnerIdx = tokens.findIndex((t) => t.endsWith("test-runner.mjs"));
		if (runnerIdx === -1) return null;
		const args = tokens.slice(runnerIdx + 1);
		const files = args.filter((t) => t.endsWith(".test.ts") && existsSync(path.join(root, t)));
		if (files.length === 0) return null;
		return { args, files };
	} catch {
		return null;
	}
}

/**
 * Honest fallback. Runs the FULL `test:critical` gate when it can be read from
 * package.json; otherwise runs the legacy 3-file broker subset and SAYS it is a
 * subset (F18 AC-13/AC-14: the old message claimed "test:critical subset" while
 * running 3 of 14 files, and the non-git branch claimed the same while running 1).
 * @returns {string[]} wrapper args
 */
function fallbackArgs(reason) {
	const gate = criticalGate();
	if (gate) {
		console.log(`[test:changed] ${reason}`);
		console.log(`[test:changed] → running the FULL test:critical gate (${gate.files.length} file(s) from package.json).`);
		return gate.args;
	}
	const subset = [
		"test/unit/runtime/broker/crew-broker-handshake.test.ts",
		"test/unit/runtime/broker/crew-broker-feature-flag.test.ts",
		"test/unit/runtime/broker/crew-broker-server-gate.test.ts",
	].filter((t) => existsSync(path.join(root, t)));
	console.log(`[test:changed] ${reason}`);
	console.log(
		`[test:changed] WARNING: could not read the "test:critical" script from package.json — running a ${subset.length}-file SUBSET of the critical gate, NOT the full gate.`,
	);
	return subset;
}

/** Run the wrapper and exit with its (fail-closed) status. */
function runWrapper(args) {
	const result = spawnSync(process.execPath, ["scripts/test-runner.mjs", ...args], {
		cwd: root,
		stdio: "inherit",
		env: process.env,
	});
	process.exit(resolveExitCode(result));
}

const userArgs = process.argv.slice(2);
const dryRun = process.env.TEST_CHANGED_DRY_RUN === "1";
const branchMode = isBranchMode();

if (!isGitRepo()) {
	const args = fallbackArgs("not a git repo — no diff is available, so no change-based selection is possible.");
	if (dryRun) {
		console.log(`[test:changed] DRY RUN — would run: ${args.join(" ")}`);
		process.exit(0);
	}
	runWrapper([...args, ...userArgs]);
}

const { files: changes, sources } = changedFiles(branchMode);
const { tests, directTests, mappedTests } = selectTests(changes);

console.log(`[test:changed] mode: ${branchMode ? "branch/CI" : "local"} (sources: ${sources.join("; ")})`);
console.log(
	`[test:changed] changed files: ${changes.length === 0 ? "none (clean tree?)" : `${changes.length} → ${changes.join(", ")}`}`,
);

let finalArgs;
if (tests.length === 0) {
	finalArgs = fallbackArgs(
		changes.length === 0
			? "no changed files detected (clean tree), so there is nothing to map to a test."
			: "no changed file maps to a test (docs/config-only change?), so the critical gate runs as the safety net.",
	);
} else {
	console.log(`[test:changed] running ${tests.length} test file(s):`);
	if (directTests.length > 0) console.log(`[test:changed]   directly changed tests (${directTests.length}):`);
	for (const t of directTests) console.log(`  ${path.relative(root, t)}`);
	if (mappedTests.length > 0) console.log(`[test:changed]   mapped from changed src (${mappedTests.length}):`);
	for (const t of mappedTests) console.log(`  ${path.relative(root, t)}`);
	finalArgs = [...tests, ...userArgs];
}

if (dryRun) {
	console.log(`[test:changed] DRY RUN — would run: node scripts/test-runner.mjs ${finalArgs.join(" ")}`);
	process.exit(0);
}

runWrapper(finalArgs);
