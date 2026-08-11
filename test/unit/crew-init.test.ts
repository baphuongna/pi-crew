/**
 * Tests for P0: Auto-setup .crew directory and .gitignore.
 *
 * ── F-6 documentation (post-issue-#28 review, commit e95e055) ────────────
 * Issue #28's fix targets `crew-init.ts` because it is the top of an
 * `await import()` chain in jiti. The fix removes the runtime dependency
 * on the `path` namespace binding by inlining `parseRoot`, `safeJoin`,
 * `safeDirname`, and `safeResolve`.
 *
 * A natural follow-up question: does `src/runtime/async-runner.ts` have
 * the same problem? It uses `path.resolve`, `path.parse`, `path.join`,
 * and `path.dirname` directly (lines 37, 41, 131–132). The answer is NO:
 * `async-runner.ts` is reached via the *static* re-export chain
 * `src/subagents/async-entry.ts` → `src/extension/team-tool/run.ts` and
 * `src/extension/team-tool/parallel-dispatch.ts`. jiti's namespace race
 * only affects the top of an `await import()` chain. Static imports are
 * resolved when the module is first loaded by jiti, well before any
 * concurrent dynamic-import activity. Therefore `async-runner.ts` does
 * not need the same treatment.
 *
 * If a future refactor ever moves `async-runner.ts` behind a dynamic
 * `import()` in a concurrent code path, this file's F-2 and F-3
 * regression tests should be re-applied to it.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

// We test the modules directly via dynamic import so they resolve
// relative to the source tree correctly.
const { ensureCrewDirectory } = await import("../../src/state/crew-init.ts");
const { updateGitignore } = await import("../../src/state/gitignore-manager.ts");

function makeTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-crew-init-test-"));
	// Add a .git marker so projectCrewRoot resolves to .crew/ inside this dir
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	return dir;
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

// --- crew-init tests ---

test("ensureCrewDirectory creates required directory structure", async () => {
	const dir = makeTempProject();
	try {
		await ensureCrewDirectory(dir);
		const crewRoot = path.join(dir, ".crew");
		const expectedDirs = [
			".crew",
			".crew/state/runs",
			".crew/state/subagents",
			".crew/artifacts",
			".crew/cache",
			".crew/graphs",
			".crew/audit",
		];
		for (const sub of expectedDirs) {
			assert.ok(fs.statSync(path.join(dir, sub)).isDirectory(), `Expected directory: ${sub}`);
		}
	} finally {
		cleanup(dir);
	}
});

test("ensureCrewDirectory creates .gitkeep placeholders", async () => {
	const dir = makeTempProject();
	try {
		await ensureCrewDirectory(dir);
		const crewRoot = path.join(dir, ".crew");
		const placeholders = ["artifacts/.gitkeep", "cache/.gitkeep", "graphs/.gitkeep", "audit/.gitkeep"];
		for (const p of placeholders) {
			const fullPath = path.join(crewRoot, p);
			assert.ok(fs.existsSync(fullPath), `Expected placeholder: ${p}`);
			assert.equal(fs.readFileSync(fullPath, "utf-8"), "");
		}
	} finally {
		cleanup(dir);
	}
});

test("ensureCrewDirectory writes README.md", async () => {
	const dir = makeTempProject();
	try {
		await ensureCrewDirectory(dir);
		const readmePath = path.join(dir, ".crew", "README.md");
		assert.ok(fs.existsSync(readmePath), "README.md should exist");
		const content = fs.readFileSync(readmePath, "utf-8");
		assert.ok(content.includes("pi-crew"), "README should mention pi-crew");
		assert.ok(content.includes("state/runs"), "README should describe state/runs");
	} finally {
		cleanup(dir);
	}
});

test("ensureCrewDirectory is idempotent", async () => {
	const dir = makeTempProject();
	try {
		await ensureCrewDirectory(dir);
		const readmeBefore = fs.readFileSync(path.join(dir, ".crew", "README.md"), "utf-8");
		// Call again — should not throw
		await ensureCrewDirectory(dir);
		const readmeAfter = fs.readFileSync(path.join(dir, ".crew", "README.md"), "utf-8");
		// README content should be the same (overwritten with same content)
		assert.equal(readmeBefore, readmeAfter);
		// Directories should still exist
		assert.ok(fs.statSync(path.join(dir, ".crew", "state", "runs")).isDirectory());
	} finally {
		cleanup(dir);
	}
});

// --- gitignore-manager tests ---

test("updateGitignore creates .gitignore if it doesn't exist", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-gitignore-test-"));
	try {
		const gitignorePath = path.join(dir, ".gitignore");
		await updateGitignore(gitignorePath);
		assert.ok(fs.existsSync(gitignorePath));
		const content = fs.readFileSync(gitignorePath, "utf-8");
		assert.ok(content.includes("/.crew/"), "Should contain /.crew/");
		assert.ok(content.includes("!.crew/artifacts/"), "Should contain !.crew/artifacts/");
		assert.ok(content.includes("!.crew/graphs/.gitkeep"), "Should contain !.crew/graphs/.gitkeep");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("updateGitignore adds entries to existing .gitignore", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-gitignore-test-"));
	try {
		const gitignorePath = path.join(dir, ".gitignore");
		fs.writeFileSync(gitignorePath, "node_modules/\ndist/\n", "utf-8");
		await updateGitignore(gitignorePath);
		const content = fs.readFileSync(gitignorePath, "utf-8");
		// Existing content preserved
		assert.ok(content.includes("node_modules/"));
		assert.ok(content.includes("dist/"));
		// New entries added
		assert.ok(content.includes("/.crew/"));
		assert.ok(content.includes("!.crew/artifacts/"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("updateGitignore does not duplicate existing entries", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-gitignore-test-"));
	try {
		const gitignorePath = path.join(dir, ".gitignore");
		await updateGitignore(gitignorePath);
		const content1 = fs.readFileSync(gitignorePath, "utf-8");
		await updateGitignore(gitignorePath);
		const content2 = fs.readFileSync(gitignorePath, "utf-8");
		assert.equal(content1, content2, "Content should not change on second call");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("updateGitignore preserves existing content", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-gitignore-test-"));
	try {
		const gitignorePath = path.join(dir, ".gitignore");
		const existingContent = "# My project\n*.log\nbuild/\n";
		fs.writeFileSync(gitignorePath, existingContent, "utf-8");
		await updateGitignore(gitignorePath);
		const content = fs.readFileSync(gitignorePath, "utf-8");
		assert.ok(content.startsWith("# My project\n*.log\nbuild/"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// NEW-R5: the read-modify-write of .gitignore must go through atomicWriteFile
// (temp+rename) — no leftover temp files, no non-atomic truncate window.
test("updateGitignore writes atomically — no temp file leftovers (NEW-R5)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-gitignore-atomic-"));
	try {
		const gitignorePath = path.join(dir, ".gitignore");
		fs.writeFileSync(gitignorePath, "node_modules/\n", "utf-8");
		await updateGitignore(gitignorePath);
		const content = fs.readFileSync(gitignorePath, "utf-8");
		assert.ok(content.includes("/.crew/"), "entries appended");
		// Atomic write leaves no .tmp files in the directory.
		const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
		assert.deepEqual(leftovers, [], "no temp files should remain after atomic write");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// G12 (2026-08-10): when `.pi/` exists and `.crew/` does not, the project is
// on the legacy `.pi/teams/` layout. gitignore entries must target that path
// or run state silently leaks into git. Mirrors the projectCrewRoot fallback
// in src/utils/paths.ts:230-241.
test("updateGitignore writes .pi/teams/ entries when .pi/ exists without .crew/ (G12)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-gitignore-pi-teams-"));
	try {
		// Create .pi/ to trigger the legacy-layout branch.
		fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
		const gitignorePath = path.join(dir, ".gitignore");
		await updateGitignore(gitignorePath);
		const content = fs.readFileSync(gitignorePath, "utf-8");
		assert.ok(content.includes("/.pi/teams/state/"), "Should contain /.pi/teams/state/");
		assert.ok(content.includes("/.pi/teams/cache/"), "Should contain /.pi/teams/cache/");
		assert.ok(content.includes("/.pi/teams/worktrees/"), "Should contain /.pi/teams/worktrees/");
		assert.ok(content.includes("!/.pi/teams/artifacts/"), "artifacts stay committable");
		assert.ok(content.includes("!/.pi/teams/graphs/"), "graphs stay committable");
		// Must NOT contain the .crew/ entries — wrong layout.
		assert.ok(!content.includes("/.crew/"), "Should NOT contain /.crew/ on .pi/ layout");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("updateGitignore prefers .crew/ entries when both .crew/ and .pi/ exist (G12)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-gitignore-both-"));
	try {
		fs.mkdirSync(path.join(dir, ".crew"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
		const gitignorePath = path.join(dir, ".gitignore");
		await updateGitignore(gitignorePath);
		const content = fs.readFileSync(gitignorePath, "utf-8");
		assert.ok(content.includes("/.crew/"), ".crew/ takes precedence when it exists");
		assert.ok(!content.includes("/.pi/teams/state/"), "Should NOT add .pi/teams/ when .crew/ exists");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("updateGitignore writes .pi/teams/ entries atomically — no temp leftovers (G12)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-gitignore-pi-atomic-"));
	try {
		fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
		const gitignorePath = path.join(dir, ".gitignore");
		fs.writeFileSync(gitignorePath, "node_modules/\n", "utf-8");
		await updateGitignore(gitignorePath);
		const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
		assert.deepEqual(leftovers, [], "no temp files on .pi/ layout either");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ensureCrewDirectory updates .gitignore in project root", async () => {
	const dir = makeTempProject();
	try {
		await ensureCrewDirectory(dir);
		const gitignorePath = path.join(dir, ".gitignore");
		assert.ok(fs.existsSync(gitignorePath), ".gitignore should be created");
		const content = fs.readFileSync(gitignorePath, "utf-8");
		assert.ok(content.includes("/.crew/"));
		assert.ok(content.includes("!.crew/artifacts/"));
	} finally {
		cleanup(dir);
	}
});

// --- Regression: issue #28 — parallel subagent race condition ---
//
// Bug: `path.parse(start).root` crashed with `TypeError: Cannot read properties
// of undefined (reading 'parse')` when 3+ concurrent subagents dynamically
// imported `crew-init.ts`. The fix inlines root detection via `parseRoot` and
// uses `safeJoin` / `safeDirname` / `safeResolve` that don't depend on the
// `path` namespace binding.

test("ensureCrewDirectory is safe under concurrent invocation (issue #28)", async () => {
	const dir = makeTempProject();
	try {
		// Launch 8 concurrent calls — same number of in-flight dynamic imports
		// that triggered the original race in the bug report.
		const calls = Array.from({ length: 8 }, () => ensureCrewDirectory(dir));
		// If any call throws (e.g. `path.parse` undefined), the aggregate will reject.
		const results = await Promise.all(calls);
		assert.equal(results.length, 8);
		// Structure should still be correct after the race.
		const crewRoot = path.join(dir, ".crew");
		assert.ok(fs.statSync(crewRoot).isDirectory());
		assert.ok(fs.statSync(path.join(crewRoot, "state", "runs")).isDirectory());
	} finally {
		cleanup(dir);
	}
});

test("ensureCrewDirectory survives a corrupted `path` namespace binding (issue #28)", async () => {
	// Node.js freezes the `node:path` module, so we can't monkey-patch it directly.
	// Instead, we test the inline fallbacks in isolation via __test__internals
	// to lock in their behavior — this is the same code path that runs when
	// `path.parse` is `undefined` in the jiti race.
	const crewInitModule = await import("../../src/state/crew-init.ts");
	const { parseRoot, safeJoin, safeDirname, safeResolve, findProjectRoot } = crewInitModule.__test__internals;

	// parseRoot: POSIX
	assert.equal(parseRoot("/"), "/");
	assert.equal(parseRoot("/a/b/c"), "/");
	assert.equal(parseRoot(""), "/");
	// parseRoot: Windows drive letter
	assert.equal(parseRoot("C:\\"), "C:\\");
	assert.equal(parseRoot("C:/foo"), "C:/");
	assert.equal(parseRoot("D:\\projects"), "D:\\");
	// parseRoot: UNC
	// UNC paths use double backslash at the start: \\server\share\foo
	assert.equal(parseRoot("\\\\server\\share\\foo"), "\\\\server\\share");
	// POSIX-style `//server/share/foo` is treated as a POSIX absolute path
	// (starting with `/`) — not a UNC path. This matches `path.parse` behavior.
	assert.equal(parseRoot("//server/share/foo"), "/");
	// parseRoot: relative
	assert.equal(parseRoot("foo/bar"), "foo/bar");
	assert.equal(parseRoot("./relative"), "./relative");

	// safeDirname
	assert.equal(safeDirname("/a/b/c"), "/a/b");
	assert.equal(safeDirname("/a"), "/");
	assert.equal(safeDirname("C:\\foo\\bar"), "C:\\foo");
	assert.equal(safeDirname("foo"), "foo");
	assert.equal(safeDirname("/"), "/");

	// safeJoin — POSIX
	assert.equal(safeJoin("/a", "b", "c"), "/a/b/c");
	assert.equal(safeJoin("/a/", "b"), "/a/b");
	// safeJoin — Windows
	assert.equal(safeJoin("C:\\", "foo", "bar"), "C:\\foo\\bar");
	// safeJoin — UNC (F-1 regression)
	assert.equal(safeJoin("\\\\server", "share"), "\\\\server\\share");
	assert.equal(safeJoin("\\\\server", "share", "foo", "bar"), "\\\\server\\share\\foo\\bar");
	// safeJoin — collapses middle runs of separator
	assert.equal(safeJoin("a", "b//c"), "a/b/c");
	assert.equal(safeJoin("a\\\\b", "c"), "a\\b\\c");
	// safeJoin — empty parts filter
	assert.equal(safeJoin("/a", "", "b"), "/a/b");
	// safeJoin — trailing separator in part is stripped (F-8 regression).
	// This prevents `safeJoin("/", "foo")` → `"//foo"` (double slash) which
	// could be misinterpreted as a UNC path on POSIX tools.
	assert.equal(safeJoin("/", "foo"), "/foo");
	assert.equal(safeJoin("\\\\", "foo"), "\\\\foo");
	// safeJoin — multiple trailing separators
	assert.equal(safeJoin("/a//", "b"), "/a/b");
	assert.equal(safeJoin("/a/", "/b"), "/a/b");

	// safeResolve: identity when path module is unavailable, but
	// the real path.resolve is still available in the test environment.
	assert.equal(safeResolve("/foo"), path.resolve("/foo"));

	// --- F-2 regression: simulate the jiti race with a `path` proxy ---
	// In the original jiti race, `path` is a namespace object whose properties
	// are `undefined` (the namespace exists but its bindings haven't been
	// populated yet). We simulate this with a Proxy that returns `undefined`
	// for every property access, and pass it to the source's findProjectRoot
	// (which now accepts an optional path dependency). This proves the
	// production code path works with a broken `path` binding, not just a
	// copy of the logic in the test.
	const stubPath = new Proxy(
		{},
		{
			get() {
				return undefined;
			},
			has() {
				return false;
			},
		},
	);
	// Use a real temp directory; with the inline helpers, the stub `path`
	// should never be called and the loop should walk up to the .git marker.
	const realProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-jiti-race-test-"));
	fs.mkdirSync(path.join(realProject, ".git"), { recursive: true });
	const nested = path.join(realProject, "a", "b", "c", "d");
	fs.mkdirSync(nested, { recursive: true });
	try {
		// Pass the stubbed `path` dependency to the source's findProjectRoot.
		// With the fix, the inline helpers (parseRoot, safeJoin, safeDirname,
		// safeResolve) don't delegate to `path`, so the loop completes.
		const result = findProjectRoot(realProject, stubPath as unknown as typeof path);
		assert.equal(result, realProject, "findProjectRoot should walk up via .git marker even with stubbed path");
	} finally {
		fs.rmSync(realProject, { recursive: true, force: true });
	}

	// --- F-3 regression: safeResolve degradation is graceful ---
	// If path.resolve is unavailable, safeResolve returns its input. The
	// findProjectRoot loop should still terminate (either by finding a
	// marker or by walking all the way to the root). Pass a path proxy
	// whose `.resolve` is undefined; safeResolve should fall back to
	// identity, and the source's findProjectRoot should still complete.
	const stubNoResolve = new Proxy(
		{},
		{
			get(target, prop) {
				if (prop === "resolve") return undefined; // identity fallback
				return undefined;
			},
		},
	);
	assert.doesNotThrow(() => {
		// Should not throw; returns undefined (no .git anywhere up the tree).
		const result = findProjectRoot("/some/absolute/path", stubNoResolve as unknown as typeof path);
		assert.equal(result, undefined);
	});
});

// Direct unit tests for the inlined `parseRoot` helper.
//
// We import the module fresh and read the function via a tiny shim: the
// helper is module-private, so we exercise it indirectly through
// `ensureCrewDirectory` running on a known temp project with a deeply
// nested path. The point of these tests is to lock in the behavior so
// future refactors don't reintroduce the `path.parse` dependency.
test("ensureCrewDirectory walks up to .git marker from a deeply nested cwd", async () => {
	const dir = makeTempProject();
	const nested = path.join(dir, "a", "b", "c", "d");
	fs.mkdirSync(nested, { recursive: true });
	try {
		await ensureCrewDirectory(nested);
		assert.ok(fs.statSync(path.join(dir, ".crew")).isDirectory(), "Should locate project root via .git marker and create .crew/ there");
	} finally {
		cleanup(dir);
	}
});

test("ensureCrewDirectory walks up to package.json marker", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-crew-init-pkgjson-"));
	fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf-8");
	const nested = path.join(dir, "src", "lib");
	fs.mkdirSync(nested, { recursive: true });
	try {
		await ensureCrewDirectory(nested);
		assert.ok(
			fs.statSync(path.join(dir, ".crew")).isDirectory(),
			"Should locate project root via package.json and create .crew/ there",
		);
	} finally {
		cleanup(dir);
	}
});
