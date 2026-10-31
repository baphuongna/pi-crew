import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	getPiSpawnCommand,
	resolveCommandOnPath,
	resolvePathFallbackCommand,
	validatePathResolvedPi,
} from "../../../../src/runtime/pi-spawn.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

test("getPiSpawnCommand preserves requested args", () => {
	const spec = getPiSpawnCommand(["--version"]);
	assert.ok(spec.command.length > 0);
	assert.ok(spec.args.includes("--version"));
});

test("PI_TEAMS_PI_BIN accepts symlink targets in npm-style lib/node_modules", async () => {
	// Skip on macOS/Windows in CI — symlink resolution via realpathSync.native
	// has environment-specific behavior in GitHub Actions macOS runners where
	// /var/folders is a symlink to /private/var/folders and the validation
	// path check may not match the npm_config_prefix.
	if (process.platform === "darwin" || (process.platform as string) === "win32") {
		return;
	}
	const previousBin = process.env.PI_TEAMS_PI_BIN;
	const previousPrefix = process.env.npm_config_prefix;
	const tempPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-prefix-"));
	const binDir = path.join(tempPrefix, "bin");
	const libDir = path.join(tempPrefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist");
	const targetScript = path.join(libDir, "cli.js");
	const shimPath = path.join(binDir, process.platform === "win32" ? "pi.cmd" : "pi");
	try {
		fs.mkdirSync(libDir, { recursive: true });
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(targetScript, "console.log('ok');\n", "utf-8");
		fs.symlinkSync(targetScript, shimPath);
		process.env.npm_config_prefix = tempPrefix;
		process.env.PI_TEAMS_PI_BIN = shimPath;
		const command = getPiSpawnCommand(["--version"]);
		assert.equal(command.command, shimPath);
		assert.deepEqual(command.args, ["--version"]);
	} finally {
		if (previousBin === undefined) delete process.env.PI_TEAMS_PI_BIN;
		else process.env.PI_TEAMS_PI_BIN = previousBin;
		if (previousPrefix === undefined) delete process.env.npm_config_prefix;
		else process.env.npm_config_prefix = previousPrefix;
		await removeDirWithRetry(tempPrefix);
	}
});

// ── S-4 (Wave G): bare-"pi" PATH fallback validation ──
// Before S-4, when resolvePiCliScript() missed, getPiSpawnCommand returned
// `{ command: "pi" }` and spawn() resolved that name against the INHERITED
// PATH with zero validation — any hijacked PATH entry would be executed with
// the worker env (which carries the inference-broker token). These tests pin
// the new contract via resolvePathFallbackCommand(): a PATH hit inside an
// allowed prefix is spawned by absolute path; an out-of-prefix (or
// out-of-prefix-symlink-target) hit THROWS so the worker is skipped loudly —
// the same UX as an invalid PI_TEAMS_PI_BIN (run-worker-cap.test.ts T-4).

interface FallbackEnvSnapshot {
	PATH?: string;
	npm_config_prefix?: string;
	NPM_CONFIG_PREFIX?: string;
}

function snapshotFallbackEnv(): FallbackEnvSnapshot {
	return {
		PATH: process.env.PATH,
		npm_config_prefix: process.env.npm_config_prefix,
		NPM_CONFIG_PREFIX: process.env.NPM_CONFIG_PREFIX,
	};
}

function restoreFallbackEnv(snap: FallbackEnvSnapshot): void {
	if (snap.PATH === undefined) delete process.env.PATH;
	else process.env.PATH = snap.PATH;
	if (snap.npm_config_prefix === undefined) delete process.env.npm_config_prefix;
	else process.env.npm_config_prefix = snap.npm_config_prefix;
	if (snap.NPM_CONFIG_PREFIX === undefined) delete process.env.NPM_CONFIG_PREFIX;
	else process.env.NPM_CONFIG_PREFIX = snap.NPM_CONFIG_PREFIX;
}

/** Write a fake executable `pi` into <dir>/bin and return its path. */
function writeFakePiOnPath(root: string, executable = true): string {
	const binDir = path.join(root, "bin");
	fs.mkdirSync(binDir, { recursive: true });
	const piPath = path.join(binDir, "pi");
	fs.writeFileSync(piPath, "#!/bin/sh\necho fake-pi\n", "utf-8");
	if (executable) fs.chmodSync(piPath, 0o755);
	return piPath;
}

test("S-4: PATH hit inside an allowed prefix is spawned by absolute path", async () => {
	if (process.platform === "win32") return; // chmod/symlink semantics
	const snap = snapshotFallbackEnv();
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-s4-prefix-"));
	try {
		const piPath = writeFakePiOnPath(tempRoot);
		// npm_config_prefix extends the allowlist (pi-spawn.ts reads both
		// spellings) — the hit now sits inside <prefix>/bin.
		process.env.npm_config_prefix = tempRoot;
		process.env.PATH = path.join(tempRoot, "bin");
		const spec = resolvePathFallbackCommand(["--version"]);
		assert.equal(spec.command, piPath, "validated hit must be spawned by absolute path");
		assert.deepEqual(spec.args, ["--version"]);
	} finally {
		restoreFallbackEnv(snap);
		await removeDirWithRetry(tempRoot);
	}
});

test("S-4: PATH hit outside every allowed prefix throws (skip + diagnostic)", async () => {
	if (process.platform === "win32") return; // chmod/X_OK semantics
	const snap = snapshotFallbackEnv();
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-s4-hijack-"));
	try {
		const piPath = writeFakePiOnPath(tempRoot);
		// No prefix env, PATH only has the hijacked dir (os.tmpdir, outside
		// every allowlist prefix).
		delete process.env.npm_config_prefix;
		delete process.env.NPM_CONFIG_PREFIX;
		process.env.PATH = path.join(tempRoot, "bin");
		assert.throws(
			() => resolvePathFallbackCommand(["--version"]),
			(e: Error) =>
				e.message.includes("outside allowed prefixes") &&
				e.message.includes(piPath) &&
				e.message.includes("Refusing to spawn an unvalidated PATH hit"),
			"an unvalidated PATH hit must throw a clear diagnostic instead of spawning",
		);
	} finally {
		restoreFallbackEnv(snap);
		await removeDirWithRetry(tempRoot);
	}
});

test("S-4: PATH hit whose symlink target is outside allowed prefixes throws", async () => {
	if (process.platform === "win32") return; // symlink creation needs privileges
	// Same guard as the PI_TEAMS_PI_BIN symlink test above for macOS CI
	// /var ↔ /private/var canonicalization quirks.
	if (process.platform === "darwin") return;
	const snap = snapshotFallbackEnv();
	const inPrefixRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-s4-linkin-"));
	const outOfPrefixRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-s4-linkout-"));
	try {
		// Real target lives in the OUT-of-prefix dir; the shim in the
		// IN-prefix dir is a symlink to it.
		const target = path.join(outOfPrefixRoot, "real-pi.js");
		fs.writeFileSync(target, "#!/bin/sh\necho hijacked\n", "utf-8");
		fs.chmodSync(target, 0o755);
		const binDir = path.join(inPrefixRoot, "bin");
		fs.mkdirSync(binDir, { recursive: true });
		const shim = path.join(binDir, "pi");
		fs.symlinkSync(target, shim);
		process.env.npm_config_prefix = inPrefixRoot;
		delete process.env.NPM_CONFIG_PREFIX;
		process.env.PATH = binDir;
		assert.throws(
			() => resolvePathFallbackCommand([]),
			(e: Error) => e.message.includes("symlink target") && e.message.includes("outside allowed prefixes"),
			"an in-prefix shim whose realpath lands outside the allowlist must throw",
		);
	} finally {
		restoreFallbackEnv(snap);
		await removeDirWithRetry(inPrefixRoot);
		await removeDirWithRetry(outOfPrefixRoot);
	}
});

test("S-4: no PATH hit keeps the legacy bare-'pi' command", async () => {
	const snap = snapshotFallbackEnv();
	try {
		process.env.PATH = ""; // which-equivalent finds nothing
		const spec = resolvePathFallbackCommand(["--version"]);
		assert.equal(spec.command, "pi");
		assert.deepEqual(spec.args, ["--version"]);
	} finally {
		restoreFallbackEnv(snap);
	}
});

test("S-4: resolveCommandOnPath scans PATH in order and requires an executable file", async () => {
	if (process.platform === "win32") return; // chmod/X_OK semantics
	const snap = snapshotFallbackEnv();
	const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-s4-scanA-"));
	const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-s4-scanB-"));
	try {
		// dirA has a NON-executable `pi` (must be skipped), dirB has the
		// executable one — first EXECUTABLE hit wins even though dirA is first.
		fs.writeFileSync(path.join(dirA, "pi"), "#!/bin/sh\n", "utf-8");
		fs.chmodSync(path.join(dirA, "pi"), 0o644);
		const hitB = path.join(dirB, "pi");
		fs.writeFileSync(hitB, "#!/bin/sh\n", "utf-8");
		fs.chmodSync(hitB, 0o755);
		// A directory named `pi` must never resolve as a command.
		fs.mkdirSync(path.join(dirB, "pi-dir"), { recursive: true });
		process.env.PATH = [dirA, dirB, path.join(dirB, "pi-dir")].join(path.delimiter);
		assert.equal(resolveCommandOnPath("pi"), hitB);
		// Unknown command → undefined.
		assert.equal(resolveCommandOnPath("pi-crew-no-such-command-xyz"), undefined);
	} finally {
		restoreFallbackEnv(snap);
		await removeDirWithRetry(dirA);
		await removeDirWithRetry(dirB);
	}
});

test("S-4 hardening: prefix-valid hit whose realpath probe fails THROWS — never degrades to bare 'pi'", async () => {
	if (process.platform === "win32") return; // symlink/chmod semantics
	const snap = snapshotFallbackEnv();
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-s4-realpath-"));
	try {
		// <prefix>/bin is an allowed prefix; both probes below sit INSIDE it.
		process.env.npm_config_prefix = tempRoot;
		delete process.env.NPM_CONFIG_PREFIX;
		const binDir = path.join(tempRoot, "bin");
		fs.mkdirSync(binDir, { recursive: true });
		// (1) TOCTOU/ENOENT: the hit vanished between PATH resolution and the
		// realpath probe — lexically prefix-valid, realpath fails for a
		// NON-prefix reason. The old contract returned undefined and the caller
		// fell back to the unvalidated bare "pi" (the exact S-4 primitive).
		const vanished = path.join(binDir, "pi-vanished");
		assert.throws(
			() => validatePathResolvedPi(vanished),
			(e: Error) =>
				e.message.includes("passed the prefix allowlist") &&
				e.message.includes("Refusing to degrade to the unvalidated bare-'pi' fallback"),
			"a found-and-prefix-valid hit must fail loudly, never silently degrade",
		);
		// (2) Symlink loop: the hit EXISTS but realpathSync cannot resolve it —
		// same loud-failure contract (ELOOP is not a prefix verdict).
		const loop = path.join(binDir, "pi-loop");
		fs.symlinkSync(loop, loop);
		assert.throws(
			() => validatePathResolvedPi(loop),
			(e: Error) => e.message.includes("Refusing to degrade to the unvalidated bare-'pi' fallback"),
			"an unresolvable realpath on a prefix-valid hit must throw, not return undefined",
		);
		// resolvePathFallbackCommand consequently NEVER spawns bare "pi" off a
		// prefix-valid-but-unresolvable hit: the no-hit path is the only one left
		// for the legacy command (pinned by the "no PATH hit" test above).
	} finally {
		restoreFallbackEnv(snap);
		await removeDirWithRetry(tempRoot);
	}
});
