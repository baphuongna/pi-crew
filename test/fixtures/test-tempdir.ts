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
	// On Windows, mkdtempSync may still return a short-name (8.3) path.
	// Resolve again to get the canonical long-name form.
	try { dir = fs.realpathSync.native(dir); if (dir.startsWith("\\\\?\\")) dir = dir.slice(4); } catch { /* keep as-is */ }
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
test.after(() => {
	for (const dir of tracked) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
	tracked.clear();
});

/** Resolve a temp directory to its canonical long-name path.
 *  Handles macOS /var → /private/var symlink and Windows
 *  RUNNER~1 → runneradmin short-name alias. */
export function resolveCanonicalDir(dir: string): string {
	try {
		const resolved = fs.realpathSync.native(dir);
		return resolved.startsWith("\\\\?\\") ? resolved.slice(4) : resolved;
	} catch {
		try { return fs.realpathSync(dir); } catch { return dir; }
	}
}
