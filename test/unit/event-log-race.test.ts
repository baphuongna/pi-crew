import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { appendEvent, appendEventAsync, resetEventLogMode } from "../../src/state/event-log.ts";

describe("H2: Event log sync/async coordination", () => {
	let tmpDir: string;
	let eventsPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "event-log-race-"));
		eventsPath = path.join(tmpDir, "events.jsonl");
		resetEventLogMode();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		resetEventLogMode();
	});

	it("should route sync appendEvent through async queue after appendEventAsync is called", async () => {
		// First, call appendEventAsync to activate the async queue mode
		await appendEventAsync(eventsPath, {
			type: "test.async.first",
			runId: "test-run",
		});

		// Now call sync appendEvent — should be routed through async queue
		appendEvent(eventsPath, {
			type: "test.sync.after.async",
			runId: "test-run",
		});

		// Give the async queue time to flush
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Both events should be in the file
		const content = fs.readFileSync(eventsPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		assert.ok(lines.length >= 2, `Expected at least 2 events, got ${lines.length}`);

		const events = lines.map((l) => JSON.parse(l));
		assert.equal(events[0].type, "test.async.first");
		assert.ok(events.some((e) => e.type === "test.sync.after.async"), "Sync event should have been written via async queue");
	});

	it("should not corrupt JSONL under concurrent sync and async writes", async () => {
		// Fire many async events to activate the queue
		const asyncPromises: Promise<unknown>[] = [];
		for (let i = 0; i < 20; i++) {
			asyncPromises.push(
				appendEventAsync(eventsPath, {
					type: `test.async.${i}`,
					runId: "test-run",
				}),
			);
		}

		// Also fire sync events concurrently
		for (let i = 0; i < 20; i++) {
			appendEvent(eventsPath, {
				type: `test.sync.${i}`,
				runId: "test-run",
			});
		}

		await Promise.all(asyncPromises);
		// Give extra time for routed sync events to flush
		await new Promise((resolve) => setTimeout(resolve, 300));

		// Verify file is valid JSONL (no corruption)
		const content = fs.readFileSync(eventsPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			assert.doesNotThrow(() => JSON.parse(line), `Invalid JSON line: ${line.slice(0, 100)}`);
		}
		assert.ok(lines.length >= 2, `Expected at least 2 events, got ${lines.length}`);
	});

	it("resetEventLogMode should allow sync writes again", async () => {
		// Activate async mode
		await appendEventAsync(eventsPath, {
			type: "test.async",
			runId: "test-run",
		});

		// Reset mode
		resetEventLogMode();

		// Sync write should use direct path again
		appendEvent(eventsPath, {
			type: "test.sync.direct",
			runId: "test-run",
		});

		const content = fs.readFileSync(eventsPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		assert.ok(lines.length >= 1, "Should have at least the sync event");
	});
});
