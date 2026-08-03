/**
 * Round 29 regression test — withFileLockSync re-entrance guard.
 *
 * Prior to this fix, withFileLockSync would self-deadlock when the same
 * call stack tried to acquire the same file lock twice (e.g.
 * registerWorker -> cleanupOrphanWorkers -> readRegistry on the same
 * registry file). The second acquisition would read its own freshly-
 * written lock file (same pid, fresh createdAt), fail the steal
 * check, and retry for the full staleMs window — hanging the file.
 *
 * See research-findings/round-29-file-level-test-hangs.md for the full
 * mechanism + strace evidence.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { withFileLockSync } from "../../src/state/coordination/locks.ts";

function mkTmp(): { dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "round29-reentrant-"));
	return {
		dir,
		cleanup: () => {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		},
	};
}

test("Round 29: nested withFileLockSync on the SAME path returns without deadlock", () => {
	const { dir, cleanup } = mkTmp();
	try {
		const target = path.join(dir, "registry.json");
		const result = withFileLockSync(
			target,
			() => {
				// Outer hold: re-entrant call on the SAME target path.
				// Before the fix this hung for staleMs (default 60s).
				return withFileLockSync(target, () => "inner-ok", {
					staleMs: 1000,
				});
			},
			{ staleMs: 1000 },
		);
		assert.equal(result, "inner-ok");
	} finally {
		cleanup();
	}
});

test("Round 29: deeply nested (3 levels) on the same path returns correctly", () => {
	const { dir, cleanup } = mkTmp();
	try {
		const target = path.join(dir, "deep.json");
		const innermost = withFileLockSync(target, () => "deep-ok", {
			staleMs: 1000,
		});
		const middle = withFileLockSync(target, () => innermost, {
			staleMs: 1000,
		});
		const result = withFileLockSync(target, () => middle, {
			staleMs: 1000,
		});
		assert.equal(result, "deep-ok");
	} finally {
		cleanup();
	}
});

test("Round 29: nested withFileLockSync on DIFFERENT paths returns without deadlock", () => {
	const { dir, cleanup } = mkTmp();
	try {
		const a = path.join(dir, "a.json");
		const b = path.join(dir, "b.json");
		const result = withFileLockSync(a, () => withFileLockSync(b, () => "cross-ok", { staleMs: 1000 }), { staleMs: 1000 });
		assert.equal(result, "cross-ok");
	} finally {
		cleanup();
	}
});

test("Round 29: after withFileLockSync returns, the lock file is released (subsequent acquisitions succeed)", () => {
	const { dir, cleanup } = mkTmp();
	try {
		const target = path.join(dir, "reacquire.json");
		withFileLockSync(target, () => "first", { staleMs: 1000 });
		// Second acquisition on same path after release — must succeed
		// (proves the re-entrance map entry was deleted in finally, so
		// the second call sees an empty map and acquires afresh).
		const second = withFileLockSync(target, () => "second", {
			staleMs: 1000,
		});
		assert.equal(second, "second");
	} finally {
		cleanup();
	}
});

test("Round 29: outer fn returning a value flows through the inner re-entrant call", () => {
	const { dir, cleanup } = mkTmp();
	try {
		const target = path.join(dir, "flow.json");
		const result = withFileLockSync(
			target,
			() => {
				const outer = "outer-value";
				const inner = withFileLockSync(target, () => `${outer} + inner`, { staleMs: 1000 });
				return inner;
			},
			{ staleMs: 1000 },
		);
		assert.equal(result, "outer-value + inner");
	} finally {
		cleanup();
	}
});
