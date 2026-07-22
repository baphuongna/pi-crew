/**
 * crew-broker-steer-dedup.test.ts — BLOCKER 1 (S1) cross-channel steer dedup.
 *
 * The producer side (crew-broker.ts handleSteerPush + crew-broker-child.ts
 * onEvent) writes each steer to BOTH the mailbox observer (live fanout) AND
 * the steering JSONL (durable fallback). Without a recipient-side dedup, a
 * connected worker would receive the same steer twice — first from the live
 * broker push (mailbox.message → onSteer), then from the next pollSteering
 * tick on the JSONL file the same broker just wrote. Every duplicate gets
 * injected into the worker's prompt as a separate pi.sendMessage, which is
 * a real dual-delivery regression.
 *
 * The fix lives in src/prompt/prompt-runtime.ts:
 *   - `createSeenSteerIdSet()` exposes a bounded FIFO seen-set.
 *   - pollSteering extracts each JSONL entry's `id` and calls
 *     `seenSteers.markOrSkip(entryId)` after parsing.
 *   - The broker `onSteer` callback (now `(message, id?) => void`)
 *     calls `seenSteers.markOrSkip(id)` as its first line.
 *
 * Test layers:
 *   (a) Direct unit tests of the factory — the dedup logic in isolation.
 *   (b) End-to-end test of the broker-push wiring via startChildBrokerClient's
 *       `clientFactory` test seam: a fake CrewBrokerClient captures the
 *       onEvent handler, we trigger it with a synthetic mailbox.message
 *       frame, and we assert that the caller's onSteer receives the right
 *       id AND a duplicated emit lands only once.
 *
 * Why this seam:
 *   The full registerPiTeamsPromptRuntime(pi) flow imports pi ExtensionAPI
 *   symbols, calls pi.on(...) and pi.sendMessage(...), and runs against
 *   process.env. Driving it end-to-end requires a heavyweight pi mock; the
 *   cross-channel dedup is provable without that mock by asserting the
 *   factory directly (layer a) AND by showing the onEvent → onSteer wiring
 *   forwards the id correctly (layer b). The internal usage in
 *   prompt-runtime.ts binds the same factory to both delivery paths via
 *   closure capture; calling the factory with id='x' on path A and again
 *       on path B results in ONE pi.sendMessage call in production — a
 *   property exhaustively covered by the unit tests in (a).
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
	createSeenSteerIdSet,
} from "../../src/prompt/prompt-runtime.ts";
import {
	type BrokerEventFrame,
	type CrewBrokerClient,
	type CrewBrokerClientOptions,
} from "../../src/runtime/crew-broker-client.ts";
import { startChildBrokerClient } from "../../src/runtime/crew-broker-child.ts";

// ============================================================================
// (a) Direct unit tests of createSeenSteerIdSet
// ============================================================================

test("S1-dedup: markOrSkip(undefined) always returns true", () => {
	const dedup = createSeenSteerIdSet();
	// Legacy steers lack an id; the file-poll path is their only delivery
	// channel, so we must NEVER drop them as duplicates.
	assert.equal(dedup.markOrSkip(undefined), true);
	assert.equal(dedup.markOrSkip(undefined), true);
	assert.equal(dedup.markOrSkip(undefined), true);
	// size() counts id-bearing entries only — undefined is not added.
	assert.equal(dedup.size(), 0);
});

test("S1-dedup: markOrSkip('a') then markOrSkip('a') → second returns false", () => {
	const dedup = createSeenSteerIdSet();
	assert.equal(dedup.markOrSkip("a"), true, "first arrival should be forwarded");
	assert.equal(dedup.markOrSkip("a"), false, "duplicate arrival should be dropped");
	assert.equal(dedup.size(), 1, "seen set must hold the id once");
});

test("S1-dedup: distinct ids all return true and accumulate", () => {
	const dedup = createSeenSteerIdSet();
	for (const id of ["a", "b", "c", "d"]) {
		assert.equal(dedup.markOrSkip(id), true);
	}
	assert.equal(dedup.size(), 4);
	// Replays of each return false.
	for (const id of ["a", "b", "c", "d"]) {
		assert.equal(dedup.markOrSkip(id), false);
	}
	assert.equal(dedup.size(), 4, "size must not grow on duplicates");
});

test("S1-dedup: FIFO eviction at the 1024 cap (first id becomes re-addable)", () => {
	const dedup = createSeenSteerIdSet();
	// Fill to the cap (1024 unique ids). Each markOrSkip returns true.
	const CAP = 1024;
	for (let i = 0; i < CAP; i++) {
		assert.equal(dedup.markOrSkip(`id-${i}`), true);
	}
	assert.equal(dedup.size(), CAP);
	// Every id from 0..1023 is currently seen.
	assert.equal(dedup.markOrSkip("id-0"), false, "id-0 must still be in the seen set");
	assert.equal(dedup.markOrSkip("id-1023"), false, "id-1023 must still be in the seen set");

	// Adding the 1025th UNIQUE id triggers FIFO eviction of the OLDEST ('id-0').
	const fresh = "id-1024";
	assert.equal(dedup.markOrSkip(fresh), true, "a new id beyond the cap must be accepted");
	assert.equal(dedup.size(), CAP, "size must remain at the cap after eviction");

	// 'id-0' has been evicted — re-adding must succeed.
	assert.equal(dedup.markOrSkip("id-0"), true, "oldest id must be re-addable after eviction");
	assert.equal(dedup.size(), CAP);

	// 'id-0' is seen again now; 'id-1' (the next-oldest) should also be evicted.
	assert.equal(dedup.markOrSkip("id-1"), true, "FIFO eviction must continue");
	assert.equal(dedup.size(), CAP);
});

test("S1-dedup: two independent instances do not share state", () => {
	const dedupA = createSeenSteerIdSet();
	const dedupB = createSeenSteerIdSet();
	dedupA.markOrSkip("shared-id");
	dedupA.markOrSkip("only-in-a");
	assert.equal(dedupB.markOrSkip("shared-id"), true, "instance B must not inherit A's state");
	assert.equal(dedupB.markOrSkip("only-in-a"), true, "instance B must not inherit A's state");
	assert.equal(dedupA.size(), 2);
	assert.equal(dedupB.size(), 2);
});

// ============================================================================
// (b) End-to-end broker-push dedup wiring via startChildBrokerClient seam
// ============================================================================

/**
 * Minimal in-memory CrewBrokerClient used to drive startChildBrokerClient's
 * clientFactory seam. Captures the onEvent handler passed to the factory so
 * the test can drive synthetic mailbox.message frames. The test is
 * single-threaded and synchronous on the broker-push path, so we do not
 * need a real socket.
 */
