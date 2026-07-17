import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExtensionBridge } from "../../src/runtime/live-extension-bridge.ts";

/** Minimal mock session that satisfies PiSdkSession interface. */
function mockSession(overrides: Record<string, unknown> = {}) {
	return {
		sendCustomMessage: () => {},
		sendUserMessage: () => {},
		getActiveToolNames: () => ["tool_a", "tool_b"],
		getAllTools: () => ["tool_a", "tool_b", "tool_c"],
		setActiveToolsByName: () => {},
		steer: async () => {},
		prompt: async () => {},
		abort: () => {},
		getContextUsage: () => ({ used: 100, total: 200 }),
		subscribe: () => () => {},
		bindExtensions: async () => {},
		compact: () => {},
		getSessionStats: () => ({}),
		model: "test-model",
		systemPrompt: "test prompt",
		pendingMessageCount: 0,
		isStreaming: false,
		...overrides,
	};
}

describe("buildExtensionBridge", () => {
	it("returns null if sendCustomMessage is not a function", () => {
		const session = mockSession({ sendCustomMessage: undefined });
		const result = buildExtensionBridge(session as never);
		assert.strictEqual(result, null);
	});

	it("returns bridge with apis and host when session is valid", () => {
		const session = mockSession();
		const result = buildExtensionBridge(session as never);
		assert.ok(result);
		assert.ok(result!.apis);
		assert.ok(result!.host);
	});

	it("apis.sendMessage calls session.sendCustomMessage", () => {
		let called = false;
		const session = mockSession({
			sendCustomMessage: () => {
				called = true;
			},
		});
		const result = buildExtensionBridge(session as never);
		result!.apis.sendMessage("test-msg");
		assert.strictEqual(called, true);
	});

	it("apis.sendMessage swallows errors", () => {
		const session = mockSession({
			sendCustomMessage: () => {
				throw new Error("boom");
			},
		});
		const result = buildExtensionBridge(session as never);
		assert.doesNotThrow(() => result!.apis.sendMessage("test"));
	});

	it("apis.sendUserMessage calls session.sendUserMessage", () => {
		let called = false;
		const session = mockSession({
			sendUserMessage: () => {
				called = true;
			},
		});
		const result = buildExtensionBridge(session as never);
		result!.apis.sendUserMessage("hello");
		assert.strictEqual(called, true);
	});

	it("apis.sendUserMessage swallows errors", () => {
		const session = mockSession({
			sendUserMessage: () => {
				throw new Error("fail");
			},
		});
		const result = buildExtensionBridge(session as never);
		assert.doesNotThrow(() => result!.apis.sendUserMessage("hello"));
	});

	it("apis.getActiveTools returns tool names", () => {
		const session = mockSession({
			getActiveToolNames: () => ["read", "write"],
		});
		const result = buildExtensionBridge(session as never);
		assert.deepStrictEqual(result!.apis.getActiveTools(), ["read", "write"]);
	});

	it("apis.getActiveTools returns [] on error", () => {
		const session = mockSession({
			getActiveToolNames: () => {
				throw new Error("err");
			},
		});
		const result = buildExtensionBridge(session as never);
		assert.deepStrictEqual(result!.apis.getActiveTools(), []);
	});

	it("apis.getAllTools falls back to getActiveToolNames on error", () => {
		const session = mockSession({
			getAllTools: () => {
				throw new Error("err");
			},
			getActiveToolNames: () => ["fallback"],
		});
		const result = buildExtensionBridge(session as never);
		assert.deepStrictEqual(result!.apis.getAllTools(), ["fallback"]);
	});

	it("apis.setActiveTools calls session.setActiveToolsByName", () => {
		let captured: string[] = [];
		const session = mockSession({
			setActiveToolsByName: (names: string[]) => {
				captured = names;
			},
		});
		const result = buildExtensionBridge(session as never);
		result!.apis.setActiveTools(["tool1"]);
		assert.deepStrictEqual(captured, ["tool1"]);
	});

	it("apis.setActiveTools swallows errors", () => {
		const session = mockSession({
			setActiveToolsByName: () => {
				throw new Error("err");
			},
		});
		const result = buildExtensionBridge(session as never);
		assert.doesNotThrow(() => result!.apis.setActiveTools(["x"]));
	});
});

describe("ExtensionHostApis", () => {
	it("host.getModel returns session.model", () => {
		const session = mockSession({ model: "gpt-4" });
		const result = buildExtensionBridge(session as never);
		assert.strictEqual(result!.host.getModel(), "gpt-4");
	});

	it("host.isIdle returns true when not streaming", () => {
		const session = mockSession({ isStreaming: false });
		const result = buildExtensionBridge(session as never);
		assert.strictEqual(result!.host.isIdle(), true);
	});

	it("host.isIdle returns false when streaming", () => {
		const session = mockSession({ isStreaming: true });
		const result = buildExtensionBridge(session as never);
		assert.strictEqual(result!.host.isIdle(), false);
	});

	it("host.hasPendingMessages returns false when 0", () => {
		const session = mockSession({ pendingMessageCount: 0 });
		const result = buildExtensionBridge(session as never);
		assert.strictEqual(result!.host.hasPendingMessages(), false);
	});

	it("host.hasPendingMessages returns true when > 0", () => {
		const session = mockSession({ pendingMessageCount: 3 });
		const result = buildExtensionBridge(session as never);
		assert.strictEqual(result!.host.hasPendingMessages(), true);
	});

	it("host.getContextUsage returns session context", () => {
		const ctx = { used: 50, total: 100 };
		const session = mockSession({ getContextUsage: () => ctx });
		const result = buildExtensionBridge(session as never);
		assert.deepStrictEqual(result!.host.getContextUsage(), ctx);
	});

	it("host.getContextUsage returns undefined on error", () => {
		const session = mockSession({
			getContextUsage: () => {
				throw new Error("err");
			},
		});
		const result = buildExtensionBridge(session as never);
		assert.strictEqual(result!.host.getContextUsage(), undefined);
	});

	it("host.getSystemPrompt returns session.systemPrompt", () => {
		const session = mockSession({ systemPrompt: "my prompt" });
		const result = buildExtensionBridge(session as never);
		assert.strictEqual(result!.host.getSystemPrompt(), "my prompt");
	});

	it("host.getSystemPrompt returns empty string when undefined", () => {
		const session = mockSession({ systemPrompt: undefined });
		const result = buildExtensionBridge(session as never);
		assert.strictEqual(result!.host.getSystemPrompt(), "");
	});
});
