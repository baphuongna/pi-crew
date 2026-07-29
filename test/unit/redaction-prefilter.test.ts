/**
 * P1-6 regression guard: redaction pre-filter.
 *
 * The pre-filter (mayContainSecret) skips the ~14 redaction passes when no
 * secret marker is present. It MUST be complete — a secret whose marker is
 * missing would bypass redaction entirely. This test asserts:
 *   1. clean strings are returned verbatim (the skip path), and
 *   2. EVERY known secret type is still redacted (no bypass).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecretString } from "../../src/utils/redaction.ts";

test("pre-filter: clean strings are returned verbatim (skip path)", () => {
	const clean = [
		"hello world",
		"a normal log line with no secrets",
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "sure, here is the answer" }] } }),
		"running task explore-1: reading files",
		"the quick brown fox jumps over the lazy dog",
	];
	for (const s of clean) {
		assert.equal(redactSecretString(s), s, `clean string should be unchanged: ${s.slice(0, 40)}`);
	}
});

test("pre-filter: PEM private key is redacted", () => {
	const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
	assert.notEqual(redactSecretString(pem), pem);
	assert.ok(!redactSecretString(pem).includes("MIIEpA"));
});

test("pre-filter: JWT is redacted", () => {
	const jwt = "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.SflKxwRJSMeKKF2QT4f";
	assert.ok(!redactSecretString(jwt).includes("eyJhbGciOiJIUzI1NiJ9"));
});

test("pre-filter: GitHub PAT is redacted", () => {
	const pat = "ghp_" + "a".repeat(36);
	assert.ok(!redactSecretString(pat).includes("ghp_"));
});

test("pre-filter: AWS access key is redacted", () => {
	const aws = "AKIA" + "IOSFODNN7EXAMPLE".slice(0, 16);
	assert.ok(!redactSecretString(aws).includes("AKIA"));
});

test("pre-filter: Slack token is redacted", () => {
	const slack = "xoxb-" + "1".repeat(24) + "-slack";
	assert.ok(!redactSecretString(slack).includes("xoxb-"));
});

test("pre-filter: Google API key is redacted", () => {
	const google = "AIza" + "a".repeat(35);
	assert.ok(!redactSecretString(google).includes("AIza"));
});

test("pre-filter: Stripe key is redacted", () => {
	const stripe = "sk_live_" + "1".repeat(24);
	assert.ok(!redactSecretString(stripe).includes("sk_live_"));
});

test("pre-filter: Bearer token is redacted", () => {
	const bearer = "Authorization: Bearer " + "x".repeat(40);
	assert.ok(!redactSecretString(bearer).includes("x".repeat(40)));
});

test("pre-filter: Authorization header (non-Bearer) is redacted", () => {
	const auth = "authorization: Basic dXNlcjpwYXNz";
	assert.ok(!redactSecretString(auth).includes("dXNlcjpwYXNz"));
});

test("pre-filter: inline secret (api_key=value) is redacted", () => {
	const inline = "config api_key=supersecretvalue123";
	assert.ok(!redactSecretString(inline).includes("supersecretvalue123"));
});

test("PERF GATE: large clean JSON skips the 14 passes quickly", () => {
	// A realistic large assistant-message JSON line with NO secret markers.
	const line =
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "x".repeat(64 * 1024) }],
			},
		}) + "\n";
	const t0 = performance.now();
	for (let i = 0; i < 200; i++) redactSecretString(line);
	const ms = performance.now() - t0;
	// 200 × 64KB clean lines through the pre-filter should be well under 500ms.
	// (Without the pre-filter each would run ~14 passes incl. case conversions +
	// char loops.) Generous threshold for CI jitter; a regression that disables
	// the skip would blow past it.
	assert.ok(ms < 500, `redact clean 64KB×200 took ${ms.toFixed(1)} ms (gate < 500)`);
});
