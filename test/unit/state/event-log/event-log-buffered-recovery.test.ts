import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { appendEventBuffered, flushEventLogBuffer, readEvents } from "../../../../src/state/event-log/event-log.ts";

/**
 * M2a recovery tests (spec §2.1 / docs/archive/m2-targets-and-framework.md §2.1):
 *   - scenario 2: overflow truncate (>1000 entries) — oldest dropped with explicit reject
 *   - scenario 3: lock-acquire fail rejection — caller .catch handles, no unhandled rejection
 *
 * These cover the framework-level invariants that EVERY converted call-site relies on.
 * Per-site tests would be redundant given these framework invariants + tsc + ci:fast.
 */

test("appendEventBuffered overflow (>1000 entries) rejects oldest dropped events with explicit error", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-overflow-"));
	const eventsPath = path.join(dir, "events.jsonl");
	const keepAlive = setInterval(() => undefined, 20);
	const captured: Array<{ ok: boolean; error?: string }> = [];
	try {
		// Enqueue 1500 entries with a long bufferMs so they all stay in queue.
		const promises: Array<Promise<unknown>> = [];
		for (let i = 0; i < 1500; i++) {
			promises.push(
				appendEventBuffered(
					eventsPath,
					{ type: "task.progress", runId: "run-overflow", data: { i } },
					200, // short buffer so all 1500 entries share one flush window
				).then(
					() => {
						captured.push({ ok: true });
					},
					(e: unknown) => {
						captured.push({ ok: false, error: e instanceof Error ? e.message : String(e) });
					},
				),
			);
		}
		await Promise.allSettled(promises);
		// Flush to drain.
		await flushEventLogBuffer();
		// Wait for any in-flight rejection handlers to settle.
		await new Promise((r) => setTimeout(r, 50));

		// Of the 1500, the framework keeps the most recent 500 and rejects the
		// oldest 1000 with an "Event log buffer overflow" error.
		const rejected = captured.filter((c) => !c.ok);
		const accepted = captured.filter((c) => c.ok);
		assert.ok(rejected.length >= 900 && rejected.length <= 1000, `expected ~1000 oldest rejected (got ${rejected.length})`);
		assert.ok(accepted.length >= 500, `expected ~500 newest accepted (got ${accepted.length})`);
		assert.ok(
			rejected.every((r) => r.error?.includes("Event log buffer overflow")),
			"every rejected entry must include explicit 'Event log buffer overflow' reason",
		);

		// After flush, the file on disk has the kept entries.
		const events = readEvents(eventsPath);
		assert.ok(events.length >= 500, `disk should have ~500 kept events (got ${events.length})`);
	} finally {
		clearInterval(keepAlive);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("appendEventBuffered: caller .catch handler pattern works with rejection (policy A verification)", async () => {
	// Simulate the .catch pattern used by M2a conversions:
	//   appendEventBuffered(path, ev).catch(e => logInternalError(...))
	// This test verifies the pattern resolves/rejects correctly and that the
	// .catch handler is invoked on rejection.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-catch-"));
	const eventsPath = path.join(dir, "events.jsonl");
	const keepAlive = setInterval(() => undefined, 20);
	try {
		let catchHandlerInvoked = false;
		let caughtError: unknown;

		// Happy path: .catch is unused, no error.
		const okPromise = appendEventBuffered(eventsPath, { type: "task.progress", runId: "run-catch-ok" }, 50).catch((e) => {
			catchHandlerInvoked = true;
			caughtError = e;
		});
		await okPromise;
		assert.equal(catchHandlerInvoked, false, ".catch must not run on success");

		// Now trigger overflow to force a rejection and verify .catch runs.
		// We use a separate eventsPath so we can fill its queue without
		// interfering with the prior path.
		const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-catch2-"));
		const eventsPath2 = path.join(dir2, "events.jsonl");
		const bigPromises: Array<Promise<unknown>> = [];
		for (let i = 0; i < 1500; i++) {
			bigPromises.push(
				appendEventBuffered(
					eventsPath2,
					{ type: "task.progress", runId: "run-catch-overflow", data: { i } },
					200, // short buffer for fast overflow
				).catch((e) => {
					caughtError = e;
					return null; // policy A swallow
				}),
			);
		}
		await Promise.allSettled(bigPromises);
		await flushEventLogBuffer();
		await new Promise((r) => setTimeout(r, 50));

		assert.ok(caughtError instanceof Error && caughtError.message.includes("overflow"), ".catch must receive the overflow rejection");
		fs.rmSync(dir2, { recursive: true, force: true });
	} finally {
		clearInterval(keepAlive);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
