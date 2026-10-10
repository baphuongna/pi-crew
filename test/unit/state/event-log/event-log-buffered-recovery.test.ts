import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

/**
 * U2 (2026-10-10): graceful-shutdown durability — a SIGTERM arriving mid-run
 * (events still sitting in the 20ms buffer queue, well before their timer
 * fires) must NOT lose them. event-log.ts installs
 * process.on("SIGTERM", () => setImmediate(() => flushBufferedQueuesSync()))
 * at module load; this test proves that handler end-to-end in a REAL child
 * process, exercising the exact signal path production uses (not a direct
 * flushBufferedQueuesSync() call).
 *
 * Skipped on win32: TerminateProcess delivers no JS-visible SIGTERM, so the
 * handler contract is untestable there (same precedent as
 * event-log-r16-r17-regression.test.ts).
 */
const SIGTERM_CHILD_SRC = `
import * as fs from "node:fs";
const [moduleUrl, eventsPath, readyPath] = process.argv.slice(2);
const { appendEventBuffered } = await import(moduleUrl);
const N = 40;
for (let i = 0; i < N; i++) {
	// 60s buffer window: the queue is still full when SIGTERM lands — only the
	// signal handler's sync flush can persist these.
	void appendEventBuffered(eventsPath, { type: "task.progress", runId: "run-sigterm", taskId: "t1", data: { i } }, 60_000);
}
process.on("SIGTERM", () => {
	// event-log's own SIGTERM handler (registered at import) does
	// setImmediate(flushBufferedQueuesSync); give it loop turns, then exit.
	setTimeout(() => process.exit(0), 250);
});
fs.writeFileSync(readyPath, "ready");
setInterval(() => undefined, 50); // keep the loop alive (buffer timers are unref'd)
`;

test("U2: SIGTERM mid-run flushes buffered events — no loss on graceful shutdown", { skip: process.platform === "win32" }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-sigterm-"));
	const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-sigterm-src-"));
	const eventsPath = path.join(dir, "events.jsonl");
	const readyPath = path.join(dir, "ready");
	try {
		const moduleUrl = new URL("../../../../src/state/event-log/event-log.ts", import.meta.url).href;
		const tmpScript = path.join(scriptDir, "child.mjs");
		fs.writeFileSync(tmpScript, SIGTERM_CHILD_SRC);
		const child = spawn(
			process.execPath,
			["--experimental-strip-types", "--no-warnings", tmpScript, moduleUrl, eventsPath, readyPath],
			{
				stdio: "ignore",
			},
		);
		try {
			// Wait for the child to finish enqueueing its buffered events.
			const readyDeadline = Date.now() + 30_000;
			while (!fs.existsSync(readyPath)) {
				if (Date.now() > readyDeadline) throw new Error("child never became ready (30s)");
				if (child.exitCode !== null) throw new Error(`child exited early with code ${child.exitCode}`);
				await new Promise((r) => setTimeout(r, 50));
			}
			// Events must NOT be on disk yet (they sit in the 60s buffer window) —
			// proves the test really exercises the buffer, not a direct write.
			await new Promise((r) => setTimeout(r, 150));
			assert.ok(!fs.existsSync(eventsPath), "buffered events must not be flushed before SIGTERM");

			child.kill("SIGTERM");
			const exitDeadline = Date.now() + 30_000;
			while (child.exitCode === null) {
				if (Date.now() > exitDeadline) throw new Error("child never exited after SIGTERM (30s)");
				await new Promise((r) => setTimeout(r, 50));
			}
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
		}
		const events = readEvents(eventsPath);
		assert.equal(events.length, 40, `all 40 buffered events must survive SIGTERM (got ${events.length})`);
		assert.ok(events.every((e) => e.type === "task.progress" && e.runId === "run-sigterm"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(scriptDir, { recursive: true, force: true });
	}
});
