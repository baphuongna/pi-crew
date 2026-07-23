/**
 * Regression test for extractSessionId + extractBrokerSessionId.
 *
 * Background: the inter-pi broker NEVER started in a real pi session because
 * Pi's ExtensionContext does NOT expose a top-level `sessionId` property —
 * the id is reachable only via `ctx.sessionManager.getSessionId()`.
 *
 * Approach: `extractSessionId` is kept on the original property-only lookup
 * because it is called on EVERY `context` event (before every LLM call) from
 * `context-status-injection.ts`. Method invocations on that hot path were
 * observed to freeze the TUI (dashboard/settings open but unresponsive, pi
 * crew footer missing) during live smoke testing — so the hot path is
 * intentionally trivial.
 *
 * A SEPARATE helper `extractBrokerSessionId` is added that does the full
 * sessionManager lookup. It is only called from
 * `installCrewBrokerLifecycleController.setSessionId` (once per session_start),
 * which is safe.
 *
 * These tests pin BOTH behaviors so neither can regress without warning.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractBrokerSessionId, extractSessionId } from "../../src/utils/session-utils.ts";

describe("extractSessionId (hot path — property lookup only)", () => {
	it("returns the session id from a direct ctx.sessionId property (legacy/test shape)", () => {
		assert.equal(extractSessionId({ sessionId: "crew-test-legacy" }), "crew-test-legacy");
	});

	it("returns undefined for the real Pi ExtensionContext shape (no top-level sessionId)", () => {
		// Verifies the intentional decision NOT to read sessionManager on the
		// hot path. The real Pi shape has sessionManager, NOT sessionId.
		const ctx = {
			ui: {},
			cwd: "/tmp/proj",
			sessionManager: { getSessionId: () => "abc" },
		};
		assert.equal(extractSessionId(ctx), undefined);
	});

	it("returns undefined for empty / non-string / hostile inputs", () => {
		assert.equal(extractSessionId({ sessionId: "" }), undefined);
		assert.equal(extractSessionId({ sessionId: 42 }), undefined);
		assert.equal(extractSessionId({}), undefined);
		assert.equal(extractSessionId(null), undefined);
		assert.equal(extractSessionId(undefined), undefined);
		assert.equal(extractSessionId("string"), undefined);
		assert.equal(extractSessionId(123), undefined);
		// Hostile Proxy that traps descriptor access must not crash.
		const hostile = new Proxy(
			{ sessionId: "x" },
			{
				getOwnPropertyDescriptor() {
					throw new Error("trapped");
				},
			},
		);
		assert.equal(extractSessionId(hostile), undefined);
	});
});

describe("extractBrokerSessionId (broker-only path — full lookup)", () => {
	it("reads the session id from sessionManager.getSessionId() (real Pi ExtensionContext shape)", () => {
		// Confirmed live via headless `pi -p` smoke (2026-07-22). The real
		// ExtensionContext exposes sessionManager, NOT a top-level sessionId.
		const ctx = {
			ui: {},
			mode: "interactive",
			cwd: "/tmp/proj",
			sessionManager: { getSessionId: () => "019f8852-6c6a-7936-b6f2-b6b55330dc10" },
			modelRegistry: {},
		};
		assert.equal(extractBrokerSessionId(ctx), "019f8852-6c6a-7936-b6f2-b6b55330dc10");
	});

	it("falls back to a direct ctx.sessionId property (test/future-Pi compat)", () => {
		assert.equal(extractBrokerSessionId({ sessionId: "crew-test-direct" }), "crew-test-direct");
	});

	it("prefers sessionManager.getSessionId() over a direct sessionId property", () => {
		assert.equal(
			extractBrokerSessionId({
				sessionManager: { getSessionId: () => "from-manager" },
				sessionId: "from-direct",
			}),
			"from-manager",
		);
	});

	it("returns undefined when both paths are absent or invalid", () => {
		assert.equal(extractBrokerSessionId({}), undefined);
		assert.equal(extractBrokerSessionId({ sessionManager: {} }), undefined);
		assert.equal(extractBrokerSessionId({ sessionManager: { getSessionId: () => "" } }), undefined);
		assert.equal(extractBrokerSessionId({ sessionId: "" }), undefined);
		assert.equal(extractBrokerSessionId(null), undefined);
		assert.equal(extractBrokerSessionId(undefined), undefined);
		assert.equal(extractBrokerSessionId("string"), undefined);
		assert.equal(extractBrokerSessionId(42), undefined);
	});

	it("does not throw on a hostile Proxy that traps descriptor access", () => {
		const hostile = new Proxy(
			{ sessionManager: { getSessionId: () => "x" } },
			{
				getOwnPropertyDescriptor() {
					throw new Error("trapped");
				},
			},
		);
		// sessionManager path is tried first via property access; if the Proxy
		// throws on the fallback descriptor read, the catch returns undefined.
		// Either a valid id or undefined is acceptable — it must NOT throw.
		const result = extractBrokerSessionId(hostile);
		assert.ok(result === undefined || typeof result === "string");
	});
});
