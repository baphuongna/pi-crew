import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { prepareSpawnContext } from "../../../../src/runtime/child-pi/child-pi-spawn.ts";

// Phase 1 — T5: prepareSpawnContext wires the 5 scratchpad env keys for opt-in
// workers (and only opt-in). Pure-function test: prepareSpawnContext does NOT
// spawn, so this is fast and hermetic.

function makeAgent(overrides?: Partial<AgentConfig>): AgentConfig {
	return {
		name: "executor",
		description: "executor",
		source: "builtin",
		filePath: "executor.md",
		systemPrompt: "executor",
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	};
}

function envFor(
	role: string,
	agent: AgentConfig,
	opts?: { agentId?: string; artifactsRoot?: string; attempt?: number },
): Record<string, string | undefined> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-t5-"));
	try {
		const res = prepareSpawnContext(
			{
				cwd: dir,
				task: "small task", // under TASK_ARG_LIMIT (8000) → built.tempDir undefined → exercises R3-1 guard
				agent,
				role,
				agentId: opts?.agentId,
				artifactsRoot: opts?.artifactsRoot,
				attempt: opts?.attempt,
			},
			"small task",
		);
		assert.equal(res.kind, "ready", "must be ready (no pre-spawn abort)");
		if (res.kind !== "ready") return {};
		return res.ctx.mergedEnv as Record<string, string | undefined>;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("T5: opt-in executor worker gets all 5 scratchpad env keys", () => {
	const env = envFor("executor", makeAgent(), { agentId: "task-1", artifactsRoot: "/tmp/art", attempt: 2 });
	assert.equal(env.PI_CREW_SCRATCHPAD, "1");
	assert.equal(env.PI_CREW_TASK_ID, "task-1");
	assert.equal(env.PI_CREW_ATTEMPT, "2");
	assert.equal(env.PI_CREW_ARTIFACTS_ROOT, "/tmp/art");
	assert.ok(env.PI_CREW_SCRATCHPAD_SNAPSHOT, "snapshot path must be set");
	assert.match(env.PI_CREW_SCRATCHPAD_SNAPSHOT!, /task-1\.snapshot\.json$/);
});

test("T5: default attempt is 0 when input.attempt unset (C3)", () => {
	const env = envFor("executor", makeAgent(), { agentId: "t", artifactsRoot: "/tmp/a" });
	assert.equal(env.PI_CREW_ATTEMPT, "0");
});

test("T5: S-6 read-only role gets NO scratchpad keys (privilege-elevation gate at env layer)", () => {
	// security-reviewer's role; even with agent.scratchpad:true the env is absent.
	const env = envFor("security-reviewer", makeAgent({ scratchpad: true }), { agentId: "t", artifactsRoot: "/tmp/a" });
	assert.equal(env.PI_CREW_SCRATCHPAD, undefined);
	assert.equal(env.PI_CREW_SCRATCHPAD_SNAPSHOT, undefined);
	assert.equal(env.PI_CREW_TASK_ID, undefined);
	assert.equal(env.PI_CREW_ARTIFACTS_ROOT, undefined);
});

test("T5: F6 agent.scratchpad:false kills env even on a default-on role", () => {
	const env = envFor("executor", makeAgent({ scratchpad: false }), { agentId: "t", artifactsRoot: "/tmp/a" });
	assert.equal(env.PI_CREW_SCRATCHPAD, undefined);
	assert.equal(env.PI_CREW_SCRATCHPAD_SNAPSHOT, undefined);
});

test("T5: no agentId → no scratchpad keys (snapshot needs a task binding)", () => {
	const env = envFor("executor", makeAgent(), {});
	assert.equal(env.PI_CREW_SCRATCHPAD, undefined);
});

test("T5: R3-1 — small task (built.tempDir undefined) does NOT crash spawn; snapshot path still resolves", () => {
	// buildPiWorkerArgs only creates built.tempDir for systemPrompt or >8000-char task;
	// a small task leaves it undefined. The guard must mkdtemp a fallback so
	// resolveRealContainedPath(undefined) never runs (would TypeError + crash spawn).
	const env = envFor("executor", makeAgent({ systemPrompt: undefined }), { agentId: "t", artifactsRoot: "/tmp/a" });
	assert.equal(env.PI_CREW_SCRATCHPAD, "1");
	assert.ok(env.PI_CREW_SCRATCHPAD_SNAPSHOT, "guard produced a snapshot path despite undefined built.tempDir");
});

test("T5: N2-1 — snapshot path is in tempDir, NOT under artifactsRoot (F4/S-1 raw-snapshot containment)", () => {
	const env = envFor("executor", makeAgent(), { agentId: "t", artifactsRoot: "/tmp/artifacts-here" });
	const snap = env.PI_CREW_SCRATCHPAD_SNAPSHOT!;
	assert.ok(!snap.startsWith("/tmp/artifacts-here"), "RAW snapshot must NOT be under artifactsRoot");
	assert.equal(env.PI_CREW_ARTIFACTS_ROOT, "/tmp/artifacts-here", "artifactsRoot passed separately for the redacted writeArtifact");
});

test("T5: all 5 keys are PI_CREW_* control vars (pass assertOnlyControlEnvKeys)", async () => {
	// assertOnlyControlEnvKeys is the security canary — run it on exactly the keys
	// prepareSpawnContext added (extract PI_CREW_ from mergedEnv minus process.env).
	const { assertOnlyControlEnvKeys } = await import("../../../../src/runtime/child-pi/child-pi-spawn.ts");
	const env = envFor("executor", makeAgent(), { agentId: "t", artifactsRoot: "/tmp/a" });
	const added = Object.fromEntries(
		Object.entries(env).filter(
			([k]) =>
				k.startsWith("PI_CREW_SCRATCHPAD") || k === "PI_CREW_TASK_ID" || k === "PI_CREW_ATTEMPT" || k === "PI_CREW_ARTIFACTS_ROOT",
		),
	);
	// must not throw — all keys are PI_CREW_* prefixed.
	assert.doesNotThrow(() => assertOnlyControlEnvKeys(added));
});
