import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	cancelScratchpadSnapshot,
	createExecuteTool,
	PI_CREW_ARTIFACTS_ROOT_ENV,
	PI_CREW_SCRATCHPAD_SNAPSHOT_ENV,
	PI_CREW_TASK_ID_ENV,
	performShutdownFlush,
	SCRATCHPAD_DOCTRINE,
	scheduleScratchpadSnapshot,
} from "../../src/prompt/scratchpad-lifecycle.ts";
import type { EngineManager } from "../../src/runtime/scratchpad/engine.ts";
import type { ArtifactWriteOptions } from "../../src/state/stores/artifact-store.ts";

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
	start: () => Promise<void>;
	listNamespaceNames: () => Promise<string[] | null>;
	snapshotState: () => Promise<{ path: string; saved: string[]; failed: { name: string; reason: string }[] } | null>;
	kill: () => Promise<void>;
}

function makeMockEngine(overrides: Partial<MockEngineShape> = {}): { engine: EngineManager; calls: Record<string, number> } {
	const calls: Record<string, number> = { execute: 0, start: 0, listNamespaceNames: 0, snapshotState: 0, kill: 0 };
	const base: MockEngineShape = {
		isRunning: false,
		state: "idle",
		execute: async () => {
			calls.execute++;
			return { stdout: "", stderr: "", status: "ok", durationMs: 1, result: "2" };
		},
		start: async () => {
			calls.start++;
		},
		listNamespaceNames: async () => {
			calls.listNamespaceNames++;
			return ["x"];
		},
		snapshotState: async () => {
			calls.snapshotState++;
			return null;
		},
		kill: async () => {
			calls.kill++;
		},
	};
	return { engine: { ...base, ...overrides } as unknown as EngineManager, calls };
}

interface TempCtx {
	root: string;
	artifactsRoot: string;
	snapshotPath: string;
	cleanup(): void;
}

