/**
 * Regression test for extractSessionId.
 *
 * Background: the inter-pi broker NEVER started in a real pi session because
 * extractSessionId read `extensionCtx.sessionId`, but Pi's ExtensionContext
 * does NOT expose a top-level `sessionId` property — the session id is only
 * reachable via `extensionCtx.sessionManager.getSessionId()`. Unit tests
 * passed because they mocked the ctx with a `.sessionId` property, bypassing
 * the real wiring. This test pins the real Pi shape so the bug cannot recur.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractSessionId } from "../../src/utils/session-utils.ts";

describe("extractSessionId", () => {
	it("reads the session id from sessionManager.getSessionId() (real Pi ExtensionContext shape)", () => {
		// This is the ACTUAL shape Pi's ExtensionContext exposes — verified live
		// via a headless `pi -p` run (2026-07-22). There is no top-level sessionId.
		const ctx = {
			ui: {},
			mode: "interactive",
			cwd: "/tmp/proj",
			sessionManager: { getSessionId: () => "019f8852-6c6a-7936-b6f2-b6b55330dc10" },
			modelRegistry: {},
		};
		assert.equal(extractSessionId(ctx), "019f8852-6c6a-7936-b6f2-b6b55330dc10");
	});

	it("returns undefined when sessionManager is absent (the pre-fix bug)", () => {
		// The pre-fix code also returned undefined here, but for the WRONG reason:
		// it looked for a non-existent `sessionId` property. This test ensures we
		// still return undefined (not throw) when neither path yields an id.
		const ctx = { ui: {}, cwd: "/tmp/proj" };
		assert.equal(extractSessionId(ctx), undefined);
	});

	it("returns undefined when sessionManager.getSessionId() returns empty", () => {
		const ctx = { sessionManager: { getSessionId: () => "" } };
		assert.equal(extractSessionId(ctx), undefined);
	});

	it("falls back to a direct ctx.sessionId property (test/future-Pi compat)", () => {
		const ctx = { sessionId: "crew-test-session-123" };
		assert.equal(extractSessionId(ctx), "crew-test-session-123");
	});

	it("prefers sessionManager.getSessionId() over a direct sessionId property", () => {
		const ctx = {
			sessionManager: { getSessionId: () => "from-manager" },
			sessionId: "from-direct",
		};
		assert.equal(extractSessionId(ctx), "from-manager");
	});

	it("returns undefined for null / non-object / hostile inputs", () => {
		assert.equal(extractSessionId(null), undefined);
		assert.equal(extractSessionId(undefined), undefined);
		assert.equal(extractSessionId("string"), undefined);
		assert.equal(extractSessionId(42), undefined);
		// A Proxy that traps descriptor access must not crash the accessor.
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
		const result = extractSessionId(hostile);
		assert.ok(result === undefined || typeof result === "string");
	});
});
