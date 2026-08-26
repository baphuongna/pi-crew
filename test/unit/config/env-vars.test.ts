/**
 * Tests for Phase 3.2 (refactor-plan row 3.2): central crew env-var registry.
 *
 * Covers:
 *   - registry completeness (every crew-family name READ in src/ is present;
 *     every entry's `name` matches its key)
 *   - mirror-alias behavior (PI_TEAMS_X → PI_CREW_X fallback + precedence)
 *   - parser types (int / boolean / json / string)
 *   - default fallback (typed getters apply the registry default when unset)
 *   - raw getter preserves existence/truthiness semantics (undefined when unset)
 *
 * NOTE: tests mutate process.env for the specific keys under test and restore
 * them in `finally` — no leakage into other suites.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CREW_ENV_VARS, crewEnvNames, getCrewEnv, getCrewEnvBool, getCrewEnvInt, getCrewEnvParsed } from "../../../src/config/env-vars.ts";

/** Every crew-family name READ in src/ (dot, bracket, or env-object). */
const SRC_READ_NAMES: readonly string[] = [
	// mirror pairs — teams-first
	"PI_CREW_HOME",
	"PI_TEAMS_HOME",
	// mirror pairs — crew-first
	"PI_CREW_DEPTH",
	"PI_TEAMS_DEPTH",
	"PI_CREW_MAX_DEPTH",
	"PI_TEAMS_MAX_DEPTH",
	"PI_CREW_ROLE",
	"PI_TEAMS_ROLE",
	"PI_CREW_VERIFICATION_PRESERVE_ENV",
	"PI_TEAMS_VERIFICATION_PRESERVE_ENV",
	"PI_CREW_VERIFICATION_WORKTREE",
	"PI_TEAMS_VERIFICATION_WORKTREE",
	"PI_CREW_INHERIT_PROJECT_CONTEXT",
	"PI_TEAMS_INHERIT_PROJECT_CONTEXT",
	"PI_CREW_INHERIT_SKILLS",
	"PI_TEAMS_INHERIT_SKILLS",
	// mirror pairs — OR (dual reads)
	"PI_CREW_ADAPTIVE_REPAIR",
	"PI_TEAMS_ADAPTIVE_REPAIR",
	"PI_CREW_BG_REPORT_ON_FATAL",
	"PI_TEAMS_BG_REPORT_ON_FATAL",
	"PI_CREW_EXECUTE_WORKERS",
	"PI_TEAMS_EXECUTE_WORKERS",
	"PI_CREW_VERIFICATION_SANITIZE_ENV",
	"PI_TEAMS_VERIFICATION_SANITIZE_ENV",
	"PI_CREW_WORKER_ATOMIC_WRITER",
	"PI_TEAMS_WORKER_ATOMIC_WRITER",
	// singles read via process.env (dot)
	"PI_CREW_ALLOW_MOCK",
	"PI_CREW_ASYNC_EARLY_EXIT_GUARD",
	"PI_CREW_BACKGROUND_MODE",
	"PI_CREW_BROKER",
	"PI_CREW_DEBUG",
	"PI_CREW_DEBUG_BUDGET",
	"PI_CREW_DISABLE_RESULT_READ_CACHE",
	"PI_CREW_DWF_SCRIPT_TIMEOUT_MS",
	"PI_CREW_DWF_SKIP_DETERMINISM_CHECK",
	"PI_CREW_INTERRUPT_GUARD_INTERVAL_MS",
	"PI_CREW_MAX_RUN_MS",
	"PI_CREW_MAX_WORKERS",
	"PI_CREW_MOCK_LIVE_SESSION",
	"PI_CREW_PARENT_GUARD_INTERVAL_MS",
	"PI_CREW_PARENT_PID",
	"PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC",
	"PI_CREW_PLAN_UI",
	"PI_CREW_SCRATCHPAD_DEMOTE_BASH",
	"PI_CREW_SKIP_HOME_CHECK",
	"PI_CREW_SUPPRESS_RPC_WARNING",
	"PI_CREW_TRUST_PROJECT_AGENT_EXTENSIONS",
	"PI_CREW_TRUST_PROJECT_DWF",
	"PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS",
	"PI_TEAMS_DEBUG",
	"PI_TEAMS_MOCK_CHILD_PI",
	"PI_TEAMS_PI_BIN",
	// singles read via process.env[...] (const/bracket)
	"PI_CREW_MAX_OUTPUT",
	"PI_CREW_STEERING_FILE",
	"PI_CREW_KEYBINDINGS",
	"PI_CREW_RPC_SECRET",
	"PI_CREW_PEER_DEP_DIR",
	// names read from a passed-in env object (child-spawned env)
	"PI_CREW_SCRATCHPAD",
	"PI_CREW_KIND",
	"PI_CREW_TASK_ID",
	"PI_CREW_EVENTS_PATH",
	"PI_CREW_BROKER_RUN_ID",
	"PI_CREW_ARTIFACTS_ROOT",
	"PI_CREW_ASK_ENABLED",
	"PI_CREW_SCRATCHPAD_SNAPSHOT",
	"PI_CREW_ATTEMPT",
	"PI_CREW_SCRATCHPAD_RESTORE",
	"PI_CREW_SCRATCHPAD_RESTORE_MTIME",
	"PI_CREW_MAX_AUTO_FALLBACKS",
	"PI_CREW_MODEL_FALLBACK_ORDER",
	"PI_CREW_MODEL_REQUIRE_CREDENTIALS",
	"PI_CREW_MODEL",
	"PI_CREW_BROKER_SOCKET",
	"PI_CREW_BROKER_TOKEN",
	"PI_CREW_BROKER_TASK_ID",
	"PI_CREW_GUEST",
];

