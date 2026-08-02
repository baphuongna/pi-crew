/**
 * SEC-1 regression test: worker-emitted secrets embedded in lifecycle events
 * and error messages MUST be redacted.
 *
 * `redactStderrExcerpt` (src/runtime/child-pi/child-pi.ts) is the security boundary
 * between the in-memory raw stderr/stdout accumulators and any persisted
 * event/diagnostic log. The real runChildPi spawn error/timeout paths fire
 * these lifecycle events, but they are NOT reachable via PI_TEAMS_MOCK_CHILD_PI
 * (the mock returns before the spawn lifecycle handlers run). Therefore the
 * redaction boundary is tested directly here against real secret patterns.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { redactStderrExcerpt } from "../../src/runtime/child-pi/child-pi.ts";

// Real-shaped secrets matching the anchored patterns in redaction.ts.
const GITHUB_PAT = "ghp_" + "0123456789abcdefghijklmnopqrstuvwxyz"; // 36 chars after prefix
const AWS_KEY = "AKIA" + "0123456789ABCDEF"; // 16 chars after prefix
const JWT = "eyJhbGciOi.eyJzdWIiOi.bGciOiJSUzI1NiIsInR5c"; // eyJ.eyJ.<base64url>

test("SEC-1: redacts a GitHub PAT embedded in a stderr excerpt", () => {
	const stderr = `Worker error: authentication failed\nGITHUB_TOKEN=${GITHUB_PAT}\nstack trace...`;
	const out = redactStderrExcerpt(stderr, 2000);
	assert.ok(!out.includes(GITHUB_PAT), `plaintext GitHub PAT must NOT survive redaction; got: ${out}`);
	assert.ok(out.includes("***"), "redaction marker must be present");
});

test("SEC-1: redacts an AWS access key id embedded in a stderr excerpt", () => {
	const stderr = `config error: AWS_ACCESS_KEY_ID=${AWS_KEY} region=us-east-1`;
	const out = redactStderrExcerpt(stderr, 2000);
	assert.ok(!out.includes(AWS_KEY), `plaintext AWS key must NOT survive redaction; got: ${out}`);
});

test("SEC-1: redacts a JWT embedded in a stderr excerpt", () => {
	const stderr = `Auth middleware crashed decoding token: ${JWT}`;
	const out = redactStderrExcerpt(stderr, 2000);
	assert.ok(!out.includes(JWT), `plaintext JWT must NOT survive redaction; got: ${out}`);
});

test("SEC-1: redacts a Bearer token embedded in a stderr excerpt", () => {
	const stderr = `HTTP 401: Authorization: Bearer ${GITHUB_PAT}`;
	const out = redactStderrExcerpt(stderr, 2000);
	assert.ok(!out.includes(GITHUB_PAT), `plaintext bearer token must NOT survive redaction; got: ${out}`);
});

test("SEC-1: redacts multiple secret types in the same excerpt", () => {
	const stderr = `failed: pat=${GITHUB_PAT} aws=${AWS_KEY} jwt=${JWT}`;
	const out = redactStderrExcerpt(stderr, 2000);
	assert.ok(!out.includes(GITHUB_PAT) && !out.includes(AWS_KEY) && !out.includes(JWT), "all three secret types must be redacted");
});

test("SEC-1: preserves non-secret stderr content verbatim", () => {
	const stderr = "normal diagnostic line\nError: ENOENT no such file\n    at /src/index.ts:42:10";
	const out = redactStderrExcerpt(stderr, 2000);
	assert.equal(out, stderr, "non-secret content must pass through unchanged");
});

test("SEC-1: respects the maxChars slice (only the tail N chars are redacted/returned)", () => {
	// Build stderr longer than maxChars so only the tail slice is returned.
	const head = "HEAD_SECRET_do_not_expect=" + GITHUB_PAT + "\n"; // lands BEFORE the slice window
	const tail = "TAIL_ERROR=" + AWS_KEY + "\n"; // lands INSIDE the slice window
	// Repeat filler so the GitHub PAT in the head is pushed out of the tail window.
	const filler = "x".repeat(1100) + "\n";
	const stderr = head + filler + tail;
	const out = redactStderrExcerpt(stderr, 1000);
	// tail-window AWS key MUST be redacted
	assert.ok(!out.includes(AWS_KEY), "secret within the tail slice window must be redacted");
	// head-window GitHub PAT should not appear (sliced off) nor its plaintext leak
	assert.ok(!out.includes(GITHUB_PAT), "no plaintext secret may survive");
});

test("SEC-1: empty stderr produces empty excerpt (no crash)", () => {
	assert.equal(redactStderrExcerpt("", 1000), "");
});
