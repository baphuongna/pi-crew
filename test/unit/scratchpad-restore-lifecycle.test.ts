import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ToolDefinition } from "../../src/extension/pi-api.ts";
import {
	PI_CREW_ARTIFACTS_ROOT_ENV,
	PI_CREW_KIND_ENV,
	PI_CREW_SCRATCHPAD_ENV,
	PI_CREW_SCRATCHPAD_RESTORE_ENV,
	PI_CREW_SCRATCHPAD_RESTORE_MTIME_ENV,
	PI_CREW_SCRATCHPAD_SNAPSHOT_ENV,
	PI_CREW_TASK_ID_ENV,
	RESTORE_MTIME_TOLERANCE_MS,
	registerScratchpadLifecycle,
	SNAPSHOT_MAX_BYTES,
	validateRestoreEnv,
} from "../../src/prompt/scratchpad-lifecycle.ts";
import type { EngineManager } from "../../src/runtime/scratchpad/engine.ts";

// Phase 2 — P2-T3: restore-on-first-execute lifecycle (D3/D10/D11, MAJOR-P1:
// re-validation at READ time; MAJOR-P2: capture-before-null ordering).

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
	restoreState: () => Promise<{ path: string; restored: string[]; failed: { name: string; reason: string }[] } | null>;
	kill: () => Promise<void>;
}

function makeMockEngine(overrides: Partial<MockEngineShape> = {}): {
	engine: EngineManager;
	restoreCalls: () => number;
} {
	const state = { restoreCalls: 0 };
	const base: MockEngineShape = {
		isRunning: false,
		state: "idle",
		execute: async () => ({ stdout: "", stderr: "", status: "ok", durationMs: 1, result: "42" }),
		start: async () => {
			/* noop */
		},
		listNamespaceNames: async () => ["x"],
		restoreState: async () => {
			state.restoreCalls++;
			return { path: "/p", restored: ["data"], failed: [{ name: "apiKey", reason: "redacted" }] };
		},
		kill: async () => {
			/* noop */
		},
	};
	return { engine: { ...base, ...overrides } as unknown as EngineManager, restoreCalls: () => state.restoreCalls };
}

interface Ctx {
	root: string;
	artifacts: string;
	snapshotFile: string;
	env: Record<string, string>;
	engine: EngineManager;
	restoreCalls: () => number;
	tool: ToolDefinition<any, any> | null;
}

function makeCtx(overrides: { env?: Record<string, string>; engine?: Partial<MockEngineShape> } = {}): Ctx {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "p2-restore-"));
	createdRoots.push(root);
	const artifacts = path.join(root, "artifacts");
	fs.mkdirSync(path.join(artifacts, "scratchpad"), { recursive: true });
	const snapshotFile = path.join(artifacts, "scratchpad", "task-1.attempt-0.snapshot.json");
	fs.writeFileSync(snapshotFile, JSON.stringify({ version: 1, vars: { data: "eA==" }, failed: [] }));
	const env: Record<string, string> = {
		[PI_CREW_SCRATCHPAD_ENV]: "1",
		[PI_CREW_KIND_ENV]: "subagent",
		[PI_CREW_TASK_ID_ENV]: "task-1",
		[PI_CREW_ARTIFACTS_ROOT_ENV]: artifacts,
		[PI_CREW_SCRATCHPAD_SNAPSHOT_ENV]: path.join(root, "raw.snapshot.json"),
		[PI_CREW_SCRATCHPAD_RESTORE_ENV]: snapshotFile,
		[PI_CREW_SCRATCHPAD_RESTORE_MTIME_ENV]: String(fs.statSync(snapshotFile).mtimeMs),
		...overrides.env,
	};
	const mock = makeMockEngine(overrides.engine);
	const captured: { tool: ToolDefinition<any, any> | null } = { tool: null };
	const fakePi = {
		registerTool: (t: ToolDefinition<any, any>) => {
			captured.tool = t;
		},
		on: () => {
			/* noop */
		},
	} as any;
	registerScratchpadLifecycle(fakePi, { engine: mock.engine, env });
	return { root, artifacts, snapshotFile, env, engine: mock.engine, restoreCalls: mock.restoreCalls, tool: captured.tool };
}

