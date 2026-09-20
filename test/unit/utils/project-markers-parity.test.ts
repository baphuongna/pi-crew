/**
 * project-markers-parity.test.ts — RR-020 Fix 1 regression (HIGH).
 *
 * Bug: the project-root marker lists were duplicated and had drifted, so TWO
 * resolvers disagreed about the project root for the SAME cwd:
 *   - src/utils/paths.ts:computeRepoRoot()  → 15 markers (incl. `.pi`, `.crew`)
 *   - src/state/crew-init.ts:findProjectRoot() → 7 markers (only VCS dirs +
 *     4 build files)
 * With `parent/.git` + `parent/subproject/.pi` and cwd=`parent/subproject`,
 * paths.ts resolved `subproject` (→ `subproject/.pi/teams`) while crew-init.ts
 * walked PAST `.pi` up to `parent/.git` (→ `parent/.crew`). Both are reachable
 * in one run (`run-intent.ts` → ensureCrewDirectory), producing two roots.
 *
 * The fix unifies both resolvers on src/utils/project-markers.ts. These tests
 * assert ROOT PARITY for the three layouts called out by the plan, plus the
 * end-to-end consequence (ensureCrewDirectory creates exactly projectCrewRoot).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { clearProjectRootCache, findRepoRoot, projectCrewRoot } from "../../../src/utils/paths.ts";

const crewInitModule = await import("../../../src/state/crew-init.ts");
const { ensureCrewDirectory } = crewInitModule;
const { findProjectRoot } = crewInitModule.__test__internals;

/** Canonical temp dir (findRepoRoot/projectCrewRoot compare canonical paths). */
function makeTempDir(prefix: string): string {
	let dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		const r = fs.realpathSync.native(dir);
		dir = r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		try {
			dir = fs.realpathSync(dir);
		} catch {
			/* keep as-is */
		}
	}
	return dir;
}

/**
 * Both resolvers must agree. `findRepoRoot` returns undefined when no marker is
 * found, and BOTH call sites fall back to the cwd itself (`projectCrewRoot`,
 * `computeCrewRoot`), so compare the effective roots.
 */
function assertRootParity(cwd: string, expected: string, label: string): void {
	clearProjectRootCache();
	const pathsRoot = findRepoRoot(cwd) ?? cwd;
	const crewInitRoot = findProjectRoot(cwd) ?? cwd;
	assert.equal(crewInitRoot, pathsRoot, `${label}: crew-init root must match paths.ts root (${cwd})`);
	assert.equal(pathsRoot, expected, `${label}: root must be ${expected}`);
}

