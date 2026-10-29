/**
 * env-allowlist-registry.ts — central env-FORWARDING registry (C-1).
 *
 * Wave A item 1 (upgrade research round 2 §C-1, round 3 §L-lane): the three
 * hand-maintained allowlists (`BACKGROUND_RUNNER_ENV_ALLOWLIST` in
 * src/runtime/async-runner.ts, `BASE_ALLOWLIST` in
 * src/runtime/child-pi/child-pi-spawn.ts, `WINDOWS_ESSENTIAL_ENV_VARS` in
 * src/utils/env-allowlist.ts) drifted independently twice into P2 incidents
 * (PI_CREW_MODEL stripped 2026-09-29; PI_CREW_STATE_BACKEND / CHILD_PI_MODE /
 * CHILD_PI_POOL stripped 2026-10-10, fix 44d16d94). This module is the single
 * place that GENERATES both crew-carrying allowlists from one decision table
 * seeded from the read-side registry (`src/config/env-vars.ts` — CREW_ENV_VARS).
 *
 * BEHAVIOR-PRESERVATION CONTRACT (0.11.17):
 * - The generated lists are byte-identical to the pre-registry literals (pinned
 *   by test/unit/config/env-allowlist-registry.test.ts against frozen copies),
 *   with ONE documented addition: PI_CREW_TOOLS_MODIFIERS (L2-3 opt-in flag,
 *   new control var introduced together with this registry).
 * - Export paths do not move: async-runner.ts and child-pi-spawn.ts keep
 *   exporting their arrays (now assigned from the generators); consumers
 *   (spec-sandbox.ts, worktree/*, tests) are untouched.
 * - `WINDOWS_ESSENTIAL_ENV_VARS` stays DEFINED in src/utils/env-allowlist.ts:
 *   test/unit/utils/env-allowlist.test.ts pins that file as the only src/
 *   location allowed to carry the var literals. This registry IMPORTS it as a
 *   building block — no literals duplicated here.
 *
 * DECISION MODEL — every CREW_ENV_VARS key MUST carry exactly one decision
 * (fail-fast at module load + unit-test):
 *   - `allowlist` — ambient env forwarded via a generated allowlist (which
 *     destinations: "background-runner" and/or "child-pi").
 *   - `explicit`  — forwarded through a dedicated set-only channel (e.g.
 *     forwardModelControlEnv for secret-LOOKING names sanitizeEnvSecrets would
 *     reject from an allowlist).
 *   - `child-write` — WRITTEN into the per-child `built.env` by the spawner
 *     (child-pi-spawn.ts / prepareSurfaceSpawn.ts / pi-args.ts env emission);
 *     ambient forwarding is neither needed nor wanted.
 *   - `host-only` — read only by the host pi-crew process (UI, config load,
 *     pre-spawn decisions); spawned processes never read it.
 *   - `gap` — KNOWN GAP: the reading code ALSO runs inside the detached
 *     background runner (or the worker-argv builder), but the var is
 *     deliberately NOT forwarded today — forwarding it would change runtime
 *     behavior, which this wave forbids. Gaps are surfaced (see
 *     crewEnvForwardingGapReport) for a follow-up wave; the C-1 gate exists so
 *     no NEW control var lands unclassified.
 *   - `test-only` — docs/test fixtures; never part of any runtime surface.
 */

import { WINDOWS_ESSENTIAL_ENV_VARS } from "../utils/env-allowlist.ts";
import { CREW_ENV_VARS } from "./env-vars.ts";

// ── Platform groups (non-crew: OS + toolchain; NOT from CREW_ENV_VARS) ────

/** Process-essential vars every spawned process needs (locale/paths/term). */
export const ESSENTIAL_PROCESS_ENV_VARS: readonly string[] = [
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
	// R1-M1 (wave-2b): Node's fs.realpathSync.native / os.tmpdir / sqlite WAL
	// all consult TMPDIR; a host with a non-default TMPDIR spawned children that
	// diverged from it (temp paths under /tmp vs $TMPDIR) — pass it through so
	// parent and children agree on the temp root.
	"TMPDIR",
];

