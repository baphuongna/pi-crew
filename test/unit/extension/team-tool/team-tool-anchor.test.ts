/**
 * Unit tests for team-tool anchor handlers.
 * @see src/extension/team-tool/anchor.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleAnchorAccumulate, handleAnchorClear, handleAnchorSet, handleAnchorStatus } from "../../../../src/extension/team-tool/anchor.ts";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import type { TeamToolParamsValue } from "../../../../src/schema/team-tool-schema.ts";

function makeCtx(overrides: Partial<TeamContext> = {}): TeamContext {
	return { cwd: "/tmp/test-anchor", ...overrides };
}

function makeParams(overrides: Partial<TeamToolParamsValue> = {}): TeamToolParamsValue {
	return { ...overrides };
}

// ─── handleAnchorSet ──────────────────────────────────────────────────────────

describe("handleAnchorSet", () => {
	it("sets an anchor and returns anchor ID in the result text", () => {
		const ctx = makeCtx({ sessionId: "sess-1" });
		const res = handleAnchorSet(makeParams(), ctx);

		assert.strictEqual(res.isError, false);
		const text = textFromToolResult(res);
		assert.ok(text.includes("Anchor set successfully"));
		assert.ok(text.includes("Session: sess-1"));
		assert.ok(/Anchor ID: anchor-/.test(text));
	});

	it("passes context from config into the anchor", () => {
		const ctx = makeCtx({ sessionId: "sess-ctx" });
		const params = makeParams({
			config: { context: { keyA: "valA", keyB: 42 } },
		});
		const res = handleAnchorSet(params, ctx);

		const text = textFromToolResult(res);
		assert.ok(text.includes("keyA"));
		assert.ok(text.includes("valA"));
		assert.ok(text.includes("keyB"));
	});

	it("strips prototype-pollution keys from context", () => {
		const ctx = makeCtx({ sessionId: "sess-pollute" });
		const params = makeParams({
			config: {
				context: {
					__proto__: "evil",
					constructor: "evil",
					prototype: "evil",
					safe: "yes",
				},
			},
		});
		const res = handleAnchorSet(params, ctx);

		const text = textFromToolResult(res);
		assert.ok(text.includes("safe"));
		assert.ok(!text.includes("evil"));
	});

	it("uses cfg.key shorthand for single key context", () => {
		const ctx = makeCtx({ sessionId: "sess-key" });
		const params = makeParams({
			config: { key: "my-key-123" },
		});
		const res = handleAnchorSet(params, ctx);

		const text = textFromToolResult(res);
		assert.ok(text.includes("my-key-123"));
	});

	it("uses 'default' session when sessionId is not provided", () => {
		const ctx = makeCtx(); // no sessionId
		const res = handleAnchorSet(makeParams(), ctx);

		const text = textFromToolResult(res);
		assert.ok(text.includes("Session: default"));
	});
});

// ─── handleAnchorClear ────────────────────────────────────────────────────────

describe("handleAnchorClear", () => {
	it("returns error when no anchor exists for the session", () => {
		const ctx = makeCtx({ sessionId: "no-anchor-session" });
		const res = handleAnchorClear(makeParams(), ctx);

		assert.strictEqual(res.isError, true);
		const text = textFromToolResult(res);
		assert.ok(text.includes("No anchor found"));
	});

	it("returns error when clearing a non-existent anchorId", () => {
		const ctx = makeCtx({ sessionId: "clear-missing" });
		const params = makeParams({
			config: { anchorId: "anchor-nonexistent-999" },
		});
		const res = handleAnchorClear(params, ctx);

		assert.strictEqual(res.isError, true);
		const text = textFromToolResult(res);
		assert.ok(text.includes("Anchor not found"));
	});

	it("returns error when clearing an anchor with no handoffs accumulated", () => {
		const ctx = makeCtx({ sessionId: "clear-empty" });
		// Set an anchor first (no handoffs)
		const setRes = handleAnchorSet(makeParams(), ctx);
		const setText = textFromToolResult(setRes);
		const anchorIdMatch = setText.match(/Anchor ID: (anchor-\S+)/);

		if (anchorIdMatch) {
			const params = makeParams({
				config: { anchorId: anchorIdMatch[1] },
			});
			const res = handleAnchorClear(params, ctx);

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("No handoffs have been accumulated"), `Expected 'No handoffs' message, got: ${text}`);
		}
	});
});

// ─── handleAnchorStatus ───────────────────────────────────────────────────────

describe("handleAnchorStatus", () => {
	it("returns 'no anchor' message when no anchor is set for session", () => {
		const ctx = makeCtx({ sessionId: "status-empty" });
		const res = handleAnchorStatus(makeParams(), ctx);

		assert.strictEqual(res.isError, false);
		const text = textFromToolResult(res);
		assert.ok(text.includes("No anchor set for session"));
	});

	it("returns 'no anchor' for a non-existent anchorId", () => {
		const ctx = makeCtx({ sessionId: "status-missing" });
		const params = makeParams({
			config: { anchorId: "anchor-nonexistent-404" },
		});
		const res = handleAnchorStatus(params, ctx);

		const text = textFromToolResult(res);
		assert.ok(text.includes("No anchor found with ID"));
	});

	it("returns anchor status after setting an anchor", () => {
		const ctx = makeCtx({ sessionId: "status-ok" });
		handleAnchorSet(makeParams(), ctx);
		const res = handleAnchorStatus(makeParams(), ctx);

		const text = textFromToolResult(res);
		assert.ok(text.includes("Anchor Status"));
		assert.ok(text.includes("Anchor ID:"));
		assert.ok(text.includes("Session ID: status-ok"));
		assert.ok(text.includes("Handoffs: 0"));
	});
});

// ─── handleAnchorAccumulate ───────────────────────────────────────────────────

describe("handleAnchorAccumulate", () => {
	it("returns guidance message with ok status", () => {
		const ctx = makeCtx();
		const res = handleAnchorAccumulate(makeParams(), ctx);

		assert.strictEqual(res.isError, false);
		const text = textFromToolResult(res);
		assert.ok(text.includes("handleAnchorSet"));
		assert.ok(text.includes("accumulated automatically"));
	});

	it("returns ok action=anchor in details", () => {
		const ctx = makeCtx();
		const res = handleAnchorAccumulate(makeParams(), ctx);

		assert.deepStrictEqual(res.details.action, "anchor");
		assert.deepStrictEqual(res.details.status, "ok");
	});

	it("does not error regardless of params", () => {
		const ctx = makeCtx();
		const params = makeParams({ config: { arbitrary: true } });
		const res = handleAnchorAccumulate(params, ctx);

		assert.strictEqual(res.isError, false);
	});
});
