/**
 * scratchpad-worker.test.ts — Phase 1 Checkpoint E (T8): integration tests for
 * the worker scratchpad (`execute` tool + EngineManager lifecycle).
 *
 * HYBRID (plan T8 / plan.review-v4 F3 — LEADER CHỐT):
 *
 * GROUP (a) — DETERMINISTIC, hermetic, always runs, CI-safe, NO LLM/network.
 *   Exercises the REAL spawn→register pipeline in-process:
 *     role-tools isScratchpadEnabledForRole
 *       → child-pi-spawn prepareSpawnContext (the actual env wiring, incl. the
 *         5 PI_CREW_* scratchpad keys)
 *       → scratchpad-lifecycle shouldRegisterScratchpadTool /
 *         registerScratchpadLifecycle (the worker-side gate) against a fake
 *         ExtensionAPI.
 *   Lazy-guest uses a REAL EngineManager (never calls execute) and asserts
 *   engine.state stays "idle" / isRunning===false / no guest.ts child.
 *
 *   APPROACH CHOICE (justified in checkpoint-E report): direct in-process
 *   handler test (packet option (i)), strengthened by deriving the worker env
 *   from the REAL prepareSpawnContext instead of hand-injecting it. Option
 *   (ii) (a scratchpad-mock-pi.mjs wire-protocol fixture) is NOT hermetic:
 *   fake-pi.mjs swallows --extension (cannot load extensions), and a mock
 *   would have to emulate pi's tool-dispatch loop to trigger registerTool —
 *   far more brittle surface with zero extra coverage for these STRUCTURE
 *   assertions. (i) covers the full spawn→env→registration pipeline
 *   deterministically.
 *
 * GROUP (b) — REAL pi + REAL model, GATED by PI_CREW_TEST_REAL_MODEL
 *   (`test({ skip: !env })`). Happy-path state persistence ("42") + snapshot
 *   file + no guest-process leak after normal completion. NEVER logs
 *   auth.json/provider keys; restores all env vars in finally.
 *
 * NOTE on group (b) agent: the BUILTIN executor agent (agents/executor.md)
 * carries `tools: read,grep,find,ls,bash,edit,write` — pi's `--tools` is a
 * HARD allowlist over extension tools too (pi agent-session.js:1996), so the
 * builtin executor's execute tool would be inactive. Group (b) therefore uses
 * a custom executor agent WITHOUT a tools allowlist (real pi + real model +
 * real prepareSpawnContext wiring + real EngineManager + real snapshot
 * flush), which is exactly the "opt-in worker" the spec §12 (a)/(b) describes.
 * The builtin-agent tool-surface gap is reported as a finding (T9 rollout).
 *
 * Acceptance coverage (§12): (a) group b case 5; (b) group b case 5;
 * (c) group a case 1 (planner) + case 3 (S-6); (d) group a case 1 (planner);
 * (f) group a case 2 (F6); (h) group a case 4 (lazy-guest) + group b case 6.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import { isScratchpadEnabledForRole } from "../../src/config/role-tools.ts";
import type { ExtensionAPI } from "../../src/extension/pi-api.ts";
import {
	cancelScratchpadSnapshot,
	PI_CREW_ARTIFACTS_ROOT_ENV,
	PI_CREW_ATTEMPT_ENV,
	PI_CREW_KIND_ENV,
	PI_CREW_SCRATCHPAD_ENV,
	PI_CREW_SCRATCHPAD_SNAPSHOT_ENV,
	PI_CREW_TASK_ID_ENV,
	registerScratchpadLifecycle,
	shouldRegisterScratchpadTool,
} from "../../src/prompt/scratchpad-lifecycle.ts";
import { runChildPi } from "../../src/runtime/child-pi/child-pi.ts";
import { prepareSpawnContext } from "../../src/runtime/child-pi/child-pi-spawn.ts";
import { cleanupAllTrackedTempDirs, cleanupTempDir } from "../../src/runtime/model/pi-args.ts";
import { EngineManager } from "../../src/runtime/scratchpad/engine.ts";

// ── env hygiene ─────────────────────────────────────────────────────────────
// Every key this file can touch — restored to their original values in finally.
/** artifactsRoot used by group (a) env-derivation (never written to). */
const UNUSED_ARTIFACTS_ROOT = path.join(os.tmpdir(), "pi-crew-artifacts-unused");

