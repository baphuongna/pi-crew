import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import {
	PI_CREW_ARTIFACTS_ROOT_ENV,
	PI_CREW_ATTEMPT_ENV,
	PI_CREW_KIND_ENV,
	PI_CREW_SCRATCHPAD_ENV,
	PI_CREW_SCRATCHPAD_RESTORE_ENV,
	PI_CREW_SCRATCHPAD_RESTORE_MTIME_ENV,
	PI_CREW_SCRATCHPAD_SNAPSHOT_ENV,
	PI_CREW_TASK_ID_ENV,
	registerScratchpadLifecycle,
} from "../../src/prompt/scratchpad-lifecycle.ts";
import { prepareSpawnContext } from "../../src/runtime/child-pi/child-pi-spawn.ts";
import type { EngineManager } from "../../src/runtime/scratchpad/engine.ts";

// Phase 2 — P2-T7: integration of the crash-resume pipeline.
// group (a) deterministic: full prepareSpawnContext → restore env set; lifecycle
//   first-execute restore + notice (mock engine). Does NOT spawn pi.
// group (b) real-model gated (PI_CREW_TEST_REAL_MODEL=1): a real pi worker attempt
//   1 executes + flushes, attempt 2 spawns with the restore env and revives.

const REAL_MODEL = process.env.PI_CREW_TEST_REAL_MODEL === "1";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeAgent(): AgentConfig {
	return {
		name: "executor",
		description: "executor",
		source: "builtin",
		filePath: "executor.md",
		systemPrompt: "executor",
		inheritProjectContext: false,
		inheritSkills: false,
	};
}

function makeArtifacts(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "p2-resume-"));
	roots.push(root);
	const artifacts = path.join(root, "artifacts");
	fs.mkdirSync(path.join(artifacts, "scratchpad"), { recursive: true });
	return artifacts;
}

describe("P2-T7 crash-resume integration", () => {
	describe("group (a) — deterministic pipeline", () => {
		it("prepareSpawnContext sets RESTORE env when a prior snapshot artifact exists", () => {
			const artifacts = makeArtifacts();
			const snap = path.join(artifacts, "scratchpad", "task-resume.attempt-0.snapshot.json");
			fs.writeFileSync(snap, JSON.stringify({ version: 1, vars: {}, failed: [] }));
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p2-resume-cwd-"));
			roots.push(cwd);
			const res = prepareSpawnContext(
				{
					cwd,
					task: "resume task",
					agent: makeAgent(),
					role: "executor",
					agentId: "task-resume",
					artifactsRoot: artifacts,
					attempt: 1,
				},
				"resume task",
			);
			assert.equal(res.kind, "ready");
			if (res.kind !== "ready") return;
			const env = res.ctx.mergedEnv as Record<string, string | undefined>;
			assert.equal(env[PI_CREW_SCRATCHPAD_RESTORE_ENV], snap, "RESTORE env must point at the prior snapshot");
			assert.match(env[PI_CREW_SCRATCHPAD_RESTORE_MTIME_ENV]!, /^\d/, "RESTORE_MTIME numeric hint set");
			assert.equal(env[PI_CREW_SCRATCHPAD_ENV], "1", "scratchpad still armed");
			assert.equal(env[PI_CREW_ATTEMPT_ENV], "1");
		});

		it("lifecycle restores on first execute and emits the notice (mock engine)", async () => {
			const artifacts = makeArtifacts();
			const snap = path.join(artifacts, "scratchpad", "task-resume.attempt-0.snapshot.json");
			fs.writeFileSync(snap, JSON.stringify({ version: 1, vars: { x: "eA==" }, failed: [] }));
			const env: Record<string, string> = {
				[PI_CREW_SCRATCHPAD_ENV]: "1",
				[PI_CREW_KIND_ENV]: "subagent",
				[PI_CREW_TASK_ID_ENV]: "task-resume",
				[PI_CREW_ARTIFACTS_ROOT_ENV]: artifacts,
				[PI_CREW_SCRATCHPAD_SNAPSHOT_ENV]: path.join(artifacts, "raw.json"),
				[PI_CREW_SCRATCHPAD_RESTORE_ENV]: snap,
				[PI_CREW_SCRATCHPAD_RESTORE_MTIME_ENV]: String(fs.statSync(snap).mtimeMs),
			};
			const mockEngine = {
				isRunning: false,
				state: "idle" as const,
				execute: async () => ({ stdout: "", stderr: "", status: "ok" as const, durationMs: 1, result: "ok" }),
				listNamespaceNames: async () => ["x"],
				restoreState: async () => ({ path: snap, restored: ["x"], failed: [] }),
				snapshotState: async () => null, // NIT-1: present so post-ok debounce cannot TypeError on the mock
				kill: async () => {
					/* noop */
				},
			} as unknown as EngineManager;
			const captured: { ref: any } = { ref: null };
			const fakePi = {
				registerTool: (t: any) => {
					captured.ref = t;
				},
				on: () => {
					/* noop */
				},
			} as any;
			registerScratchpadLifecycle(fakePi, { engine: mockEngine, env });
			const tool: any = captured.ref;
			assert.ok(tool, "tool registered");
			const res = await tool.execute("x", { code: "1" }, undefined, undefined, undefined);
			const text = (res.content[0] as { text: string }).text;
			assert.match(text, /\[scratchpad\] restored 1 vars from attempt-0/);
		});

		it("prepareSpawnContext does NOT set RESTORE when no prior snapshot (first attempt)", () => {
			const artifacts = makeArtifacts(); // empty scratchpad dir
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p2-resume-cwd-"));
			roots.push(cwd);
			const res = prepareSpawnContext(
				{ cwd, task: "t", agent: makeAgent(), role: "executor", agentId: "task-x", artifactsRoot: artifacts, attempt: 0 },
				"t",
			);
			assert.equal(res.kind, "ready");
			if (res.kind !== "ready") return;
			const env = res.ctx.mergedEnv as Record<string, string | undefined>;
			assert.equal(env[PI_CREW_SCRATCHPAD_RESTORE_ENV], undefined);
		});
	});

	describe("group (b) — real pi worker resume (gated: PI_CREW_TEST_REAL_MODEL=1)", () => {
		// PLACEHOLDER (MINOR-E1): a full two-spawn real-worker harness (attempt 1
		// execute+flush → attempt 2 spawn with restore env → first execute revives)
		// is intentionally NOT implemented here — the cross-attempt contract is
		// already pinned deterministically by restore-e2e.spike.test.ts (real engine,
		// real writeArtifact, real findLatest/restoreState) + group (a) above (real
		// prepareSpawnContext + lifecycle). A maintainer wanting a live end-to-end
		// smoke can run, on a provisioned box with auth:
		//   PI_CREW_TEST_REAL_MODEL=1 node scripts/test-runner.mjs --test-force-exit \
		//     --test-name-pattern="LIVE" test/integration/scratchpad-resume.test.ts
		// after implementing the two-spawn harness below.
		it.skip("LIVE (placeholder): real two-spawn resume — see comment above", async () => {
			assert.ok(makeArtifacts());
		});
	});
});
