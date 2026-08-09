import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "../../src/extension/pi-api.ts";
import {
	cancelScratchpadSnapshot,
	createExecuteTool,
	type ExecuteToolDefinition,
	PI_CREW_KIND_ENV,
	PI_CREW_SCRATCHPAD_ENV,
	registerScratchpadLifecycle,
	shouldRegisterScratchpadTool,
} from "../../src/prompt/scratchpad-lifecycle.ts";
import type { EngineManager } from "../../src/runtime/scratchpad/engine.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

interface MockEngineShape {
	isRunning: boolean;
	state: "idle" | "starting" | "running" | "shutdown";
	execute: () => Promise<{
		stdout: string;
		stderr: string;
		status: "ok" | "error" | "aborted";
		durationMs: number;
		result?: string;
		error?: { name: string; message: string; stack: string[] };
	}>;
	listNamespaceNames: () => Promise<string[] | null>;
	start: () => Promise<void>;
	snapshotState: () => Promise<{ path: string; saved: string[]; failed: { name: string; reason: string }[] } | null>;
	kill: () => Promise<void>;
}

function makeMockEngine(overrides: Partial<MockEngineShape> = {}): { engine: EngineManager; calls: Record<string, number> } {
	const calls: Record<string, number> = { execute: 0, listNamespaceNames: 0, start: 0, snapshotState: 0, kill: 0 };
	const base: MockEngineShape = {
		isRunning: false,
		state: "idle",
		execute: async () => {
			calls.execute++;
			return { stdout: "", stderr: "", status: "ok", durationMs: 1, result: "2" };
		},
		listNamespaceNames: async () => {
			calls.listNamespaceNames++;
			return ["x"];
		},
		start: async () => {
			calls.start++;
		},
		snapshotState: async () => null,
		kill: async () => {
			calls.kill++;
		},
	};
	return { engine: { ...base, ...overrides } as unknown as EngineManager, calls };
}

function makeFakePi(): { pi: ExtensionAPI; handlers: Map<string, (e: unknown) => unknown>; registered: unknown[] } {
	const handlers = new Map<string, (e: unknown) => unknown>();
	const registered: unknown[] = [];
	const pi = {
		on: (event: string, handler: (e: unknown) => unknown) => {
			handlers.set(event, handler);
		},
		registerTool: (tool: unknown) => {
			registered.push(tool);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, registered };
}

function okEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
	return { [PI_CREW_SCRATCHPAD_ENV]: "1", [PI_CREW_KIND_ENV]: "subagent", ...overrides };
}

// ── tests ───────────────────────────────────────────────────────────────────

afterEach(() => {
	cancelScratchpadSnapshot();
});

