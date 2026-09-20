/**
 * F18 (RR-015) — `scripts/test-changed.mjs` must SEE uncommitted work.
 *
 * Before the fix the script computed its change set from
 * `git diff --name-only <merge-base>..HEAD`, i.e. COMMITS ONLY. Both staged and
 * unstaged edits were invisible, so a developer editing `src/foo.ts` in place
 * got:
 *
 *     [test:changed] no changed src files map to a test; running test:critical subset for safety.
 *     [test:changed] (changed files: none (clean tree?))
 *
 * — the tool reported "clean tree" on a dirty one and ran an unrelated fallback.
 * The fallback was also dishonest: it ran 3 hand-copied broker files while the
 * real `test:critical` gate lists 14 (package.json), and the non-git branch ran
 * ONE file while printing "falling back to test:critical subset".
 *
 * METHOD: each test builds a throwaway git repo under tmpdir with a STUB
 * `scripts/test-runner.mjs` that just prints its argv. That isolates the
 * SELECTION logic (what F18 is about) from the test execution, and lets us
 * assert exactly which files the script decided to run. The script under test
 * is the real one, copied into the fixture, so its own `root` resolves to the
 * fixture.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "test-changed.mjs");
const RUNNER = join(REPO_ROOT, "scripts", "test-runner.mjs");

const tmpDirs: string[] = [];
after(() => {
	for (const dir of tmpDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

function sh(cmd: string, args: string[], cwd: string): string {
	return execFileSync(cmd, args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Build a git repo fixture that mirrors the layout `test-changed.mjs` expects:
 *   scripts/test-changed.mjs   (the REAL script under test)
 *   scripts/test-runner.mjs    (STUB — echoes its argv so selection is visible)
 *   src/…, test/unit/…         (candidate test files)
 * `origin/main` points at the initial commit so merge-base resolves.
 */
function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "test-changed-f18-"));
	tmpDirs.push(dir);
	mkdirSync(join(dir, "scripts"), { recursive: true });
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, "test", "unit"), { recursive: true });

	cpSync(SCRIPT, join(dir, "scripts", "test-changed.mjs"));
	// Stub runner: prints the file list it was asked to run, exits 0.
	writeFileSync(
		join(dir, "scripts", "test-runner.mjs"),
		[
			'export function resolveExitCode(r) { return typeof r?.status === "number" ? r.status : 1; }',
			"export function describeExitOutcome() { return undefined; }",
			'if (process.argv[1] && process.argv[1].endsWith("test-runner.mjs")) {',
			'  console.log("STUB-RUNNER-ARGS:" + JSON.stringify(process.argv.slice(2)));',
			"  process.exit(0);",
			"}",
			"",
		].join("\n"),
		"utf-8",
	);

	// package.json carries a realistic `test:critical` gate (3 of 14 files is
	// enough to prove the fallback reads the REAL script rather than a
	// hand-copied list).
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify(
			{
				name: "fixture",
				type: "module",
				private: true,
				scripts: {
					"test:critical":
						"node scripts/test-runner.mjs --test-concurrency=4 --test-timeout=30000 --test-force-exit test/unit/critical-a.test.ts test/unit/critical-b.test.ts test/unit/critical-c.test.ts",
				},
			},
			null,
			"\t",
		),
		"utf-8",
	);

	// Candidate test files.
	for (const name of ["foo", "bar", "critical-a", "critical-b", "critical-c"]) {
		writeFileSync(join(dir, "test", "unit", `${name}.test.ts`), `// fixture ${name}\n`, "utf-8");
	}
	writeFileSync(join(dir, "src", "foo.ts"), "export const foo = 1;\n", "utf-8");
	writeFileSync(join(dir, "src", "bar.ts"), "export const bar = 1;\n", "utf-8");
	writeFileSync(join(dir, "README.md"), "fixture\n", "utf-8");

	sh("git", ["init", "-q", "-b", "main"], dir);
	sh("git", ["config", "user.email", "t@example.com"], dir);
	sh("git", ["config", "user.name", "t"], dir);
	sh("git", ["add", "-A"], dir);
	sh("git", ["commit", "-q", "-m", "init"], dir);
	// `origin/main` = initial commit, so merge-base HEAD origin/main == HEAD.
	sh("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], dir);
	return dir;
}

