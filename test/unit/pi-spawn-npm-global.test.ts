/**
 * Issue #33 — Windows `spawn pi ENOENT` fix: runtime `npm root -g` probe.
 *
 * On Windows, pi may live outside %APPDATA%\npm (nvm-windows / Volta / fnm put
 * the global node_modules elsewhere). The static %APPDATA%\npm paths in
 * resolvePiCliScript() miss those, and the bare-`"pi"` spawn fallback then
 * fails with ENOENT (spawn does not do PATHEXT resolution). The fix probes the
 * real npm global root at runtime via `npm root -g` (execSync DOES resolve
 * npm.cmd via PATHEXT), memoized once per process.
 *
 * These tests pin: (1) the probe returns a real path, (2) memoization, (3) the
 * pure dir-mapping helper, (4) the Issue-#33 scenario end-to-end (pi found
 * under a custom npm global root, NOT %APPDATA%\npm).
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getPiSpawnCommand,
	resolveNpmGlobalRoot,
	buildNpmGlobalPackageDirs,
	__setNpmGlobalRootForTest,
} from "../../src/runtime/pi-spawn.ts";

test("resolveNpmGlobalRoot returns an absolute path on a machine with npm", () => {
	// Force recompute so we test the live `npm root -g` path, not a prior cache.
	__setNpmGlobalRootForTest(undefined);
	const root = resolveNpmGlobalRoot();
	assert.ok(root, "expected npm root -g to resolve on this machine");
	assert.ok(path.isAbsolute(root), `expected absolute path, got ${root}`);
	assert.ok(fs.existsSync(root), `expected the dir to exist: ${root}`);
});

test("resolveNpmGlobalRoot is memoized (same value, no recompute observable)", () => {
	__setNpmGlobalRootForTest(undefined);
	const first = resolveNpmGlobalRoot();
	const second = resolveNpmGlobalRoot();
	// Same string (memo hit). On dev machines npm root -g is deterministic.
	assert.equal(second, first);
});

test("resolveNpmGlobalRoot recomputes after the test hook resets the cache", () => {
	// Seed the memo with a fake, then reset and recompute.
	__setNpmGlobalRootForTest("/fake/global/root");
	assert.equal(resolveNpmGlobalRoot(), "/fake/global/root");
	__setNpmGlobalRootForTest(undefined); // null → forces recompute
	const live = resolveNpmGlobalRoot();
	assert.notEqual(live, "/fake/global/root");
});

test("buildNpmGlobalPackageDirs maps a root to both scope package dirs", () => {
	const root = os.platform() === "win32" ? "C:\\Users\\x\\npm-global" : "/usr/local/lib/node_modules";
	const dirs = buildNpmGlobalPackageDirs(root);
	assert.equal(dirs.length, 2);
	// Each dir is <root>/<scope>/<name>.
	assert.ok(dirs.every((d) => d.startsWith(root)));
	assert.ok(
		dirs.some((d) => d.includes("@earendil-works") && d.includes("pi-coding-agent")),
		`expected @earendil-works scope, got ${dirs.join(", ")}`,
	);
	assert.ok(
		dirs.some((d) => d.includes("@mariozechner") && d.includes("pi-coding-agent")),
		`expected @mariozechner scope, got ${dirs.join(", ")}`,
	);
});

test("Issue #33: pi found under a custom npm global root (nvm/Volta/fnm layout), not %APPDATA%", () => {
	// Simulate pi installed in an npm global root that is NOT %APPDATA%\npm —
	// the exact scenario that produced `spawn pi ENOENT` on Windows.
	const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-npmglobal-"));
	const pkgDir = path.join(fakeRoot, "@earendil-works", "pi-coding-agent");
	const distDir = path.join(pkgDir, "dist");
	const cliJs = path.join(distDir, "cli.js");
	fs.mkdirSync(distDir, { recursive: true });
	fs.writeFileSync(
		path.join(pkgDir, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" } }),
		"utf-8",
	);
	fs.writeFileSync(cliJs, "#!/usr/bin/env node\nconsole.log('pi shim');\n", "utf-8");

	// Clear any explicit override so we exercise resolution, and inject the fake
	// global root so it is preferred over the real one.
	const prevBin = process.env.PI_TEAMS_PI_BIN;
	delete process.env.PI_TEAMS_PI_BIN;
	__setNpmGlobalRootForTest(fakeRoot);
	try {
		const spec = getPiSpawnCommand(["--print", "--no-extensions"]);
		// Resolved to node + the discovered cli.js (NOT a bare "pi").
		assert.equal(spec.command, process.execPath);
		assert.equal(spec.args[0], cliJs, "expected the custom-root cli.js to be resolved");
		assert.deepEqual(spec.args.slice(1), ["--print", "--no-extensions"]);
	} finally {
		if (prevBin === undefined) delete process.env.PI_TEAMS_PI_BIN;
		else process.env.PI_TEAMS_PI_BIN = prevBin;
		__setNpmGlobalRootForTest(undefined); // reset memo for other tests
		fs.rmSync(fakeRoot, { recursive: true, force: true });
	}
});

test("Issue #33: @mariozechner legacy scope also resolves via the global root", () => {
	const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-npmglobal-"));
	const pkgDir = path.join(fakeRoot, "@mariozechner", "pi-coding-agent");
	const distDir = path.join(pkgDir, "dist");
	const cliJs = path.join(distDir, "cli.js");
	fs.mkdirSync(distDir, { recursive: true });
	fs.writeFileSync(
		path.join(pkgDir, "package.json"),
		JSON.stringify({ name: "@mariozechner/pi-coding-agent", bin: { pi: "dist/cli.js" } }),
		"utf-8",
	);
	fs.writeFileSync(cliJs, "#!/usr/bin/env node\nconsole.log('pi shim');\n", "utf-8");

	const prevBin = process.env.PI_TEAMS_PI_BIN;
	delete process.env.PI_TEAMS_PI_BIN;
	__setNpmGlobalRootForTest(fakeRoot);
	try {
		const spec = getPiSpawnCommand(["--version"]);
		assert.equal(spec.command, process.execPath);
		assert.equal(spec.args[0], cliJs);
		assert.deepEqual(spec.args.slice(1), ["--version"]);
	} finally {
		if (prevBin === undefined) delete process.env.PI_TEAMS_PI_BIN;
		else process.env.PI_TEAMS_PI_BIN = prevBin;
		__setNpmGlobalRootForTest(undefined);
		fs.rmSync(fakeRoot, { recursive: true, force: true });
	}
});