const TEST_ENV_KEYS = [
	PI_CREW_SCRATCHPAD_ENV,
	PI_CREW_TASK_ID_ENV,
	PI_CREW_ATTEMPT_ENV,
	PI_CREW_ARTIFACTS_ROOT_ENV,
	PI_CREW_SCRATCHPAD_SNAPSHOT_ENV,
	PI_CREW_KIND_ENV,
	"PI_CREW_TEST_REAL_MODEL",
	"PI_TEAMS_MOCK_CHILD_PI",
	"PI_CREW_ALLOW_MOCK",
	"PI_TEAMS_EXECUTE_WORKERS",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const key of TEST_ENV_KEYS) out[key] = process.env[key];
	return out;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
	for (const key of TEST_ENV_KEYS) {
		const value = snap[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Fake ExtensionAPI capturing registerTool()/on() (same shape as T7 unit tests). */
function makeFakePi(): { pi: ExtensionAPI; registered: unknown[] } {
	const registered: unknown[] = [];
	const pi = {
		on: () => {
			// No-op — this fake only needs to capture registerTool() calls.
		},
		registerTool: (tool: unknown) => {
			registered.push(tool);
		},
	} as unknown as ExtensionAPI;
	return { pi, registered };
}

/** Minimal AgentConfig. `tools` deliberately UNDEFINED so no `--tools`
 *  allowlist is emitted (a hard allowlist would hide extension-registered
 *  `execute` from the model — see header note). */
function makeAgent(name: string, scratchpad?: boolean): AgentConfig {
	return {
		name,
		description: "test",
		source: "builtin",
		filePath: `${name}.md`,
		systemPrompt: "test",
		...(scratchpad === undefined ? {} : { scratchpad }),
	};
}

/** Run the REAL spawn env-derivation (child-pi-spawn.ts) for a role/agent and
 *  return the control env it would hand to the worker. */
function deriveSpawnEnv(
	role: string,
	agent: AgentConfig,
	agentId: string,
	attempt = 0,
	artifactsRoot = UNUSED_ARTIFACTS_ROOT,
): { builtEnv: Record<string, string | undefined>; tempDir: string | undefined } {
	const prep = prepareSpawnContext({ cwd: process.cwd(), task: "task", agent, role, agentId, artifactsRoot, attempt }, "task");
	assert.equal(prep.kind, "ready", "prepareSpawnContext must succeed for the matrix");
	if (prep.kind !== "ready") throw new Error("unreachable");
	return { builtEnv: prep.ctx.builtEnv, tempDir: prep.ctx.tempDir };
}

/** Count engine guest processes (node --experimental-strip-types <guest.ts>).
 *  Windows has no portable `ps` — engine-state assertions carry the proof there
 *  (a guest can only exist after engine.start(), which lazy-guest never calls). */
function countGuestProcesses(): number {
	if (process.platform === "win32") return 0;
	try {
		const out = execFileSync("ps", ["-eo", "args="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
		return out.split("\n").filter((line) => /guest\.ts/.test(line)).length;
	} catch {
		return 0;
	}
}

async function waitFor(check: () => boolean, timeoutMs: number, intervalMs = 250): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	return check();
}

function findSnapshotFile(artifactsRoot: string, agentId: string, attempt: number): string | undefined {
	const dir = path.join(artifactsRoot, "scratchpad");
	const expected = path.join(dir, `${agentId}.attempt-${attempt}.snapshot.json`);
	if (fs.existsSync(expected)) return expected;
	if (!fs.existsSync(dir)) return undefined;
	// F4/F17: never hardcode an attempt suffix — glob as the backstop and take
	// the highest attempt file actually written.
	const matches = fs
		.readdirSync(dir)
		.filter((name) => name.startsWith(`${agentId}.attempt-`) && name.endsWith(".snapshot.json"))
		.sort();
	if (matches.length === 0) return undefined;
	return path.join(dir, matches[matches.length - 1]);
}

// ── group (b) model gate ────────────────────────────────────────────────────
// PI_CREW_TEST_REAL_MODEL=1 → default to the machine's known provider
// (knowledge.md 2026-08-07: opencode-go/deepseek-v4-flash); any other value is
// treated as an explicit model spec. Absent → group (b) skips cleanly.
function realModelOption(): string | undefined {
	const raw = process.env.PI_CREW_TEST_REAL_MODEL;
	if (!raw) return undefined;
	return raw === "1" ? "opencode-go/deepseek-v4-flash" : raw;
}

const realModel = realModelOption();

after(() => {
	cancelScratchpadSnapshot();
	cleanupAllTrackedTempDirs();
});

// ── GROUP (a): deterministic structure assertions (CI-safe) ─────────────────

test("T8-a1: opt-in executor → execute tool present; non-opt-in planner → absent", () => {
	const snap = snapshotEnv();
	try {
		// Executor (role default scratchpad:true) — full spawn env derivation.
		const optIn = deriveSpawnEnv("executor", makeAgent("executor", true), "task-exec-1", 2);
		try {
			assert.equal(isScratchpadEnabledForRole("executor", { scratchpad: true }), true, "executor opt-in predicted");
			assert.equal(optIn.builtEnv[PI_CREW_SCRATCHPAD_ENV], "1", "env layer: scratchpad on for opt-in");
			// All 5 env keys wired by child-pi-spawn.ts:281-300.
			assert.equal(optIn.builtEnv[PI_CREW_TASK_ID_ENV], "task-exec-1", "taskId provenance");
			assert.equal(optIn.builtEnv[PI_CREW_ATTEMPT_ENV], "2", "attempt derived from input (C3 per-attempt)");
			assert.equal(optIn.builtEnv[PI_CREW_ARTIFACTS_ROOT_ENV], UNUSED_ARTIFACTS_ROOT);
			assert.ok(
				optIn.builtEnv[PI_CREW_SCRATCHPAD_SNAPSHOT_ENV]?.endsWith("task-exec-1.snapshot.json"),
				`snapshot path should point at <agentId>.snapshot.json (got ${optIn.builtEnv[PI_CREW_SCRATCHPAD_SNAPSHOT_ENV]})`,
			);
			// Worker-side gate on the REAL spawn env → tool surface.
			assert.equal(shouldRegisterScratchpadTool(optIn.builtEnv), true, "gate passes on derived env");
			const { pi, registered } = makeFakePi();
			registerScratchpadLifecycle(pi, { env: optIn.builtEnv });
			assert.equal(registered.length, 1, "execute must be registered for opt-in executor");
			assert.equal((registered[0] as { name: string }).name, "scratchpad");
		} finally {
			cleanupTempDir(optIn.tempDir);
		}

		// Planner (read-only, no role default) — absent at every layer.
		const nonOptIn = deriveSpawnEnv("planner", makeAgent("planner"), "task-plan-1", 0);
		try {
			assert.equal(isScratchpadEnabledForRole("planner"), false, "planner non-opt-in predicted");
			assert.equal(nonOptIn.builtEnv[PI_CREW_SCRATCHPAD_ENV], undefined, "no scratchpad env for planner");
			assert.equal(shouldRegisterScratchpadTool(nonOptIn.builtEnv), false, "gate fails on planner env");
			const { pi, registered } = makeFakePi();
			registerScratchpadLifecycle(pi, { env: nonOptIn.builtEnv });
			assert.equal(registered.length, 0, "no execute tool for planner");
		} finally {
			cleanupTempDir(nonOptIn.tempDir);
		}

		// SEC-2 kind gate on the derived env: a leaked PI_CREW_SCRATCHPAD=1 in a
		// main session (kind !== subagent) must NOT activate the tool.
		const leaked = { ...optInEnvCopy() };
		assert.equal(shouldRegisterScratchpadTool(leaked), false, "scratchpad env without kind must not register");
	} finally {
		restoreEnv(snap);
	}
});

// Helper: fresh copy of an opt-in env for the SEC-2 mutation assertion.
function optInEnvCopy(): Record<string, string | undefined> {
	const derived = deriveSpawnEnv("executor", makeAgent("executor", true), "task-leak-1", 0);
	const env = { ...derived.builtEnv, [PI_CREW_KIND_ENV]: "main" };
	cleanupTempDir(derived.tempDir);
	return env;
}

test("T8-a2: F6 kill-switch — executor agent with scratchpad:false → execute absent", () => {
	const snap = snapshotEnv();
	try {
		assert.equal(isScratchpadEnabledForRole("executor", { scratchpad: false }), false, "F6 explicit-false predicted");
		const env = deriveSpawnEnv("executor", makeAgent("executor", false), "task-kill-1", 0);
		try {
			assert.equal(env.builtEnv[PI_CREW_SCRATCHPAD_ENV], undefined, "kill-switch: no scratchpad env");
			assert.equal(env.builtEnv[PI_CREW_TASK_ID_ENV], undefined, "kill-switch: no taskId env either");
			assert.equal(shouldRegisterScratchpadTool(env.builtEnv), false, "gate fails");
			const { pi, registered } = makeFakePi();
			registerScratchpadLifecycle(pi, { env: env.builtEnv });
			assert.equal(registered.length, 0, "no execute tool under F6 kill-switch");
		} finally {
			cleanupTempDir(env.tempDir);
		}
	} finally {
		restoreEnv(snap);
	}
});

test("T8-a3: S-6 — security-reviewer + scratchpad:true → execute absent (read-only role gate)", () => {
	const snap = snapshotEnv();
	try {
		// S-6: read-only gate FIRST — agent opt-in cannot elevate.
		assert.equal(isScratchpadEnabledForRole("security-reviewer", { scratchpad: true }), false, "S-6 predicted");
		const env = deriveSpawnEnv("security-reviewer", makeAgent("security-reviewer", true), "task-sec-1", 0);
		try {
			assert.equal(env.builtEnv[PI_CREW_SCRATCHPAD_ENV], undefined, "env layer: no scratchpad for read-only role");
			assert.equal(shouldRegisterScratchpadTool(env.builtEnv), false, "gate fails");
			const { pi, registered } = makeFakePi();
			registerScratchpadLifecycle(pi, { env: env.builtEnv });
			assert.equal(registered.length, 0, "no execute tool for security-reviewer (privilege-elevation guard)");
		} finally {
			cleanupTempDir(env.tempDir);
		}
	} finally {
		restoreEnv(snap);
	}
});

test("T8-a4: lazy-guest — opt-in worker that never calls execute spawns 0 guest processes", () => {
	const snap = snapshotEnv();
	const before = countGuestProcesses();
	const engine = new EngineManager();
	try {
		const env: NodeJS.ProcessEnv = {
			[PI_CREW_SCRATCHPAD_ENV]: "1",
			[PI_CREW_KIND_ENV]: "subagent",
			[PI_CREW_TASK_ID_ENV]: "task-lazy-1",
			[PI_CREW_ATTEMPT_ENV]: "0",
			[PI_CREW_ARTIFACTS_ROOT_ENV]: path.join(os.tmpdir(), "pi-crew-lazy-artifacts"),
			[PI_CREW_SCRATCHPAD_SNAPSHOT_ENV]: path.join(os.tmpdir(), "pi-crew-lazy-snap", "task-lazy-1.snapshot.json"),
		};
		const { pi, registered } = makeFakePi();
		// REAL EngineManager — registration is cheap, the GUEST spawns lazily on
		// the first execute (engine.ts F21). We never call execute.
		registerScratchpadLifecycle(pi, { engine, env });
		assert.equal(registered.length, 1, "tool surface still carries execute for opt-in");
		assert.equal((registered[0] as { name: string }).name, "scratchpad");

		// No execute call → engine never leaves idle → no guest can exist.
		assert.equal(engine.state, "idle", "engine must stay idle without execute");
		assert.equal(engine.isRunning, false, "isRunning must stay false without execute");
		const after = countGuestProcesses();
		assert.ok(after <= before, `no guest may spawn for a lazy worker (before=${before}, after=${after})`);
	} finally {
		engine.killSync();
		restoreEnv(snap);
	}
});

// ── GROUP (b): real pi + real model, GATED (skips without PI_CREW_TEST_REAL_MODEL) ─

const REAL_TASK = [
	"Use the execute tool twice, in this exact order:",
	"1. First execute call with code: `const x = 41`",
	"2. Second execute call with code: `return x + 1`",
	"Then, in your final answer, state the value returned by the second execute call.",
	"Do not modify any files.",
].join("\n");

interface RealRunResult {
	output: string;
	artifactsRoot: string;
	agentId: string;
	attempt: number;
	/** mkdtemp workspace — caller must rm in finally. */
	cwd: string;
}

/** Run a REAL worker (real pi + real model) with the scratchpad opt-in wiring.
 *  Only invoked when PI_CREW_TEST_REAL_MODEL is set. Restores env + cwd in a
 *  finally owned by the caller. */
async function runRealScratchpadTask(): Promise<RealRunResult> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-scratchpad-real-"));
	const artifactsRoot = path.join(cwd, "artifacts");
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	fs.mkdirSync(artifactsRoot, { recursive: true });
	delete process.env.PI_TEAMS_MOCK_CHILD_PI; // real model — no mock
	delete process.env.PI_CREW_ALLOW_MOCK;

	// Custom executor agent WITHOUT a tools allowlist (see header note) so the
	// extension-registered `execute` tool is actually active for the model.
	const agentId = "task-real-1";
	const attempt = 0;
	const result = await runChildPi({
		cwd,
		task: REAL_TASK,
		agent: makeAgent("executor", true),
		role: "executor",
		agentId,
		artifactsRoot,
		attempt,
		model: realModel,
	});
	return {
		output: result.rawFinalText ?? result.stdout ?? "",
		artifactsRoot,
		agentId,
		attempt,
		cwd,
	};
}

test("T8-b5: real-model happy-path — 2 cells persist state (x=41 → x+1=42) + snapshot file", {
	skip: realModel === undefined ? "PI_CREW_TEST_REAL_MODEL not set — group (b) skipped" : false,
}, async () => {
	const snap = snapshotEnv();
	const baseline = countGuestProcesses();
	let cwd: string | undefined;
	try {
		const { output, artifactsRoot, agentId, attempt, cwd: workspace } = await runRealScratchpadTask();
		cwd = workspace;
		// (a) cell 2 sees cell 1's variable: the worker must surface 42.
		assert.match(output, /42/, `worker output must contain "42" (state persisted across cells); got:\n${output}`);

		// (b) snapshot file written to the artifact store.
		const snapshotPath = await waitFor(() => findSnapshotFile(artifactsRoot, agentId, attempt) !== undefined, 10_000);
		assert.ok(snapshotPath, `snapshot file should exist under ${path.join(artifactsRoot, "scratchpad")}`);
		const snapshotFile = findSnapshotFile(artifactsRoot, agentId, attempt)!;
		const raw = fs.readFileSync(snapshotFile, "utf8");
		const parsed = JSON.parse(raw) as { version?: unknown; vars?: unknown; failed?: unknown };
		assert.equal(parsed.version, 1, "snapshot JSON shape: version 1");
		assert.ok(parsed.vars !== undefined && typeof parsed.vars === "object" && !Array.isArray(parsed.vars), "snapshot has vars");
		assert.ok(Array.isArray(parsed.failed), "snapshot has failed array");
		// NOTE: `kind: "result"` lives on the writeArtifact descriptor
		// (flushScratchpadSnapshot), asserted at unit level in
		// scratchpad-artifact.test.ts; at integration level the observable
		// proxy is the result-kind engine snapshot shape {version, vars, failed}.

		// (6) no-leak after normal completion.
		const clean = await waitFor(() => countGuestProcesses() <= baseline, 10_000);
		assert.ok(clean, `no guest process may remain after a completed task (baseline=${baseline})`);
	} finally {
		if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
		restoreEnv(snap);
	}
});

test("T8-b6: no-leak — after the real task completes normally, 0 guest processes remain", {
	skip: realModel === undefined ? "PI_CREW_TEST_REAL_MODEL not set — group (b) skipped" : false,
}, async () => {
	const snap = snapshotEnv();
	const baseline = countGuestProcesses();
	let cwd: string | undefined;
	try {
		const run = await runRealScratchpadTask();
		cwd = run.cwd;
		const clean = await waitFor(() => countGuestProcesses() <= baseline, 10_000);
		assert.ok(clean, `no guest process may remain after normal completion (baseline=${baseline})`);
	} finally {
		if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
		restoreEnv(snap);
	}
});