/** Run the script under test in a fixture and return {status, stdout, stderr}. */
function runScript(dir: string, env: Record<string, string | undefined> = {}): { status: number | null; stdout: string; stderr: string } {
	const res = spawnSync(process.execPath, [join(dir, "scripts", "test-changed.mjs")], {
		cwd: dir,
		encoding: "utf-8",
		timeout: 60_000,
		stdio: ["ignore", "pipe", "pipe"],
		// Strip the ambient CI markers so the fixture takes the LOCAL branch.
		env: { ...process.env, CI: undefined, GITHUB_ACTIONS: undefined, TEST_CHANGED_REF: undefined, ...env },
	});
	return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** The argv the stub runner received, or null if it never ran. */
function stubArgs(stdout: string): string[] | null {
	const line = stdout.split("\n").find((l) => l.startsWith("STUB-RUNNER-ARGS:"));
	return line ? (JSON.parse(line.slice("STUB-RUNNER-ARGS:".length)) as string[]) : null;
}

// ---------------------------------------------------------------------------
// Local mode — staged / unstaged / untracked must be VISIBLE
// ---------------------------------------------------------------------------

test("F18/AC-8: local mode sees an UNSTAGED src edit and runs its mapped test", () => {
	const dir = makeRepo();
	writeFileSync(join(dir, "src", "foo.ts"), "export const foo = 2; // unstaged\n", "utf-8");

	const res = runScript(dir);
	assert.doesNotMatch(res.stdout, /none \(clean tree\?\)/, `an unstaged edit must not read as a clean tree. stdout: ${res.stdout}`);
	const args = stubArgs(res.stdout);
	assert.ok(args, `the wrapper must have run. stdout: ${res.stdout}`);
	const files = args.filter((a) => a.endsWith(".test.ts")).map((a) => a.replace(`${dir}/`, ""));
	assert.ok(files.includes("test/unit/foo.test.ts"), `must run the test mapped from src/foo.ts. Got: ${JSON.stringify(files)}`);
});

test("F18/AC-9: local mode sees a STAGED src edit and runs its mapped test", () => {
	const dir = makeRepo();
	writeFileSync(join(dir, "src", "bar.ts"), "export const bar = 2; // staged\n", "utf-8");
	sh("git", ["add", "src/bar.ts"], dir);

	const res = runScript(dir);
	assert.doesNotMatch(res.stdout, /none \(clean tree\?\)/, `a staged edit must not read as a clean tree. stdout: ${res.stdout}`);
	const args = stubArgs(res.stdout);
	assert.ok(args, `the wrapper must have run. stdout: ${res.stdout}`);
	const files = args.filter((a) => a.endsWith(".test.ts")).map((a) => a.replace(`${dir}/`, ""));
	assert.ok(files.includes("test/unit/bar.test.ts"), `must run the test mapped from src/bar.ts. Got: ${JSON.stringify(files)}`);
});

test("F18/AC-10: local mode runs a brand-NEW (untracked) test file directly", () => {
	const dir = makeRepo();
	// A new test file that has never been committed and matches no src basename.
	writeFileSync(join(dir, "test", "unit", "brand-new.test.ts"), "// brand new\n", "utf-8");

	const res = runScript(dir);
	const args = stubArgs(res.stdout);
	assert.ok(args, `the wrapper must have run. stdout: ${res.stdout}`);
	const files = args.filter((a) => a.endsWith(".test.ts")).map((a) => a.replace(`${dir}/`, ""));
	assert.ok(
		files.includes("test/unit/brand-new.test.ts"),
		`an untracked test file must be run because it CHANGED. Got: ${JSON.stringify(files)}`,
	);
});

test("F18/AC-11: local mode runs a CHANGED test file directly (was: no test ran at all)", () => {
	const dir = makeRepo();
	// Only a test file changes — no src file, so basename mapping finds nothing.
	// Pre-fix: the fallback ran and the changed test itself was NEVER run.
	writeFileSync(join(dir, "test", "unit", "foo.test.ts"), "// edited test only\n", "utf-8");

	const res = runScript(dir);
	const args = stubArgs(res.stdout);
	assert.ok(args, `the wrapper must have run. stdout: ${res.stdout}`);
	const files = args.filter((a) => a.endsWith(".test.ts")).map((a) => a.replace(`${dir}/`, ""));
	assert.ok(files.includes("test/unit/foo.test.ts"), `the changed test file must run. Got: ${JSON.stringify(files)}`);
	assert.ok(
		!files.includes("test/unit/critical-a.test.ts"),
		`the critical fallback must NOT run when a changed test resolves. Got: ${JSON.stringify(files)}`,
	);
});

// ---------------------------------------------------------------------------
// Branch/CI mode — unchanged semantics (AC-12)
// ---------------------------------------------------------------------------

test("F18/AC-12: branch/CI mode still uses the committed range (merge-base..HEAD)", () => {
	const dir = makeRepo();
	sh("git", ["config", "user.email", "t@example.com"], dir);
	// Commit a src change, then leave a DIFFERENT uncommitted edit behind.
	writeFileSync(join(dir, "src", "foo.ts"), "export const foo = 3; // committed\n", "utf-8");
	sh("git", ["add", "src/foo.ts"], dir);
	sh("git", ["commit", "-q", "-m", "feat: change foo"], dir);
	writeFileSync(join(dir, "src", "bar.ts"), "export const bar = 9; // uncommitted\n", "utf-8");

	const res = runScript(dir, { CI: "true" });
	const args = stubArgs(res.stdout);
	assert.ok(args, `the wrapper must have run. stdout: ${res.stdout}`);
	const files = args.filter((a) => a.endsWith(".test.ts")).map((a) => a.replace(`${dir}/`, ""));
	assert.ok(files.includes("test/unit/foo.test.ts"), `committed change must be selected. Got: ${JSON.stringify(files)}`);
	// Branch mode deliberately ignores the working tree: the uncommitted bar edit
	// must NOT pull in bar.test.ts. (That is the documented branch-mode contract.)
	assert.ok(!files.includes("test/unit/bar.test.ts"), `branch mode must not select uncommitted changes. Got: ${JSON.stringify(files)}`);
});

test("F18: TEST_CHANGED_REF keeps working as an explicit diff base", () => {
	const dir = makeRepo();
	writeFileSync(join(dir, "src", "foo.ts"), "export const foo = 4;\n", "utf-8");
	sh("git", ["add", "src/foo.ts"], dir);
	sh("git", ["commit", "-q", "-m", "feat: foo"], dir);
	// Base = the initial commit (HEAD~1) → the committed foo change is in range.
	const res = runScript(dir, { TEST_CHANGED_REF: "HEAD~1" });
	const args = stubArgs(res.stdout);
	assert.ok(args, `the wrapper must have run. stdout: ${res.stdout}`);
	const files = args.filter((a) => a.endsWith(".test.ts")).map((a) => a.replace(`${dir}/`, ""));
	assert.ok(files.includes("test/unit/foo.test.ts"), `TEST_CHANGED_REF=HEAD~1 must see the commit. Got: ${JSON.stringify(files)}`);
});

// ---------------------------------------------------------------------------
// Fallback honesty (AC-13 / AC-14)
// ---------------------------------------------------------------------------

test("F18/AC-13: the fallback runs the REAL test:critical gate, not 3 hand-copied files", () => {
	const dir = makeRepo();
	// Change only a doc — nothing maps to a test, so the fallback fires.
	writeFileSync(join(dir, "README.md"), "changed docs only\n", "utf-8");

	const res = runScript(dir);
	const args = stubArgs(res.stdout);
	assert.ok(args, `the wrapper must have run. stdout: ${res.stdout}`);
	// The fixture's test:critical lists 3 files; the pre-fix fallback hard-coded a
	// DIFFERENT 3 broker paths that do not exist here. Assert the selected set is
	// exactly what package.json declares.
	const files = args.filter((a) => a.endsWith(".test.ts")).map((a) => a.replace(`${dir}/`, ""));
	assert.deepEqual(
		files.sort(),
		["test/unit/critical-a.test.ts", "test/unit/critical-b.test.ts", "test/unit/critical-c.test.ts"],
		`the fallback must read test:critical from package.json. Got: ${JSON.stringify(files)}`,
	);
	assert.match(res.stdout, /FULL test:critical gate \(3 file\(s\)/, `the message must state the real file count. stdout: ${res.stdout}`);
});

test("F18/AC-14: the non-git branch does not claim a subset is the critical gate", () => {
	const dir = mkdtempSync(join(tmpdir(), "test-changed-f18-nogit-"));
	tmpDirs.push(dir);
	mkdirSync(join(dir, "scripts"), { recursive: true });
	mkdirSync(join(dir, "test", "unit"), { recursive: true });
	cpSync(SCRIPT, join(dir, "scripts", "test-changed.mjs"));
	cpSync(RUNNER, join(dir, "scripts", "test-runner.mjs"));
	for (const name of ["critical-a", "critical-b", "critical-c"]) {
		writeFileSync(join(dir, "test", "unit", `${name}.test.ts`), `// fixture ${name}\n`, "utf-8");
	}
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			name: "fixture",
			type: "module",
			private: true,
			scripts: {
				"test:critical":
					"node scripts/test-runner.mjs test/unit/critical-a.test.ts test/unit/critical-b.test.ts test/unit/critical-c.test.ts",
			},
		}),
		"utf-8",
	);
	// Use DRY RUN so the real wrapper never executes the fixture's stub tests.
	const res = spawnSync(process.execPath, [join(dir, "scripts", "test-changed.mjs")], {
		cwd: dir,
		encoding: "utf-8",
		timeout: 60_000,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, CI: undefined, GITHUB_ACTIONS: undefined, TEST_CHANGED_REF: undefined, TEST_CHANGED_DRY_RUN: "1" },
	});
	const stdout = res.stdout ?? "";
	assert.match(stdout, /not a git repo/, `must report the non-git case. stdout: ${stdout}`);
	// The pre-fix message claimed "test:critical subset" while running ONE file.
	// Now the count printed must match the number of files actually selected.
	assert.match(stdout, /FULL test:critical gate \(3 file\(s\)/, `must report the real count. stdout: ${stdout}`);
	assert.doesNotMatch(stdout, /test:critical subset/i, `must not call a 3-file run a "test:critical subset". stdout: ${stdout}`);
	const wouldRun = stdout.split("\n").find((l) => l.includes("would run:"));
	assert.ok(wouldRun, `dry run must print the plan. stdout: ${stdout}`);
	for (const name of ["critical-a", "critical-b", "critical-c"]) {
		assert.ok(wouldRun?.includes(name), `the plan must include ${name}. Got: ${wouldRun}`);
	}
});
