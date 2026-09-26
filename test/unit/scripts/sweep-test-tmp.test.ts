import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
// @ts-expect-error TS7016 — scripts/sweep-test-tmp.mjs ships no .d.mts (dev-only
// script, same convention as test-runner.mjs in test-runner-exit.test.ts).
import { sweepStaleTestTmpdirs } from "../../../scripts/sweep-test-tmp.mjs";

/**
 * Post-suite tmp sweep (2026-09-26 zombie-noise root-cause): the runner calls
 * this after every suite to remove PRE-EXISTING `pi-crew-*` debris (older than
 * suite start − 30min). Young dirs and non-matching entries must never be
 * touched; a symlink named pi-crew-* must be skipped, not followed/removed.
 */

test("sweep removes only OLD pi-crew-* dirs; young + foreign + symlink survive", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-test-root-"));
	try {
		const now = Date.now();
		const oldDir = path.join(tmp, "pi-crew-old-debris");
		const youngDir = path.join(tmp, "pi-crew-young-live");
		const foreignDir = path.join(tmp, "other-old-dir");
		fs.mkdirSync(oldDir);
		fs.mkdirSync(youngDir);
		fs.mkdirSync(foreignDir);
		fs.utimesSync(oldDir, new Date(now - 3 * 60 * 60 * 1000), new Date(now - 3 * 60 * 60 * 1000));
		fs.utimesSync(foreignDir, new Date(now - 3 * 60 * 60 * 1000), new Date(now - 3 * 60 * 60 * 1000));
		// symlink named pi-crew-* → must be SKIPPED (never followed/removed)
		const target = path.join(tmp, "precious-target");
		fs.mkdirSync(target);
		fs.symlinkSync(target, path.join(tmp, "pi-crew-link"));
		fs.utimesSync(path.join(tmp, "pi-crew-link"), new Date(now - 3 * 60 * 60 * 1000), new Date(now - 3 * 60 * 60 * 1000));

		const out = sweepStaleTestTmpdirs({ tmpDir: tmp, thresholdMs: now - 30 * 60 * 1000 });
		assert.equal(out.removed, 1, `expected exactly the old debris removed, got ${JSON.stringify(out)}`);
		assert.ok(!fs.existsSync(oldDir), "old debris removed");
		assert.ok(fs.existsSync(youngDir), "young dir preserved");
		assert.ok(fs.existsSync(foreignDir), "non pi-crew-* dir preserved");
		assert.ok(fs.existsSync(path.join(tmp, "pi-crew-link")), "pi-crew-* SYMLINK skipped, not removed");
		assert.ok(fs.existsSync(target), "symlink target untouched");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("sweep on a missing tmpDir is a safe no-op", () => {
	const out = sweepStaleTestTmpdirs({ tmpDir: "/nonexistent-sweep-root", thresholdMs: Date.now() });
	assert.deepEqual(out, { removed: 0, skipped: 0, errors: 0 });
});
