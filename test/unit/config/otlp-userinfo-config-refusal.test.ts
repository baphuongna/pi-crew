/**
 * W9-R1 (SEC-2026-11 w7b deferred residual): parseOtlpConfig must refuse a
 * credential-bearing (userinfo) OTLP endpoint at CONFIG VALIDATION time,
 * mirroring the runtime refusal added by w7b in otlp-exporter.ts
 * validateEndpoint (same wording style).
 *
 * Proven here:
 *  - the throw fires for user:pass@ and password-only forms;
 *  - the error text renders the ORIGIN only — the credential-bearing URL is
 *    never echoed (and an unparseable credential URL refuses without echoing
 *    any part of the endpoint);
 *  - clean endpoints, endpoints whose path/query merely CONTAINS "@", and
 *    non-http schemes (dropped by the existing ^https?:// schema pattern)
 *    keep their pre-existing behavior.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig, parseConfigWithWarnings } from "../../../src/config/config-validation.ts";

const SECRET = "sup3r-s3cret-pw";
const ORIGIN = "http://collector.internal:4318";

test("parseConfig refuses a userinfo otlp endpoint (origin-only error, no credential echo)", () => {
	assert.throws(
		() => parseConfig({ otlp: { enabled: true, endpoint: `http://ci-user:${SECRET}@collector.internal:4318/v1/traces` } }),
		(error: unknown) => {
			assert.ok(error instanceof Error, "refusal must be an Error");
			assert.match(error.message, /must not embed credentials \(userinfo\)/);
			assert.match(error.message, /pass them via headers instead/);
			assert.ok(!error.message.includes(SECRET), "credential must never be echoed");
			assert.ok(!error.message.includes("ci-user"), "userinfo must never be echoed");
			assert.ok(error.message.includes(ORIGIN), `origin-only rendering expected, got: ${error.message}`);
			return true;
		},
	);
});

test("parseConfigWithWarnings refuses the same endpoint (validation entrypoint parity)", () => {
	assert.throws(
		() => parseConfigWithWarnings({ otlp: { enabled: true, endpoint: `http://ci-user:${SECRET}@collector.internal:4318` } }),
		/userinfo/,
	);
});

test("password-only userinfo is refused without echoing the secret", () => {
	assert.throws(
		() => parseConfig({ otlp: { enabled: true, endpoint: `http://:${SECRET}@collector.internal:4318` } }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /must not embed credentials \(userinfo\)/);
			assert.ok(!error.message.includes(SECRET), "credential must never be echoed");
			assert.ok(error.message.includes(ORIGIN));
			return true;
		},
	);
});

test("an unparseable credential-bearing endpoint refuses WITHOUT echoing any part of it", () => {
	assert.throws(
		() => parseConfig({ otlp: { enabled: true, endpoint: "http://u5er:p4ss@:4318" } }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /must not embed credentials \(userinfo\)/);
			assert.ok(!error.message.includes("u5er"), "userinfo must never be echoed");
			assert.ok(!error.message.includes("p4ss"), "credential must never be echoed");
			assert.ok(!error.message.includes("4318"), "no endpoint fragment may be echoed when the URL is unparseable");
			return true;
		},
	);
});

test("clean endpoints keep parsing (no over-refusal regression)", () => {
	const parsed = parseConfig({ otlp: { enabled: true, endpoint: ORIGIN, intervalMs: 6000 } });
	assert.equal(parsed.otlp?.endpoint, ORIGIN);
	assert.equal(parsed.otlp?.enabled, true);
	assert.equal(parsed.otlp?.intervalMs, 6000);
});

test("a literal '@' in path/query is not userinfo — endpoint preserved", () => {
	const endpoint = "http://collector.internal:4318/v1/traces?token=@lookup";
	const parsed = parseConfig({ otlp: { enabled: true, endpoint } });
	assert.equal(parsed.otlp?.endpoint, endpoint);
});

test("non-http credential endpoints keep the pre-existing silent drop (schema ^https?:// pattern)", () => {
	const parsed = parseConfig({ otlp: { enabled: true, endpoint: "ftp://u5er:p4ss@collector.internal:4318" } });
	assert.equal(parsed.otlp?.endpoint, undefined, "non-http endpoints parse to undefined (unchanged F19-5 behavior)");
});