/** Snapshot of the full registry key set (catches accidental drops/renames). */
const REGISTRY_SNAPSHOT: readonly string[] = [
	...SRC_READ_NAMES,
	// docs/tests-only names (best-effort, non-src reads)
	"PI_CREW_USE_BUNDLE",
	"PI_CREW_SMOKE",
	"PI_CREW_RUN_PLATFORM_TESTS",
	"PI_CREW_HARD_KILL_GRACE_MS",
	"PI_CREW_LIVE_MODEL",
	"PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION",
	"PI_CREW_RUN_ID",
	"PI_TEAMS_CONFIG_KEYS",
	"PI_TEAMS_MOCK",
	"PI_CREW_VERIFICATION",
	"PI_TEAMS_VERIFICATION",
	"PI_CREW_ATOMIC_WRITER",
	"PI_CREW_BROKER_DIAG_UI",
	"PI_CREW_DEBUG_KILL",
	"PI_CREW_DWF_SANDBOX_DRY_RUN",
	"PI_CREW_HOOK",
	"PI_CREW_POOL_HEALTH",
	"PI_CREW_QUIET_PREFLIGHT",
	"PI_CREW_SAFE_BASH",
	"PI_CREW_SCRATCHPAD_EXPERIMENT",
	"PI_CREW_SESSION_DEPTH",
	"PI_CREW_SIG",
	"PI_CREW_SNAPSHOT_HMAC_KEY",
	"PI_CREW_SNAPSHOT_HMAC_STRICT",
	"PI_CREW_STATE_ROOT",
	"PI_CREW_TEST_REAL_MODEL",
	"PI_CREW_TOOLING_429_NOTE",
	"PI_CREW_MAX_OUTPUT_TOKENS",
	"PI_CREW_GOAL_OSCILLATION_EMBEDDINGS",
	"PI_CREW_MSG_ENABLED",
	"PI_CREW_OPENAI_API_KEY",
	"PI_CREW_SECRET_TOKEN",
	"PI_CREW_REFUSE_GATE_PATTERNS",
	"PI_CREW_PROCEED_PATTERNS",
	"PI_CREW_ENFORCEMENT_PATTERNS",
	"PI_CREW_DIR",
	"PI_CREW_ROOT",
	"PI_CREW_FOO",
	"PI_CREW_VAR",
	"PI_CREW_X",
	"PI_CREW_TEST_SECRET_VALUE",
	"PI_TEAMS_BAR",
];

/**
 * Global env isolation (packet requirement: save/restore in beforeEach/afterEach).
 * Snapshot the whole process.env before each test and restore it after, so no
 * test can leak crew-family vars (or any var) into sibling tests even if a
 * future test forgets the withEnv/withoutEnv helpers.
 */
const envBackup = new Map<string, string | undefined>();
beforeEach(() => {
	envBackup.clear();
	for (const key of Object.keys(process.env)) envBackup.set(key, process.env[key]);
});
afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!envBackup.has(key)) delete process.env[key];
	}
	for (const [key, value] of envBackup) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

