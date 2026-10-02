/**
 * crew-broker-request-parsers.test.ts — Table-driven unit tests for the
 * wire-protocol boundary parsers (src/runtime/broker/protocol/request-parsers.ts).
 *
 * Every parser here is the FIRST gate between the socket and the dispatcher:
 * a malformed frame must die at this boundary, never inside a handler. The
 * cases below pin the accept/reject surface per parser (valid, malformed
 * reject, boundary, adversarial), plus the §7-adjacent msg.send param shape
 * (sender binding is enforced downstream on conn.taskId — the parser only
 * guarantees the param object is structurally sound).
 *
 * Characterization notes:
 *  - isHelloParams guards exact-type protocol ("1" string rejected, non-
 *    integer rejected) but does NOT reject a DIFFERENT integer protocol
 *    number (e.g. 2) — the guard only forces number/integer when != 1.
 *    Pinned as-is (source of truth = current behavior); flagged in the G8
 *    report for the leader to review.
 *  - parseMsgSendParams accepts an EMPTY recipient array (Array.every on []
 *    is vacuously true). Pinned as-is; downstream recipient checks handle it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	BROKER_PROTOCOL,
	isHelloParams,
	isRequestObject,
	parseMsgInboxParams,
	parseMsgSendParams,
	parseWaitRequestParams,
	parseWaitResolveParams,
	safeStringify,
	WAIT_OPTION_MAX_CHARS,
	WAIT_OPTIONS_MAX,
	WAIT_QUESTION_MAX_CHARS,
	WAIT_REQUEST_TIMEOUT_SEC_DEFAULT,
	WAIT_REQUEST_TIMEOUT_SEC_MAX,
} from "../../../../src/runtime/broker/protocol/request-parsers.ts";

// ---------------------------------------------------------------------------
// Protocol constant pins
// ---------------------------------------------------------------------------

test("BROKER_PROTOCOL is 1 and wait limits are pinned (ADR-0 P2-7 / F2)", () => {
	assert.equal(BROKER_PROTOCOL, 1);
	assert.equal(WAIT_REQUEST_TIMEOUT_SEC_MAX, 3600, "server-side ceiling: 1h (ADR P2-7)");
	assert.equal(WAIT_REQUEST_TIMEOUT_SEC_DEFAULT, 480, "default stays strictly below the 600s response watchdog (F2)");
	assert.equal(WAIT_QUESTION_MAX_CHARS, 8192);
	assert.equal(WAIT_OPTIONS_MAX, 16);
	assert.equal(WAIT_OPTION_MAX_CHARS, 256);
});

// ---------------------------------------------------------------------------
// isRequestObject — request framing type guard
// ---------------------------------------------------------------------------

test("isRequestObject accepts a well-formed request frame", () => {
	assert.equal(isRequestObject({ id: "req-1", method: "msg.send", params: { to: "all" } }), true);
	assert.equal(
		isRequestObject({ id: "x".repeat(256), method: "m".repeat(64), params: undefined }),
		true,
		"params key present, value may be anything",
	);
});

test("isRequestObject rejects non-object and array shapes (adversarial)", () => {
	for (const bad of [undefined, null, 42, "request", true, [], [{ id: "a", method: "b", params: 1 }]]) {
		assert.equal(isRequestObject(bad), false, `must reject ${JSON.stringify(bad) ?? String(bad)}`);
	}
});

test("isRequestObject rejects malformed id / method / params shapes", () => {
	const base = { method: "ping", params: {} };
	for (const c of [
		{ name: "missing id", value: { ...base } },
		{ name: "empty id", value: { ...base, id: "" } },
		{ name: "non-string id", value: { ...base, id: 7 } },
		{ name: "oversize id (257)", value: { ...base, id: "x".repeat(257) } },
		{ name: "missing method", value: { id: "a", params: {} } },
		{ name: "empty method", value: { id: "a", method: "", params: {} } },
		{ name: "non-string method", value: { id: "a", method: 42, params: {} } },
		{ name: "method too long (65)", value: { id: "a", method: "m".repeat(65), params: {} } },
		{ name: "method starts with digit", value: { id: "a", method: "9ping", params: {} } },
		{ name: "method starts with dot", value: { id: "a", method: ".ping", params: {} } },
		{ name: "method has space", value: { id: "a", method: "msg send", params: {} } },
		{ name: "method has control char", value: { id: "a", method: "msg\tsend", params: {} } },
		{ name: "method has unicode", value: { id: "a", method: "msg.sänd", params: {} } },
		{ name: "method has dollar", value: { id: "a", method: "msg$send", params: {} } },
		{ name: "missing params key", value: { id: "a", method: "ping" } },
	]) {
		assert.equal(isRequestObject(c.value), false, `must reject: ${c.name}`);
	}
});

test("isRequestObject method charset boundary: 64 chars ok, dash/dot/underscore ok", () => {
	assert.equal(isRequestObject({ id: "a", method: "a".repeat(64), params: {} }), true);
	assert.equal(isRequestObject({ id: "a", method: "wait_request.resolve-v2", params: {} }), true);
	assert.equal(isRequestObject({ id: "a", method: "Z9._-", params: {} }), true);
});

// ---------------------------------------------------------------------------
// isHelloParams — handshake frame guard
// ---------------------------------------------------------------------------

test("isHelloParams accepts a valid hello with protocol 1 (role optional)", () => {
	assert.equal(isHelloParams({ protocol: 1, runId: "run-1", taskId: "task-1", token: "tok" }), true, "role is optional metadata");
	assert.equal(isHelloParams({ protocol: 1, runId: "run-1", taskId: "task-1", token: "tok", role: "worker" }), true);
});

test("isHelloParams enforces exact-type protocol (adversarial coercion attempts)", () => {
	const base = { runId: "run-1", taskId: "task-1", token: "tok" };
	assert.equal(isHelloParams({ ...base, protocol: "1" }), false, 'string "1" must not equal the number 1');
	assert.equal(isHelloParams({ ...base, protocol: 1.5 }), false, "non-integer number rejected");
	assert.equal(isHelloParams({ ...base, protocol: true }), false, "boolean coerced to 1 must be rejected");
	assert.equal(isHelloParams({ ...base, protocol: null }), false);
});

test("isHelloParams CHARACTERIZATION: a different integer protocol passes the guard", () => {
	// The guard only forces number/integer when protocol !== 1; an integer
	// protocol like 2 falls through and the frame validates. Current source
	// behavior — pinned so a future tightening is a deliberate, visible change.
	assert.equal(isHelloParams({ protocol: 2, runId: "r", taskId: "t", token: "k" }), true);
});

test("isHelloParams rejects malformed runId/taskId/token (boundary + malformed)", () => {
	const base = { protocol: 1, runId: "run-1", taskId: "task-1", token: "tok" };
	for (const c of [
		{ name: "missing runId", value: { ...base, runId: undefined } },
		{ name: "empty runId", value: { ...base, runId: "" } },
		{ name: "oversize runId", value: { ...base, runId: "r".repeat(257) } },
		{ name: "non-string runId", value: { ...base, runId: 1 } },
		{ name: "empty taskId", value: { ...base, taskId: "" } },
		{ name: "oversize taskId", value: { ...base, taskId: "t".repeat(257) } },
		{ name: "empty token", value: { ...base, token: "" } },
		{ name: "oversize token", value: { ...base, token: "k".repeat(257) } },
		{ name: "array frame", value: [1, "run-1", "task-1", "tok"] },
		{ name: "null", value: null },
	]) {
		assert.equal(isHelloParams(c.value), false, `must reject: ${c.name}`);
	}
});

// ---------------------------------------------------------------------------
// parseMsgSendParams — §7 #4 surface (worker msg.send sender-binding)
// ---------------------------------------------------------------------------

test("parseMsgSendParams accepts valid shapes across every kind/priority", () => {
	const kinds = ["message", "notify", "steer", "follow-up", "response", "group_join"] as const;
	for (const kind of kinds) {
		const parsed = parseMsgSendParams({ to: "task-1", body: "hi", kind });
		assert.ok(parsed, `kind=${kind} must parse`);
		assert.equal(parsed.kind, kind);
	}
	for (const priority of ["urgent", "normal", "low"] as const) {
		const parsed = parseMsgSendParams({ to: "all", body: 0, priority });
		assert.ok(parsed);
		assert.equal(parsed.priority, priority);
	}
	const full = parseMsgSendParams({
		to: ["a", "b"],
		body: { deep: true },
		kind: "notify",
		priority: "low",
		replyTo: "msg_1",
		subject: "s",
	});
	assert.ok(full);
	assert.deepEqual(full.to, ["a", "b"]);
	assert.deepEqual(full.body, { deep: true });
	assert.equal(full.replyTo, "msg_1");
	assert.equal(full.subject, "s");
	// body may be falsy — only `undefined` body is rejected.
	const nullBody = parseMsgSendParams({ to: "x", body: null });
	assert.ok(nullBody);
	assert.equal(nullBody.body, null);
});

test("parseMsgSendParams rejects malformed frames at the boundary", () => {
	for (const c of [
		{ name: "non-object", value: "nope" },
		{ name: "array", value: [{ to: "x", body: 1 }] },
		{ name: "missing to", value: { body: 1 } },
		{ name: "to wrong type", value: { to: 42, body: 1 } },
		{ name: "to empty string", value: { to: "", body: 1 } },
		{ name: "to array with empty element", value: { to: ["a", ""], body: 1 } },
		{ name: "to array with non-string", value: { to: ["a", 7], body: 1 } },
		{ name: "undefined body", value: { to: "x" } },
		{ name: "unknown kind", value: { to: "x", body: 1, kind: "shout" } },
		{ name: "kind wrong type", value: { to: "x", body: 1, kind: 3 } },
		{ name: "unknown priority", value: { to: "x", body: 1, priority: "asap" } },
	]) {
		assert.equal(parseMsgSendParams(c.value), undefined, `must reject: ${c.name}`);
	}
});

test("parseMsgSendParams subject/replyTo coercion boundaries", () => {
	// subject kept at exactly 256, silently dropped at 257 / empty / wrong type.
	assert.equal(parseMsgSendParams({ to: "x", body: 1, subject: "s".repeat(256) })?.subject, "s".repeat(256));
	assert.equal(parseMsgSendParams({ to: "x", body: 1, subject: "s".repeat(257) })?.subject, undefined);
	assert.equal(parseMsgSendParams({ to: "x", body: 1, subject: "" })?.subject, undefined);
	assert.equal(parseMsgSendParams({ to: "x", body: 1, subject: 42 })?.subject, undefined);
	// replyTo only survives as a string.
	assert.equal(parseMsgSendParams({ to: "x", body: 1, replyTo: 42 })?.replyTo, undefined);
	// CHARACTERIZATION: empty recipient array is vacuously valid (every() on []).
	const emptyList = parseMsgSendParams({ to: [], body: 1 });
	assert.ok(emptyList);
	assert.deepEqual(emptyList.to, []);
});

// ---------------------------------------------------------------------------
// parseMsgInboxParams — pagination params
// ---------------------------------------------------------------------------

test("parseMsgInboxParams defaults when params are absent", () => {
	assert.deepEqual(parseMsgInboxParams(undefined), { limit: 100, cursor: undefined });
	assert.deepEqual(parseMsgInboxParams(null), { limit: 100, cursor: undefined });
});

test("parseMsgInboxParams accepts valid pagination shapes", () => {
	assert.deepEqual(parseMsgInboxParams({}), { limit: undefined, cursor: undefined });
	assert.deepEqual(parseMsgInboxParams({ limit: 1 }), { limit: 1, cursor: undefined });
	assert.deepEqual(
		parseMsgInboxParams({ limit: 100000 }),
		{ limit: 100000, cursor: undefined },
		"no parser-side upper bound (handler clamps to 1000)",
	);
	assert.deepEqual(parseMsgInboxParams({ cursor: "42" }), { limit: undefined, cursor: "42" });
	assert.deepEqual(parseMsgInboxParams({ cursor: "" }), { limit: undefined, cursor: "" });
	assert.deepEqual(parseMsgInboxParams({ limit: 2, cursor: "7" }), { limit: 2, cursor: "7" });
	// CHARACTERIZATION: finite floats >= 1 pass the parser (no isInteger
	// check); slice() truncates downstream. Non-finite values are rejected.
	assert.deepEqual(parseMsgInboxParams({ limit: 2.5 }), { limit: 2.5, cursor: undefined });
});

test("parseMsgInboxParams rejects malformed limit/cursor", () => {
	for (const c of [
		{ name: "array", value: [] },
		{ name: "string params", value: "limit=5" },
		{ name: "limit 0", value: { limit: 0 } },
		{ name: "limit negative", value: { limit: -1 } },
		{ name: "limit string", value: { limit: "10" } },
		{ name: "limit NaN", value: { limit: Number.NaN } },
		{ name: "limit Infinity", value: { limit: Number.POSITIVE_INFINITY } },
		{ name: "cursor number", value: { cursor: 42 } },
		{ name: "cursor null", value: { cursor: null } },
	]) {
		assert.equal(parseMsgInboxParams(c.value), undefined, `must reject: ${c.name}`);
	}
});

// ---------------------------------------------------------------------------
// parseWaitRequestParams — ask/wait surface bounds (WP-2/R2)
// ---------------------------------------------------------------------------

test("parseWaitRequestParams accepts a minimal and a maximal valid ask", () => {
	assert.deepEqual(parseWaitRequestParams({ to: "leader", question: "proceed?" }), {
		to: "leader",
		question: "proceed?",
		options: undefined,
		timeoutSec: undefined,
	});
	const maximal = parseWaitRequestParams({
		to: "t".repeat(256),
		question: "q".repeat(WAIT_QUESTION_MAX_CHARS),
		options: Array.from({ length: WAIT_OPTIONS_MAX }, () => "o".repeat(WAIT_OPTION_MAX_CHARS)),
		timeoutSec: WAIT_REQUEST_TIMEOUT_SEC_MAX,
	});
	assert.ok(maximal);
	assert.equal(maximal.options?.length, WAIT_OPTIONS_MAX);
	assert.equal(maximal.timeoutSec, 3600);
});

test("parseWaitRequestParams rejects malformed to/question/options/timeoutSec", () => {
	for (const c of [
		{ name: "non-object", value: 42 },
		{ name: "missing to", value: { question: "q" } },
		{ name: "empty to", value: { to: "", question: "q" } },
		{ name: "oversize to", value: { to: "t".repeat(257), question: "q" } },
		{ name: "empty question", value: { to: "l", question: "" } },
		{ name: "question over cap", value: { to: "l", question: "q".repeat(WAIT_QUESTION_MAX_CHARS + 1) } },
		{ name: "non-string question", value: { to: "l", question: 9 } },
		{ name: "options not array", value: { to: "l", question: "q", options: "yes,no" } },
		{ name: "options empty array", value: { to: "l", question: "q", options: [] } },
		{ name: "options over cap", value: { to: "l", question: "q", options: Array.from({ length: WAIT_OPTIONS_MAX + 1 }, () => "y") } },
		{ name: "option empty", value: { to: "l", question: "q", options: ["yes", ""] } },
		{ name: "option over cap", value: { to: "l", question: "q", options: ["y".repeat(WAIT_OPTION_MAX_CHARS + 1)] } },
		{ name: "option non-string", value: { to: "l", question: "q", options: [1] } },
		{ name: "timeoutSec string", value: { to: "l", question: "q", timeoutSec: "30" } },
		{ name: "timeoutSec NaN", value: { to: "l", question: "q", timeoutSec: Number.NaN } },
		{ name: "timeoutSec Infinity", value: { to: "l", question: "q", timeoutSec: Number.POSITIVE_INFINITY } },
	]) {
		assert.equal(parseWaitRequestParams(c.value), undefined, `must reject: ${c.name}`);
	}
});

test("parseWaitRequestParams passes finite timeoutSec through (clamping is handler-side)", () => {
	// The parser only rejects non-finite values; the broker handler applies
	// deadline = now + min(timeoutSec, 3600) and floors non-positive to 1s.
	assert.equal(parseWaitRequestParams({ to: "l", question: "q", timeoutSec: 0 })?.timeoutSec, 0);
	assert.equal(parseWaitRequestParams({ to: "l", question: "q", timeoutSec: -5 })?.timeoutSec, -5);
	assert.equal(parseWaitRequestParams({ to: "l", question: "q", timeoutSec: 3601 })?.timeoutSec, 3601);
});

// ---------------------------------------------------------------------------
// parseWaitResolveParams
// ---------------------------------------------------------------------------

test("parseWaitResolveParams accepts valid shapes and rejects boundaries", () => {
	assert.deepEqual(parseWaitResolveParams({ to: "task-1", questionId: "q1" }), { to: "task-1", questionId: "q1" });
	assert.deepEqual(parseWaitResolveParams({ to: "t".repeat(256), questionId: "q".repeat(128) }), {
		to: "t".repeat(256),
		questionId: "q".repeat(128),
	});
	for (const c of [
		{ name: "non-object", value: "x" },
		{ name: "empty to", value: { to: "", questionId: "q1" } },
		{ name: "oversize to", value: { to: "t".repeat(257), questionId: "q1" } },
		{ name: "missing questionId", value: { to: "l" } },
		{ name: "empty questionId", value: { to: "l", questionId: "" } },
		{ name: "oversize questionId", value: { to: "l", questionId: "q".repeat(129) } },
		{ name: "non-string questionId", value: { to: "l", questionId: 42 } },
	]) {
		assert.equal(parseWaitResolveParams(c.value), undefined, `must reject: ${c.name}`);
	}
});

// ---------------------------------------------------------------------------
// safeStringify — never throws
// ---------------------------------------------------------------------------

test("safeStringify never throws: circular / BigInt / undefined all yield {}", () => {
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	assert.equal(safeStringify(circular), "{}");
	assert.equal(safeStringify(10n), "{}");
	assert.equal(safeStringify(undefined), "{}");
	assert.equal(
		safeStringify(() => 1),
		"{}",
		"functions are not JSON-serializable",
	);
});

test("safeStringify encodes normal values verbatim", () => {
	assert.equal(safeStringify({ a: 1 }), '{"a":1}');
	assert.equal(safeStringify(null), "null");
	assert.equal(safeStringify([1, 2]), "[1,2]");
	assert.equal(safeStringify("plain"), '"plain"');
});