/** Node/npm toolchain vars (nvm prefixes, npm registry/config). */
export const NVM_ENV_VARS: readonly string[] = ["NVM_BIN", "NVM_DIR", "NVM_INC"];
export const NODE_ENV_VARS: readonly string[] = ["NODE_DISABLE_COLORS", "NODE_EXTRA_CA_CERTS"];
export const NPM_CONFIG_ENV_VARS: readonly string[] = ["NPM_CONFIG_REGISTRY", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG"];

/**
 * Mux-surface env (2026-08-30 Finding 2): the detached runner needs these to
 * DETECT and REACH the host's tmux/herdr — without them every async run gates
 * to no-mux and stays headless. None are secret-named (sanitizeEnvSecrets
 * would reject secret-looking allowlist entries absent from the env).
 */
export const MUX_SURFACE_ENV_VARS: readonly string[] = [
	"TMUX",
	"TMUX_PANE",
	"TMUX_TMPDIR",
	"HERDR_ENV",
	"HERDR_SESSION",
	"HERDR_PANE_ID",
	"HERDR_SOCKET_PATH",
	"HERDR_WORKSPACE_ID",
	"HERDR_PING_TIMEOUT_MS",
];

// ── Crew forwarding decisions (seeded from CREW_ENV_VARS) ─────────────────

export type EnvForwardDestination = "background-runner" | "child-pi";

export type CrewEnvForwardDecision =
	| { kind: "allowlist"; destinations: readonly EnvForwardDestination[]; reason: string }
	| { kind: "explicit"; channel: string; reason: string }
	| { kind: "child-write"; reason: string }
	| { kind: "host-only"; reason: string }
	| { kind: "gap"; reason: string }
	| { kind: "test-only"; reason: string };

const allowlist = (destinations: readonly EnvForwardDestination[], reason: string): CrewEnvForwardDecision => ({
	kind: "allowlist",
	destinations,
	reason,
});

/**
 * The decision table. Keys must be EXACTLY the CREW_ENV_VARS keys (validated at
 * module load): adding a control var to env-vars.ts without a decision here
 * throws on import — the C-1 guard against the "allowlist lagging the control
 * var" incident class (checklist C-8 item 3).
 */
const CREW_ENV_FORWARDING_DECL: Record<string, CrewEnvForwardDecision> = {
	// — allowlist: forwarded to the detached background runner (+ children) —
	PI_CREW_DEPTH: allowlist(["background-runner", "child-pi"], "depth accounting must survive into the runner AND every child worker"),
	PI_TEAMS_DEPTH: allowlist(["background-runner"], "depth mirror (CREW ?? TEAMS read in the runner)"),
	PI_CREW_MAX_DEPTH: allowlist(["background-runner"], "runner-side depth clamp"),
	PI_TEAMS_MAX_DEPTH: allowlist(["background-runner"], "depth-clamp mirror"),
	PI_CREW_INHERIT_PROJECT_CONTEXT: allowlist(["background-runner"], "runner builds worker prompts — inheritance must match the parent"),
	PI_TEAMS_INHERIT_PROJECT_CONTEXT: allowlist(["background-runner"], "inherit mirror"),
	PI_CREW_INHERIT_SKILLS: allowlist(["background-runner"], "runner builds worker prompts — inheritance must match the parent"),
	PI_TEAMS_INHERIT_SKILLS: allowlist(["background-runner"], "inherit mirror"),
	PI_CREW_PARENT_PID: allowlist(["background-runner"], "runner parent-guard liveness check"),
	PI_TEAMS_PI_BIN: allowlist(["background-runner"], "runner spawns child pi workers — needs the explicit binary path"),
	PI_TEAMS_MOCK_CHILD_PI: allowlist(["background-runner"], "runner-side mock fixture select"),
	PI_CREW_ALLOW_MOCK: allowlist(["background-runner"], "mock gate double-keyed with PI_TEAMS_MOCK_CHILD_PI"),
	PI_CREW_BACKGROUND_RUNNER_ENTRY: allowlist(["background-runner"], "entry guard read by the runner main() itself"),
	PI_CREW_WORKER_ATOMIC_WRITER: allowlist(["background-runner"], "RFC 15 worker-thread atomic writer opt-in (runner side)"),
	PI_TEAMS_WORKER_ATOMIC_WRITER: allowlist(["background-runner"], "atomic-writer mirror"),
	PI_CREW_VERIFICATION_SANITIZE_ENV: allowlist(["background-runner"], "verification commands run inside the runner"),
	PI_TEAMS_VERIFICATION_SANITIZE_ENV: allowlist(["background-runner"], "sanitize mirror"),
	PI_CREW_VERIFICATION_PRESERVE_ENV: allowlist(["background-runner"], "verification commands run inside the runner"),
	PI_TEAMS_VERIFICATION_PRESERVE_ENV: allowlist(["background-runner"], "preserve-env mirror"),
	PI_CREW_VERIFICATION_WORKTREE: allowlist(["background-runner"], "verification worktree sandbox (RFC 16) runs inside the runner"),
	PI_TEAMS_VERIFICATION_WORKTREE: allowlist(["background-runner"], "worktree-sandbox mirror"),
	PI_CREW_BG_REPORT_ON_FATAL: allowlist(
		["background-runner"],
		"V8 report flags are applied by the parent when BUILDING the runner argv (RFC 17); forwarded for parity/diagnostics",
	),
	PI_TEAMS_BG_REPORT_ON_FATAL: allowlist(["background-runner"], "report-on-fatal mirror"),
	PI_CREW_MODEL: allowlist(
		["background-runner"],
		"model routing for manifests without persisted modelContext (2026-09-29 full-battery Finding #1)",
	),
	PI_CREW_MODEL_FALLBACK_ORDER: allowlist(["background-runner"], "resolveModelFallbackPolicy in the runner"),
	PI_CREW_STATE_BACKEND: allowlist(["background-runner"], "runner OWNS task-state writes (U8 P2 parity — d0cef00f/44d16d94)"),
	PI_CREW_CHILD_PI_MODE: allowlist(["background-runner"], "runner spawns the child-pi workers (U14 parity)"),
	PI_CREW_CHILD_PI_POOL: allowlist(["background-runner"], "rpc worker pool rides along for the same parity reason"),
	PI_CREW_TOOLS_MODIFIERS: allowlist(
		["background-runner"],
		"L2-3 opt-in: the runner builds worker argv (pi-args) — the flag must reach it. The ONE deliberate content addition shipped with this registry",
	),

	// — explicit: set-only forwarding channels (never ambient) —
	PI_CREW_MODEL_REQUIRE_CREDENTIALS: {
		kind: "explicit",
		channel: "forwardModelControlEnv",
		reason: "secret-LOOKING suffix trips sanitizeEnvSecrets on unset envs — copied set-only (async-runner.ts)",
	},
	PI_CREW_PEER_DEP_DIR: {
		kind: "explicit",
		channel: "async-runner childEnv (PEER_DEP_DIR_ENV)",
		reason: "resolved peer-dep dir is computed at spawn time and injected next to the sanitized env",
	},
	PI_CREW_ASYNC_RUN: {
		kind: "explicit",
		channel: "buildBackgroundRunnerEnv",
		reason: "async telemetry marker STAMPED onto the runner env (never ambient; not a surface gate)",
	},

	// — child-write: written into per-child built.env by the spawner —
	PI_CREW_SCRATCHPAD: { kind: "child-write", reason: "child-pi-spawn dormant gate" },
	PI_CREW_KIND: { kind: "child-write", reason: "child-pi-spawn worker-kind marker" },
	PI_CREW_TASK_ID: { kind: "child-write", reason: "child-pi-spawn per-child task id" },
	PI_CREW_EVENTS_PATH: { kind: "child-write", reason: "child-pi-spawn per-child events log" },
	PI_CREW_ASK_ENABLED: { kind: "child-write", reason: "child-pi-spawn dormant ask gate" },
	PI_CREW_MSG_ENABLED: { kind: "child-write", reason: "child-pi-spawn dormant message gate" },
	PI_CREW_DELEGATE_ENABLED: { kind: "child-write", reason: "child-pi-spawn dormant delegate gate" },
	PI_CREW_STATE_ROOT: { kind: "child-write", reason: "child-pi-spawn mailbox root" },
	PI_CREW_BROKER_RUN_ID: { kind: "child-write", reason: "child-pi-spawn broker handshake" },
	PI_CREW_AGENT_EVENTS_PATH: { kind: "child-write", reason: "prepareSurfaceSpawn recorder log" },
	PI_CREW_BROKER_SOCKET: { kind: "child-write", reason: "child-pi-spawn broker handshake (never ambient — per-run socket)" },
	PI_CREW_BROKER_TOKEN: {
		kind: "child-write",
		reason: "per-task compound broker token via built.env/pipe (F4) — secret, never allowlisted",
	},
	PI_CREW_BROKER_TASK_ID: { kind: "child-write", reason: "child-pi-spawn broker handshake" },
	PI_CREW_BROKER_STDIN: {
		kind: "child-write",
		reason: "LOW-1 broker-credential transport gate (DEFAULT-ON since 2026-10-28 — only exact '0' opts out) — read by the HOST spawner (child-pi-spawn .resolveBrokerStdinHandshakeEnabled) to pick env vs stdin route, then RE-WRITTEN by that spawner into every gate-ON brokered child's built.env ('1') so the worker-side mirror gate (crew-broker-child .resolveBrokerStdinFallbackEnabled, which reads its OWN process.env) is armed deterministically and pre-flip workers (mirror === '1') stay compatible — ambient forwarding never reaches the child, so child-write is the only channel that wires the route through (FIX-1 2026-10-28). Never ambient-allowlisted: route selection is per-spawn",
	},
	PI_CREW_INFERENCE_BROKER: {
		kind: "gap",
		reason: "v0.11.31 inference broker toggle — resolved in the PARENT only (ensureInferenceBroker); deliberately never forwarded to children (a child re-starting its own broker would be nonsensical)",
	},
	PI_CREW_INFERENCE_TOKEN: {
		kind: "child-write",
		reason: "v0.11.31 per-worker inference broker token via built.env — secret, never allowlisted",
	},
	PI_CREW_INFERENCE_BUDGET_TOKENS: {
		kind: "gap",
		reason: "v0.11.31 per-worker budget read by the parent broker at token issuance (registerInferenceWorker)",
	},
	PI_CREW_INFERENCE_UPSTREAM: {
		kind: "test-only",
		reason: "v0.11.31 broker upstream override — TESTS ONLY (local mock), production never sets it",
	},
	PI_CREW_INFERENCE_UPSTREAM_ANTHROPIC: { kind: "test-only", reason: "v0.11.34 anthropic-only broker upstream override — TESTS ONLY" },
	PI_CREW_INFERENCE_UPSTREAM_OPENAI: { kind: "test-only", reason: "v0.11.34 openai-only broker upstream override — TESTS ONLY" },
	PI_CREW_INFERENCE_UPSTREAM_GOOGLE: { kind: "test-only", reason: "v0.11.36 google-only broker upstream override — TESTS ONLY" },
	PI_CREW_SANDBOX: {
		kind: "gap",
		reason: "v0.11.36 OS-boundary knob read in the PARENT spawn path only (bwrap wrap decision) — deliberately never forwarded to children",
	},
	PI_CREW_SANDBOX_NET: {
		kind: "gap",
		reason: "v0.11.36 sandbox network profile (share|off) read in the PARENT spawn path only — deliberately never forwarded to children",
	},
	PI_CREW_REAP_GROUP: allowlist(
		["background-runner"],
		"fix-wave 11a process-group reap kill switch — read by the reaping code (reap-group.ts resolveReapGroupEnabled) which ALSO runs inside the detached background runner; unforwarded it would be silently inert there (wave 11a review MINOR #7). Not forwarded to children: a worker must not be able to disable its own reaping",
	),
	PI_CREW_REAP_RUN_DESCENDANTS: allowlist(
		["background-runner"],
		"fix-wave 11b run-scoped descendant sweep kill switch (run-descendant-sweep.ts resolveRunDescendantSweepEnabled) — the stale reconciler that drives the sweep also runs inside the detached background runner, so the same inert-switch argument as PI_CREW_REAP_GROUP applies. Not forwarded to children: a worker must not be able to disable its own reaping",
	),
	PI_CREW_STEERING_FILE: { kind: "child-write", reason: "child-pi-spawn per-run steering JSONL" },
	PI_CREW_MAX_OUTPUT: { kind: "child-write", reason: "pi-args emits agent.maxTokens into built.env" },
	PI_CREW_RPC_SECRET: { kind: "child-write", reason: "shared HMAC secret handed to the child at spawn — secret name, never allowlisted" },
	PI_CREW_AUTO_EXIT: { kind: "child-write", reason: "prepareSurfaceSpawn D7 shutdown marker" },
	PI_CREW_SURFACE: { kind: "child-write", reason: "prepareSurfaceSpawn surface kind" },
	PI_CREW_PARENT_START_TIME: { kind: "child-write", reason: "prepareSurfaceSpawn pid-reuse-safe guard input" },
	PI_CREW_ARTIFACTS_ROOT: { kind: "child-write", reason: "child-pi-spawn scratchpad containment root" },
	PI_CREW_SCRATCHPAD_SNAPSHOT: { kind: "child-write", reason: "child-pi-spawn snapshot target" },
	PI_CREW_ATTEMPT: { kind: "child-write", reason: "child-pi-spawn attempt number" },
	PI_CREW_SCRATCHPAD_RESTORE: { kind: "child-write", reason: "child-pi-spawn restore hint" },
	PI_CREW_SCRATCHPAD_RESTORE_MTIME: { kind: "child-write", reason: "child-pi-spawn swap-detection pin" },
	PI_CREW_GUEST: { kind: "child-write", reason: "guest scratchpad self-marker" },

	// — host-only: read by the host pi-crew process before/during spawn —
	PI_CREW_HOME: { kind: "host-only", reason: "host config/paths resolution" },
	PI_TEAMS_HOME: { kind: "host-only", reason: "host config/paths resolution (mirror)" },
	PI_CREW_ROLE: { kind: "host-only", reason: "role-permission host-side check" },
	PI_TEAMS_ROLE: { kind: "host-only", reason: "role mirror" },
	PI_CREW_ADAPTIVE_REPAIR: { kind: "host-only", reason: "adaptive-plan repair runs pre-spawn in the host" },
	PI_TEAMS_ADAPTIVE_REPAIR: { kind: "host-only", reason: "adaptive-repair mirror" },
	PI_CREW_EXECUTE_WORKERS: { kind: "host-only", reason: "spawn-mode decision made by the host" },
	PI_TEAMS_EXECUTE_WORKERS: { kind: "host-only", reason: "execute-workers mirror" },
	PI_CREW_TEST_ASYNC_INLINE: { kind: "host-only", reason: "async-runner spawn seam decision (test-only, host side)" },
	PI_CREW_ASYNC_EARLY_EXIT_GUARD: { kind: "host-only", reason: "team-tool/run.ts early-exit guard (host spawn path)" },
	PI_CREW_BROKER: { kind: "host-only", reason: "defaults/lifecycle broker enable (host session)" },
	PI_CREW_DEBUG_BUDGET: { kind: "host-only", reason: "token-budget debug log at run submit" },
	PI_CREW_DEBUG_STALE: { kind: "host-only", reason: "stale reconciler forensic gate — may run in any HOST process" },
	PI_CREW_MOCK_LIVE_SESSION: { kind: "host-only", reason: "runtime-resolver mode pick (host)" },
	PI_CREW_SKIP_HOME_CHECK: { kind: "host-only", reason: "config load escape check" },
	PI_CREW_SUPPRESS_RPC_WARNING: { kind: "host-only", reason: "host extension rpc-hmac warning" },
	PI_CREW_PLAN_UI: { kind: "host-only", reason: "host UI pane toggle" },
	PI_CREW_KEYBINDINGS: { kind: "host-only", reason: "host keybinding map" },
	PI_CREW_AUTO_PRUNE_KEEP: { kind: "host-only", reason: "session-start auto-prune (run-maintenance, host)" },
	PI_CREW_AUTO_PRUNE_AGE_FLOOR_HOURS: { kind: "host-only", reason: "session-start auto-prune (host)" },
	PI_CREW_USE_BUNDLE: { kind: "host-only", reason: "root index.ts loader choice (outside src/ gate scope)" },

	// — gap: read by code that ALSO runs in the detached runner, deliberately
	//   NOT forwarded (behavior preservation 0.11.17) — follow-up candidates.
	PI_CREW_PROMPT_BREAKDOWN: { kind: "gap", reason: "prompt-builder runs in the runner for async runs" },
	PI_CREW_PROMPT_SKILLS: { kind: "gap", reason: "prompt-builder runs in the runner for async runs" },
	PI_CREW_BACKGROUND_MODE: { kind: "gap", reason: "child-executor read inside the runner" },
	PI_CREW_DEBUG: { kind: "gap", reason: "background-runner debug logging" },
	PI_TEAMS_DEBUG: { kind: "gap", reason: "internal-error severity gate — every process incl. the runner" },
	PI_CREW_DWF_SCRIPT_TIMEOUT_MS: { kind: "gap", reason: "dynamic-workflow runner executes in-process" },
	PI_CREW_DWF_SKIP_DETERMINISM_CHECK: { kind: "gap", reason: "deterministic-ast check in the DWF path" },
	PI_CREW_TRUST_PROJECT_DWF: { kind: "gap", reason: "project DWF trust gate on the runner path" },
	PI_CREW_HEARTBEAT_PULSE_MS: { kind: "gap", reason: "child-executor liveness pulse (runner)" },
	PI_CREW_INTERRUPT_GUARD_INTERVAL_MS: { kind: "gap", reason: "background-runner interrupt guard" },
	PI_CREW_WATCHDOG_INTERVAL_MS: {
		kind: "gap",
		reason: "WD-INTERVAL foreground-watchdog poll interval — read by the HOST session only; registered as a gap (deliberately not forwarded) so the decision table stays complete and a future runner-side watchdog is auditable",
	},
	PI_CREW_MAX_RUN_MS: { kind: "gap", reason: "background-runner run ceiling" },
	PI_CREW_MAX_WORKERS: { kind: "gap", reason: "global worker cap — enforced in the runner too" },
	PI_CREW_DISABLE_RESULT_READ_CACHE: { kind: "gap", reason: "task-output-context read cache (runner)" },
	PI_CREW_HANDOFF_BUDGET_TOKENS: { kind: "gap", reason: "dependency-context trim (runner)" },
	PI_CREW_PARENT_GUARD_INTERVAL_MS: { kind: "gap", reason: "parent-guard poll (runner + surface workers)" },
	PI_CREW_SCRATCHPAD_DEMOTE_BASH: { kind: "gap", reason: "agent-config parse on the runner prompt path" },
	PI_CREW_TRUST_PROJECT_AGENT_EXTENSIONS: { kind: "gap", reason: "pi-args reads input.env when the runner builds worker argv" },
	PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC: { kind: "gap", reason: "config load happens in the runner too" },
	PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS: { kind: "gap", reason: "child-pi response timeout resolved in the runner" },
	PI_CREW_SESSION_RECOVERY: { kind: "gap", reason: "session-recovery resolve on the runner path" },
	PI_CREW_HERMETIC_WORKERS: { kind: "gap", reason: "pi-args hermetic resolve when the runner builds argv" },
	PI_CREW_WORKER_TRANSPORT: { kind: "gap", reason: "rpc-worker transport seam (runner)" },
	PI_CREW_CLASSIFIER_ENABLED: { kind: "gap", reason: "child-executor retry classifier (runner)" },
	PI_CREW_CLASSIFIER_MODEL: { kind: "gap", reason: "child-executor retry classifier (runner)" },
	PI_CREW_VERIFY_GATE: { kind: "gap", reason: "verify-gate pre-gate before verifier spawns (runner)" },
	PI_CREW_VERIFY_GATE_TIMEOUT_MS: { kind: "gap", reason: "verify-gate per-check timeout (runner)" },
	PI_CREW_VERIFY_GATE_MEMO: {
		kind: "gap",
		reason: "W10-2 memoized green verify-gate (host-only tree-hash memo; never forwarded to children — each process gates itself, exactly like PI_CREW_VERIFY_GATE)",
	},
	PI_CREW_VERIFY_DETERMINISM: {
		kind: "gap",
		reason: "U13-ADJ layer-3 determinism rerun toggle — resolved in the runner before the verifier spawns; deliberately unforwarded (each process decides its own gate determinism tier, exactly like PI_CREW_VERIFY_GATE above)",
	},
	PI_CREW_RUN_LOCK_SOCKET: {
		kind: "gap",
		reason: "U21 run-lock dual-guard toggle — withRunLock also runs in the runner; deliberately unforwarded this wave (socket dies with each process, so a host-vs-runner toggle mismatch is harmless: each process just picks its own admission tier)",
	},
	PI_CREW_RPC_DIALOG_ANSWER: { kind: "gap", reason: "rpc-worker dialog policy (runner)" },
	PI_CREW_RPC_TURN_TIMEOUT_MS: { kind: "gap", reason: "rpc-worker turn timeout (runner)" },
	PI_CREW_MAX_AUTO_FALLBACKS: { kind: "gap", reason: "model-fallback cap resolved in the runner" },

	// — test-only: docs/test fixtures; never on a runtime surface —
	PI_CREW_SMOKE: { kind: "test-only", reason: "smoke helper" },
	PI_CREW_RUN_PLATFORM_TESTS: { kind: "test-only", reason: "platform test gate" },
	PI_CREW_HARD_KILL_GRACE_MS: { kind: "test-only", reason: "watchdog harness script" },
	PI_CREW_LIVE_MODEL: { kind: "test-only", reason: "live-session test model" },
	PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION: { kind: "test-only", reason: "experimental opt-in (docs)" },
	PI_CREW_RUN_ID: { kind: "test-only", reason: "fixture name; src uses PI_CREW_BROKER_RUN_ID" },
	PI_TEAMS_CONFIG_KEYS: { kind: "test-only", reason: "fixture" },
	PI_TEAMS_MOCK: { kind: "test-only", reason: "fixture" },
	PI_CREW_VERIFICATION: { kind: "test-only", reason: "partial fixture name" },
	PI_TEAMS_VERIFICATION: { kind: "test-only", reason: "partial fixture name" },
	PI_CREW_ATOMIC_WRITER: { kind: "test-only", reason: "superseded by PI_CREW_WORKER_ATOMIC_WRITER" },
	PI_CREW_BROKER_DIAG_UI: { kind: "test-only", reason: "removed" },
	PI_CREW_DEBUG_KILL: { kind: "test-only", reason: "docs/test-only" },
	PI_CREW_DWF_SANDBOX_DRY_RUN: { kind: "test-only", reason: "docs/test-only" },
	PI_CREW_HOOK: { kind: "test-only", reason: "docs/test-only" },
	PI_CREW_POOL_HEALTH: { kind: "test-only", reason: "docs/test-only" },
	PI_CREW_QUIET_PREFLIGHT: { kind: "test-only", reason: "docs/test-only" },
	PI_CREW_SAFE_BASH: { kind: "test-only", reason: "dead" },
	PI_CREW_SCRATCHPAD_EXPERIMENT: { kind: "test-only", reason: "docs/test-only" },
	PI_CREW_SESSION_DEPTH: { kind: "test-only", reason: "legacy name (ADR drift 2026-08-09)" },
	PI_CREW_SIG: { kind: "test-only", reason: "docs/test-only" },
	PI_CREW_SNAPSHOT_HMAC_KEY: { kind: "test-only", reason: "reverted 2026-08-13" },
	PI_CREW_SNAPSHOT_HMAC_STRICT: { kind: "test-only", reason: "reverted 2026-08-13" },
	PI_CREW_TEST_REAL_MODEL: { kind: "test-only", reason: "docs/test-only" },
	PI_CREW_TOOLING_429_NOTE: { kind: "test-only", reason: "docs/test-only" },
	PI_CREW_MAX_OUTPUT_TOKENS: { kind: "test-only", reason: "legacy name; real var PI_CREW_MAX_OUTPUT" },
	PI_CREW_GOAL_OSCILLATION_EMBEDDINGS: { kind: "test-only", reason: "docs/test-only" },
	PI_CREW_OPENAI_API_KEY: { kind: "test-only", reason: "env-filter secret-name EXAMPLE (comment-only)" },
	PI_CREW_SECRET_TOKEN: { kind: "test-only", reason: "env-filter secret-name EXAMPLE (comment-only)" },
	PI_CREW_REFUSE_GATE_PATTERNS: { kind: "test-only", reason: "docs-only" },
	PI_CREW_PROCEED_PATTERNS: { kind: "test-only", reason: "docs-only" },
	PI_CREW_ENFORCEMENT_PATTERNS: { kind: "test-only", reason: "docs-only" },
	PI_CREW_DIR: { kind: "test-only", reason: "isolation fixture" },
	PI_CREW_ROOT: { kind: "test-only", reason: "isolation fixture" },
	PI_CREW_FOO: { kind: "test-only", reason: "isolation fixture" },
	PI_CREW_VAR: { kind: "test-only", reason: "isolation fixture" },
	PI_CREW_X: { kind: "test-only", reason: "isolation fixture" },
	PI_CREW_TEST_SECRET_VALUE: { kind: "test-only", reason: "isolation fixture" },
	PI_TEAMS_BAR: { kind: "test-only", reason: "isolation fixture" },
};

function validateDecisionTable(): void {
	const registryKeys = new Set(Object.keys(CREW_ENV_VARS));
	const decisionKeys = new Set(Object.keys(CREW_ENV_FORWARDING_DECL));
	const unclassified = [...registryKeys].filter((k) => !decisionKeys.has(k));
	if (unclassified.length > 0) {
		throw new Error(`env-allowlist-registry: CREW_ENV_VARS entries without a forwarding decision (C-1): ${unclassified.join(", ")}`);
	}
	const orphan = [...decisionKeys].filter((k) => !registryKeys.has(k));
	if (orphan.length > 0) {
		throw new Error(`env-allowlist-registry: decisions for names NOT in CREW_ENV_VARS (orphans): ${orphan.join(", ")}`);
	}
}

validateDecisionTable();

/** Read-only view of the decision table (tests + gap reporting). */
export function crewEnvForwardingDecisions(): Readonly<Record<string, CrewEnvForwardDecision>> {
	return CREW_ENV_FORWARDING_DECL;
}

/** Names whose decision is `kind` (sorted for stable reporting). */
export function crewEnvNamesByDecisionKind(kind: CrewEnvForwardDecision["kind"]): string[] {
	return Object.entries(CREW_ENV_FORWARDING_DECL)
		.filter(([, d]) => d.kind === kind)
		.map(([name]) => name)
		.sort();
}

/**
 * Known forwarding gaps (kind "gap"): control vars read by spawned-process
 * code but deliberately NOT forwarded as of 0.11.17. Surfaced for follow-up
 * waves — DO NOT silently forward one (each addition changes runtime env
 * behavior and needs its own parity rationale).
 */
export function crewEnvForwardingGapReport(): { name: string; reason: string }[] {
	return Object.entries(CREW_ENV_FORWARDING_DECL)
		.filter(([, d]) => d.kind === "gap")
		.map(([name, d]) => ({ name, reason: d.reason }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Validate the FULL ordered group set for one destination. Fail-fast
 * invariants (programming errors, caught by tests at authoring time;
 * runtime never sees these throw on a green test suite):
 *   - every name must be a CREW_ENV_VARS key with an `allowlist` decision
 *     covering `destination` (no orphan entries — C-1 test),
 *   - no duplicates across groups,
 *   - every `allowlist`-decision name for `destination` appears in exactly
 *     one group (no silently dropped control var — the incident class).
 */
function validateCrewForwardingOrder(destination: EnvForwardDestination, groups: readonly (readonly string[])[]): void {
	const tagged = new Set(
		Object.entries(CREW_ENV_FORWARDING_DECL)
			.filter(([, d]) => d.kind === "allowlist" && d.destinations.includes(destination))
			.map(([name]) => name),
	);
	const seen = new Set<string>();
	for (const group of groups) {
		for (const name of group) {
			if (seen.has(name)) {
				throw new Error(`env-allowlist-registry: duplicate crew env "${name}" for ${destination}`);
			}
			if (!tagged.has(name)) {
				throw new Error(
					`env-allowlist-registry: "${name}" is in the ${destination} group order but has no allowlist decision for it (orphan or mis-tagged)`,
				);
			}
			seen.add(name);
		}
	}
	for (const name of tagged) {
		if (!seen.has(name)) {
			throw new Error(`env-allowlist-registry: "${name}" is allowlisted for ${destination} but missing from its group order`);
		}
	}
}

// Historical group ORDER (pre-registry literals — do not reorder; the
// behavior-preservation test pins exact content):
const BG_CREW_CORE_ORDER = [
	// depth + inheritance + parent-guard + bin/mock gates + entry guard +
	// atomic writer + verification trio + report-on-fatal (pre-mux block).
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
] as const;
const BG_CREW_MODEL_ORDER = ["PI_CREW_MODEL", "PI_CREW_MODEL_FALLBACK_ORDER"] as const;
const BG_CREW_STATE_ORDER = ["PI_CREW_STATE_BACKEND", "PI_CREW_CHILD_PI_MODE", "PI_CREW_CHILD_PI_POOL"] as const;
const BG_CREW_TOOLS_ORDER = ["PI_CREW_TOOLS_MODIFIERS"] as const;
// Wave 11a review (MINOR #7): the reap kill switch must be honoured by the
// detached runner too — the runner (and the surface workers it spawns) own
// kill/reap paths, so an unforwarded switch was silently inert there.
const BG_CREW_REAP_ORDER = ["PI_CREW_REAP_GROUP", "PI_CREW_REAP_RUN_DESCENDANTS"] as const;
const CHILD_CREW_DEPTH_ORDER = ["PI_CREW_DEPTH"] as const;

const BG_CREW_GROUPS = [BG_CREW_CORE_ORDER, BG_CREW_MODEL_ORDER, BG_CREW_STATE_ORDER, BG_CREW_TOOLS_ORDER, BG_CREW_REAP_ORDER] as const;

/**
 * Generate the detached background-runner allowlist (exported AS
 * BACKGROUND_RUNNER_ENV_ALLOWLIST by src/runtime/async-runner.ts).
 * Provider API keys are INTENTIONALLY OMITTED (security review M1): the
 * runner only spawns child Pi workers, which read keys from the Pi config
 * file (not env) — env keys leak into V8 fatal-error reports unredacted.
 * Layout preserves the pre-registry literal order: platform prefix → crew
 * core → mux surface → model → state → tools-modifier (the one addition).
 */
export function backgroundRunnerEnvAllowlist(): string[] {
	validateCrewForwardingOrder("background-runner", BG_CREW_GROUPS);
	return [
		...ESSENTIAL_PROCESS_ENV_VARS,
		...WINDOWS_ESSENTIAL_ENV_VARS,
		...NVM_ENV_VARS,
		"NODE_PATH",
		...NODE_ENV_VARS,
		...NPM_CONFIG_ENV_VARS,
		...BG_CREW_CORE_ORDER,
		...MUX_SURFACE_ENV_VARS,
		...BG_CREW_MODEL_ORDER,
		...BG_CREW_STATE_ORDER,
		...BG_CREW_TOOLS_ORDER,
		...BG_CREW_REAP_ORDER,
	];
}

/**
 * Generate the child-Pi base allowlist (exported AS BASE_ALLOWLIST by
 * src/runtime/child-pi/child-pi-spawn.ts). Provider API keys are injected
 * dynamically via buildScopedAllowList() only when a model is assigned
 * (per-task key scoping). No NODE_PATH here — buildChildPiSpawnOptions
 * validates it separately against safe prefixes.
 */
export function childPiBaseAllowlist(): string[] {
	validateCrewForwardingOrder("child-pi", [CHILD_CREW_DEPTH_ORDER]);
	return [
		...ESSENTIAL_PROCESS_ENV_VARS,
		...WINDOWS_ESSENTIAL_ENV_VARS,
		...NVM_ENV_VARS,
		...NODE_ENV_VARS,
		...NPM_CONFIG_ENV_VARS,
		...CHILD_CREW_DEPTH_ORDER,
	];
}
