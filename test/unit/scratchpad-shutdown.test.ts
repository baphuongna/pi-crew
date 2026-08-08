import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "../../src/extension/pi-api.ts";
import {
	cancelScratchpadSnapshot,
	PI_CREW_ARTIFACTS_ROOT_ENV,
	PI_CREW_SCRATCHPAD_SNAPSHOT_ENV,
	PI_CREW_TASK_ID_ENV,
	registerScratchpadLifecycle,
	scheduleScratchpadSnapshot,
} from "../../src/prompt/scratchpad-lifecycle.ts";
import type { EngineManager } from "../../src/runtime/scratchpad/engine.ts";
import type { ArtifactWriteOptions } from "../../src/state/stores/artifact-store.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

interface MockEngineShape {
	isRunning: boolean;
	state: "idle" | "starting" | "running" | "shutdown";
	snapshotState: () => Promise<{ path: string; saved: string[]; failed: { name: string; reason: string }[] } | null>;
	kill: () => Promise<void>;
}

function makeMockEngine(overrides: Partial<MockEngineShape> = {}): { engine: EngineManager; calls: Record<string, number> } {
	const calls: Record<string, number> = { snapshotState: 0, kill: 0 };
	const base: MockEngineShape = {
		isRunning: true,
		state: "running",
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

function makeFakePi(): { pi: ExtensionAPI; state: { shutdownHandler?: (e: { reason: string }) => unknown }; registered: unknown[] } {
	const state: { shutdownHandler?: (e: { reason: string }) => unknown } = {};
	const registered: unknown[] = [];
	const pi = {
		on: (event: string, handler: (e: { reason: string }) => unknown) => {
			if (event === "session_shutdown") state.shutdownHandler = handler;
		},
		registerTool: (tool: unknown) => {
			registered.push(tool);
		},
	} as unknown as ExtensionAPI;
	return { pi, state, registered };
}

interface TempCtx {
	root: string;
	artifactsRoot: string;
	snapshotPath: string;
	cleanup(): void;
}

function makeTempCtx(): TempCtx {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-scratchpad-shutdown-"));
	const artifactsRoot = path.join(root, "artifacts");
	const snapshotDir = path.join(root, "snap");
	fs.mkdirSync(artifactsRoot, { recursive: true });
	fs.mkdirSync(snapshotDir, { recursive: true });
	const snapshotPath = path.join(snapshotDir, "task-1.snapshot.json");
	return { root, artifactsRoot, snapshotPath, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function makeEnv(ctx: TempCtx): NodeJS.ProcessEnv {
	return {
		PI_CREW_SCRATCHPAD: "1",
		PI_CREW_KIND: "subagent",
		[PI_CREW_TASK_ID_ENV]: "task-1",
		PI_CREW_ATTEMPT: "1",
		[PI_CREW_ARTIFACTS_ROOT_ENV]: ctx.artifactsRoot,
		[PI_CREW_SCRATCHPAD_SNAPSHOT_ENV]: ctx.snapshotPath,
	};
}

function capturedWriteArtifact() {
	const calls: Array<{ root: string; options: ArtifactWriteOptions }> = [];
	const spy = (root: string, options: ArtifactWriteOptions): unknown => {
		calls.push({ root, options });
		return null;
	};
	return { calls, spy };
}

function wireLifecycle(
	engine: EngineManager,
	ctx: TempCtx,
	opts: { writeArtifact?: (root: string, options: ArtifactWriteOptions) => unknown; log?: (scope: string, error: unknown) => void } = {},
) {
	const fake = makeFakePi();
	const env = makeEnv(ctx);
	registerScratchpadLifecycle(fake.pi, {
		engine,
		env,
		...(opts.writeArtifact ? { writeArtifact: opts.writeArtifact } : {}),
		...(opts.log ? { logInternalError: opts.log } : {}),
	});
	return { pi: fake.pi, state: fake.state, env };
}

// ── tests ───────────────────────────────────────────────────────────────────

afterEach(() => {
	cancelScratchpadSnapshot();
});

describe("scratchpad-shutdown (T7 §10.4 / plan T7 — F3/F5/F22)", () => {
	it("F3/F5: reason 'quit' → flush (snapshot→writeArtifact) then kill", async () => {
		const ctx = makeTempCtx();
		try {
			fs.writeFileSync(ctx.snapshotPath, JSON.stringify({ version: 1, vars: { x: "1" }, failed: [] }));
			const { engine, calls } = makeMockEngine({
				snapshotState: async () => {
					calls.snapshotState++;
					return { path: ctx.snapshotPath, saved: ["x"], failed: [] };
				},
			});
			const { calls: writes, spy } = capturedWriteArtifact();
			const { state } = wireLifecycle(engine, ctx, { writeArtifact: spy });
			assert.ok(state.shutdownHandler, "session_shutdown handler must be registered");
			await state.shutdownHandler!({ reason: "quit" });
			assert.equal(calls.snapshotState, 1, "quit must flush the final snapshot");
			assert.equal(writes.length, 1);
			assert.equal(writes[0].options.relativePath, "scratchpad/task-1.attempt-1.snapshot.json");
			assert.equal(calls.kill, 1, "quit must kill the engine");
			assert.equal(fs.existsSync(ctx.snapshotPath), false, "raw temp cleaned after quit flush");
		} finally {
			ctx.cleanup();
		}
	});

	it("F3/F5: reload/new/resume/fork → no-op (engine stays alive, no flush, no kill)", async () => {
		const ctx = makeTempCtx();
		try {
			fs.writeFileSync(ctx.snapshotPath, JSON.stringify({ version: 1, vars: {}, failed: [] }));
			const { engine, calls } = makeMockEngine({
				snapshotState: async () => {
					calls.snapshotState++;
					return { path: ctx.snapshotPath, saved: [], failed: [] };
				},
			});
			const { calls: writes, spy } = capturedWriteArtifact();
			const { state } = wireLifecycle(engine, ctx, { writeArtifact: spy });
			for (const reason of ["reload", "new", "resume", "fork"]) {
				await state.shutdownHandler!({ reason });
			}
			assert.equal(calls.snapshotState, 0, "non-quit reasons must not flush");
			assert.equal(writes.length, 0, "non-quit reasons must not write artifacts");
			assert.equal(calls.kill, 0, "non-quit reasons must not kill (state:shutdown is terminal)");
		} finally {
			ctx.cleanup();
		}
	});

	it("F22: quit with idle engine → no snapshotState (no chmod ENOENT), no kill", async () => {
		const ctx = makeTempCtx();
		try {
			const { engine, calls } = makeMockEngine({ isRunning: false, state: "idle" });
			const { calls: writes, spy } = capturedWriteArtifact();
			const { state } = wireLifecycle(engine, ctx, { writeArtifact: spy });
			await state.shutdownHandler!({ reason: "quit" });
			assert.equal(calls.snapshotState, 0, "idle engine must not be flushed");
			assert.equal(writes.length, 0);
			assert.equal(calls.kill, 0);
		} finally {
			ctx.cleanup();
		}
	});

	it("R-3/SEC-RACE-1: quit-flush cancels a pending debounced snapshot (no double write of the same temp path)", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const ctx = makeTempCtx();
		try {
			fs.writeFileSync(ctx.snapshotPath, JSON.stringify({ version: 1, vars: {}, failed: [] }));
			const { engine, calls } = makeMockEngine({
				snapshotState: async () => {
					calls.snapshotState++;
					return { path: ctx.snapshotPath, saved: [], failed: [] };
				},
			});
			const { calls: writes, spy } = capturedWriteArtifact();
			const env = makeEnv(ctx);
			// A debounced snapshot is already scheduled (unfired).
			scheduleScratchpadSnapshot({ engine, writeArtifact: spy, env }, 1500);
			const { state } = wireLifecycle(engine, ctx, { writeArtifact: spy });
			await state.shutdownHandler!({ reason: "quit" });
			// The quit flush itself produced exactly one snapshot+write.
			assert.equal(calls.snapshotState, 1);
			assert.equal(writes.length, 1);
			// Let the debounce window elapse — the cancelled timer must NOT fire.
			t.mock.timers.tick(5000);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(calls.snapshotState, 1, "cancelled debounce must not race the quit flush");
			assert.equal(writes.length, 1);
		} finally {
			t.mock.timers.reset();
			ctx.cleanup();
		}
	});

	it("F13: shutdown-flush failures are logged, not thrown", async () => {
		const ctx = makeTempCtx();
		try {
			const { engine } = makeMockEngine({
				snapshotState: async () => {
					throw new Error("snapshot exploded");
				},
			});
			const logged: string[] = [];
			const { state } = wireLifecycle(engine, ctx, {
				log: (scope) => logged.push(scope),
			});
			await state.shutdownHandler!({ reason: "quit" });
			assert.ok(logged.includes("scratchpad.shutdown-flush") || logged.includes("scratchpad.snapshot"), "error must be surfaced");
		} finally {
			ctx.cleanup();
		}
	});
});
