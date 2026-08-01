import assert from "node:assert/strict";
import test from "node:test";
import { buildExtensionBridge } from "../../src/runtime/live-extension-bridge.ts";

/**
 * Round 27 (test coverage gaps): `live-extension-bridge.ts` bridges pi-crew's
 * extension lifecycle with the Pi SDK session. buildExtensionBridge() creates
 * API wrapper objects from a Pi SDK session-like object.
 *
 * Tests cover buildExtensionBridge with mock session objects.
 */

function makeMockSession(overrides: Record<string, unknown> = {}) {
	return {
		sendCustomMessage: () => undefined,
		sendUserMessage: () => undefined,
		getActiveToolNames: () => ["read", "write"],
		getAllTools: () => ["read", "write", "bash"],
		setActiveToolsByName: () => undefined,
		steer: async () => undefined,
		prompt: async () => undefined,
		abort: () => undefined,
		getContextUsage: () => ({ percent: 50 }),
		subscribe: () => () => undefined,
		bindExtensions: async () => undefined,
		compact: () => undefined,
		getSessionStats: () => ({}),
		isStreaming: false,
		model: "test-model",
		systemPrompt: "You are a test.",
		pendingMessageCount: 0,
		...overrides,
	};
}

// ─── buildExtensionBridge ──────────────────────────────────────────────────

test("buildExtensionBridge: returns null if sendCustomMessage is missing", () => {
	const session = makeMockSession({ sendCustomMessage: undefined });
	assert.equal(buildExtensionBridge(session as any), null);
});

test("buildExtensionBridge: returns null if sendCustomMessage is not a function", () => {
	const session = makeMockSession({ sendCustomMessage: "not-a-fn" });
	assert.equal(buildExtensionBridge(session as any), null);
});

test("buildExtensionBridge: returns apis and host for valid session", () => {
	const bridge = buildExtensionBridge(makeMockSession());
	assert.ok(bridge);
	assert.ok(bridge!.apis);
	assert.ok(bridge!.host);
});

// ─── apis ──────────────────────────────────────────────────────────────────

test("apis.sendMessage: delegates to session.sendCustomMessage", () => {
	const messages: unknown[] = [];
	const session = makeMockSession({
		sendCustomMessage: (msg: unknown) => {
			messages.push(msg);
		},
	});
	const bridge = buildExtensionBridge(session);
	bridge!.apis.sendMessage("hello");
	assert.equal(messages.length, 1);
	assert.equal(messages[0], "hello");
});

test("apis.sendMessage: swallows errors", () => {
	const session = makeMockSession({
		sendCustomMessage: () => {
			throw new Error("boom");
		},
	});
	const bridge = buildExtensionBridge(session);
	// Should not throw
	bridge!.apis.sendMessage("test");
});

test("apis.sendUserMessage: delegates to session.sendUserMessage", () => {
	const messages: unknown[] = [];
	const session = makeMockSession({
		sendUserMessage: (content: unknown) => {
			messages.push(content);
		},
	});
	const bridge = buildExtensionBridge(session);
	bridge!.apis.sendUserMessage("user says hi");
	assert.equal(messages[0], "user says hi");
});

test("apis.sendUserMessage: swallows errors", () => {
	const session = makeMockSession({
		sendUserMessage: () => {
			throw new Error("fail");
		},
	});
	const bridge = buildExtensionBridge(session);
	bridge!.apis.sendUserMessage("test");
});

test("apis.getActiveTools: delegates to session.getActiveToolNames", () => {
	const bridge = buildExtensionBridge(makeMockSession());
	assert.deepEqual(bridge!.apis.getActiveTools(), ["read", "write"]);
});

test("apis.getActiveTools: returns [] on error", () => {
	const session = makeMockSession({
		getActiveToolNames: () => {
			throw new Error("fail");
		},
	});
	const bridge = buildExtensionBridge(session);
	assert.deepEqual(bridge!.apis.getActiveTools(), []);
});

test("apis.getAllTools: delegates to session.getAllTools", () => {
	const bridge = buildExtensionBridge(makeMockSession());
	assert.deepEqual(bridge!.apis.getAllTools(), ["read", "write", "bash"]);
});

test("apis.getAllTools: falls back to getActiveToolNames on error", () => {
	const session = makeMockSession({
		getAllTools: () => {
			throw new Error("fail");
		},
	});
	const bridge = buildExtensionBridge(session);
	assert.deepEqual(bridge!.apis.getAllTools(), ["read", "write"]);
});

test("apis.setActiveTools: delegates to session.setActiveToolsByName", () => {
	const setCalls: string[][] = [];
	const session = makeMockSession({
		setActiveToolsByName: (tools: string[]) => {
			setCalls.push(tools);
		},
	});
	const bridge = buildExtensionBridge(session);
	bridge!.apis.setActiveTools(["read"]);
	assert.deepEqual(setCalls[0], ["read"]);
});

test("apis.setActiveTools: swallows errors", () => {
	const session = makeMockSession({
		setActiveToolsByName: () => {
			throw new Error("fail");
		},
	});
	const bridge = buildExtensionBridge(session);
	bridge!.apis.setActiveTools(["read"]);
});

// ─── host ──────────────────────────────────────────────────────────────────

test("host.getModel: returns session.model", () => {
	const bridge = buildExtensionBridge(makeMockSession());
	assert.equal(bridge!.host.getModel(), "test-model");
});

test("host.isIdle: returns true when not streaming", () => {
	const bridge = buildExtensionBridge(makeMockSession({ isStreaming: false }));
	assert.equal(bridge!.host.isIdle(), true);
});

test("host.isIdle: returns false when streaming", () => {
	const bridge = buildExtensionBridge(makeMockSession({ isStreaming: true }));
	assert.equal(bridge!.host.isIdle(), false);
});

test("host.hasPendingMessages: returns true when pendingMessageCount > 0", () => {
	const bridge = buildExtensionBridge(makeMockSession({ pendingMessageCount: 3 }));
	assert.equal(bridge!.host.hasPendingMessages(), true);
});

test("host.hasPendingMessages: returns false when pendingMessageCount is 0", () => {
	const bridge = buildExtensionBridge(makeMockSession({ pendingMessageCount: 0 }));
	assert.equal(bridge!.host.hasPendingMessages(), false);
});

test("host.hasPendingMessages: returns false when pendingMessageCount is undefined", () => {
	const bridge = buildExtensionBridge(makeMockSession({ pendingMessageCount: undefined }));
	assert.equal(bridge!.host.hasPendingMessages(), false);
});

test("host.getSystemPrompt: returns session.systemPrompt", () => {
	const bridge = buildExtensionBridge(makeMockSession());
	assert.equal(bridge!.host.getSystemPrompt(), "You are a test.");
});

test("host.getSystemPrompt: returns empty string when undefined", () => {
	const bridge = buildExtensionBridge(makeMockSession({ systemPrompt: undefined }));
	assert.equal(bridge!.host.getSystemPrompt(), "");
});

test("host.getContextUsage: delegates to session", () => {
	const bridge = buildExtensionBridge(makeMockSession());
	assert.deepEqual(bridge!.host.getContextUsage(), { percent: 50 });
});

test("host.getContextUsage: returns undefined on error", () => {
	const session = makeMockSession({
		getContextUsage: () => {
			throw new Error("fail");
		},
	});
	const bridge = buildExtensionBridge(session);
	assert.equal(bridge!.host.getContextUsage(), undefined);
});
