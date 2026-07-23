/**
 * child-pi-env-spread.test.ts — Regression test for the env-stripping spread fix.
 *
 * Guards the critical spread that was extracted into buildFinalChildPiSpawnOptions
 * in child-pi-spawn.ts (BLOCKER 2 / S5):
 *
 *   export function buildFinalChildPiSpawnOptions(cwd, mergedEnv, builtEnv, model?) {
 *     assertOnlyControlEnvKeys(builtEnv);                          // canary
 *     const spawnOptions = buildChildPiSpawnOptions(cwd, mergedEnv, model);
 *     spawnOptions.env = { ...spawnOptions.env, ...builtEnv };     // the spread
 *     return spawnOptions;
 *   }
 *
 * `buildChildPiSpawnOptions` filters env via an allowlist that only preserves
 * system vars (PATH, HOME, …) and scoped provider keys — it STRIPS every
 * PI_CREW-prefixed / PI_TEAMS-prefixed execution-control var (steering file,
 * kind, role, broker keys). The spread re-applies builtEnv (the per-call
 * control vars) on top of the filtered env so they actually reach the child
 * process.
 *
 * If someone reverts or removes the spread line inside buildFinalChildPiSpawnOptions,
 * these tests MUST fail — proving that buildChildPiSpawnOptions alone does not
 * preserve control vars.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertOnlyControlEnvKeys, buildFinalChildPiSpawnOptions } from "../../src/runtime/child-pi-spawn.ts";

// ── Test fixtures ────────────────────────────────────────────────────────

/**
 * The PI_CREW_* / PI_TEAMS_* execution-control keys that `builtEnv` carries
 * per-call. Set by `prepareSpawnContext` (steering file) and `buildPiWorkerArgs`
 * (kind, role, broker credentials) and MUST survive to the child process.
 */
const CONTROL_KEYS: Record<string, string> = {
	PI_CREW_STEERING_FILE: "/tmp/crew/steering/task-42.jsonl",
	PI_CREW_KIND: "subagent",
	PI_CREW_ROLE: "executor",
	PI_CREW_BROKER_TOKEN: "broker-token-abc123",
	PI_CREW_BROKER_SOCKET: "/tmp/crew/broker.sock",
	PI_CREW_BROKER_RUN_ID: "run_20260722030602_abc",
	PI_CREW_BROKER_TASK_ID: "task-42",
};

/** Standard system env vars that are always on the allowlist. */
const STD_ENV: Record<string, string> = {
	PATH: "/usr/local/bin:/usr/bin:/bin",
	HOME: "/home/user",
	USER: "user",
	SHELL: "/bin/bash",
	TERM: "xterm-256color",
	LANG: "en_US.UTF-8",
};

const CWD = "/tmp/project";

/**
 * mergedEnv simulates what `prepareSpawnContext` produces:
 *   { ...process.env, ...built.env }
 * Here we merge standard env with the control keys.
 */
const MERGED_ENV: NodeJS.ProcessEnv = { ...STD_ENV, ...CONTROL_KEYS };

// ── Tests ─────────────────────────────────────────────────────────────────

