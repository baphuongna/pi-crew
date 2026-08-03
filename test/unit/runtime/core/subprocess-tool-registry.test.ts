import assert from "node:assert/strict";
import test from "node:test";
import {
	type SubprocessToolEvent,
	type SubprocessToolHandler,
	subprocessToolRegistry,
} from "../../../../src/runtime/subprocess-tool-registry.ts";

// Helper to create a fresh registry for isolated tests
function createRegistry() {
	const handlers = new Map<string, SubprocessToolHandler>();
	return {
		register<T>(toolName: string, handler: SubprocessToolHandler<T>): void {
			handlers.set(toolName, handler as SubprocessToolHandler);
		},
		getHandler(toolName: string): SubprocessToolHandler | undefined {
			return handlers.get(toolName);
		},
		hasHandler(toolName: string): boolean {
			return handlers.has(toolName);
		},
		getRegisteredTools(): string[] {
			return [...handlers.keys()];
		},
		extractAll(event: SubprocessToolEvent): Record<string, unknown> {
			const extracted: Record<string, unknown> = {};
			for (const [toolName, handler] of handlers) {
				if (handler.extractData) {
					const data = handler.extractData(event);
					if (data !== undefined) {
						extracted[toolName] = data;
					}
				}
			}
			return extracted;
		},
	};
}

function makeEvent(overrides: Partial<SubprocessToolEvent> = {}): SubprocessToolEvent {
	return {
		toolName: "test_tool",
		toolCallId: "call-1",
		...overrides,
	};
}

test("register and getHandler", () => {
	const registry = createRegistry();
	const handler: SubprocessToolHandler<{ count: number }> = {
		extractData: (e) => ({ count: e.toolCallId.length }),
	};
	registry.register("read", handler);
	const got = registry.getHandler("read");
	assert.ok(got);
	assert.equal(typeof got.extractData, "function");
});

test("hasHandler returns false for unknown tools", () => {
	const registry = createRegistry();
	assert.equal(registry.hasHandler("nonexistent"), false);
	registry.register("read", {});
	assert.equal(registry.hasHandler("read"), true);
	assert.equal(registry.hasHandler("write"), false);
});

test("getRegisteredTools lists all registered", () => {
	const registry = createRegistry();
	registry.register("read", {});
	registry.register("write", {});
	registry.register("bash", {});
	const tools = registry.getRegisteredTools();
	assert.deepEqual(tools.sort(), ["bash", "read", "write"]);
});

test("extractAll collects from multiple handlers", () => {
	const registry = createRegistry();
	registry.register("read", {
		extractData: () => ({ bytes: 42 }),
	});
	registry.register("bash", {
		extractData: () => ({ exitCode: 0 }),
	});
	const result = registry.extractAll(makeEvent({ toolName: "any" }));
	assert.deepEqual(result, {
		read: { bytes: 42 },
		bash: { exitCode: 0 },
	});
});

test("extractAll skips handlers that return undefined", () => {
	const registry = createRegistry();
	registry.register("read", {
		extractData: () => ({ path: "/tmp" }),
	});
	registry.register("skip_me", {
		extractData: () => undefined,
	});
	registry.register("bash", {
		extractData: () => ({ cmd: "ls" }),
	});
	const result = registry.extractAll(makeEvent({ toolName: "any" }));
	assert.ok(!("skip_me" in result), "should not include undefined results");
	assert.deepEqual(result, {
		read: { path: "/tmp" },
		bash: { cmd: "ls" },
	});
});

test("shouldTerminate delegation", () => {
	const registry = createRegistry();
	const terminated = false;
	registry.register("write", {
		shouldTerminate: (e) => e.isError === true,
	});
	registry.register("read", {
		shouldTerminate: () => false,
	});

	const writeHandler = registry.getHandler("write");
	assert.ok(writeHandler?.shouldTerminate);
	assert.equal(writeHandler.shouldTerminate(makeEvent({ isError: true })), true);
	assert.equal(writeHandler.shouldTerminate(makeEvent({ isError: false })), false);

	const readHandler = registry.getHandler("read");
	assert.ok(readHandler?.shouldTerminate);
	assert.equal(readHandler.shouldTerminate(makeEvent()), false);
});

test("singleton subprocessToolRegistry is importable and functional", () => {
	assert.ok(subprocessToolRegistry);
	assert.equal(typeof subprocessToolRegistry.register, "function");
	assert.equal(typeof subprocessToolRegistry.hasHandler, "function");
	assert.equal(typeof subprocessToolRegistry.getHandler, "function");
	assert.equal(typeof subprocessToolRegistry.getRegisteredTools, "function");
	assert.equal(typeof subprocessToolRegistry.extractAll, "function");
});