/** Run `fn` with the given env keys removed, then restore them. */
function withoutEnv<T>(keys: readonly string[], fn: () => T): T {
	const saved = new Map<string, string | undefined>();
	for (const key of keys) {
		saved.set(key, process.env[key]);
		delete process.env[key];
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/** Run `fn` with the given env values set, then restore. */
function withEnv<T>(pairs: Record<string, string | undefined>, fn: () => T): T {
	const saved = new Map<string, string | undefined>();
	for (const key of Object.keys(pairs)) {
		saved.set(key, process.env[key]);
	}
	for (const [key, value] of Object.entries(pairs)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("registry is self-consistent: every key has a spec whose name matches", () => {
	const names = crewEnvNames();
	assert.ok(names.length >= SRC_READ_NAMES.length, `registry should cover at least ${SRC_READ_NAMES.length} src-read names`);
	for (const name of names) {
		const spec = CREW_ENV_VARS[name];
		assert.ok(spec, `missing spec for registered name ${name}`);
		assert.equal(spec.name, name, `spec.name must equal its key for ${name}`);
	}
});

test("registry completeness: every crew-family name read in src/ is registered", () => {
	const registered = new Set(crewEnvNames());
	const missing = SRC_READ_NAMES.filter((name) => !registered.has(name));
	assert.deepEqual(missing, [], `names read in src/ missing from registry: ${missing.join(", ")}`);
});

test("registry snapshot: full key set matches the expected list", () => {
	const actual = [...crewEnvNames()].sort();
	const expected = [...new Set(REGISTRY_SNAPSHOT)].sort();
	assert.deepEqual(actual, expected);
});

test("mirror alias: PI_CREW_HOME falls back to PI_TEAMS_HOME (teams-first)", () => {
	withoutEnv(["PI_CREW_HOME", "PI_TEAMS_HOME"], () => {
		assert.equal(getCrewEnv("PI_CREW_HOME"), undefined);
		assert.equal(getCrewEnv("PI_TEAMS_HOME"), undefined);
	});
	withEnv({ PI_CREW_HOME: "/crew", PI_TEAMS_HOME: "/teams" }, () => {
		assert.equal(getCrewEnv("PI_CREW_HOME"), "/teams", "PI_TEAMS_HOME must win over PI_CREW_HOME");
		assert.equal(getCrewEnv("PI_TEAMS_HOME"), "/teams");
	});
	withEnv({ PI_CREW_HOME: "/crew" }, () => {
		// Clear the TEAMS counterpart so ambient PI_TEAMS_HOME cannot win (teams-first).
		withoutEnv(["PI_TEAMS_HOME"], () => {
			assert.equal(getCrewEnv("PI_CREW_HOME"), "/crew");
			assert.equal(getCrewEnv("PI_TEAMS_HOME"), "/crew");
		});
	});
});

test("mirror alias: crew-first pair (verification-worktree)", () => {
	withEnv({ PI_CREW_VERIFICATION_WORKTREE: "1", PI_TEAMS_VERIFICATION_WORKTREE: "0" }, () => {
		assert.equal(getCrewEnv("PI_CREW_VERIFICATION_WORKTREE"), "1", "PI_CREW must win");
		assert.equal(getCrewEnv("PI_TEAMS_VERIFICATION_WORKTREE"), "1");
	});
	withEnv({ PI_TEAMS_VERIFICATION_WORKTREE: "1" }, () => {
		// Clear the CREW counterpart so ambient PI_CREW_VERIFICATION_WORKTREE cannot win (crew-first).
		withoutEnv(["PI_CREW_VERIFICATION_WORKTREE"], () => {
			assert.equal(getCrewEnv("PI_CREW_VERIFICATION_WORKTREE"), "1", "fallback to PI_TEAMS when PI_CREW unset");
		});
	});
});

test("mirror alias: OR pairs are NOT collapsed (each name reads its own raw value)", () => {
	withEnv({ PI_CREW_EXECUTE_WORKERS: "0", PI_TEAMS_EXECUTE_WORKERS: "1" }, () => {
		assert.equal(getCrewEnv("PI_CREW_EXECUTE_WORKERS"), "0");
		assert.equal(getCrewEnv("PI_TEAMS_EXECUTE_WORKERS"), "1");
	});
});

test("mirror alias: OR semantics — either EXECUTE_WORKERS name '0' disables (call-site pattern)", () => {
	// Original sites read both names independently and OR the disables
	// (team-tool.ts:376, run.ts): `A === "0" || B === "0"` → execution off.
	const disabled = (name: string): boolean => getCrewEnv(name) === "0";
	const executionOff = (): boolean => disabled("PI_CREW_EXECUTE_WORKERS") || disabled("PI_TEAMS_EXECUTE_WORKERS");
	withEnv({ PI_CREW_EXECUTE_WORKERS: "0" }, () => {
		assert.equal(executionOff(), true, "PI_CREW=0 alone disables");
	});
	withEnv({ PI_TEAMS_EXECUTE_WORKERS: "0" }, () => {
		assert.equal(executionOff(), true, "PI_TEAMS=0 alone disables");
	});
	withEnv({ PI_CREW_EXECUTE_WORKERS: "1", PI_TEAMS_EXECUTE_WORKERS: "1" }, () => {
		assert.equal(executionOff(), false, "both unset/truthy → execution stays on");
	});
});

test("mirror alias: PI_TEAMS_ROLE falls back to PI_CREW_ROLE (crew-first, direct TEAMS query)", () => {
	// Explicitly clear the mirror counterpart in each scenario — ambient env
	// (e.g. a pi-crew worker session exports PI_CREW_ROLE) must not leak in.
	withoutEnv(["PI_TEAMS_ROLE"], () => {
		withEnv({ PI_CREW_ROLE: "executor" }, () => {
			assert.equal(getCrewEnv("PI_TEAMS_ROLE"), "executor", "querying the TEAMS name returns the CREW value");
		});
	});
	withoutEnv(["PI_CREW_ROLE"], () => {
		withEnv({ PI_TEAMS_ROLE: "reviewer" }, () => {
			assert.equal(getCrewEnv("PI_CREW_ROLE"), "reviewer", "CREW falls back to TEAMS when only TEAMS is set");
		});
	});
	withEnv({ PI_CREW_ROLE: "executor", PI_TEAMS_ROLE: "reviewer" }, () => {
		assert.equal(getCrewEnv("PI_CREW_ROLE"), "executor", "PI_CREW wins when both set");
		assert.equal(getCrewEnv("PI_TEAMS_ROLE"), "executor");
	});
});

test("raw getter returns undefined when unset (existence/truthiness preserved)", () => {
	withoutEnv(["PI_CREW_DEBUG", "PI_CREW_MOCK_LIVE_SESSION"], () => {
		assert.equal(getCrewEnv("PI_CREW_DEBUG"), undefined);
		assert.equal(getCrewEnv("PI_CREW_MOCK_LIVE_SESSION"), undefined);
	});
	withEnv({ PI_CREW_DEBUG: "" }, () => {
		assert.equal(getCrewEnv("PI_CREW_DEBUG"), "");
	});
});

test("int parser: parses and applies default when unset/invalid", () => {
	withoutEnv(["PI_CREW_DWF_SCRIPT_TIMEOUT_MS"], () => {
		assert.equal(getCrewEnvInt("PI_CREW_DWF_SCRIPT_TIMEOUT_MS"), 1_800_000);
		assert.equal(getCrewEnvParsed("PI_CREW_DWF_SCRIPT_TIMEOUT_MS"), 1_800_000);
	});
	withEnv({ PI_CREW_DWF_SCRIPT_TIMEOUT_MS: "5000" }, () => {
		assert.equal(getCrewEnvInt("PI_CREW_DWF_SCRIPT_TIMEOUT_MS"), 5000);
		assert.equal(getCrewEnv("PI_CREW_DWF_SCRIPT_TIMEOUT_MS"), "5000", "raw getter stays a string");
	});
	withEnv({ PI_CREW_DWF_SCRIPT_TIMEOUT_MS: "not-a-number" }, () => {
		assert.equal(getCrewEnvParsed("PI_CREW_DWF_SCRIPT_TIMEOUT_MS"), 1_800_000, "invalid → default");
	});
});

test("boolean parser: 1/true/yes → true, 0/false/no → false, ambiguous → default", () => {
	withoutEnv(["PI_CREW_ALLOW_MOCK"], () => {
		assert.equal(getCrewEnvBool("PI_CREW_ALLOW_MOCK"), undefined);
	});
	withEnv({ PI_CREW_ALLOW_MOCK: "true" }, () => {
		assert.equal(getCrewEnvBool("PI_CREW_ALLOW_MOCK"), true);
	});
	withEnv({ PI_CREW_ALLOW_MOCK: "1" }, () => {
		assert.equal(getCrewEnvBool("PI_CREW_ALLOW_MOCK"), true);
	});
	withEnv({ PI_CREW_ALLOW_MOCK: "yes" }, () => {
		assert.equal(getCrewEnvBool("PI_CREW_ALLOW_MOCK"), true);
	});
	withEnv({ PI_CREW_ALLOW_MOCK: "0" }, () => {
		assert.equal(getCrewEnvBool("PI_CREW_ALLOW_MOCK"), false);
	});
	withEnv({ PI_CREW_ALLOW_MOCK: "garbage" }, () => {
		assert.equal(getCrewEnvBool("PI_CREW_ALLOW_MOCK"), undefined, "ambiguous → undefined (no default registered)");
	});
});

test("string parser: raw pass-through — trim stays at the call site (role-permission.ts:46)", () => {
	// role-permission.ts:46 reads `env.PI_CREW_ROLE?.trim() || env.PI_TEAMS_ROLE?.trim()`;
	// the registry must return the raw value so call-site .trim() keeps working.
	withEnv({ PI_CREW_ROLE: "  security-reviewer  " }, () => {
		assert.equal(getCrewEnv("PI_CREW_ROLE"), "  security-reviewer  ", "raw getter must NOT trim");
		assert.equal(getCrewEnvParsed("PI_CREW_ROLE"), "  security-reviewer  ", "string parser = raw");
	});
});

test("number parser: Number() with NaN fallback (PI_CREW_SCRATCHPAD_RESTORE_MTIME)", () => {
	withoutEnv(["PI_CREW_SCRATCHPAD_RESTORE_MTIME"], () => {
		assert.equal(getCrewEnvParsed("PI_CREW_SCRATCHPAD_RESTORE_MTIME"), undefined);
	});
	withEnv({ PI_CREW_SCRATCHPAD_RESTORE_MTIME: "1234.5" }, () => {
		assert.equal(getCrewEnvParsed("PI_CREW_SCRATCHPAD_RESTORE_MTIME"), 1234.5);
	});
	withEnv({ PI_CREW_SCRATCHPAD_RESTORE_MTIME: "not-a-number" }, () => {
		assert.equal(getCrewEnvParsed("PI_CREW_SCRATCHPAD_RESTORE_MTIME"), undefined, "NaN → fallback (no default registered)");
	});
});

test("json parser: PI_CREW_KEYBINDINGS parses JSON, invalid → default/undefined", () => {
	withEnv({ PI_CREW_KEYBINDINGS: '{"x":1}' }, () => {
		assert.deepEqual(getCrewEnvParsed("PI_CREW_KEYBINDINGS"), { x: 1 });
	});
	withEnv({ PI_CREW_KEYBINDINGS: "not-json" }, () => {
		assert.equal(getCrewEnvParsed("PI_CREW_KEYBINDINGS"), undefined, "invalid JSON → undefined (no default)");
	});
	withoutEnv(["PI_CREW_KEYBINDINGS"], () => {
		assert.equal(getCrewEnvParsed("PI_CREW_KEYBINDINGS"), undefined);
	});
});

test("string default fallback: PI_CREW_ATTEMPT returns '0' when unset", () => {
	withoutEnv(["PI_CREW_ATTEMPT"], () => {
		assert.equal(getCrewEnvParsed("PI_CREW_ATTEMPT"), "0");
		assert.equal(getCrewEnv("PI_CREW_ATTEMPT"), undefined, "raw getter does NOT apply the default");
	});
});

test("unregistered names fall back to raw process.env reads", () => {
	withEnv({ PI_CREW_NOT_A_REAL_VAR: "hello" }, () => {
		assert.equal(getCrewEnv("PI_CREW_NOT_A_REAL_VAR"), "hello");
	});
	withoutEnv(["PI_CREW_NOT_A_REAL_VAR"], () => {
		assert.equal(getCrewEnv("PI_CREW_NOT_A_REAL_VAR"), undefined);
	});
});

test("registry metadata: mirror pairs and defaults are declared", () => {
	assert.equal(CREW_ENV_VARS.PI_CREW_HOME.mirror, "PI_TEAMS_HOME");
	assert.equal(CREW_ENV_VARS.PI_CREW_HOME.mirrorPrecedence, "teams");
	assert.equal(CREW_ENV_VARS.PI_CREW_VERIFICATION_WORKTREE.mirrorPrecedence, "crew");
	assert.equal(CREW_ENV_VARS.PI_CREW_EXECUTE_WORKERS.mirrorPrecedence, "or");
	assert.equal(CREW_ENV_VARS.PI_CREW_DWF_SCRIPT_TIMEOUT_MS.parser, "int");
	assert.equal(CREW_ENV_VARS.PI_CREW_MAX_RUN_MS.default, 7_200_000);
});