function makeTempCtx(): TempCtx {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-scratchpad-lifecycle-"));
	const artifactsRoot = path.join(root, "artifacts");
	const snapshotDir = path.join(root, "snap");
	fs.mkdirSync(artifactsRoot, { recursive: true });
	fs.mkdirSync(snapshotDir, { recursive: true });
	return {
		root,
		artifactsRoot,
		snapshotPath: path.join(snapshotDir, "task-1.snapshot.json"),
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

function makeEnv(ctx: TempCtx): NodeJS.ProcessEnv {
	return {
		PI_CREW_SCRATCHPAD: "1",
		PI_CREW_KIND: "subagent",
		[PI_CREW_TASK_ID_ENV]: "task-1",
		PI_CREW_ATTEMPT: "0",
		[PI_CREW_ARTIFACTS_ROOT_ENV]: ctx.artifactsRoot,
		[PI_CREW_SCRATCHPAD_SNAPSHOT_ENV]: ctx.snapshotPath,
	};
}

function noopWriteArtifact(_root: string, _options: ArtifactWriteOptions): unknown {
	return null;
}

// ── tests ───────────────────────────────────────────────────────────────────

afterEach(() => {
	cancelScratchpadSnapshot();
});

describe("scratchpad doctrine truthfulness (plan I1/I2 — no absent tools advertised)", () => {
	it("I1: doctrine does not advertise a tools bridge that does not exist (no 'await expressions' tool-call claim)", () => {
		for (const line of SCRATCHPAD_DOCTRINE) {
			assert.ok(
				!line.includes("await expressions") && !line.includes("tools.read") && !line.includes("await tools"),
				`doctrine must not advertise absent tool bindings: ${line}`,
			);
		}
	});

	it("I2: doctrine references no <rlm_engine_reset> marker that pi-crew never emits", () => {
		for (const line of SCRATCHPAD_DOCTRINE) {
			assert.ok(!line.includes("<rlm_engine_reset>"), `doctrine must not reference the foreign <rlm_engine_reset> marker: ${line}`);
		}
	});

	it("I2: doctrine teaches the real [scratchpad] restore/reset notice prefix", () => {
		const joined = SCRATCHPAD_DOCTRINE.join("\n");
		assert.ok(joined.includes("[scratchpad]"), "doctrine must teach the real [scratchpad] prefix");
		assert.ok(/re-verify variables/.test(joined), "doctrine must tell the model to re-verify variables after a restore");
		assert.ok(joined.includes("especially inside shell commands"), "doctrine must keep the I6-pairing shell-command clause");
	});

	it("I3: the model-facing tool surface is English (no Vietnamese in description/promptSnippet)", () => {
		const tool = createExecuteTool(makeMockEngine().engine, { env: makeEnv(makeTempCtx()) });
		const { description, promptSnippet, promptGuidelines } = tool;
		const nonAscii = /[\u00C0-\u1FFF\u2E80-\u9FFF\uAC00-\uD7AF]/; // accented/Vietnamese + CJK
		assert.ok(description !== undefined && !nonAscii.test(description), `description must be English, got: ${description}`);
		assert.ok(promptSnippet !== undefined && !nonAscii.test(promptSnippet), `promptSnippet must be English, got: ${promptSnippet}`);
		assert.ok(Array.isArray(promptGuidelines) && promptGuidelines.length > 0, "promptGuidelines must remain populated");
	});
});

describe("scratchpad-lifecycle (T7 §10.6 / plan T7 — F21)", () => {
	it("F21: lazy start — the handler never calls start() before the first execute (lazy start is inside engine.execute)", async () => {
		const { engine, calls } = makeMockEngine({ isRunning: false, state: "idle" });
		const tool = createExecuteTool(engine, { env: makeEnv(makeTempCtx()) });
		await tool.execute("c1", { code: "1+1" }, undefined, undefined, {} as never);
		assert.equal(calls.start, 0, "handler must not force a guest start");
		assert.equal(calls.listNamespaceNames, 0, "idle engine must not be pinged");
		assert.equal(calls.execute, 1, "first execute runs and lazy-starts inside the engine");
	});

	it("F21: session_shutdown flush runs when the engine is running", async () => {
		const ctx = makeTempCtx();
		try {
			fs.writeFileSync(ctx.snapshotPath, JSON.stringify({ version: 1, vars: {}, failed: [] }));
			const { engine, calls } = makeMockEngine({
				isRunning: true,
				state: "running",
				snapshotState: async () => {
					calls.snapshotState++;
					return { path: ctx.snapshotPath, saved: [], failed: [] };
				},
			});
			await performShutdownFlush(engine, { env: makeEnv(ctx), writeArtifact: noopWriteArtifact });
			assert.equal(calls.snapshotState, 1);
			assert.equal(calls.kill, 1);
			assert.equal(fs.existsSync(ctx.snapshotPath), false, "raw temp cleaned by the flush");
		} finally {
			ctx.cleanup();
		}
	});

	it("F21: session_shutdown does NOT flush when the engine is idle", async () => {
		const ctx = makeTempCtx();
		try {
			const { engine, calls } = makeMockEngine({ isRunning: false, state: "idle" });
			await performShutdownFlush(engine, { env: makeEnv(ctx), writeArtifact: noopWriteArtifact });
			assert.equal(calls.snapshotState, 0);
			assert.equal(calls.kill, 0);
		} finally {
			ctx.cleanup();
		}
	});

	it("D5: only one debounce timer is alive — re-scheduling clears the previous one", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const ctx = makeTempCtx();
		try {
			fs.writeFileSync(ctx.snapshotPath, JSON.stringify({ version: 1, vars: {}, failed: [] }));
			const { engine, calls } = makeMockEngine({
				isRunning: true,
				state: "running",
				snapshotState: async () => {
					calls.snapshotState++;
					return { path: ctx.snapshotPath, saved: [], failed: [] };
				},
			});
			const env = makeEnv(ctx);
			scheduleScratchpadSnapshot({ engine, writeArtifact: noopWriteArtifact, env }, 1500);
			scheduleScratchpadSnapshot({ engine, writeArtifact: noopWriteArtifact, env }, 1500); // clears the first
			t.mock.timers.tick(1500);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(calls.snapshotState, 1, "two schedules must produce exactly one flush");
		} finally {
			t.mock.timers.reset();
			ctx.cleanup();
		}
	});

	it("F8: no debounced snapshot is scheduled after an errored cell", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const ctx = makeTempCtx();
		try {
			const { engine, calls } = makeMockEngine({
				isRunning: true,
				state: "running",
				execute: async () => {
					calls.execute++;
					return {
						stdout: "",
						stderr: "",
						status: "error" as const,
						durationMs: 2,
						error: { name: "Error", message: "boom", stack: ["at x"] },
					};
				},
				snapshotState: async () => {
					calls.snapshotState++;
					return null;
				},
			});
			const tool = createExecuteTool(engine, { env: makeEnv(ctx) });
			await tool.execute("c1", { code: "throw" }, undefined, undefined, {} as never);
			t.mock.timers.tick(5000);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(calls.snapshotState, 0, "an errored cell must not schedule a snapshot");
		} finally {
			t.mock.timers.reset();
			ctx.cleanup();
		}
	});
});
