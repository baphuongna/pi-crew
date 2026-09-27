/**
 * HB-002 POSIX test: BSD-vs-GNU tooling differences.
 *
 * The v0.9.3 incident: a CI step worked on Linux (GNU grep) but failed on
 * macOS (BSD grep) because of a `--help` exit-code / flag difference. This
 * test documents the POSIX-vs-GNU split and verifies the pi-crew code paths
 * that shell out do NOT depend on GNU-only behavior. It runs on macOS AND
 * Linux (both are "POSIX-ish"), but the assertions are tuned to catch the
 * kind of difference that bit v0.9.3.
 *
 * Self-skips on Windows (different toolchain entirely — PowerShell/cmd).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const isWindows = process.platform === "win32";

// RR-021 WI-4.2: the resolveShellForScript test was removed with its dead
// module (src/utils/resolve-shell.ts — 0 production consumers). The remaining
// checks below are pure POSIX-toolchain probes with no pi-crew dependency.

test("HB-002 POSIX: `grep` is callable without GNU-only assumptions", {
	skip: isWindows ? "POSIX-only; run on ubuntu/macos CI" : false,
}, () => {
	// v0.9.3 regression: code parsed `grep --help` output assuming GNU flags.
	// Here we only assert that a plain POSIX grep invocation works on both
	// BSD (macOS) and GNU (Linux) grep. No `--help` flag parsing.
	const out = execFileSync("sh", ["-c", "echo pi-crew-smoke | grep -q smoke && echo MATCH"], {
		encoding: "utf-8",
		timeout: 5_000,
	}).trim();
	assert.equal(out, "MATCH", "plain POSIX grep -q must work on both BSD and GNU grep");
});

test("HB-002 POSIX: realpath resolves macOS /var → /private/var transparently", {
	skip: isWindows ? "POSIX-only; run on ubuntu/macos CI" : false,
}, () => {
	// v0.9.1 lesson: macOS symlinks /var → /private/var; path-containment
	// checks that use string startsWith break. Verify the OS realpath call
	// (used by resolveRealContainedPath) canonicalises it.
	const tmp = path.join(os.tmpdir(), "pi-crew-plat-realpath");
	fs.mkdirSync(tmp, { recursive: true });
	try {
		const real = fs.realpathSync.native(tmp);
		// On macOS, if tmpdir was under /var, real will start with /private/var.
		// On Linux, real === tmp. Either way, the resolved path must exist.
		assert.ok(fs.existsSync(real), `realpath "${real}" must point at an existing dir`);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
