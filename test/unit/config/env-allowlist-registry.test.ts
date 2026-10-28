/**
 * C-1 (upgrade research round 2 §C-1, Wave A item 1): the env-allowlist
 * registry is the SINGLE source that generates the two crew-carrying
 * allowlists (BACKGROUND_RUNNER_ENV_ALLOWLIST, BASE_ALLOWLIST). This suite
 * pins the C-1 invariants:
 *
 *   1. BEHAVIOR PRESERVATION — the generated lists are byte-identical to the
 *      pre-registry literals (frozen copies below), plus the ONE documented
 *      addition (PI_CREW_TOOLS_MODIFIERS, introduced with this registry).
 *   2. DECISION COVERAGE — every CREW_ENV_VARS key carries exactly one
 *      forwarding decision; no decision names an unregistered var (the
 *      module already fail-fasts on import — this is the belt to that
 *      suspenders, and the guard for FUTURE registry additions).
 *   3. NO ORPHANS / NO DROPS — every allowlist decision appears in its
 *      destination list, and every crew-family entry IN the lists maps back
 *      to an allowlist decision for that destination.
 *   4. CHANNEL HONESTY — explicit-channel names (forwardModelControlEnv,
 *      PEER_DEP_DIR) are classified `explicit`; child-write/gap/host-only/
 *      test-only names never appear on a generated list.
 *   5. The generated allowlist stays validator-clean with an empty env
 *      (sanitizeEnvSecrets would throw on secret-looking entries that are
 *      absent — the MODEL_REQUIRE_CREDENTIALS lesson, pinned).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	backgroundRunnerEnvAllowlist,
	childPiBaseAllowlist,
	crewEnvForwardingDecisions,
	crewEnvForwardingGapReport,
} from "../../../src/config/env-allowlist-registry.ts";
import { CREW_ENV_VARS } from "../../../src/config/env-vars.ts";
import { BACKGROUND_RUNNER_ENV_ALLOWLIST, MODEL_CONTROL_ENV_EXPLICIT } from "../../../src/runtime/async-runner.ts";
import { BASE_ALLOWLIST } from "../../../src/runtime/child-pi/child-pi-spawn.ts";
import { sanitizeEnvSecrets } from "../../../src/utils/env-filter.ts";

/**
 * FROZEN pre-registry content (v0.11.16 literals). Order matters — the
 * generators must reproduce the historical order exactly so downstream
 * consumers (spec-sandbox, worktree/*, tests) see no drift. The permitted
 * deltas vs v0.11.16: PI_CREW_TOOLS_MODIFIERS appended (L2-3 opt-in flag — a
 * NEW control var, absent from the old literal by construction) and, from the
 * wave 11a review (MINOR #7), PI_CREW_REAP_GROUP appended (the reap kill switch
 * had to be forwarded to the detached runner, where the reap code also runs).
 */
const FROZEN_BACKGROUND_RUNNER = [
	"PATH",
	"HOME",
	"USER",
	"SHELL",
	"TERM",
	"LANG",
	"LC_ALL",
	"LC_COLLATE",
	"LC_CTYPE",
	"LC_MESSAGES",
	"LC_MONETARY",
	"LC_NUMERIC",
	"LC_TIME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_RUNTIME_DIR",
	// R1-M1 (wave-2b): documented addition — TMPDIR joins the essential set.
	"TMPDIR",
	"APPDATA",
	"LOCALAPPDATA",
	"USERPROFILE",
	"SystemRoot",
	"ComSpec",
	"TEMP",
	"TMP",
	"NVM_BIN",
	"NVM_DIR",
	"NVM_INC",
	"NODE_PATH",
	"NODE_DISABLE_COLORS",
	"NODE_EXTRA_CA_CERTS",
	"NPM_CONFIG_REGISTRY",
	"NPM_CONFIG_USERCONFIG",
	"NPM_CONFIG_GLOBALCONFIG",
	"PI_CREW_DEPTH",
	"PI_CREW_MAX_DEPTH",
	"PI_CREW_INHERIT_PROJECT_CONTEXT",
	"PI_CREW_INHERIT_SKILLS",
	"PI_CREW_PARENT_PID",
	"PI_TEAMS_DEPTH",
	"PI_TEAMS_MAX_DEPTH",
	"PI_TEAMS_INHERIT_PROJECT_CONTEXT",
	"PI_TEAMS_INHERIT_SKILLS",
	"PI_TEAMS_PI_BIN",
	"PI_TEAMS_MOCK_CHILD_PI",
	"PI_CREW_ALLOW_MOCK",
	"PI_CREW_BACKGROUND_RUNNER_ENTRY",
	"PI_CREW_WORKER_ATOMIC_WRITER",
	"PI_TEAMS_WORKER_ATOMIC_WRITER",
	"PI_CREW_VERIFICATION_SANITIZE_ENV",
	"PI_TEAMS_VERIFICATION_SANITIZE_ENV",
	"PI_CREW_VERIFICATION_PRESERVE_ENV",
	"PI_TEAMS_VERIFICATION_PRESERVE_ENV",
	"PI_CREW_VERIFICATION_WORKTREE",
	"PI_TEAMS_VERIFICATION_WORKTREE",
	"PI_CREW_BG_REPORT_ON_FATAL",
	"PI_TEAMS_BG_REPORT_ON_FATAL",
	"TMUX",
	"TMUX_PANE",
	"TMUX_TMPDIR",
	"HERDR_ENV",
	"HERDR_SESSION",
	"HERDR_PANE_ID",
	"HERDR_SOCKET_PATH",
	"HERDR_WORKSPACE_ID",
	"HERDR_PING_TIMEOUT_MS",
	"PI_CREW_MODEL",
	"PI_CREW_MODEL_FALLBACK_ORDER",
	"PI_CREW_STATE_BACKEND",
	"PI_CREW_CHILD_PI_MODE",
	"PI_CREW_CHILD_PI_POOL",
	// ── the ONE documented addition (L2-3, shipped with this registry) ──
	"PI_CREW_TOOLS_MODIFIERS",
	// ── wave 11a review (MINOR #7): documented addition #2 — the process-group
	// reap kill switch must reach the detached runner, which owns kill/reap
	// paths of its own; unforwarded it was silently inert there.
	"PI_CREW_REAP_GROUP",
	// ── wave 11b: documented addition #3 — the run-scoped descendant sweep kill
	// switch, same argument: the reconciler that drives the sweep also runs in
	// the detached runner.
	"PI_CREW_REAP_RUN_DESCENDANTS",
];