const createdRoots: string[] = [];
afterEach(() => {
	// NIT-4: scope cleanup to this file's own roots only (a broad `p2-restore-*`
	// glob would race parallel test files sharing os.tmpdir()).
	for (const root of createdRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("P2-T3 restore lifecycle", () => {
	it("restores exactly ONCE on first execute; notice carries attempt + restored/failed var names (MINOR-5)", async () => {
		const ctx = makeCtx();
		assert.ok(ctx.tool, "tool must be registered (env is armed)");
		const first = await ctx.tool!.execute("x", { code: "1+1" }, undefined, undefined, undefined as any);
		const text = (first.content[0] as { text: string }).text;
		assert.match(text, /\[scratchpad\] restored 1 vars from attempt-0/);
		assert.match(text, /restored: \[data\]/);
		assert.match(text, /failed: \[apiKey\]/);
		assert.match(text, /status: ok/);
		assert.equal(ctx.restoreCalls(), 1);
		// second execute: no restore again (D3 — once per session)
		const second = await ctx.tool!.execute("x", { code: "1+1" }, undefined, undefined, undefined as any);
		assert.equal(ctx.restoreCalls(), 1);
		assert.doesNotMatch((second.content[0] as { text: string }).text, /snapshot restore/);
	});

	it("no restore env → no restore call, no notice", async () => {
		const ctx = makeCtx({ env: { [PI_CREW_SCRATCHPAD_RESTORE_ENV]: "", [PI_CREW_SCRATCHPAD_RESTORE_MTIME_ENV]: "" } });
		const res = await ctx.tool!.execute("x", { code: "1+1" }, undefined, undefined, undefined as any);
		assert.equal(ctx.restoreCalls(), 0);
		assert.doesNotMatch((res.content[0] as { text: string }).text, /scratchpad\]/);
	});

	it("file vanished after register → fail-open: no restore, execute still runs, no path leak", async () => {
		const ctx = makeCtx();
		fs.unlinkSync(ctx.snapshotFile); // swap: file removed after register
		const res = await ctx.tool!.execute("x", { code: "1+1" }, undefined, undefined, undefined as any);
		assert.equal(ctx.restoreCalls(), 0);
		assert.match((res.content[0] as { text: string }).text, /status: ok/);
		assert.doesNotMatch((res.content[0] as { text: string }).text, /p2-restore-|artifacts/, "no absolute path may leak");
	});

	it("path inside container but wrong pattern → fail-closed, no restore (D10 layer 2)", async () => {
		const ctx = makeCtx();
		const wrong = path.join(ctx.artifacts, "scratchpad", "task-1.other.json");
		fs.writeFileSync(wrong, "{}");
		const ctx2 = makeCtx({
			env: { [PI_CREW_SCRATCHPAD_RESTORE_ENV]: wrong, [PI_CREW_SCRATCHPAD_RESTORE_MTIME_ENV]: "" },
		});
		const res = await ctx2.tool!.execute("x", { code: "1+1" }, undefined, undefined, undefined as any);
		assert.equal(ctx2.restoreCalls(), 0);
		assert.match((res.content[0] as { text: string }).text, /status: ok/, "fail-open execute continues");
	});

	it("symlink restore path → fail-closed (D10 layer 3)", async () => {
		const ctx = makeCtx();
		fs.unlinkSync(ctx.snapshotFile);
		const outside = path.join(ctx.root, "outside-target.json");
		fs.writeFileSync(outside, "{}");
		try {
			fs.symlinkSync(outside, ctx.snapshotFile);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EPERM" || code === "EACCES") return; // symlinks unsupported — skip
			throw error;
		}
		const res = await ctx.tool!.execute("x", { code: "1+1" }, undefined, undefined, undefined as any);
		assert.equal(ctx.restoreCalls(), 0);
		assert.match((res.content[0] as { text: string }).text, /status: ok/);
	});

	it("restoreState throws (engine start fail) → fail-open notice, execute continues, no path leak (D11)", async () => {
		const ctx = makeCtx({
			engine: {
				restoreState: async () => {
					throw new Error("spawn failed: /tmp/secret/temp/dir/engine-guest.ts");
				},
			},
		});
		const res = await ctx.tool!.execute("x", { code: "1+1" }, undefined, undefined, undefined as any);
		assert.match((res.content[0] as { text: string }).text, /\[scratchpad\] snapshot restore failed; continuing with empty namespace/);
		assert.doesNotMatch((res.content[0] as { text: string }).text, /tmp|secret|engine-guest/, "error path must be sanitized");
		assert.match((res.content[0] as { text: string }).text, /status: ok/, "execute still runs after restore failure");
	});

	it("mtime mismatch (swap-after-register) → detected at READ time, no restore (MAJOR-P1)", async () => {
		const ctx = makeCtx();
		// swap: rewrite the file with a NEW mtime beyond tolerance
		const newMtime = Date.now() + RESTORE_MTIME_TOLERANCE_MS + 5000;
		fs.utimesSync(ctx.snapshotFile, new Date(newMtime), new Date(newMtime));
		const res = await ctx.tool!.execute("x", { code: "1+1" }, undefined, undefined, undefined as any);
		assert.equal(ctx.restoreCalls(), 0, "swap must be caught at READ time");
		assert.match((res.content[0] as { text: string }).text, /status: ok/);
	});

	it("file larger than SNAPSHOT_MAX_BYTES → fail-closed (D6 read-side)", async () => {
		const ctx = makeCtx();
		fs.writeFileSync(ctx.snapshotFile, Buffer.alloc(SNAPSHOT_MAX_BYTES + 1, "x"));
		const res = await ctx.tool!.execute("x", { code: "1+1" }, undefined, undefined, undefined as any);
		assert.equal(ctx.restoreCalls(), 0);
		assert.match((res.content[0] as { text: string }).text, /status: ok/);
	});

	it("restoreState returns null (empty state) → fail-open notice, execute continues", async () => {
		// restoreState override returns null WITHOUT counting (mock quirk) — the
		// notice itself proves restore was attempted (it only fires post-call).
		const ctx = makeCtx({ engine: { restoreState: async () => null } });
		const res = await ctx.tool!.execute("x", { code: "1+1" }, undefined, undefined, undefined as any);
		assert.match((res.content[0] as { text: string }).text, /no state to restore \(fail-open\)/);
		assert.match((res.content[0] as { text: string }).text, /status: ok/);
	});

	it("__proto__ / constructor var names in restore result are inert in the notice (NIT-4a)", async () => {
		const ctx = makeCtx({
			engine: {
				restoreState: async () => ({
					path: "/p",
					restored: ["__proto__", "constructor"],
					failed: [],
				}),
			},
		});
		const res = await ctx.tool!.execute("x", { code: "1+1" }, undefined, undefined, undefined as any);
		assert.match((res.content[0] as { text: string }).text, /restored: \[__proto__, constructor\]/);
		assert.match((res.content[0] as { text: string }).text, /status: ok/);
	});

	it("validateRestoreEnv: unit — pattern/attempt/lstat/size/mtime layers", () => {
		const ctx = makeCtx();
		const ok = validateRestoreEnv(ctx.env, ctx.snapshotFile);
		assert.equal(ok.valid, true);
		assert.equal(ok.attempt, 0);
		// missing taskId
		assert.equal(validateRestoreEnv({ ...ctx.env, [PI_CREW_TASK_ID_ENV]: "" }, ctx.snapshotFile).valid, false);
		// attempt non-numeric
		const badName = path.join(ctx.artifacts, "scratchpad", "task-1.attempt-x.snapshot.json");
		fs.writeFileSync(badName, "{}");
		assert.equal(validateRestoreEnv(ctx.env, badName).valid, false);
		// path outside container
		assert.equal(validateRestoreEnv(ctx.env, path.join(ctx.root, "outside.json")).valid, false);
	});
});