test("parity (a): parent/.git + parent/subproject/.pi, cwd=subproject resolves to subproject", () => {
	const parent = makeTempDir("pi-crew-markers-a-");
	try {
		fs.mkdirSync(path.join(parent, ".git"), { recursive: true });
		const subproject = path.join(parent, "subproject");
		fs.mkdirSync(path.join(subproject, ".pi"), { recursive: true });

		assertRootParity(subproject, subproject, "scan-a");
		// The regression: crew-init used to stop at parent/.git.
		assert.notEqual(findProjectRoot(subproject), parent, "crew-init must not walk past the .pi marker");
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("parity (b): a .git-FILE worktree resolves to the worktree, not the main repo", () => {
	const main = makeTempDir("pi-crew-markers-b-");
	try {
		fs.mkdirSync(path.join(main, ".git"), { recursive: true });
		const worktree = path.join(main, "wt");
		fs.mkdirSync(worktree, { recursive: true });
		// `git worktree add` writes a `.git` FILE (not a directory) into the worktree.
		fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);

		assertRootParity(worktree, worktree, "scan-b");
	} finally {
		fs.rmSync(main, { recursive: true, force: true });
	}
});

test("parity (c): nested monorepo stops at the innermost package", () => {
	const mono = makeTempDir("pi-crew-markers-c-");
	try {
		fs.writeFileSync(path.join(mono, "package.json"), "{}\n");
		const pkg = path.join(mono, "packages", "app");
		const src = path.join(pkg, "src");
		fs.mkdirSync(src, { recursive: true });
		fs.writeFileSync(path.join(pkg, "package.json"), "{}\n");

		assertRootParity(src, pkg, "scan-c");
	} finally {
		fs.rmSync(mono, { recursive: true, force: true });
	}
});

test("parity: a non-VCS marker (.crew only) is honoured by BOTH resolvers", () => {
	const dir = makeTempDir("pi-crew-markers-d-");
	try {
		fs.mkdirSync(path.join(dir, ".crew"), { recursive: true });
		const nested = path.join(dir, "deep", "nested");
		fs.mkdirSync(nested, { recursive: true });

		// `.crew` is in paths.ts's list but was NOT in crew-init's list (the
		// drift half of the bug).
		assertRootParity(nested, dir, "scan-d");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("end-to-end: ensureCrewDirectory creates exactly projectCrewRoot(cwd) — one root, not two", async () => {
	const parent = makeTempDir("pi-crew-markers-e2e-");
	try {
		fs.mkdirSync(path.join(parent, ".git"), { recursive: true });
		const subproject = path.join(parent, "subproject");
		fs.mkdirSync(path.join(subproject, ".pi"), { recursive: true });

		clearProjectRootCache();
		const expectedRoot = projectCrewRoot(subproject);
		assert.equal(expectedRoot, path.join(subproject, ".pi", "teams"), "fixture: .pi layout ⇒ <subproject>/.pi/teams");

		await ensureCrewDirectory(subproject);
		clearProjectRootCache();

		assert.ok(fs.existsSync(path.join(expectedRoot, "state", "runs")), `crew root created at ${expectedRoot}`);
		// The pre-fix second root: crew-init resolved parent/.git ⇒ parent/.crew.
		assert.equal(fs.existsSync(path.join(parent, ".crew")), false, "must NOT create a second root at parent/.crew");
		assert.equal(projectCrewRoot(subproject), expectedRoot, "paths.ts root is unchanged after initialisation (no layout flip)");
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

// ── RR-020 cold-verify follow-up: home/tmp boundary stop (bug-029 parity) ──
//
// The FIRST version of Fix 1 unified the marker lists but NOT the walk:
// paths.ts:computeRepoRoot stops before checking markers at $HOME / the temp
// root, crew-init:findProjectRoot did not. With `.pi` now a marker for BOTH,
// `$HOME/.pi` (created by userPiRoot()) made a MARKERLESS cwd under $HOME
// resolve crew-init to $HOME (⇒ $HOME/.pi/teams) while projectCrewRoot
// resolved to <cwd>/.crew — the two-roots bug in a new shape, reproduced on a
// real machine. findProjectRoot now ports the boundary stop.

test("boundary: a MARKERLESS cwd under $HOME must not resolve to $HOME (bug-029 parity)", async () => {
	const parent = makeTempDir("pi-crew-homeboundary-");
	const realHome = path.join(parent, "fakehome");
	const ws = path.join(realHome, "markerless-project");
	try {
		// fake $HOME carries .pi (like userPiRoot() creates) but NO project markers
		fs.mkdirSync(path.join(realHome, ".pi"), { recursive: true });
		fs.mkdirSync(ws, { recursive: true });

		const prevHome = process.env.HOME;
		process.env.HOME = realHome; // POSIX os.homedir() honours $HOME
		try {
			clearProjectRootCache();
			// paths.ts: boundary stop ⇒ no repo root ⇒ cwd fallback ⇒ <ws>/.crew
			assert.equal(projectCrewRoot(ws), path.join(ws, ".crew"), "paths.ts: markerless cwd ⇒ <cwd>/.crew");
			// crew-init must agree (pre-follow-up it returned realHome ⇒ .pi/teams)
			assert.equal(findProjectRoot(ws), undefined, "crew-init: boundary stop ⇒ no project root");
			await ensureCrewDirectory(ws);
			clearProjectRootCache();
			assert.ok(fs.existsSync(path.join(ws, ".crew", "state", "runs")), "single root <ws>/.crew created");
			assert.equal(fs.existsSync(path.join(realHome, ".pi", "teams")), false, "must NOT create $HOME/.pi/teams");
			assert.equal(fs.existsSync(path.join(realHome, ".gitignore")), false, "must NOT touch $HOME/.gitignore");
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
		}
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("boundary: markers BELOW $HOME still win (boundary stops the walk, not legit roots)", () => {
	const parent = makeTempDir("pi-crew-homeboundary2-");
	const realHome = path.join(parent, "fakehome");
	const proj = path.join(realHome, "proj");
	try {
		fs.mkdirSync(path.join(realHome, ".pi"), { recursive: true });
		fs.mkdirSync(proj, { recursive: true });
		fs.mkdirSync(path.join(proj, ".git"));

		const prevHome = process.env.HOME;
		process.env.HOME = realHome;
		try {
			clearProjectRootCache();
			assert.equal(findProjectRoot(proj), proj, "repo root found below $HOME");
			assert.equal(projectCrewRoot(proj), path.join(proj, ".crew"), "paths.ts agrees");
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
		}
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});
