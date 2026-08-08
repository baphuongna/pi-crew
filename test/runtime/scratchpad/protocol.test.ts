/**
 * Scratchpad spike — protocol unit tests (pure, no subprocess).
 *
 * Covers the fd-3 line-delimited JSON envelope: every message is wrapped in
 * the `__rlm` envelope key, and when a nonce is supplied the envelope must
 * carry it. Authentication is load-bearing: a wrong (or missing) nonce must
 * decode to null so forged or foreign traffic is dropped, never parsed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	decodeMessage,
	ENVELOPE_KEY,
	encodeMessage,
	type GuestToHostMessage,
	type HostToGuestMessage,
	NONCE_ENV,
	PROTOCOL_FD,
} from "../../../src/runtime/scratchpad/protocol.ts";

test("protocol round-trips an envelope", () => {
	const message: GuestToHostMessage = { type: "pong", id: "abc-123" };
	const line = encodeMessage(message);
	assert.ok(line.endsWith("\n"), "transport is line-delimited");
	const decoded = decodeMessage<{ __rlm: number; type: string; id: string }>(line);
	assert.ok(decoded, "envelope must decode");
	assert.equal(decoded!.__rlm, 1, "envelope key is preserved");
	assert.equal(decoded!.type, "pong");
	assert.equal(decoded!.id, "abc-123");
});

test("protocol round-trips with a nonce", () => {
	const nonce = "deadbeefcafe";
	const message: HostToGuestMessage = { type: "run", cellId: "cell-1", code: "const x = 1;" };
	const line = encodeMessage(message, nonce);
	const decoded = decodeMessage<HostToGuestMessage>(line, nonce);
	assert.ok(decoded, "envelope with the right nonce must decode");
	assert.equal(decoded!.type, "run");
	assert.equal((decoded as { cellId: string }).cellId, "cell-1");
});

test("decodeMessage rejects a wrong nonce", () => {
	const line = encodeMessage({ type: "ping", id: "x" }, "right-nonce");
	assert.equal(decodeMessage(line, "wrong-nonce"), null);
});

test("decodeMessage rejects a missing nonce when one is required", () => {
	// Host always mints a nonce; a guest that fails to attach it is rejected.
	const line = encodeMessage({ type: "ping", id: "x" });
	assert.equal(decodeMessage(line, "required-nonce"), null);
});

test("decodeMessage rejects non-envelope traffic", () => {
	// Cell output that accidentally looks like JSON must never be parsed as
	// protocol traffic.
	assert.equal(decodeMessage('{"type":"ping","id":"x"}'), null);
	assert.equal(decodeMessage('{"__rlm":1}'), null); // missing type
});

test("decodeMessage rejects malformed JSON and garbage lines", () => {
	assert.equal(decodeMessage("not json at all"), null);
	assert.equal(decodeMessage(""), null);
	assert.equal(decodeMessage('{"__rlm":1,"type":"ping","id":"x"'), null); // truncated
});

test("protocol constants are exposed", () => {
	assert.equal(ENVELOPE_KEY, "__rlm");
	assert.equal(NONCE_ENV, "PI_RLM_NONCE");
	assert.equal(PROTOCOL_FD, 3);
});
