/**
 * Regression test for extractSessionId + extractBrokerSessionId.
 *
 * Background: Pi's ExtensionContext does NOT expose a top-level `sessionId`
 * property — the id is reachable only via `ctx.sessionManager.getSessionId()`.
 *
 * extractSessionId (the canonical accessor, called on every `context` event
 * from `context-status-injection.ts`) now reads `sessionManager.getSessionId()`
 * as its primary path, memoising the result in a WeakMap keyed by the
 * `sessionManager` ref (stable across events, unlike `ctx` which is recreated
 * per event). It falls back to a direct `ctx.sessionId` own property for test
 * mocks and older Pi versions.
 *
 * `extractBrokerSessionId` performs the same lookup but WITHOUT caching,
 * since it is called only once per `session_start`.
 *
 * These tests pin BOTH behaviors so neither can regress without warning.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractBrokerSessionId, extractSessionId } from "../../../src/utils/session-utils.ts";

describe("extractSessionId (canonical accessor — sessionManager primary + cache)", () => {
	it("returns the session id from sessionManager.getSessionId() (real Pi ExtensionContext shape)", () => {
		const ctx = {
			ui: {},
			cwd: "/tmp/proj",
			sessionManager: { getSessionId: () => "019f8852-6c6a-7936-b6f2-b6b55330dc10" },
		};
		assert.equal(extractSessionId(ctx), "019f8852-6c6a-7936-b6f2-b6b55330dc10");
	});

	it("caches by sessionManager ref: a second call does NOT invoke getSessionId() again", () => {
		let callCount = 0;
		const sessionManager = {
			getSessionId: () => {
				callCount += 1;
				return "cached-session-id";
			},
		};
		const ctxA = { sessionManager };
		const ctxB = { sessionManager }; // different ctx, SAME sessionManager ref
		assert.equal(extractSessionId(ctxA), "cached-session-id");
		assert.equal(callCount, 1);
		// Second call with a fresh ctx but identical sessionManager → cache hit.
		assert.equal(extractSessionId(ctxB), "cached-session-id");
		assert.equal(callCount, 1);
	});

	it("cache miss for a different sessionManager ref invokes getSessionId() again", () => {
		let callsA = 0;
		let callsB = 0;
		const smA = {
			getSessionId: () => {
				callsA += 1;
				return "session-a";
			},
		};
		const smB = {
			getSessionId: () => {
				callsB += 1;
				return "session-b";
			},
		};
		assert.equal(extractSessionId({ sessionManager: smA }), "session-a");
		assert.equal(extractSessionId({ sessionManager: smB }), "session-b");
		assert.equal(callsA, 1);
		assert.equal(callsB, 1);
		// Repeating with smA is a cache hit.
		assert.equal(extractSessionId({ sessionManager: smA }), "session-a");
		assert.equal(callsA, 1);
	});

	it("falls back to a direct ctx.sessionId property when no sessionManager (test mock / old Pi)", () => {
		assert.equal(extractSessionId({ sessionId: "crew-test-legacy" }), "crew-test-legacy");
	});

	it("prefers sessionManager.getSessionId() over a direct sessionId property", () => {
		assert.equal(
			extractSessionId({
				sessionManager: { getSessionId: () => "from-manager" },
				sessionId: "from-direct",
			}),
			"from-manager",
		);
	});

	it("returns undefined for empty / non-string / hostile inputs", () => {
		assert.equal(extractSessionId({ sessionId: "" }), undefined);
		assert.equal(extractSessionId({ sessionId: 42 }), undefined);
		assert.equal(extractSessionId({}), undefined);
		assert.equal(extractSessionId({ sessionManager: {} }), undefined);
		assert.equal(extractSessionId({ sessionManager: { getSessionId: () => "" } }), undefined);
		assert.equal(extractSessionId(null), undefined);
		assert.equal(extractSessionId(undefined), undefined);
		assert.equal(extractSessionId("string"), undefined);
		assert.equal(extractSessionId(123), undefined);
		// Hostile Proxy that traps descriptor access must not crash.
		// sessionManager is read via normal property access (no trap) and is
		// absent on the target, so it falls through to the descriptor lookup
		// which throws → caught → undefined.
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