/** FROZEN pre-registry BASE_ALLOWLIST (v0.11.16) — plus the wave-2b TMPDIR addition. */
const FROZEN_BASE = [
	"PATH",
	"HOME",
	"USER",
	"SHELL",
	"TERM",
	"LANG",
	"LC_ALL",
	"LC_COLLATE",
	"LC_CTYPE",
	"LC_MESSAGES",
	"LC_MONETARY",
	"LC_NUMERIC",
	"LC_TIME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_RUNTIME_DIR",
	// R1-M1 (wave-2b): documented addition — TMPDIR joins the essential set.
	"TMPDIR",
	"APPDATA",
	"LOCALAPPDATA",
	"USERPROFILE",
	"SystemRoot",
	"ComSpec",
	"TEMP",
	"TMP",
	"NVM_BIN",
	"NVM_DIR",
	"NVM_INC",
	"NODE_DISABLE_COLORS",
	"NODE_EXTRA_CA_CERTS",
	"NPM_CONFIG_REGISTRY",
	"NPM_CONFIG_USERCONFIG",
	"NPM_CONFIG_GLOBALCONFIG",
	"PI_CREW_DEPTH",
];

const CREW_FAMILY_RE = /^(PI_CREW_|PI_TEAMS_)/;

test("behavior preservation: BACKGROUND_RUNNER_ENV_ALLOWLIST is the frozen v0.11.16 literal + the documented additions", () => {
	assert.deepEqual(BACKGROUND_RUNNER_ENV_ALLOWLIST, FROZEN_BACKGROUND_RUNNER);
	assert.deepEqual(backgroundRunnerEnvAllowlist(), FROZEN_BACKGROUND_RUNNER, "the generator must be the live source of the export");
});

test("behavior preservation: BASE_ALLOWLIST is the frozen v0.11.16 literal, byte-identical", () => {
	assert.deepEqual(BASE_ALLOWLIST, FROZEN_BASE);
});

test("R1-M1 (wave-2b): TMPDIR is present in BOTH generated allowlists (background runner + child pi)", () => {
	// The essential-process set feeds both generators; a regression that
	// rebuilds either list from a stale literal silently re-drops TMPDIR and
	// parent/children disagree on the temp root again.
	assert.ok(backgroundRunnerEnvAllowlist().includes("TMPDIR"), "backgroundRunnerEnvAllowlist must carry TMPDIR");
	assert.ok(childPiBaseAllowlist().includes("TMPDIR"), "childPiBaseAllowlist must carry TMPDIR");
});

test("C-1 coverage: every CREW_ENV_VARS key has exactly one forwarding decision (no unclassified, no orphan decisions)", () => {
	const decisions = crewEnvForwardingDecisions();
	const registryKeys = Object.keys(CREW_ENV_VARS).sort();
	const decisionKeys = Object.keys(decisions).sort();
	assert.deepEqual(
		decisionKeys,
		registryKeys,
		"the decision table must mirror the registry 1:1 — a NEW control var without a decision throws at import (see env-allowlist-registry.ts)",
	);
});

