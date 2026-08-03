import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { withEventLogLockSync } from "../../src/state/event-log/event-log.ts";

describe("event-log lock timeout is capped", () => {
	it("should throw quickly when lock is contended (injectable timeout)", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evlog-timeout-"));
		const eventsPath = path.join(tmpDir, "events.jsonl");
		const lockDir = `${eventsPath}.mkdirlock`;

		// Simulate an existing lock held by another (dead) process
		fs.mkdirSync(lockDir);
		// Write a PID that is alive (our own PID) so stale detection does NOT clean it
		fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid), "utf-8");

		// Round 19: inject a tiny timeout (50ms) instead of waiting the real 5s.
		// The test now runs in <100ms instead of >4s, exercising the same code path.
		const start = Date.now();
		assert.throws(
			() =>
				withEventLogLockSync(eventsPath, () => "unreachable", {
					timeoutMs: 50,
					staleMs: 60_000,
				}),
			/lock timeout/,
		);
		const elapsed = Date.now() - start;

		// Must not block for more than ~1s (50ms timeout + retries overhead)
		assert.ok(elapsed < 1000, `Expected < 1s but took ${elapsed}ms`);
		// Must have waited at least the injected timeout (40ms with retry granularity)
		assert.ok(elapsed >= 40, `Expected >= 40ms but took only ${elapsed}ms`);

		// Cleanup
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("should succeed when no lock contention", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evlog-nocontention-"));
		const eventsPath = path.join(tmpDir, "events.jsonl");

		const result = withEventLogLockSync(eventsPath, () => 42);
		assert.equal(result, 42);

		// Cleanup
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});
});
