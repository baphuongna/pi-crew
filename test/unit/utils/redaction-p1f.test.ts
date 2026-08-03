/**
 * P1f redaction unit tests (RFC §P1f / §6 STRIDE).
 *
 * Covers the NEW structured-secret regexes added to redactSecretString:
 * JWT, GitHub PAT, AWS access key, PEM, Bearer — plus the optional OQ13 set
 * (Slack / Google / Stripe). Also asserts ReDoS-safety on pathological input
 * (linear time, no hang).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactSecretString } from "../../../src/utils/redaction.ts";

// Realistic-shaped (non-sensitive) sample tokens for each pattern class.
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const GITHUB_PAT = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789"; // 36 chars
const GITHUB_FINEGRAINED = "gho_" + "abcdefghijklmnopqrstuvwxyz0123456789";
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE"; // AKIA + 16 uppercase alnum (canonical AWS example)
const SLACK = "xoxb-" + "1234567890123-1234567890123-1234567890123456789012";
const GOOGLE = "AIza" + "SyA1234567890_-abcdefghijklmnopqrst"; // AIza + 35
const STRIPE = "sk_live_" + "0123456789abcdefghijklmn"; // sk_live_ + 24

describe("P1f redaction — structured secret tokens", () => {
	it("redacts a bare JWT", () => {
		const out = redactSecretString(`token=${JWT} done`);
		assert.ok(!out.includes(JWT), "JWT must be removed");
		assert.ok(out.includes("***"), "redaction marker present");
		assert.ok(out.includes("done"), "surrounding text preserved");
	});

	it("redacts a JWT embedded in prose without key=value", () => {
		const out = redactSecretString(`auth token: ${JWT}`);
		assert.ok(!out.includes(JWT));
	});

	it("redacts a GitHub classic PAT (ghp_) and fine-grained (gho_)", () => {
		for (const pat of [GITHUB_PAT, GITHUB_FINEGRAINED]) {
			const out = redactSecretString(`deploy key ${pat} ok`);
			assert.ok(!out.includes(pat), `GitHub PAT must be removed: ${pat}`);
			assert.ok(out.includes("***"));
		}
	});

	it("redacts an AWS access key id", () => {
		const out = redactSecretString(`aws key=${AWS_KEY}`);
		assert.ok(!out.includes(AWS_KEY));
		assert.ok(out.includes("***"));
	});

	it("redacts PEM private keys", () => {
		const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKx1\n-----END RSA PRIVATE KEY-----";
		const out = redactSecretString(pem);
		assert.ok(!out.includes("MIIBOgIBAAJBAKx1"));
		assert.ok(out.includes("***"));
	});

	it("redacts Bearer tokens", () => {
		const out = redactSecretString("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789");
		assert.ok(!out.includes("abcdefghijklmnopqrstuvwxyz0123456789"));
		assert.ok(out.includes("Bearer"));
	});

	it("still redacts inline key=value secrets", () => {
		const out = redactSecretString("password=hunter2secret");
		assert.ok(!out.includes("hunter2secret"));
		assert.ok(out.includes("***"));
	});
});

describe("P1f redaction — optional OQ13 patterns", () => {
	it("redacts a Slack token", () => {
		const out = redactSecretString(`slack=${SLACK}`);
		assert.ok(!out.includes(SLACK));
		assert.ok(out.includes("***"));
	});

	it("redacts a Google API key", () => {
		const out = redactSecretString(`google=${GOOGLE}`);
		assert.ok(!out.includes(GOOGLE));
		assert.ok(out.includes("***"));
	});

	it("redacts a Stripe live key", () => {
		const out = redactSecretString(`stripe=${STRIPE}`);
		assert.ok(!out.includes(STRIPE));
		assert.ok(out.includes("***"));
	});
});

describe("P1f redaction — non-secret text is unchanged", () => {
	it("leaves ordinary prose untouched", () => {
		const text = "The build passed: 42 tests, 0 failures in 1.23s (node v22.6.0)";
		assert.equal(redactSecretString(text), text);
	});

	it("does not redact short look-alikes that fail length requirements", () => {
		// ghp_ + only 4 chars is too short (needs exactly 36).
		const out = redactSecretString("see ghp_abcd for details");
		assert.ok(out.includes("ghp_abcd"), "short non-secret prefix should be preserved");
	});

	it("does not redact a bare AKIA word without the 16-char tail", () => {
		const out = redactSecretString("the value AKIA was mentioned");
		assert.ok(out.includes("AKIA"));
	});

	it("preserves multiple distinct non-secret lines", () => {
		const text = ["line one", "package version 1.2.3", "tsconfig.json settings"].join("\n");
		assert.equal(redactSecretString(text), text);
	});
});

describe("P1f redaction — ReDoS safety (linear-time, no hang)", () => {
	it("handles a long base64url-ish run with no full JWT match quickly", () => {
		// Pathological for a naive (a+)+ style pattern; safe for ours.
		// Single + on a char class => linear scan, no catastrophic backtracking.
		const pathological = "eyJ" + "A_B-C0".repeat(50000); // ~300KB, no dot separator
		const start = Date.now();
		const out = redactSecretString(pathological);
		const elapsed = Date.now() - start;
		assert.ok(typeof out === "string");
		// Generous budget; a ReDoS-vulnerable pattern would take seconds+.
		assert.ok(elapsed < 1000, `redactSecretString must be linear (took ${elapsed}ms)`);
	});

	it("handles a long near-JWT with dots quickly", () => {
		// Two segments then a huge third segment, no terminator => linear.
		const pathological = "eyJ" + "A".repeat(50000) + ".eyJ" + "B".repeat(50000) + "." + "C".repeat(50000);
		const start = Date.now();
		const out = redactSecretString(pathological);
		const elapsed = Date.now() - start;
		assert.ok(typeof out === "string");
		assert.ok(elapsed < 1000, `JWT regex must be linear (took ${elapsed}ms)`);
	});

	it("handles a long run of potential AWS/GH prefixes quickly", () => {
		const pathological = ("AKIA" + "Z".repeat(20) + " ").repeat(50000); // many non-matches
		const start = Date.now();
		const out = redactSecretString(pathological);
		const elapsed = Date.now() - start;
		assert.ok(typeof out === "string");
		assert.ok(elapsed < 1000, `AWS regex must be linear (took ${elapsed}ms)`);
	});

	it("REGRESSION (cold-review #1): isSecretKey prefix-scan is O(n), not O(n^2)", () => {
		// Adversarial worker attack vector: long underscore run + '=' becomes the `key` passed
		// to isSecretKey via redactInlineSecrets. Before the fix, this was O(n^2):
		//   100KB -> 4.5s, 200KB -> 29.5s, 500KB -> 216s (verified during review).
		// After the fix (lower.startsWith(kw, i+1) + charAt, no substring/toLowerCase alloc):
		//   1MB -> ~240ms (linear).
		const pathological = "_".repeat(100000) + "=x"; // 100KB underscore run
		const start = Date.now();
		redactSecretString(pathological);
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 200, `isSecretKey prefix-scan must be O(n) (100KB took ${elapsed}ms; was 4547ms pre-fix)`);
	});
});
