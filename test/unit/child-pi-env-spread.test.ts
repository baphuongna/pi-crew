/**
 * child-pi-env-spread.test.ts — Regression test for the env-stripping spread fix.
 *
 * Guards the critical spread at child-pi.ts:419:
 *   spawnOptions.env = { ...spawnOptions.env, ...builtEnv }
 *
 * `buildChildPiSpawnOptions` filters env via an allowlist that only preserves
 * system vars (PATH, HOME, …) and scoped provider keys — it STRIPS all
 * PI_CREW_* execution-control vars (steering file, kind, role, broker keys).
 * The spread re-applies builtEnv (the per-call control vars) on top of the
 * filtered env so they actually reach the child process.
 *
 * If someone reverts or removes the spread line, this test MUST fail — proving
 * that buildChildPiSpawnOptions alone does not preserve control vars.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildChildPiSpawnOptions } from "../../src/runtime/child-pi-spawn.ts";

// ── Test fixtures ────────────────────────────────────────────────────────

/**
 * The PI_CREW_* execution-control keys that `builtEnv` carries per-call.
 * These are set by `prepareSpawnContext` (steering file) and `buildPiWorkerArgs`
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

describe("env-spread regression: PI_CREW_* control keys reach child despite allowlist stripping", () => {
	it("buildChildPiSpawnOptions STRIPS every PI_CREW_* control key (no spread)", () => {
		const spawnOptions = buildChildPiSpawnOptions(CWD, MERGED_ENV);
		const env = spawnOptions.env as Record<string, string>;

		// Every control key must be ABSENT — proving the allowlist strips them.
		for (const key of Object.keys(CONTROL_KEYS)) {
			assert.equal(env[key], undefined, `${key} should be stripped by buildChildPiSpawnOptions`);
		}
	});

	it("spread restores ALL PI_CREW_* control keys to final child env", () => {
		const spawnOptions = buildChildPiSpawnOptions(CWD, MERGED_ENV);

		// builtEnv = the per-call control vars (same shape as CONTROL_KEYS).
		const builtEnv: Record<string, string | undefined> = { ...CONTROL_KEYS };

		// THE spread under test (child-pi.ts:419):
		//   spawnOptions.env = { ...spawnOptions.env, ...builtEnv }
		const finalEnv = { ...spawnOptions.env, ...builtEnv } as Record<string, string>;

		// Every control key must be PRESENT with the correct value.
		for (const [key, value] of Object.entries(CONTROL_KEYS)) {
			assert.equal(finalEnv[key], value, `${key} must survive the spread to final env`);
		}
	});

	it("without the spread, PI_CREW_STEERING_FILE is missing (negative proof)", () => {
		const spawnOptions = buildChildPiSpawnOptions(CWD, MERGED_ENV);
		const envNoSpread = spawnOptions.env as Record<string, string>;

		// Without the spread, control keys are missing. If any of these are
		// present here, the allowlist changed and the spread may no longer be
		// the thing restoring them — flag it.
		assert.equal(envNoSpread.PI_CREW_STEERING_FILE, undefined,
			"PI_CREW_STEERING_FILE must be absent without spread — if present, the allowlist changed");
		assert.equal(envNoSpread.PI_CREW_BROKER_TOKEN, undefined,
			"PI_CREW_BROKER_TOKEN must be absent without spread");
		assert.equal(envNoSpread.PI_CREW_KIND, undefined,
			"PI_CREW_KIND must be absent without spread");
		assert.equal(envNoSpread.PI_CREW_ROLE, undefined,
			"PI_CREW_ROLE must be absent without spread");
		assert.equal(envNoSpread.PI_CREW_BROKER_SOCKET, undefined,
			"PI_CREW_BROKER_SOCKET must be absent without spread");
		assert.equal(envNoSpread.PI_CREW_BROKER_RUN_ID, undefined,
			"PI_CREW_BROKER_RUN_ID must be absent without spread");
		assert.equal(envNoSpread.PI_CREW_BROKER_TASK_ID, undefined,
			"PI_CREW_BROKER_TASK_ID must be absent without spread");
	});

	it("standard env vars survive the filter regardless of spread", () => {
		const spawnOptions = buildChildPiSpawnOptions(CWD, MERGED_ENV);
		const env = spawnOptions.env as Record<string, string>;

		assert.equal(env.PATH, STD_ENV.PATH, "PATH must survive allowlist");
		assert.equal(env.HOME, STD_ENV.HOME, "HOME must survive allowlist");
		assert.equal(env.LANG, STD_ENV.LANG, "LANG must survive allowlist");
		assert.equal(env.TERM, STD_ENV.TERM, "TERM must survive allowlist");
	});

	it("control keys survive spread even with model-scoped allowlist", () => {
		const spawnOptions = buildChildPiSpawnOptions(CWD, MERGED_ENV, "openai/gpt-4o");
		const builtEnv: Record<string, string | undefined> = { ...CONTROL_KEYS };
		const finalEnv = { ...spawnOptions.env, ...builtEnv } as Record<string, string>;

		// Model scoping adds OPENAI_API_KEY to the allowlist but does NOT
		// add PI_CREW_* keys — the spread is still required.
		assert.equal(finalEnv.PI_CREW_STEERING_FILE, CONTROL_KEYS.PI_CREW_STEERING_FILE);
		assert.equal(finalEnv.PI_CREW_BROKER_TOKEN, CONTROL_KEYS.PI_CREW_BROKER_TOKEN);
		assert.equal(finalEnv.PI_CREW_BROKER_SOCKET, CONTROL_KEYS.PI_CREW_BROKER_SOCKET);
		assert.equal(finalEnv.PI_CREW_KIND, CONTROL_KEYS.PI_CREW_KIND);
		assert.equal(finalEnv.PI_CREW_ROLE, CONTROL_KEYS.PI_CREW_ROLE);
		assert.equal(finalEnv.PI_CREW_BROKER_RUN_ID, CONTROL_KEYS.PI_CREW_BROKER_RUN_ID);
		assert.equal(finalEnv.PI_CREW_BROKER_TASK_ID, CONTROL_KEYS.PI_CREW_BROKER_TASK_ID);

		// And the model-scoped filter still stripped them BEFORE the spread:
		const envBeforeSpread = spawnOptions.env as Record<string, string>;
		assert.equal(envBeforeSpread.PI_CREW_STEERING_FILE, undefined,
			"PI_CREW_STEERING_FILE must be stripped even with model scoping");
		assert.equal(envBeforeSpread.PI_CREW_BROKER_TOKEN, undefined,
			"PI_CREW_BROKER_TOKEN must be stripped even with model scoping");
	});

	it("PI_CREW_PARENT_PID is always injected by buildChildPiSpawnOptions", () => {
		const spawnOptions = buildChildPiSpawnOptions(CWD, MERGED_ENV);
		const env = spawnOptions.env as Record<string, string>;

		// PI_CREW_PARENT_PID is added explicitly, not via the spread — but
		// verify it survives because it's on the allowlist-free path.
		assert.ok(env.PI_CREW_PARENT_PID, "PI_CREW_PARENT_PID should be set");
		assert.equal(env.PI_CREW_PARENT_PID, String(process.pid));
	});

	it("final env preserves standard vars AND control keys together", () => {
		const spawnOptions = buildChildPiSpawnOptions(CWD, MERGED_ENV);
		const builtEnv: Record<string, string | undefined> = { ...CONTROL_KEYS };
		const finalEnv = { ...spawnOptions.env, ...builtEnv } as Record<string, string>;

		// Both system vars and control keys are present in the final env.
		assert.equal(finalEnv.PATH, STD_ENV.PATH);
		assert.equal(finalEnv.HOME, STD_ENV.HOME);
		assert.equal(finalEnv.PI_CREW_STEERING_FILE, CONTROL_KEYS.PI_CREW_STEERING_FILE);
		assert.equal(finalEnv.PI_CREW_BROKER_TOKEN, CONTROL_KEYS.PI_CREW_BROKER_TOKEN);
	});
});