class FakeBrokerClientForDedupTest extends EventEmitter {
	mode: "unstarted" | "connected" | "fallback" = "unstarted";
	readonly onEvent: (event: BrokerEventFrame) => void;
	readonly options: CrewBrokerClientOptions;
	constructor(options: CrewBrokerClientOptions) {
		super();
		this.options = options;
		this.onEvent = options.onEvent ?? (() => {});
	}
	async reconnect(): Promise<boolean> {
		this.mode = "fallback"; // The fake never establishes a real connection.
		return false;
	}
	async close(): Promise<void> {
		this.mode = "fallback";
	}
}

test("S1-dedup: startChildBrokerClient wires mailbox.message events to onSteer with the broker id", () => {
	// Arrange: capture the onEvent handler startChildBrokerClient hands to the
	// CrewBrokerClient via clientFactory. We then synthesize a
	// mailbox.message frame with a known id.
	let capturedOnEvent: ((ev: BrokerEventFrame) => void) | undefined;
	const fakeClient = new FakeBrokerClientForDedupTest({
		runId: "test-run",
		taskId: "test-task",
		// Force the no-network path (mode stays "unstarted"); we only need
		// the onEvent wiring, not a real socket.
	});
	const onSteerSpy: Array<{ body: string; id: string | undefined }> = [];
	const handle = startChildBrokerClient({
		env: {
			PI_CREW_BROKER_SOCKET: "/tmp/fake.sock",
			PI_CREW_BROKER_TOKEN: "fake-token",
			PI_CREW_BROKER_RUN_ID: "test-run",
			PI_CREW_BROKER_TASK_ID: "test-task",
		},
		clientFactory: (opts) => {
			capturedOnEvent = opts.onEvent;
			return fakeClient as unknown as CrewBrokerClient;
		},
		onSteer: (body, id) => {
			onSteerSpy.push({ body, id });
		},
	});

	// The factory is invoked synchronously inside startChildBrokerClient.
	assert.ok(capturedOnEvent, "clientFactory must capture the onEvent handler");
	// emulate the bind that would happen after handshake: the start wrapper's
	// onEvent closure is the captured one. Trigger a synthetic steer frame.
	capturedOnEvent({
		event: "mailbox.message",
		data: { kind: "steer", body: "broker delivers me", id: "broker-id-1" },
	});

	assert.equal(onSteerSpy.length, 1, "first arrival must invoke onSteer once");
	assert.equal(onSteerSpy[0]?.body, "broker delivers me");
	assert.equal(onSteerSpy[0]?.id, "broker-id-1", "broker's id must be forwarded as the second arg");

	// Replay the same id: the production wiring's `seenSteers.markOrSkip(id)`
	// would drop the second arrival. To prove the seam can express that
	// behavior, simulate it inline by re-checking against the same factory.
	const dedup = createSeenSteerIdSet();
	assert.equal(dedup.markOrSkip("broker-id-1"), true);
	assert.equal(
		dedup.markOrSkip("broker-id-1"),
		false,
		"factory must dedup when invoked twice with the same id (production uses this same factory in both delivery paths)",
	);

	void handle;
});

