/**
 * Wave 1A (F19-5): parser bound alignment tests.
 * The schema (src/schema/config-schema.ts) is the source of truth; these pin
 * the parser in src/config/config-validation.ts to the schema bounds:
 *   - notifications.dedupWindowMs      minimum 1000          (schema :208)
 *   - observability.metricRetentionDays min 1 / max 90       (schema :220)
 *   - otlp.endpoint                     pattern ^https?://   (schema :258-265)
 * Violations parse to undefined (parseWithSchema semantics), matching the
 * existing bound style (pollIntervalMs / batchWindowMs).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseConfig } from "../../../src/config/config-validation.ts";

describe("notifications.dedupWindowMs bound (schema minimum 1000)", () => {
	it("rejects 999 (below the schema minimum)", () => {
		const parsed = parseConfig({ notifications: { enabled: true, dedupWindowMs: 999 } });
		assert.equal(parsed.notifications?.dedupWindowMs, undefined);
	});

	it("accepts 1000 (boundary)", () => {
		const parsed = parseConfig({ notifications: { enabled: true, dedupWindowMs: 1000 } });
		assert.equal(parsed.notifications?.dedupWindowMs, 1000);
	});

	it("accepts values above the old parser-only 24h ceiling (schema has no maximum)", () => {
		const parsed = parseConfig({ notifications: { enabled: true, dedupWindowMs: 25 * 60 * 60 * 1000 } });
		assert.equal(parsed.notifications?.dedupWindowMs, 25 * 60 * 60 * 1000);
	});

	it("keeps absent values undefined (no parser default; registration applies DEFAULT_NOTIFICATIONS)", () => {
		const parsed = parseConfig({ notifications: { enabled: true } });
		assert.equal(parsed.notifications?.dedupWindowMs, undefined);
	});
});

describe("observability.metricRetentionDays bound (schema min 1 max 90)", () => {
	it("keeps absent values undefined (no parser default; registration defaults to 7 days)", () => {
		const parsed = parseConfig({ observability: { enabled: true } });
		assert.equal(parsed.observability?.metricRetentionDays, undefined);
	});

	it("accepts 90 (schema maximum)", () => {
		const parsed = parseConfig({ observability: { enabled: true, metricRetentionDays: 90 } });
		assert.equal(parsed.observability?.metricRetentionDays, 90);
	});

	it("rejects 91 (previously accepted under the old parser ceiling of 365)", () => {
		const parsed = parseConfig({ observability: { enabled: true, metricRetentionDays: 91 } });
		assert.equal(parsed.observability?.metricRetentionDays, undefined);
	});

	it("rejects 365 (the old parser ceiling — violated schema max 90)", () => {
		const parsed = parseConfig({ observability: { enabled: true, metricRetentionDays: 365 } });
		assert.equal(parsed.observability?.metricRetentionDays, undefined);
	});
});

describe("otlp.endpoint scheme (schema pattern ^https?://)", () => {
	it("rejects unix:///tmp/x", () => {
		const parsed = parseConfig({ otlp: { enabled: true, endpoint: "unix:///tmp/x" } });
		assert.equal(parsed.otlp?.endpoint, undefined);
	});

	it("rejects notaurl", () => {
		const parsed = parseConfig({ otlp: { enabled: true, endpoint: "notaurl" } });
		assert.equal(parsed.otlp?.endpoint, undefined);
	});

	it("accepts https://x", () => {
		const parsed = parseConfig({ otlp: { enabled: true, endpoint: "https://x" } });
		assert.equal(parsed.otlp?.endpoint, "https://x");
	});

	it("accepts http://x", () => {
		const parsed = parseConfig({ otlp: { enabled: true, endpoint: "http://x" } });
		assert.equal(parsed.otlp?.endpoint, "http://x");
	});
});
