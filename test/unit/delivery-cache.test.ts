/**
 * FIND-01 tests — verify the in-process delivery cache in mailbox.ts:
 *  (a) rapid sequential appends correctness / cache hit
 *  (b) consecutive reads return same object reference (cache hit by identity)
 *  (c) external write + fs.utimesSync mtime bump triggers fresh read
 *  (d) cache reflects state after acknowledgeMailboxMessage
 *  (e) cache hit after write-then-read then read-again returns same reference
 *  (f) missing delivery file returns empty and does not throw
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { acknowledgeMailboxMessage, appendMailboxMessage, readDeliveryState } from "../../src/state/mailbox.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

function makeManifest(stateRoot: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "delivery-cache-test",
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
	const dir = createTrackedTempDir(`delivery-cache-${suffix}-`);
	const stateRoot = path.join(dir, "state", "runs", "delivery-cache-test");
	fs.mkdirSync(stateRoot, { recursive: true });
	return { dir, manifest: makeManifest(stateRoot) };
}

describe("FIND-01 delivery cache — rapid sequential appends", () => {
	it("all appended messages appear in delivery state after rapid sequential appends", () => {
		const { dir, manifest } = setupWorkspace("seq");
		try {
			const ids: string[] = [];
			for (let i = 0; i < 10; i++) {
				const msg = appendMailboxMessage(manifest, {
					id: `seq-msg-${i}`,
					direction: "inbox",
					from: "leader",
					to: "worker",
					body: `message ${i}`,
				});
				ids.push(msg.id);
			}
			const delivery = readDeliveryState(manifest);
			assert.equal(Object.keys(delivery.messages).length, 10);
			for (const id of ids) {
				assert.equal(delivery.messages[id], "queued");
			}
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("FIND-01 delivery cache — cache hit by identity", () => {
	it("consecutive reads return deep-equal state (cache hit, snapshot copy)", () => {
		const { dir, manifest } = setupWorkspace("identity");
		try {
			appendMailboxMessage(manifest, {
				id: "identity-msg-1",
				direction: "inbox",
				from: "leader",
				to: "worker",
				body: "cache identity test",
			});
			const first = readDeliveryState(manifest);
			const second = readDeliveryState(manifest);
			// R2 fix: cache hit returns a deep-equal snapshot COPY so callers
			// mutating the result cannot leak into the cached snapshot.
			assert.deepEqual(second, first);
			assert.ok(second.messages["identity-msg-1"]);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("read-then-write-then-read returns cached state on the second read", () => {
		const { dir, manifest } = setupWorkspace("rw");
		try {
			const msg = appendMailboxMessage(manifest, {
				id: "rw-msg-1",
				direction: "inbox",
				from: "leader",
				to: "worker",
				body: "first",
			});
			const afterWrite = readDeliveryState(manifest);
			assert.equal(afterWrite.messages[msg.id], "queued");

			// Second read with no external change → cache hit (deep-equal snapshot).
			const cachedRead = readDeliveryState(manifest);
			assert.deepEqual(cachedRead, afterWrite);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("FIND-01 delivery cache — mtime invalidation", () => {
	it("external write + fs.utimesSync mtime bump triggers a fresh read", () => {
		const { dir, manifest } = setupWorkspace("mtime");
		try {
			appendMailboxMessage(manifest, {
				id: "mtime-msg-1",
				direction: "inbox",
				from: "leader",
				to: "worker",
				body: "original",
			});
			const before = readDeliveryState(manifest);
			assert.ok(before.messages["mtime-msg-1"]);

			// Externally rewrite delivery.json with new content.
			const deliveryJsonPath = path.join(manifest.stateRoot, "mailbox", "delivery.json");
			assert.ok(fs.existsSync(deliveryJsonPath));
			const externalState = {
				messages: { "external-msg": "delivered" },
				updatedAt: new Date().toISOString(),
			};
			fs.writeFileSync(deliveryJsonPath, `${JSON.stringify(externalState, null, 2)}\n`, "utf-8");

			// Bump mtime into the future so the cache mtime check fails.
			const future = Math.floor(Date.now() / 1000) + 120;
			fs.utimesSync(deliveryJsonPath, future, future);

			const after = readDeliveryState(manifest);
			// Fresh read: new object with external content.
			assert.notStrictEqual(after, before);
			assert.ok(after.messages["external-msg"], "should contain externally-written message");
			assert.equal(after.messages["external-msg"], "delivered");
			assert.ok(!after.messages["mtime-msg-1"], "should not contain stale cached message");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("FIND-01 delivery cache — acknowledgeMailboxMessage", () => {
	it("cache reflects acknowledged state after acknowledgeMailboxMessage", () => {
		const { dir, manifest } = setupWorkspace("ack");
		try {
			const msg = appendMailboxMessage(manifest, {
				id: "ack-msg-1",
				direction: "inbox",
				from: "leader",
				to: "worker",
				body: "ack me",
			});
			const beforeAck = readDeliveryState(manifest);
			assert.equal(beforeAck.messages[msg.id], "queued");

			acknowledgeMailboxMessage(manifest, msg.id);

			const afterAck = readDeliveryState(manifest);
			assert.equal(afterAck.messages[msg.id], "acknowledged");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("FIND-01 delivery cache — missing file", () => {
	it("readDeliveryState on a missing delivery file returns empty state and does not throw", () => {
		const { dir, manifest } = setupWorkspace("missing");
		try {
			// No append yet → delivery.json does not exist.
			const state = readDeliveryState(manifest);
			assert.deepEqual(state.messages, {});
			assert.ok(state.updatedAt);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});
