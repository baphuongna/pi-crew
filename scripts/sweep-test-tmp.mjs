#!/usr/bin/env node
/**
 * Post-suite sweep of leaked test tmpdirs (the "zombie /tmp" source).
 *
 * Live root-cause (2026-09-26 battery): ~3.4k `/tmp/pi-crew-*` dirs accumulated
 * because unit tests mkdtemp workspaces (320 test files) and some die before
 * teardown (timeout / F05 fail-closed / races with detached runners) — leaving
 * dirs (often with never-terminal run manifests) that surfaced as health noise
 * (`running=144`, zombie workspaces). The product reconciler self-heals them
 * within hours once UNSTARVED, but each suite run leaks a fresh batch; this
 * sweep removes PRE-EXISTING debris right after a suite finishes so local /tmp
 * stays clean without touching 320 test files.
 *
 * Safety rules (deliberately conservative):
 * - only DIRECTORIES named `pi-crew-*` directly under the tmp root
 *   (lstat — a symlink is never followed or removed);
 * - only dirs whose mtime is older than `thresholdMs` — the runner passes
 *   `suiteStart − 30min`, so anything a CONCURRENT suite created or touched
 *   recently is never swept;
 * - best-effort: every removal is individually guarded; failures are counted
 *   and reported, never thrown;
 * - opt-out: `PI_CREW_TEST_NO_TMP_SWEEP=1`.
 */

import { lstatSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Remove `pi-crew-*` directories under `tmpDir` whose mtime is older than
 * `thresholdMs`. PURE-ish (only filesystem effects) + exported for unit tests.
 *
 * @returns {removed: number, skipped: number, errors: number}
 */
export function sweepStaleTestTmpdirs(options = {}) {
	const tmpDir = options.tmpDir ?? os.tmpdir();
	const thresholdMs = options.thresholdMs ?? Date.now() - 30 * 60 * 1000;
	let removed = 0;
	let skipped = 0;
	let errors = 0;
	let entries;
	try {
		entries = readdirSync(tmpDir, { withFileTypes: true });
	} catch {
		return { removed, skipped, errors };
	}
	for (const entry of entries) {
		if (!entry.name.startsWith("pi-crew-")) continue;
		const full = path.join(tmpDir, entry.name);
		try {
			// lstat (never follow): a symlink named pi-crew-* is skipped, not removed.
			const st = lstatSync(full);
			if (!st.isDirectory()) {
				skipped++;
				continue;
			}
			if (st.mtimeMs >= thresholdMs) {
				skipped++;
				continue;
			}
			rmSync(full, { recursive: true, force: true });
			removed++;
		} catch {
			errors++;
		}
	}
	return { removed, skipped, errors };
}

/** CLI form: `node scripts/sweep-test-tmp.mjs [ageMinutes]` (default 30). */
if (process.argv[1] && process.argv[1].endsWith("sweep-test-tmp.mjs")) {
	const ageMin = Number(process.argv[2] ?? 30);
	const out = sweepStaleTestTmpdirs({ thresholdMs: Date.now() - ageMin * 60 * 1000 });
	console.log(`[tmp-sweep] removed=${out.removed} skipped=${out.skipped} errors=${out.errors}`);
}