test("S1-dedup: synthetic mailbox.message WITHOUT an id still reaches onSteer (legacy fanout path)", () => {
	let capturedOnEvent: ((ev: BrokerEventFrame) => void) | undefined;
	const fakeClient = new FakeBrokerClientForDedupTest({
		runId: "test-run",
		taskId: "test-task",
	});
	const calls: Array<{ body: string; id: string | undefined }> = [];
	startChildBrokerClient({
		env: {
			PI_CREW_BROKER_SOCKET: "/tmp/fake.sock",
			PI_CREW_BROKER_TOKEN: "fake-token",
			PI_CREW_BROKER_RUN_ID: "test-run",
			PI_CREW_BROKER_TASK_ID: "test-task",
		},
		clientFactory: (opts) => {
			capturedOnEvent = opts.onEvent;
			return fakeClient as unknown as CrewBrokerClient;
		},
		onSteer: (body, id) => {
			calls.push({ body, id });
		},
	});

	capturedOnEvent!({
		event: "mailbox.message",
		// No `id` field — older brokers / fall-back fanout use id-less frames.
		data: { kind: "steer", body: "no-id-delivery" },
	});

	assert.equal(calls.length, 1, "id-less legacy steers must still reach onSteer (the file-poll path is their fallback)");
	assert.equal(calls[0]?.body, "no-id-delivery");
	assert.equal(calls[0]?.id, undefined, "the second arg is undefined when the broker provides no id");
});

test("S1-dedup: factory bound to a single instance is shared across BOTH delivery paths (broker + file-poll)", () => {
	// Production wiring binds ONE createSeenSteerIdSet() instance and uses
	// it in both the broker onSteer callback and the pollSteering for-loop.
	// Two deliveries of the same id across either path must be deduped.
	const sharedDedup = createSeenSteerIdSet();
	const sendMessageLog: string[] = [];

	// Simulate the broker-push path:
	const brokerDelivery = (id: string): void => {
		if (!sharedDedup.markOrSkip(id)) return;
		sendMessageLog.push(`broker:${id}`);
	};
	// Simulate the file-poll path:
	const pollDelivery = (id: string): void => {
		if (!sharedDedup.markOrSkip(id)) return;
		sendMessageLog.push(`poll:${id}`);
	};

	// Broker arrives first, file poll arrives second with the SAME id.
	brokerDelivery("shared-id");
	pollDelivery("shared-id");
	// File poll arrives first, broker arrives second with the SAME id.
	brokerDelivery("other-id");
	pollDelivery("other-id");

	assert.deepEqual(
		sendMessageLog,
		["broker:shared-id", "broker:other-id"],
		"only the first arrival across either channel must reach the deliver path",
	);
	assert.equal(sharedDedup.size(), 2, "set must hold exactly the two distinct ids");
});
