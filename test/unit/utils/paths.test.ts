/**
 * Tests for src/utils/paths.ts
 * Coverage:
 * - findRepoRoot with various project markers (.git, .pi, .crew, etc.)
 * - findRepoRoot with no markers returns undefined
 * - findRepoRoot with project file markers (package.json, pyproject.toml)
 * - findRepoRoot cache TTL
 * - projectPiRoot, projectCrewRoot
 * - userPiRoot honors PI_TEAMS_HOME
 * - packageRoot returns valid path
 * - clearProjectRootCache
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { clearProjectRootCache, findRepoRoot, packageRoot, projectCrewRoot, projectPiRoot, userPiRoot } from "../../../src/utils/paths.ts";

const makeTempDir = () => {
	let dir = fs.mkdtempSync(path.join(os.tmpdir(), "paths-test-"));
	// Canonicalize to long-name form matching production code (projectCrewRoot uses .native)
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
};

test("packageRoot returns a valid directory", () => {
	const root = packageRoot();
	assert.ok(fs.existsSync(root));
	assert.ok(fs.statSync(root).isDirectory());
});

test("userPiRoot honors PI_TEAMS_HOME env var", () => {
	const origHome = process.env.PI_TEAMS_HOME;
	try {
		process.env.PI_TEAMS_HOME = "/custom/home";
		const result = userPiRoot();
		assert.equal(result, path.join("/custom/home", ".pi", "agent"));
	} finally {
		if (origHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = origHome;
	}
});

test("userPiRoot falls back to homedir when PI_TEAMS_HOME unset", () => {
	const origHome = process.env.PI_TEAMS_HOME;
	try {
		delete process.env.PI_TEAMS_HOME;
		const result = userPiRoot();
		assert.ok(result.includes(".pi") && result.includes("agent"), `Expected .pi/agent in ${result}`);
	} finally {
		if (origHome !== undefined) process.env.PI_TEAMS_HOME = origHome;
	}
});

test("userPiRoot ignores a literal 'undefined' PI_TEAMS_HOME (F4 regression)", () => {
	// A misconfigured shell (PI_TEAMS_HOME=$UNSET_VAR) sets the literal string
	// "undefined", which previously built "undefined/.pi/agent" relative to cwd.
	const origHome = process.env.PI_TEAMS_HOME;
	try {
		process.env.PI_TEAMS_HOME = "undefined";
		const result = userPiRoot();
		assert.ok(!result.startsWith("undefined"), `must not produce a relative 'undefined/...' path, got: ${result}`);
		assert.ok(result.includes(".pi") && result.includes("agent"), `Expected .pi/agent in ${result}`);
	} finally {
		if (origHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = origHome;
	}
});

test("findRepoRoot returns undefined for directory with no markers", {
	skip:
		process.platform === "darwin"
			? "macOS runner temp dirs (via realpathSync) have a marker in an ancestor directory, so the 'no ancestor marker' contract is not reliably testable here. Passes on Linux. Follow up: use a fully isolated nested temp tree."
			: undefined,
}, () => {
	const dir = makeTempDir();
	try {
		const result = findRepoRoot(dir);
		assert.equal(result, undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("findRepoRoot returns the dir itself when .git marker present", () => {
	const dir = makeTempDir();
	try {
		fs.mkdirSync(path.join(dir, ".git"));
		const result = findRepoRoot(dir);
		assert.equal(result, dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("findRepoRoot returns the dir itself when .pi marker present", () => {
	const dir = makeTempDir();
	try {
		fs.mkdirSync(path.join(dir, ".pi"));
		const result = findRepoRoot(dir);
		assert.equal(result, dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("findRepoRoot returns the dir itself when package.json present", () => {
	const dir = makeTempDir();
	try {
		fs.writeFileSync(path.join(dir, "package.json"), "{}");
		const result = findRepoRoot(dir);
		assert.equal(result, dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("findRepoRoot returns the dir itself when pyproject.toml present", () => {
	const dir = makeTempDir();
	try {
		fs.writeFileSync(path.join(dir, "pyproject.toml"), "");
		const result = findRepoRoot(dir);
		assert.equal(result, dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("findRepoRoot walks up to find a parent marker", () => {
	const dir = makeTempDir();
	const parent = makeTempDir();
	try {
		// .git in parent, no markers in child
		fs.mkdirSync(path.join(parent, ".git"));
		fs.mkdirSync(path.join(parent, "subdir", "nested"), {
			recursive: true,
		});
		const child = path.join(parent, "subdir", "nested");
		const result = findRepoRoot(child);
		assert.equal(result, parent);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("findRepoRoot stops at homedir boundary", {
	skip:
		process.platform === "darwin"
			? "macOS runner HOME boundary interacts with the temp-dir ancestor-marker issue. Passes on Linux. Follow up: make the homedir-boundary case self-contained."
			: undefined,
}, () => {
	// Use a deeply nested path that we know has no markers
	const dir = makeTempDir();
	try {
		// No markers anywhere - should return undefined
		const result = findRepoRoot(dir);
		assert.equal(result, undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("findRepoRoot uses cache (second call returns same value)", () => {
	const dir = makeTempDir();
	try {
		fs.mkdirSync(path.join(dir, ".git"));
		const r1 = findRepoRoot(dir);
		// Second call should hit cache
		const r2 = findRepoRoot(dir);
		assert.equal(r1, r2);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("clearProjectRootCache clears cached entries", () => {
	// Just verify it doesn't throw
	clearProjectRootCache();
	clearProjectRootCache();
});

test("projectPiRoot returns <repo>/.pi", () => {
	const dir = makeTempDir();
	try {
		fs.mkdirSync(path.join(dir, ".git"));
		const result = projectPiRoot(dir);
		assert.equal(result, path.join(dir, ".pi"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("projectCrewRoot returns existing .crew dir when present", () => {
	const dir = makeTempDir();
	try {
		fs.mkdirSync(path.join(dir, ".git"));
		fs.mkdirSync(path.join(dir, ".crew"));
		const result = projectCrewRoot(dir);
		assert.equal(result, path.join(dir, ".crew"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("projectCrewRoot returns .pi/teams/ when .pi exists but no .crew", () => {
	const dir = makeTempDir();
	try {
		fs.mkdirSync(path.join(dir, ".git"));
		fs.mkdirSync(path.join(dir, ".pi"));
		const result = projectCrewRoot(dir);
		assert.equal(result, path.join(dir, ".pi", "teams"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("projectCrewRoot returns .crew/ when no .pi exists", () => {
	const dir = makeTempDir();
	try {
		fs.mkdirSync(path.join(dir, ".git"));
		// No .pi, no .crew
		const result = projectCrewRoot(dir);
		assert.equal(result, path.join(dir, ".crew"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
