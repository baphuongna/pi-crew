/**
 * frame-client.test.ts — W7 (P2-3): strict-LF frame client against a fake
 * PassThrough RPC stream (no real pi spawn).
 *
 * Covers the packet's four test areas:
 *   1. framing (strict LF-only — U+2028 inside a JSON string must NOT split a
 *      frame; garbage/empty lines counted + dropped; torn final line at stream
 *      end still parsed; valid frame after garbage still matches),
 *   2. command matching (success, server error records, unknown ids, timeout),
 *   3. ui-request wiring (drain + dialog auto-answer reach the policy and the
 *      ui-response is written back on stdin),
 *   4. orderly shutdown (stdin end → exit → stop resolves, no kill) and the
 *      SIGKILL fallback (kill exactly once).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRpcFrameClient } from "../../../../src/runtime/rpc/frame-client.ts";
import { createFakeRpcServer, delay, type FakeRpcServer } from "./fake-rpc-stream.ts";

function makeClient(fake: FakeRpcServer, options: Parameters<typeof createRpcFrameClient>[0] = {}) {
	return createRpcFrameClient({
		spawnFn: () => fake.handle,
		commandTimeoutMs: 250,
		stopTimeoutMs: 120,
		...options,
	});
}

test("framing: strict LF-only — U+2028 inside a payload string stays ONE frame", async () => {
	const fake = createFakeRpcServer();
	const events: unknown[] = [];
	const client = makeClient(fake, { onEvent: (e) => events.push(e) });
	const pending = client.sendCommand({ type: "get_state" });
	// Response whose payload contains RAW U+2028 (readline would split here).
	fake.writeRaw(JSON.stringify({ id: "pi-crew-rpc-1", type: "response", command: "get_state", success: true, note: "a b" }));
	await delay(10);
	// Frame not terminated yet — must NOT have resolved, must NOT be malformed.
	let resolved = false;
	void pending.then(() => {
		resolved = true;
	});
	await delay(10);
	fake.writeRaw("\n");
	await pending;
	assert.ok(resolved);
	assert.equal(client.counters().malformedFrames, 0, "U+2028 must not be treated as a frame separator");
	assert.equal(client.counters().responsesMatched, 1);
	await client.stop();
	fake.exitWith(0);
});

test("framing: garbage + empty lines are counted and dropped; the next valid frame still matches", async () => {
	const fake = createFakeRpcServer();
	const client = makeClient(fake);
	const pending = client.sendCommand({ type: "abort" });
	fake.writeRaw("this is not json\n\n   \n");
	await delay(5);
	fake.emit({ id: "pi-crew-rpc-1", type: "response", command: "abort", success: true });
	await pending;
	const c = client.counters();
	assert.equal(c.malformedFrames, 3, "garbage + empty + whitespace-only lines");
	assert.equal(c.responsesMatched, 1, "client survives malformed frames");
	await client.stop();
	fake.exitWith(0);
});

test("framing: torn final line (complete JSON, missing trailing LF) is still parsed at stream end", async () => {
	const fake = createFakeRpcServer();
	const client = makeClient(fake);
	const pending = client.sendCommand({ type: "abort" });
	fake.writeRaw(JSON.stringify({ id: "pi-crew-rpc-1", type: "response", command: "abort", success: true }));
	fake.handle.stdout.destroy(); // abrupt cut right after a complete JSON object
	await pending;
	assert.equal(client.counters().malformedFrames, 0);
	await client.stop();
	fake.exitWith(0);
});

test("commands: server error record rejects with the server's message", async () => {
	const fake = createFakeRpcServer();
	const client = makeClient(fake);
	const pending = client.sendCommand({ type: "bash", command: "exit 3" });
	fake.emit({ id: "pi-crew-rpc-1", type: "response", command: "bash", success: false, error: "boom" });
	await assert.rejects(pending, /boom/);
	await client.stop();
	fake.exitWith(0);
});

test("commands: unknown response id is counted unmatched, pending still resolvable", async () => {
	const fake = createFakeRpcServer();
	const client = makeClient(fake);
	const pending = client.sendCommand({ type: "abort" });
	fake.emit({ id: "someone-elses-id", type: "response", command: "abort", success: true });
	await delay(5);
	assert.equal(client.counters().responsesUnmatched, 1);
	fake.emit({ id: "pi-crew-rpc-1", type: "response", command: "abort", success: true });
	await pending;
	assert.equal(client.counters().responsesMatched, 1);
	await client.stop();
	fake.exitWith(0);
});

test("commands: per-command timeout rejects and drops the pending entry", async () => {
	const fake = createFakeRpcServer();
	const client = makeClient(fake, { commandTimeoutMs: 30 });
	await assert.rejects(client.sendCommand({ type: "get_state" }), /timeout after 30ms/);
	// A late response for the dead id lands in unmatched, not a hang.
	fake.emit({ id: "pi-crew-rpc-1", type: "response", command: "get_state", success: true });
	await delay(5);
	assert.equal(client.counters().responsesUnmatched, 1);
	await client.stop();
	fake.exitWith(0);
});

test("ui wiring: fire-and-forget drained, dialog answered on stdin (cancel policy)", async () => {
	const fake = createFakeRpcServer();
	const client = makeClient(fake, { dialogPolicy: "cancel" });
	fake.emit({ type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "k", statusText: "t" });
	fake.emit({ type: "extension_ui_request", id: "d1", method: "confirm", title: "ok?", message: "m" });
	await delay(10);
	const c = client.counters();
	assert.equal(c.uiRequestsDrained, 1);
	assert.equal(c.dialogsCancelled, 1);
	const written = fake.writtenRecords();
	assert.deepEqual(written, [{ type: "extension_ui_response", id: "d1", cancelled: true }]);
	await client.stop();
	fake.exitWith(0);
});

test("ui wiring: block policy leaves the dialog pending (nothing on stdin)", async () => {
	const fake = createFakeRpcServer();
	const client = makeClient(fake, { dialogPolicy: "block" });
	fake.emit({ type: "extension_ui_request", id: "d1", method: "input", title: "t" });
	await delay(10);
	assert.equal(client.counters().dialogsBlocked, 1);
	assert.deepEqual(fake.writtenLines(), []);
	await client.stop();
	fake.exitWith(0);
});

test("events: non-response records are forwarded to onEvent", async () => {
	const fake = createFakeRpcServer();
	const events: unknown[] = [];
	const client = makeClient(fake, { onEvent: (e) => events.push(e) });
	fake.emit({ type: "message_start" });
	fake.emit({ type: "agent_settled" });
	fake.emit({ type: "extension_error", extensionPath: "x" });
	await delay(10);
	assert.deepEqual(
		events.map((e) => (e as { type: string }).type),
		["message_start", "agent_settled", "extension_error"],
	);
	await client.stop();
	fake.exitWith(0);
});

test("shutdown: orderly — stdin.end → server exits 0 → stop resolves, never kills", async () => {
	const fake = createFakeRpcServer();
	const client = makeClient(fake);
	fake.onStdinEnd = () => {
		// rpc-mode.js onInputEnd → shutdown → exit 0 (R2 live evidence).
		setTimeout(() => fake.exitWith(0), 5);
	};
	await client.stop();
	assert.equal(await client.exited(), 0);
	assert.deepEqual(fake.killSignals(), [], "orderly stop must not kill");
});

test("shutdown: server hangs → SIGKILL fallback fires exactly once, stop still resolves", async () => {
	const fake = createFakeRpcServer();
	const client = makeClient(fake, { stopTimeoutMs: 40 });
	fake.onStdinEnd = () => {
		// hang: never exit on stdin end
	};
	await client.stop();
	assert.deepEqual(fake.killSignals(), ["SIGKILL"], "kill exactly once after the stop timeout");
	assert.equal(await client.exited(), null);
});

test("stop is idempotent — a second stop() returns the same promise, no double kill", async () => {
	const fake = createFakeRpcServer();
	const client = makeClient(fake, { stopTimeoutMs: 40 });
	fake.onStdinEnd = () => {
		/* hang */
	};
	const first = client.stop();
	const second = client.stop();
	assert.equal(first, second);
	await first;
	assert.deepEqual(fake.killSignals(), ["SIGKILL"]);
});

test("pending commands are failed when the stream closes before their response", async () => {
	const fake = createFakeRpcServer();
	const client = makeClient(fake);
	const pending = client.sendCommand({ type: "get_state" });
	fake.handle.stdout.destroy();
	await assert.rejects(pending, /stdout closed|stdout error/);
	await client.stop();
	fake.exitWith(0);
});
