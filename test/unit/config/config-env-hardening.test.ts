/**
 * Tests for Round 14, Phase 4: Config & Env hardening
 * - H8: OTLP endpoint requires http:// or https://
 * - TIMEOUT: PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS bounded
 * - PI_TEAMS_HOME: validated against user home in production
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import { PiTeamsOtlpConfigSchema } from "../../../src/schema/config-schema.ts";

test("H8: OTLP endpoint accepts http://", () => {
	const result = Value.Parse(PiTeamsOtlpConfigSchema, {
		endpoint: "http://localhost:4318",
	});
	assert.equal(result.endpoint, "http://localhost:4318");
});

test("H8: OTLP endpoint accepts https://", () => {
	const result = Value.Parse(PiTeamsOtlpConfigSchema, {
		endpoint: "https://otel.example.com",
	});
	assert.equal(result.endpoint, "https://otel.example.com");
});

test("H8: OTLP endpoint rejects javascript: URL", () => {
	assert.throws(
		() =>
			Value.Parse(PiTeamsOtlpConfigSchema, {
				endpoint: "javascript:alert(1)",
			}),
		/Expected string to match/,
	);
});

test("H8: OTLP endpoint rejects empty string", () => {
	assert.throws(() => Value.Parse(PiTeamsOtlpConfigSchema, { endpoint: "" }), /Expected string length greater/);
});

test("H8: OTLP endpoint rejects file:// URL", () => {
	assert.throws(
		() =>
			Value.Parse(PiTeamsOtlpConfigSchema, {
				endpoint: "file:///etc/passwd",
			}),
		/Expected string to match/,
	);
});

test("H8: OTLP endpoint rejects overlong URL (> 2048 chars)", () => {
	const longUrl = `https://example.com/${"a".repeat(2100)}`;
	assert.throws(
		() => Value.Parse(PiTeamsOtlpConfigSchema, { endpoint: longUrl }),
		/at most 2048 characters|less than or equal to 2048|Expected string/,
	);
});
