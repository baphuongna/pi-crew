/**
 * test-tempdir.ts — Auto-cleanup for test temporary directories.
 *
 * When tests timeout or crash, `finally {}` blocks don't run, leaving
 * orphaned /tmp/pi-crew-* directories with "running" manifests that
 * confuse the TUI dashboard.
 *
 * This module tracks all created temp dirs and cleans them up via
 * `test.after()`, which runs even after timeouts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const tracked = new Set<string>();

/** Create a temp dir that will be auto-cleaned after all tests. */
export function createTrackedTempDir(prefix: string): string {
	// On macOS, os.tmpdir() may return a symlinked path (e.g. /var/folders/.../T/)
	// that atomicWriteFile refuses to write through. Resolve to the real path.
	const realTmp = fs.realpathSync(os.tmpdir());
	let dir = fs.mkdtempSync(path.join(realTmp, prefix));
	// Resolve to long-name form on Windows via realpathSync.native
	try {
		const r = fs.realpathSync.native(dir);
		dir = r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		/* keep as-is */
	}
	// LEAK PREVENTION: create a `.git` marker dir so findRepoRoot(dir) succeeds,
	// making useProjectState(dir) → true. Without this, scopeBaseRoot falls back
	// to userCrewRoot() and any createRunManifest/writeRunFixture/createRunPaths
	// call writes run records into the EXTENSION-GLOBAL state dir
	// (~/.pi/agent/extensions/pi-crew/state/runs/) — the one the crew UI reads —
	// creating persistent "zombie agent" rows after every test run. A bare `.git`
	// directory is enough for findRepoRoot; a real `git init` is unnecessary here.
	try {
		fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	} catch {
		/* best-effort */
	}
	tracked.add(dir);
	return dir;
}

/** Clean up a tracked dir immediately (e.g. in finally block). */
export function removeTrackedTempDir(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
	tracked.delete(dir);
}

// Global cleanup: runs after ALL tests in the process, even on timeout.
// NOTE: under the full concurrent suite (`--test-concurrency` + `--test-force-exit`),
// this root `test.after()` hook does not always complete before the runner force-exits,
// leaking every createTrackedTempDir dir (the bulk of /tmp/pi-crew-* zombies).
// The `process.on('exit')` backstop below fires synchronously on process.exit()
// (which --test-force-exit triggers), guaranteeing cleanup. rmSync is sync-safe in 'exit'.
const _cleanupTracked = () => {
	for (const dir of tracked) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
	tracked.clear();
};
test.after(_cleanupTracked);
process.on("exit", _cleanupTracked);

/** Resolve a temp directory to its canonical long-name path.
 *  Handles macOS /var → /private/var symlink and Windows
 *  RUNNER~1 → runneradmin short-name alias. */
export function resolveCanonicalDir(dir: string): string {
	try {
		const resolved = fs.realpathSync.native(dir);
		return resolved.startsWith("\\\\?\\") ? resolved.slice(4) : resolved;
	} catch {
		try {
			return fs.realpathSync(dir);
		} catch {
			return dir;
		}
	}
}