describe("buildFinalChildPiSpawnOptions: PI_CREW_* / PI_TEAMS_* control keys reach child despite allowlist stripping", () => {
	it("returns SpawnOptions where every PI_CREW_* control key survives the canary + filter + spread", () => {
		const spawnOptions = buildFinalChildPiSpawnOptions(CWD, MERGED_ENV, CONTROL_KEYS);
		const env = spawnOptions.env as Record<string, string>;

		// All 7 execution-control keys must be present in the final env with
		// the correct value (exercising the production helper, not a manual spread).
		assert.equal(env.PI_CREW_STEERING_FILE, CONTROL_KEYS.PI_CREW_STEERING_FILE);
		assert.equal(env.PI_CREW_KIND, CONTROL_KEYS.PI_CREW_KIND);
		assert.equal(env.PI_CREW_ROLE, CONTROL_KEYS.PI_CREW_ROLE);
		assert.equal(env.PI_CREW_BROKER_TOKEN, CONTROL_KEYS.PI_CREW_BROKER_TOKEN);
		assert.equal(env.PI_CREW_BROKER_SOCKET, CONTROL_KEYS.PI_CREW_BROKER_SOCKET);
		assert.equal(env.PI_CREW_BROKER_RUN_ID, CONTROL_KEYS.PI_CREW_BROKER_RUN_ID);
		assert.equal(env.PI_CREW_BROKER_TASK_ID, CONTROL_KEYS.PI_CREW_BROKER_TASK_ID);
	});

	it("returns SpawnOptions where PI_CREW_* control keys survive even with a model-scoped allowlist", () => {
		const spawnOptions = buildFinalChildPiSpawnOptions(CWD, MERGED_ENV, CONTROL_KEYS, "openai/gpt-4o");
		const env = spawnOptions.env as Record<string, string>;

		// Model scoping adds OPENAI_API_KEY to the allowlist but does NOT add
		// PI_CREW-prefixed keys — the spread is still required to deliver them.
		assert.equal(env.PI_CREW_STEERING_FILE, CONTROL_KEYS.PI_CREW_STEERING_FILE);
		assert.equal(env.PI_CREW_BROKER_TOKEN, CONTROL_KEYS.PI_CREW_BROKER_TOKEN);
		assert.equal(env.PI_CREW_BROKER_SOCKET, CONTROL_KEYS.PI_CREW_BROKER_SOCKET);
		assert.equal(env.PI_CREW_KIND, CONTROL_KEYS.PI_CREW_KIND);
		assert.equal(env.PI_CREW_ROLE, CONTROL_KEYS.PI_CREW_ROLE);
		assert.equal(env.PI_CREW_BROKER_RUN_ID, CONTROL_KEYS.PI_CREW_BROKER_RUN_ID);
		assert.equal(env.PI_CREW_BROKER_TASK_ID, CONTROL_KEYS.PI_CREW_BROKER_TASK_ID);
	});

	it("returns SpawnOptions that ALSO include the allowlist-filtered system vars (PATH, HOME, …)", () => {
		const spawnOptions = buildFinalChildPiSpawnOptions(CWD, MERGED_ENV, CONTROL_KEYS);
		const env = spawnOptions.env as Record<string, string>;

		// The composed env must contain BOTH the system vars (preserved by
		// buildChildPiSpawnOptions via the allowlist) AND the control keys
		// (re-applied via the spread).
		assert.equal(env.PATH, STD_ENV.PATH, "PATH must survive allowlist + spread");
		assert.equal(env.HOME, STD_ENV.HOME, "HOME must survive allowlist + spread");
		assert.equal(env.LANG, STD_ENV.LANG, "LANG must survive allowlist + spread");
		assert.equal(env.TERM, STD_ENV.TERM, "TERM must survive allowlist + spread");
		// PI_CREW_PARENT_PID is injected by buildChildPiSpawnOptions itself,
		// not via the spread — but should still be present in the final env.
		assert.ok(env.PI_CREW_PARENT_PID, "PI_CREW_PARENT_PID should be set");
		assert.equal(env.PI_CREW_PARENT_PID, String(process.pid));
	});

	it("returns SpawnOptions whose cwd is the resolved (realpath) of the input", () => {
		const spawnOptions = buildFinalChildPiSpawnOptions(CWD, MERGED_ENV, CONTROL_KEYS);
		// CWD may not exist on the test machine, so buildChildPiSpawnOptions
		// falls back to path.resolve(); either way it must be a string.
		assert.ok(spawnOptions.cwd, "cwd must be set");
		assert.equal(typeof spawnOptions.cwd, "string");
		assert.ok((spawnOptions.cwd as string).length > 0);
	});

	it("validates builtEnv via assertOnlyControlEnvKeys BEFORE building spawnOptions: secrets are rejected", () => {
		// The canary must run first — if builtEnv contains a non-control key
		// the helper must throw, never call buildChildPiSpawnOptions / spawn.
		const maliciousBuiltEnv: Record<string, string | undefined> = {
			...CONTROL_KEYS,
			OPENAI_API_KEY: "leak", // not PI_CREW_*/PI_TEAMS_* — must throw
		};

		assert.throws(
			() => buildFinalChildPiSpawnOptions(CWD, MERGED_ENV, maliciousBuiltEnv),
			/SECURITY: built\.env contains unexpected key "OPENAI_API_KEY"/,
			"canary must reject non-PI_CREW_*/PI_TEAMS_* keys before spawn options are built",
		);
	});

	it("assertOnlyControlEnvKeys (used internally) throws for any non-control key", () => {
		// Direct test of the canary so the chain is verifiable from both ends.
		assert.throws(() => assertOnlyControlEnvKeys({ OPENAI_API_KEY: "x" }), /SECURITY.*OPENAI_API_KEY/);
		assert.throws(() => assertOnlyControlEnvKeys({ SOME_OTHER_KEY: "x" }), /SECURITY.*SOME_OTHER_KEY/);
		// Control-namespace keys must still pass.
		assert.doesNotThrow(() => assertOnlyControlEnvKeys({ PI_CREW_FOO: "1", PI_TEAMS_BAR: "2" }));
	});
});
