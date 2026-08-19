import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../src/agents/agent-config.ts";
import { assertOnlyControlEnvKeys, prepareSpawnContext } from "../../../src/runtime/child-pi/child-pi-spawn.ts";

// WP-2/R2 STEP 2 (ADR-0 docs/decisions/2026-08-17-waiting-producer-ask.md
// item 2 — P0 env plumbing): prepareSpawnContext must set PI_CREW_ASK_ENABLED
// and PI_CREW_STATE_ROOT UNCONDITIONALLY for EVERY role, read-only included.
// Today PI_CREW_TASK_ID / PI_CREW_ARTIFACTS_ROOT are scratchpad-gated
// (isScratchpadEnabledForRole excludes read-only roles by design, S-6) — the
// ask tool must NOT follow that pattern or it is dead-on-arrival for exactly
// the roles that need clarification most.
//
// Pure-function test: prepareSpawnContext does NOT spawn — fast + hermetic.
// Assertions target `builtEnv` (the per-call control-var map), NOT mergedEnv,
// so inherited PI_CREW_* worker env cannot produce false passes/fails (see
// .crew/knowledge.md 2026-08-15 env-scrub note).

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

interface AskEnvResult {
	builtEnv: Record<string, string | undefined>;
	mergedEnv: Record<string, string | undefined>;
}

function askEnvFor(
	role: string,
	agent: AgentConfig,
	opts?: { agentId?: string; eventsPath?: string; artifactsRoot?: string },
): AskEnvResult {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ask-env-"));
	try {
		const res = prepareSpawnContext(
			{
				cwd: dir,
				task: "small task", // under TASK_ARG_LIMIT → built.tempDir undefined
				agent,
				role,
				agentId: opts?.agentId,
				eventsPath: opts?.eventsPath,
				artifactsRoot: opts?.artifactsRoot,
			},
			"small task",
		);
		assert.equal(res.kind, "ready", "must be ready (no pre-spawn abort)");
		if (res.kind !== "ready") return { builtEnv: {}, mergedEnv: {} };
		return {
			builtEnv: res.ctx.builtEnv as Record<string, string | undefined>,
			mergedEnv: res.ctx.mergedEnv as Record<string, string | undefined>,
		};
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// The true read-only roles (role-permission.ts READ_ONLY_ROLES): explorer,
// reviewer, security-reviewer, analyst, critic, planner. NOTE: "verifier" is a
// WRITE role (it runs bash) — the read-only reviewer class is what ADR-0 §2
// means by "read-only roles can ask".
const READ_ONLY_ROLES = ["security-reviewer", "reviewer", "explorer"] as const;

test("WP-2 step 2: read-only role spawn carries BOTH ask env vars (NOT scratchpad-gated)", () => {
	const eventsPath = "/tmp/pi-crew-ask-state-run-x/events.jsonl";
	for (const role of READ_ONLY_ROLES) {
		const { builtEnv, mergedEnv } = askEnvFor(role, makeAgent({ scratchpad: true }), {
			agentId: "task-1",
			eventsPath,
			artifactsRoot: "/tmp/pi-crew-ask-art-x",
		});
		// The two ask vars are present for the read-only role…
		assert.equal(builtEnv.PI_CREW_ASK_ENABLED, "1", `${role}: ask tool gate must be set`);
		assert.equal(builtEnv.PI_CREW_STATE_ROOT, path.dirname(eventsPath), `${role}: stateRoot must be dirname(eventsPath)`);
		// …and they survive into the merged spawn env (value-specific assert —
		// immune to inherited PI_CREW_* worker env).
		assert.equal(mergedEnv.PI_CREW_ASK_ENABLED, "1", `${role}: must reach the child process`);
		assert.equal(mergedEnv.PI_CREW_STATE_ROOT, path.dirname(eventsPath), `${role}: stateRoot must reach the child`);
		// …while the scratchpad-gated vars stay ABSENT for the same role —
		// proving the ask plumbing is a SEPARATE, unconditional path.
		assert.equal(builtEnv.PI_CREW_SCRATCHPAD, undefined, `${role}: scratchpad stays gated`);
		assert.equal(builtEnv.PI_CREW_TASK_ID, undefined, `${role}: task id stays scratchpad-gated`);
		assert.equal(builtEnv.PI_CREW_ARTIFACTS_ROOT, undefined, `${role}: artifacts root stays scratchpad-gated`);
	}
});

test("WP-2 step 2: scratchpad-enabled role gets BOTH ask env vars alongside scratchpad keys", () => {
	const eventsPath = "/tmp/pi-crew-ask-state-run-y/events.jsonl";
	const { builtEnv } = askEnvFor("executor", makeAgent(), {
		agentId: "task-2",
		eventsPath,
		artifactsRoot: "/tmp/pi-crew-ask-art-y",
	});
	assert.equal(builtEnv.PI_CREW_SCRATCHPAD, "1", "executor keeps its scratchpad keys");
	assert.equal(builtEnv.PI_CREW_ASK_ENABLED, "1", "and also gets the ask gate");
	assert.equal(builtEnv.PI_CREW_STATE_ROOT, path.dirname(eventsPath), "and the run stateRoot");
});

test("WP-2 step 2: ASK_ENABLED set even without eventsPath; STATE_ROOT stays unset (non-team fail-safe)", () => {
	// No eventsPath (non-team spawn): the tool gate is still threaded, but there
	// is no stateRoot to point at — the worker-side ask tool must fast-fail with
	// a structured notice instead of hanging on a bogus root.
	const { builtEnv } = askEnvFor("security-reviewer", makeAgent(), { agentId: "task-3" });
	assert.equal(builtEnv.PI_CREW_ASK_ENABLED, "1");
	assert.equal(builtEnv.PI_CREW_STATE_ROOT, undefined, "no eventsPath → no stateRoot (never guess)");
});

test("WP-2 step 2: ask vars need no agentId (they are not task-bound, unlike scratchpad keys)", () => {
	const { builtEnv } = askEnvFor("executor", makeAgent(), { eventsPath: "/tmp/sr-z/events.jsonl" });
	assert.equal(builtEnv.PI_CREW_ASK_ENABLED, "1");
	assert.equal(builtEnv.PI_CREW_STATE_ROOT, "/tmp/sr-z");
});

test("WP-2 step 2: the two ask keys pass the assertOnlyControlEnvKeys canary", () => {
	assert.doesNotThrow(() => assertOnlyControlEnvKeys({ PI_CREW_ASK_ENABLED: "1", PI_CREW_STATE_ROOT: "/tmp/sr" }));
});

test("WP-2 step 2: stateRoot is the dirname of the threaded eventsPath (state-store invariant)", () => {
	// manifest.eventsPath === path.join(stateRoot, "events.jsonl")
	// (state-store.ts DEFAULT_PATHS.state.eventsFile) — the spawn-side
	// derivation must mirror exactly that, for nested and flat roots alike.
	const { builtEnv } = askEnvFor("reviewer", makeAgent(), {
		eventsPath: "/tmp/deep/nested/run-dir/events.jsonl",
	});
	assert.equal(builtEnv.PI_CREW_STATE_ROOT, "/tmp/deep/nested/run-dir");
});