describe("scratchpad-tool-gating (T7 §10.2 / plan T7)", () => {
	it("D3/SEC-2: shouldRegisterScratchpadTool is true only for env 1 + subagent kind", () => {
		assert.equal(shouldRegisterScratchpadTool(okEnv()), true);
		assert.equal(shouldRegisterScratchpadTool({}), false);
		assert.equal(shouldRegisterScratchpadTool({ [PI_CREW_SCRATCHPAD_ENV]: "1" }), false, "kind must be subagent (SEC-2)");
		assert.equal(shouldRegisterScratchpadTool({ [PI_CREW_KIND_ENV]: "subagent" }), false, "scratchpad env must be 1");
		assert.equal(
			shouldRegisterScratchpadTool({ [PI_CREW_SCRATCHPAD_ENV]: "0", [PI_CREW_KIND_ENV]: "subagent" }),
			false,
			"explicit 0 must not register",
		);
		assert.equal(
			shouldRegisterScratchpadTool({ [PI_CREW_SCRATCHPAD_ENV]: "1", [PI_CREW_KIND_ENV]: "main" }),
			false,
			"main session kind must never activate the tool",
		);
	});

	it("registerScratchpadLifecycle registers execute when env 1 + subagent, else not", () => {
		const { pi, registered } = makeFakePi();
		registerScratchpadLifecycle(pi, { env: okEnv() });
		assert.equal(registered.length, 1);
		assert.equal((registered[0] as { name: string }).name, "scratchpad");
	});

	it("registerScratchpadLifecycle does NOT register when env differs (D3)", () => {
		const { pi, registered } = makeFakePi();
		registerScratchpadLifecycle(pi, { env: {} });
		assert.equal(registered.length, 0);
	});

	it("SEC-2: env 1 without subagent kind does NOT register (leaked env cannot activate)", () => {
		const { pi, registered } = makeFakePi();
		registerScratchpadLifecycle(pi, { env: { [PI_CREW_SCRATCHPAD_ENV]: "1" } });
		assert.equal(registered.length, 0);
	});

	it("layer-2 dormant: handler throws 'scratchpad is dormant' when env !== 1", async () => {
		const { engine } = makeMockEngine();
		const tool = createExecuteTool(engine, { env: { [PI_CREW_SCRATCHPAD_ENV]: "0" } });
		await assert.rejects(tool.execute("c1", { code: "1+1" }, undefined, undefined, {} as never), /scratchpad is dormant/);
	});

	it("dormant: engine is untouched (no ping, no execute)", async () => {
		const { engine, calls } = makeMockEngine({ isRunning: true, state: "running" });
		const tool = createExecuteTool(engine, { env: { [PI_CREW_SCRATCHPAD_ENV]: "0" } });
		await assert.rejects(tool.execute("c1", { code: "1+1" }, undefined, undefined, {} as never), /scratchpad is dormant/);
		assert.equal(calls.listNamespaceNames, 0);
		assert.equal(calls.execute, 0);
	});

	it("N2-2: first execute on an idle engine SKIPS the ping and runs (no false-positive wedged)", async () => {
		const { engine, calls } = makeMockEngine({ isRunning: false, state: "idle" });
		const tool = createExecuteTool(engine, { env: okEnv() });
		const result = await tool.execute("c1", { code: "1+1" }, undefined, undefined, {} as never);
		assert.equal(calls.listNamespaceNames, 0, "idle engine must not be pinged");
		assert.equal(calls.execute, 1, "execute must run (lazy start is inside engine.execute)");
		assert.equal(result.details.status, "ok");
		assert.match((result.content[0] as { text?: string }).text ?? "", /status: ok/);
	});

	it("S-2: running engine with null ping → system error 'wedged', execute NOT called", async () => {
		const { engine, calls } = makeMockEngine({
			isRunning: true,
			state: "running",
			listNamespaceNames: async () => {
				calls.listNamespaceNames++;
				return null;
			},
		});
		const tool = createExecuteTool(engine, { env: okEnv() });
		await assert.rejects(tool.execute("c1", { code: "while(true){}" }, undefined, undefined, {} as never), /engine wedged/);
		assert.equal(calls.listNamespaceNames, 1);
		assert.equal(calls.execute, 0, "wedged engine must not be asked to run another cell");
	});

	it("S-2: running engine with healthy ping proceeds to execute", async () => {
		const { engine, calls } = makeMockEngine({ isRunning: true, state: "running" });
		const tool = createExecuteTool(engine, { env: okEnv() });
		const result = await tool.execute("c1", { code: "1+1" }, undefined, undefined, {} as never);
		assert.equal(calls.listNamespaceNames, 1);
		assert.equal(calls.execute, 1);
		assert.equal(result.details.status, "ok");
	});

	it("F12: engine state 'shutdown' → system error 'engine đã chết (shutdown)', NOT 'wedged'", async () => {
		const { engine, calls } = makeMockEngine({ isRunning: false, state: "shutdown" });
		const tool = createExecuteTool(engine, { env: okEnv() });
		await assert.rejects(tool.execute("c1", { code: "1+1" }, undefined, undefined, {} as never), /đã chết \(shutdown\)/);
		await assert.rejects(
			tool.execute("c1", { code: "1+1" }, undefined, undefined, {} as never),
			(error: Error) => !/wedged/.test(error.message),
			"shutdown must not be mislabeled as wedged",
		);
		assert.equal(calls.listNamespaceNames, 0);
		assert.equal(calls.execute, 0);
	});

	it("R-5: aborted status is error-as-data (no throw), engine not flushed", async () => {
		const { engine, calls } = makeMockEngine({
			isRunning: true,
			state: "running",
			execute: async () => {
				calls.execute++;
				return { stdout: "", stderr: "", status: "aborted" as const, durationMs: 120_000 };
			},
		});
		const tool = createExecuteTool(engine, { env: okEnv() });
		const result = await tool.execute("c1", { code: "slow()" }, undefined, undefined, {} as never);
		assert.equal(result.details.status, "aborted");
		assert.match((result.content[0] as { text?: string }).text ?? "", /status: aborted/);
	});

	it("R-5: error status is error-as-data with stack capped at 20 lines", async () => {
		const stack = Array.from({ length: 30 }, (_, i) => `line-${i}`);
		const { engine } = makeMockEngine({
			isRunning: true,
			state: "running",
			execute: async () => {
				return {
					stdout: "",
					stderr: "",
					status: "error" as const,
					durationMs: 2,
					error: { name: "TypeError", message: "boom", stack },
				};
			},
		});
		const tool = createExecuteTool(engine, { env: okEnv() });
		const result = await tool.execute("c1", { code: "throw new TypeError('boom')" }, undefined, undefined, {} as never);
		assert.equal(result.details.status, "error");
		assert.equal(result.details.error?.stack.length, 20);
		assert.equal(result.details.error?.message, "boom");
	});

	it("system error: engine.execute throw propagates as system failure", async () => {
		const { engine } = makeMockEngine({
			isRunning: true,
			state: "running",
			execute: async () => {
				throw new Error("Engine has been shut down");
			},
		});
		const tool = createExecuteTool(engine, { env: okEnv() });
		await assert.rejects(
			tool.execute("c1", { code: "1" }, undefined, undefined, {} as never),
			/engine failed: Engine has been shut down/,
		);
	});

	it("tool surface: execute definition carries the required fields (F9 doctrine, renderShell default)", () => {
		const { engine } = makeMockEngine();
		const tool = createExecuteTool(engine, { env: okEnv() });
		const def = tool as unknown as ExecuteToolDefinition;
		assert.equal(def.name, "scratchpad");
		assert.equal(def.renderShell, "default");
		assert.ok(
			Array.isArray(def.promptGuidelines) && (def.promptGuidelines as string[]).length >= 5,
			"F9 doctrine via promptGuidelines",
		);
		assert.ok(def.promptSnippet, "promptSnippet present");
	});
});
