/**
 * FIND-02 tests — verify appendMailboxMessageAsync produces identical results
 * to the sync appendMailboxMessage, and that the event loop is NOT blocked
 * during the async append.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	appendMailboxMessage,
	appendMailboxMessageAsync,
	readDeliveryState,
	readMailbox,
} from "../../src/state/mailbox.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

function makeManifest(stateRoot: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "mailbox-async-test",
		team: "test-team",
		workflow: "test",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: os.tmpdir(),
		stateRoot,
		artifactsRoot: path.join(stateRoot, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	};
}

function setupWorkspace(suffix: string): { dir: string; manifest: TeamRunManifest } {
	const dir = createTrackedTempDir(`mailbox-async-${suffix}-`);
	const stateRoot = path.join(dir, "state", "runs", "mailbox-async-test");
	fs.mkdirSync(stateRoot, { recursive: true });
	return { dir, manifest: makeManifest(stateRoot) };
}

describe("appendMailboxMessageAsync produces identical results to sync", () => {
	it("same message id format, delivery state, and mailbox file content", async () => {
		const syncWs = setupWorkspace("sync");
		const asyncWs = setupWorkspace("async");
		try {
			// Use explicit ids so we can compare exact field equality.
			const syncMsg = appendMailboxMessage(syncWs.manifest, {
				id: "test-msg-001",
				direction: "inbox",
				from: "leader",
				to: "worker-1",
				body: "Hello from sync",
				kind: "message",
				priority: "normal",
			});
			const asyncMsg = await appendMailboxMessageAsync(asyncWs.manifest, {
				id: "test-msg-001",
				direction: "inbox",
				from: "leader",
				to: "worker-1",
				body: "Hello from sync",
				kind: "message",
				priority: "normal",
			});

			// Same id format (msg_ prefix for auto-generated, exact match for explicit).
			assert.equal(asyncMsg.id, syncMsg.id);
			assert.equal(asyncMsg.runId, syncMsg.runId);
			assert.equal(asyncMsg.direction, syncMsg.direction);
			assert.equal(asyncMsg.from, syncMsg.from);
			assert.equal(asyncMsg.to, syncMsg.to);
			assert.equal(asyncMsg.body, syncMsg.body);
			assert.equal(asyncMsg.status, syncMsg.status);
			assert.equal(asyncMsg.kind, syncMsg.kind);

			// Delivery state should be identical (same message id → same status).
			const syncDelivery = readDeliveryState(syncWs.manifest);
			const asyncDelivery = readDeliveryState(asyncWs.manifest);
			assert.deepEqual(asyncDelivery.messages, syncDelivery.messages);

			// Mailbox file content should have the same message line.
			const syncMessages = readMailbox(syncWs.manifest, "inbox");
			const asyncMessages = readMailbox(asyncWs.manifest, "inbox");
			assert.equal(asyncMessages.length, 1);
			assert.equal(asyncMessages[0].body, syncMessages[0].body);
			assert.equal(asyncMessages[0].from, syncMessages[0].from);
		} finally {
			removeTrackedTempDir(syncWs.dir);
			removeTrackedTempDir(asyncWs.dir);
		}
	});

	it("auto-generated id matches the msg_ format", async () => {
		const ws = setupWorkspace("idfmt");
		try {
			const msg = await appendMailboxMessageAsync(ws.manifest, {
				direction: "inbox",
				from: "a",
				to: "b",
				body: "test",
			});
			assert.match(msg.id, /^msg_[a-z0-9]+_[a-z0-9]+$/);
		} finally {
			removeTrackedTempDir(ws.dir);
		}
	});
});

describe("appendMailboxMessageAsync does not block the event loop", () => {
	it("a setImmediate callback resolves during the async append", async () => {
		const ws = setupWorkspace("eventloop");
		try {
			let immediateFired = false;
			const immediatePromise = new Promise<void>((resolve) => {
				setImmediate(() => {
					immediateFired = true;
					resolve();
				});
			});

			const appendPromise = appendMailboxMessageAsync(ws.manifest, {
				direction: "inbox",
				from: "leader",
				to: "worker",
				body: "Async message",
			});

			// Race the two: the immediate should fire before (or concurrently with)
			// the async append completes. If the event loop were blocked (sleepSync),
			// the immediate would NOT fire until after the append finishes.
			await Promise.race([immediatePromise, appendPromise]);
			assert.ok(immediateFired, "setImmediate should have fired — event loop was not blocked");
		} finally {
			removeTrackedTempDir(ws.dir);
		}
	});

	it("a setTimeout(0) callback resolves during concurrent async appends", async () => {
		const ws = setupWorkspace("timer");
		try {
			let timerFired = false;
			const timerPromise = new Promise<void>((resolve) => {
				setTimeout(() => {
					timerFired = true;
					resolve();
				}, 0);
			});

			// Fire multiple concurrent appends to exercise the promise-chain lock.
			const appends = await Promise.all([
				appendMailboxMessageAsync(ws.manifest, {
					direction: "inbox",
					from: "a",
					to: "b",
					body: "msg1",
				}),
				appendMailboxMessageAsync(ws.manifest, {
					direction: "inbox",
					from: "c",
					to: "d",
					body: "msg2",
				}),
				appendMailboxMessageAsync(ws.manifest, {
					direction: "inbox",
					from: "e",
					to: "f",
					body: "msg3",
				}),
			]);

			// Timer should fire while appends are in-flight (event loop not blocked).
			await timerPromise;
			assert.ok(timerFired, "setTimeout should have fired — event loop was not blocked");

			// All appends should have distinct ids.
			const ids = appends.map((m) => m.id);
			assert.equal(new Set(ids).size, 3);

			// Delivery state should reflect all 3 messages.
			const delivery = readDeliveryState(ws.manifest);
			for (const id of ids) {
				assert.equal(delivery.messages[id], "queued");
			}
		} finally {
			removeTrackedTempDir(ws.dir);
		}
	});
});

describe("concurrent appendMailboxMessageAsync do not lose delivery entries", () => {
	it("N concurrent async appends to the same run all appear in delivery state (R1 review fix)", async () => {
		const ws = setupWorkspace("concurrent-delivery");
		try {
			const N = 20;
			const appends = await Promise.all(
				Array.from({ length: N }, (_, i) =>
					appendMailboxMessageAsync(ws.manifest, {
						id: `concurrent-msg-${i.toString().padStart(3, "0")}`,
						direction: "inbox",
						from: "a",
						to: "b",
						body: `msg ${i}`,
					}),
				),
			);
			const ids = appends.map((m) => m.id);
			assert.equal(new Set(ids).size, N);
			const delivery = readDeliveryState(ws.manifest);
			for (const id of ids) {
				assert.equal(delivery.messages[id], "queued", `delivery entry missing for ${id}`);
			}
		} finally {
			removeTrackedTempDir(ws.dir);
		}
	});
});
