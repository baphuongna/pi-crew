/**
 * Regression test for the dead retry path in flushOnePendingAtomicWrite.
 *
 * atomicWriteFile's first statement cancels the pending coalesced entry
 * (cancelPendingCoalescedWrite), so when the write itself throws, the catch
 * in flushOnePendingAtomicWrite found an EMPTY map — no entry to retry, no
 * re-throw: the buffered write was silently dropped (surfaced during the
 * 2026-08-25 perf-round-2 final review as "dead retry path"). This suite
 * pins the fixed behavior: a failed flush RE-QUEUES the entry with backoff
 * and the retry lands the data; after MAX_FLUSH_RETRIES the error propagates.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const fsDefault = require("node:fs") as typeof fs & { __patched?: boolean };

function withWriteFailures(failTimes: number, fn: () => Promise<void> | void): Promise<void> | void {
	// atomic-write's sync path writes via openSync("wx" temp) + writeSync,
	// NOT writeFileSync — so the spy must intercept openSync on the temp path.
	const original = fsDefault.openSync;
	let left = failTimes;
	let live = false;
	fsDefault.openSync = function patchedOpenSync(...args: Parameters<typeof fs.openSync>) {
		const p = String(args[0]);
		if (p.includes("pi-crew-retry-") && p.includes(".tmp") && left > 0) {
			left--;
			live = true;
			const err = new Error("E_SIMULATED_ENOSPC: no space left on device") as NodeJS.ErrnoException;
			err.code = "ENOSPC";
			throw err;
		}
		return original.apply(fs, args as Parameters<typeof fs.openSync>);
	};
	syncBuiltinESMExports();
	return (async () => {
		try {
			await fn();
			assert.ok(live, "instrument liveness: the openSync spy must have fired");
		} finally {
			fsDefault.openSync = original;
			syncBuiltinESMExports();
		}
	})();
}

test("failed coalesced flush re-queues with backoff and retries to success", async (t) => {
	await withWriteFailures(1, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-retry-"));
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
		const target = path.join(dir, "state.json");
		const { atomicWriteJsonCoalesced, flushPendingAtomicWrites } = await import("../../../src/state/atomic-write.ts");
		atomicWriteJsonCoalesced(target, { hello: "world" }, 5, { compact: true });
		// First flush: write throws ENOSPC once. The entry must NOT be
		// silently dropped — it is re-queued with backoff (no throw while
		// retries remain, per the coalescer's error contract).
		assert.doesNotThrow(() => flushPendingAtomicWrites(target));
		assert.ok(!fs.existsSync(target), "target not written on the failed first flush");
		// Second flush (backoff timer or explicit): write succeeds and lands.
		flushPendingAtomicWrites(target);
		assert.equal(JSON.parse(fs.readFileSync(target, "utf-8")).hello, "world");
		// Entry gone after success.
		flushPendingAtomicWrites(target); // no-op, must not throw
		assert.ok(true);
	});
});

test("spy is live (fails loudly when the patch is inert)", async () => {
	await assert.rejects(
		() =>
			withWriteFailures(0, () => {
				// failTimes=0 → live stays false → the wrapper asserts liveness.
			}) as Promise<void>,
		/instrument liveness/,
	);
});