test("C-1 no-drop/no-orphan: every allowlist decision appears in its destination list; every crew entry in a list maps back", () => {
	const decisions = crewEnvForwardingDecisions();
	for (const [name, decision] of Object.entries(decisions)) {
		if (decision.kind !== "allowlist") continue;
		for (const dest of decision.destinations) {
			const list = dest === "background-runner" ? BACKGROUND_RUNNER_ENV_ALLOWLIST : BASE_ALLOWLIST;
			assert.ok(
				list.includes(name),
				`${name} is allowlisted for ${dest} but MISSING from the generated list (dropped control var — the C-1 incident class)`,
			);
		}
	}
	for (const [list, dest] of [
		[BACKGROUND_RUNNER_ENV_ALLOWLIST, "background-runner"],
		[BASE_ALLOWLIST, "child-pi"],
	] as const) {
		for (const entry of list.filter((n) => CREW_FAMILY_RE.test(n))) {
			const decision = decisions[entry];
			assert.ok(decision, `${entry} is on the ${dest} list but is not in CREW_ENV_VARS (orphan allowlist entry)`);
			assert.equal(decision.kind, "allowlist", `${entry} rides the ${dest} list — its decision must be allowlist`);
			assert.ok(
				decision.kind === "allowlist" && decision.destinations.includes(dest),
				`${entry}'s allowlist decision must cover ${dest}`,
			);
		}
	}
});

test("C-1 channel honesty: explicit channels, and non-allowlist kinds never leak onto a list", () => {
	const decisions = crewEnvForwardingDecisions();
	for (const name of MODEL_CONTROL_ENV_EXPLICIT) {
		assert.equal(decisions[name]?.kind, "explicit", `${name} forwards via forwardModelControlEnv — decision must say so`);
	}
	assert.equal(decisions.PI_CREW_PEER_DEP_DIR?.kind, "explicit");
	assert.equal(decisions.PI_CREW_ASYNC_RUN?.kind, "explicit");
	for (const [name, decision] of Object.entries(decisions)) {
		if (decision.kind === "allowlist") continue;
		assert.ok(
			!BACKGROUND_RUNNER_ENV_ALLOWLIST.includes(name),
			`${name} (${decision.kind}) must NOT ride the background-runner allowlist`,
		);
		assert.ok(!BASE_ALLOWLIST.includes(name), `${name} (${decision.kind}) must NOT ride the child-pi base allowlist`);
	}
});

test("C-1 secret safety: the generated allowlist stays validator-clean with an empty env", () => {
	assert.doesNotThrow(() => sanitizeEnvSecrets({}, { allowList: BACKGROUND_RUNNER_ENV_ALLOWLIST }));
	assert.doesNotThrow(() => sanitizeEnvSecrets({}, { allowList: BASE_ALLOWLIST }));
});

test("FIX-1 (2026-10-28): PI_CREW_BROKER_STDIN is child-write — re-written into built.env by the spawner, never ambient-forwarded", () => {
	// The worker-side mirror gate (crew-broker-child) reads its OWN
	// process.env; ambient forwarding never reaches the child, so the ONLY
	// channel that wires the opt-in route through is the spawner's explicit
	// built.env write. "child-write" is the exact registry semantic for that.
	// (Previously "host-only" with a reason claiming the parent decision fully
	// determines the route — wrong in practice: without the child write the
	// worker fallback was dead-wired and every opt-in spawn stayed creds-less.)
	const decision = crewEnvForwardingDecisions().PI_CREW_BROKER_STDIN;
	assert.equal(decision?.kind, "child-write");
	assert.ok(!BACKGROUND_RUNNER_ENV_ALLOWLIST.includes("PI_CREW_BROKER_STDIN"), "never ambient-forwarded to the runner");
	assert.ok(!BASE_ALLOWLIST.includes("PI_CREW_BROKER_STDIN"), "never ambient-forwarded to child-pi");
});

test("C-1 gap report: known runner-read gaps are surfaced explicitly (not silently forwarded)", () => {
	const gaps = crewEnvForwardingGapReport().map((g) => g.name);
	// Pin a representative sample — the full list lives in the registry table.
	for (const expected of [
		"PI_CREW_HEARTBEAT_PULSE_MS",
		"PI_CREW_MAX_RUN_MS",
		"PI_CREW_HERMETIC_WORKERS",
		"PI_CREW_TRUST_PROJECT_AGENT_EXTENSIONS",
	]) {
		assert.ok(
			gaps.includes(expected),
			`${expected} is a known gap (read by detached-runner code, deliberately unforwarded) — it must stay classified, never silently dropped`,
		);
	}
	// 44d16d94 lesson: the trio that caused the 2026-10-10 P2 must be allowlisted, NOT gap.
	for (const fixed of ["PI_CREW_STATE_BACKEND", "PI_CREW_CHILD_PI_MODE", "PI_CREW_CHILD_PI_POOL"]) {
		assert.ok(
			!gaps.includes(fixed) && BACKGROUND_RUNNER_ENV_ALLOWLIST.includes(fixed),
			`${fixed} must remain allowlisted (fix 44d16d94)`,
		);
	}
});
