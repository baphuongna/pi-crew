/**
 * Central env-var registry for the PI_CREW_* / PI_TEAMS_* families.
 *
 * Phase 3.2 (refactor-plan row 3.2) deliverable: a single place that
 * enumerates every crew-family environment variable, its default, its
 * parser family, and its mirror (PI_CREW_X ↔ PI_TEAMS_X) mapping, plus a
 * single lookup function that preserves the exact read semantics of the
 * original `process.env.X` sites.
 *
 * DESIGN NOTES (behavior-preservation contract):
 * - `getCrewEnv(name)` returns the RAW string value (undefined when unset)
 *   so truthiness/existence checks (`if (getCrewEnv(...))`) and exact-string
 *   comparisons (`=== "1"`, `=== "success"`) behave identically to the
 *   original `process.env.X` reads. The registry `default` is applied by
 *   `getCrewEnvParsed` / the typed wrappers, NOT by the raw getter.
 * - Mirror resolution: when a name has a `mirror`, `getCrewEnv` reproduces
 *   the original dual-read precedence:
 *     - `mirrorPrecedence: "teams"`  → TEAMS ?? CREW  (PI_TEAMS_HOME wins)
 *     - `mirrorPrecedence: "crew"`   → CREW ?? TEAMS  (PI_CREW wins)
 *     - `mirrorPrecedence: "or"`     → no collapse — both names are read
 *       independently by the call site (e.g. `A === "0" || B === "0"`);
 *       `getCrewEnv` returns the raw value for the queried name only.
 * - WRITE sites (e.g. `process.env.PI_CREW_BACKGROUND_MODE = "1"`) stay raw
 *   by design; the registry documents them via `doc`/`deprecated` notes.
 *
 * The CI gate `scripts/check-env-vars.mjs` fails on any raw
 * `process.env.PI_CREW_*` / `PI_TEAMS_*` READ outside this file, so new
 * reads must be routed through `getCrewEnv`.
 */

export type CrewEnvParser = "string" | "int" | "number" | "boolean" | "json";
export type MirrorPrecedence = "crew" | "teams" | "or";

export interface CrewEnvVarSpec {
	/** Canonical env var name (registry key == the literal env var name). */
	name: string;
	/**
	 * Default applied by `getCrewEnvParsed` / typed wrappers when the var is
	 * unset (or unparseable). The raw `getCrewEnv` returns undefined instead,
	 * preserving original existence/truthiness semantics.
	 */
	default?: string | number | boolean;
	/** Parser family used by `getCrewEnvParsed` (documentation + tests). */
	parser?: CrewEnvParser;
	/** Mirror name (the PI_CREW_ ↔ PI_TEAMS_ counterpart), if any. */
	mirror?: string;
	/** How dual PI_CREW_/PI_TEAMS_ reads resolve (see module doc). */
	mirrorPrecedence?: MirrorPrecedence;
	/** Value is (also) written via `process.env` at some site. */
	writeOnly?: boolean;
	/** Deprecation / status note. */
	deprecated?: string;
	/** Short doc: where it is read and what it controls. */
	doc?: string;
}

/**
 * The registry. Every name READ in src/ is mandatory; names found only in
 * docs/tests are best-effort (marked with `deprecated`/`doc` notes).
 */
export const CREW_ENV_VARS: Record<string, CrewEnvVarSpec> = {
	// ── Mirror pairs — PI_TEAMS_HOME wins ────────────────────────────────
	PI_CREW_HOME: {
		name: "PI_CREW_HOME",
		mirror: "PI_TEAMS_HOME",
		mirrorPrecedence: "teams",
		doc: "pi-crew home dir; PI_TEAMS_HOME wins (config.ts:174, paths.ts:58, crew-vibes/config.ts:16)",
	},
	PI_TEAMS_HOME: {
		name: "PI_TEAMS_HOME",
		mirror: "PI_CREW_HOME",
		mirrorPrecedence: "teams",
		doc: "pi-crew home dir — primary of the TEAMS??CREW pair",
	},

	// ── Mirror pairs — PI_CREW wins ──────────────────────────────────────
	PI_CREW_DEPTH: {
		name: "PI_CREW_DEPTH",
		mirror: "PI_TEAMS_DEPTH",
		mirrorPrecedence: "crew",
		default: "0",
		parser: "int",
		doc: "current crew depth (pi-args.ts:72 reads CREW ?? TEAMS ?? '0')",
	},
	PI_TEAMS_DEPTH: {
		name: "PI_TEAMS_DEPTH",
		mirror: "PI_CREW_DEPTH",
		mirrorPrecedence: "crew",
		default: "0",
		parser: "int",
		doc: "crew depth mirror (fallback of PI_CREW_DEPTH)",
	},
	PI_CREW_MAX_DEPTH: {
		name: "PI_CREW_MAX_DEPTH",
		mirror: "PI_TEAMS_MAX_DEPTH",
		mirrorPrecedence: "crew",
		parser: "int",
		doc: "max crew depth, clamped 1..10 (pi-args.ts:78)",
	},
	PI_TEAMS_MAX_DEPTH: {
		name: "PI_TEAMS_MAX_DEPTH",
		mirror: "PI_CREW_MAX_DEPTH",
		mirrorPrecedence: "crew",
		parser: "int",
		doc: "max crew depth mirror (fallback of PI_CREW_MAX_DEPTH)",
	},
	PI_CREW_ROLE: {
		name: "PI_CREW_ROLE",
		mirror: "PI_TEAMS_ROLE",
		mirrorPrecedence: "crew",
		doc: "crew role name (role-permission.ts:46 reads CREW?.trim() || TEAMS?.trim())",
	},
	PI_TEAMS_ROLE: {
		name: "PI_TEAMS_ROLE",
		mirror: "PI_CREW_ROLE",
		mirrorPrecedence: "crew",
		doc: "crew role mirror (fallback of PI_CREW_ROLE)",
	},
	PI_CREW_VERIFICATION_PRESERVE_ENV: {
		name: "PI_CREW_VERIFICATION_PRESERVE_ENV",
		mirror: "PI_TEAMS_VERIFICATION_PRESERVE_ENV",
		mirrorPrecedence: "crew",
		doc: "extra env keys to preserve in verification commands (CREW ?? TEAMS ?? '')",
	},
	PI_TEAMS_VERIFICATION_PRESERVE_ENV: {
		name: "PI_TEAMS_VERIFICATION_PRESERVE_ENV",
		mirror: "PI_CREW_VERIFICATION_PRESERVE_ENV",
		mirrorPrecedence: "crew",
		doc: "verification preserve-env mirror (fallback of PI_CREW_...)",
	},
	PI_CREW_VERIFICATION_WORKTREE: {
		name: "PI_CREW_VERIFICATION_WORKTREE",
		mirror: "PI_TEAMS_VERIFICATION_WORKTREE",
		mirrorPrecedence: "crew",
		doc: "enable verification worktree sandbox; '1'/'true' (CREW ?? TEAMS)",
	},
	PI_TEAMS_VERIFICATION_WORKTREE: {
		name: "PI_TEAMS_VERIFICATION_WORKTREE",
		mirror: "PI_CREW_VERIFICATION_WORKTREE",
		mirrorPrecedence: "crew",
		doc: "verification worktree mirror (fallback of PI_CREW_...)",
	},
	PI_CREW_INHERIT_PROJECT_CONTEXT: {
		name: "PI_CREW_INHERIT_PROJECT_CONTEXT",
		mirror: "PI_TEAMS_INHERIT_PROJECT_CONTEXT",
		mirrorPrecedence: "crew",
		parser: "boolean",
		doc: "inherit project context in worker prompts; CREW checked first (prompt-runtime.ts readBooleanEnvAny)",
	},
	PI_TEAMS_INHERIT_PROJECT_CONTEXT: {
		name: "PI_TEAMS_INHERIT_PROJECT_CONTEXT",
		mirror: "PI_CREW_INHERIT_PROJECT_CONTEXT",
		mirrorPrecedence: "crew",
		parser: "boolean",
		doc: "inherit project context mirror (fallback of PI_CREW_...)",
	},
	PI_CREW_INHERIT_SKILLS: {
		name: "PI_CREW_INHERIT_SKILLS",
		mirror: "PI_TEAMS_INHERIT_SKILLS",
		mirrorPrecedence: "crew",
		parser: "boolean",
		doc: "inherit skills in worker prompts; CREW checked first (prompt-runtime.ts readBooleanEnvAny)",
	},
	PI_TEAMS_INHERIT_SKILLS: {
		name: "PI_TEAMS_INHERIT_SKILLS",
		mirror: "PI_CREW_INHERIT_SKILLS",
		mirrorPrecedence: "crew",
		parser: "boolean",
		doc: "inherit skills mirror (fallback of PI_CREW_...)",
	},

	// ── Mirror pairs — OR semantics (dual reads, no collapse) ─────────────
	PI_CREW_ADAPTIVE_REPAIR: {
		name: "PI_CREW_ADAPTIVE_REPAIR",
		mirror: "PI_TEAMS_ADAPTIVE_REPAIR",
		mirrorPrecedence: "or",
		doc: "'0' disables adaptive-plan repair; either name may disable (adaptive-plan.ts:434)",
	},
	PI_TEAMS_ADAPTIVE_REPAIR: {
		name: "PI_TEAMS_ADAPTIVE_REPAIR",
		mirror: "PI_CREW_ADAPTIVE_REPAIR",
		mirrorPrecedence: "or",
		doc: "adaptive-repair mirror (read independently, OR'd with PI_CREW_...)",
	},
	PI_CREW_BG_REPORT_ON_FATAL: {
		name: "PI_CREW_BG_REPORT_ON_FATAL",
		mirror: "PI_TEAMS_BG_REPORT_ON_FATAL",
		mirrorPrecedence: "or",
		doc: "'0' disables --report-on-fatalerror; either name may disable (async-runner.ts:127)",
	},
	PI_TEAMS_BG_REPORT_ON_FATAL: {
		name: "PI_TEAMS_BG_REPORT_ON_FATAL",
		mirror: "PI_CREW_BG_REPORT_ON_FATAL",
		mirrorPrecedence: "or",
		doc: "bg-report mirror (read independently, OR'd with PI_CREW_...)",
	},
	PI_CREW_EXECUTE_WORKERS: {
		name: "PI_CREW_EXECUTE_WORKERS",
		mirror: "PI_TEAMS_EXECUTE_WORKERS",
		mirrorPrecedence: "or",
		doc: "'0' disables real worker execution; either name disables (team-tool.ts:376, run.ts, runtime-resolver.ts:91)",
	},
	PI_TEAMS_EXECUTE_WORKERS: {
		name: "PI_TEAMS_EXECUTE_WORKERS",
		mirror: "PI_CREW_EXECUTE_WORKERS",
		mirrorPrecedence: "or",
		doc: "execute-workers mirror (read independently, OR'd with PI_CREW_...)",
	},
	PI_CREW_VERIFICATION_SANITIZE_ENV: {
		name: "PI_CREW_VERIFICATION_SANITIZE_ENV",
		mirror: "PI_TEAMS_VERIFICATION_SANITIZE_ENV",
		mirrorPrecedence: "or",
		doc: "'0' disables verification env sanitization; either name disables (verification-gates.ts:69)",
	},
	PI_TEAMS_VERIFICATION_SANITIZE_ENV: {
		name: "PI_TEAMS_VERIFICATION_SANITIZE_ENV",
		mirror: "PI_CREW_VERIFICATION_SANITIZE_ENV",
		mirrorPrecedence: "or",
		doc: "verification sanitize mirror (read independently, OR'd with PI_CREW_...)",
	},
	PI_CREW_WORKER_ATOMIC_WRITER: {
		name: "PI_CREW_WORKER_ATOMIC_WRITER",
		mirror: "PI_TEAMS_WORKER_ATOMIC_WRITER",
		mirrorPrecedence: "or",
		doc: "'1' enables the worker-thread atomic writer; either name enables (worker-atomic-writer.ts:166)",
	},
	PI_TEAMS_WORKER_ATOMIC_WRITER: {
		name: "PI_TEAMS_WORKER_ATOMIC_WRITER",
		mirror: "PI_CREW_WORKER_ATOMIC_WRITER",
		mirrorPrecedence: "or",
		doc: "worker-atomic-writer mirror (read independently, OR'd with PI_CREW_...)",
	},

	// ── Single names read via process.env (dot notation) ──────────────────
	PI_CREW_ALLOW_MOCK: {
		name: "PI_CREW_ALLOW_MOCK",
		parser: "boolean",
		doc: "'1'/'true' allows PI_TEAMS_MOCK_CHILD_PI mock mode (mock-fixtures.ts:40)",
	},
	PI_CREW_ASYNC_EARLY_EXIT_GUARD: {
		name: "PI_CREW_ASYNC_EARLY_EXIT_GUARD",
		doc: "'0' skips the async-run early-exit guard (team-tool/run.ts:103)",
	},
	PI_CREW_BACKGROUND_MODE: {
		name: "PI_CREW_BACKGROUND_MODE",
		doc: "background-runner marker; READ at child-executor.ts:616 ('1'), WRITTEN at background-runner.ts:713/833 (= '1')",
	},
	PI_CREW_BROKER: {
		name: "PI_CREW_BROKER",
		doc: "'1'/'0' force broker enabled/disabled (defaults.ts:187, lifecycle-handlers.ts:908)",
	},
	PI_CREW_DEBUG: {
		name: "PI_CREW_DEBUG",
		doc: "truthiness enables background debug logging (background-runner.ts:63)",
	},
	PI_CREW_DEBUG_BUDGET: {
		name: "PI_CREW_DEBUG_BUDGET",
		doc: "'1' logs token budget (team-tool/run.ts:498)",
	},
	PI_CREW_DWF_SCRIPT_TIMEOUT_MS: {
		name: "PI_CREW_DWF_SCRIPT_TIMEOUT_MS",
		parser: "int",
		default: 1_800_000,
		doc: "dynamic-workflow script timeout; default 30 min (dynamic-workflow-runner.ts:226)",
	},
	PI_CREW_DWF_SKIP_DETERMINISM_CHECK: {
		name: "PI_CREW_DWF_SKIP_DETERMINISM_CHECK",
		doc: "'1' disables the DWF determinism check (deterministic-ast.ts:60)",
	},
	PI_CREW_INTERRUPT_GUARD_INTERVAL_MS: {
		name: "PI_CREW_INTERRUPT_GUARD_INTERVAL_MS",
		parser: "int",
		default: 1000,
		doc: "interrupt-guard poll interval; default 1000ms (background-runner.ts:217)",
	},
	PI_CREW_MAX_RUN_MS: {
		name: "PI_CREW_MAX_RUN_MS",
		parser: "int",
		default: 7_200_000,
		doc: "max background run duration; default 2h (background-runner.ts:31)",
	},
	PI_CREW_MAX_WORKERS: {
		name: "PI_CREW_MAX_WORKERS",
		parser: "int",
		doc: "max concurrent workers; unset/empty/invalid → default max(2, cpus-2) (global-worker-cap.ts:33)",
	},
	PI_CREW_DISABLE_RESULT_READ_CACHE: {
		name: "PI_CREW_DISABLE_RESULT_READ_CACHE",
		doc: "'1' bypasses the per-run result-artifact read cache (R10-1 bypass control; task-output-context.ts createResultArtifactReadCache)",
	},
	PI_CREW_MOCK_LIVE_SESSION: {
		name: "PI_CREW_MOCK_LIVE_SESSION",
		doc: "'success' mocks a successful live-session (live-session-runtime.ts:558, runtime-resolver.ts:38/116)",
	},
	PI_CREW_PARENT_GUARD_INTERVAL_MS: {
		name: "PI_CREW_PARENT_GUARD_INTERVAL_MS",
		parser: "int",
		default: 500,
		doc: "parent-guard poll interval; default 500ms (parent-guard.ts:73)",
	},
	PI_CREW_PARENT_PID: {
		name: "PI_CREW_PARENT_PID",
		parser: "int",
		doc: "parent process pid; >0 starts the parent guard (background-runner.ts:626)",
	},
	PI_CREW_SCRATCHPAD_DEMOTE_BASH: {
		name: "PI_CREW_SCRATCHPAD_DEMOTE_BASH",
		doc: "'1' demotes bash for scratchpad roles (agent-config.ts:199)",
	},
	PI_CREW_SKIP_HOME_CHECK: {
		name: "PI_CREW_SKIP_HOME_CHECK",
		doc: "'1' skips the PI_TEAMS_HOME escape check (config.ts:185)",
	},
	PI_CREW_SUPPRESS_RPC_WARNING: {
		name: "PI_CREW_SUPPRESS_RPC_WARNING",
		doc: "'1' suppresses the missing-RPC-secret warning (rpc-hmac.ts:145)",
	},
	PI_CREW_TRUST_PROJECT_AGENT_EXTENSIONS: {
		name: "PI_CREW_TRUST_PROJECT_AGENT_EXTENSIONS",
		doc: "'1' trusts project/.pi agent extensions (discover-agents.ts:445/544)",
	},
	PI_CREW_PLAN_UI: {
		name: "PI_CREW_PLAN_UI",
		doc: "'1' enables the Plan dashboard pane (7) + plans snapshot slice (WP-7/R7)",
	},
	PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC: {
		name: "PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC",
		parser: "boolean",
		doc: "'1'/'true' writes non-terminal tasks checkpoints best-effort (no fsync; 50ms coalesce kept, only durability skipped); terminal transitions stay full (defaults.ts, config.ts persistence.skipTasksFsync)",
	},
	PI_CREW_TRUST_PROJECT_DWF: {
		name: "PI_CREW_TRUST_PROJECT_DWF",
		doc: "'1' allows project-sourced .dwf.ts workflows (dynamic-workflow-runner.ts:154)",
	},
	PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS: {
		name: "PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS",
		parser: "int",
		doc: "child Pi response timeout, bounded 1s..3.6M ms (child-pi.ts:356)",
	},
	PI_TEAMS_DEBUG: {
		name: "PI_TEAMS_DEBUG",
		doc: "truthiness gates debug-severity internal-error logging (internal-error.ts:4)",
	},
	PI_TEAMS_MOCK_CHILD_PI: {
		name: "PI_TEAMS_MOCK_CHILD_PI",
		doc: "mock child-pi mode; values 'success'/'json-success'/'adaptive-plan' (mock-fixtures.ts:35)",
	},
	PI_TEAMS_PI_BIN: {
		name: "PI_TEAMS_PI_BIN",
		doc: "explicit pi binary path for spawned children (pi-spawn.ts:262)",
	},

	// ── Single names read via process.env[...] (const/bracket sites) ──────
	PI_CREW_MAX_OUTPUT: {
		name: "PI_CREW_MAX_OUTPUT",
		parser: "int",
		doc: "max output tokens cap for background workers (prompt-runtime.ts:228)",
	},
	PI_CREW_STEERING_FILE: {
		name: "PI_CREW_STEERING_FILE",
		doc: "steering JSONL path polled by the worker (prompt-runtime.ts:260)",
	},
	PI_CREW_KEYBINDINGS: {
		name: "PI_CREW_KEYBINDINGS",
		parser: "json",
		doc: "JSON keybinding override map (keybinding-map.ts:314/347)",
	},
	PI_CREW_RPC_SECRET: {
		name: "PI_CREW_RPC_SECRET",
		doc: "shared HMAC secret; READ at rpc-hmac.ts:26/41, WRITTEN/cleared at :31/:36",
	},
	PI_CREW_PEER_DEP_DIR: {
		name: "PI_CREW_PEER_DEP_DIR",
		doc: "parent-provided pi-coding-agent package dir hint (peer-dep.ts:81)",
	},

	// ── Names read from a passed-in env object (child-spawned env) ────────
	PI_CREW_SCRATCHPAD: {
		name: "PI_CREW_SCRATCHPAD",
		doc: "'1' enables the scratchpad engine (scratchpad-lifecycle.ts:486/679, written by child-pi-spawn.ts)",
	},
	PI_CREW_KIND: {
		name: "PI_CREW_KIND",
		doc: "'subagent' marks child workers (scratchpad-lifecycle.ts:679, lifecycle-handlers.ts:892, zombie-scanner.ts:183)",
	},
	PI_CREW_TASK_ID: {
		name: "PI_CREW_TASK_ID",
		doc: "current task id for scratchpad/events (scratchpad-lifecycle.ts:90/227/280)",
	},
	PI_CREW_EVENTS_PATH: {
		name: "PI_CREW_EVENTS_PATH",
		doc: "events JSONL path for fire-and-forget metric events (scratchpad-lifecycle.ts:80)",
	},
	PI_CREW_ASK_ENABLED: {
		name: "PI_CREW_ASK_ENABLED",
		doc: "'1' enables the worker-side ask tool — dormant-until-env gate (written UNCONDITIONALLY by child-pi-spawn.ts, read by prompt-runtime.ts per ADR-0 WP-2 item 2)",
	},
	PI_CREW_MSG_ENABLED: {
		name: "PI_CREW_MSG_ENABLED",
		doc: "'1' enables the worker-side message tool (D9/§15.2) — dormant-until-env gate (written UNCONDITIONALLY by child-pi-spawn.ts, read by prompt-runtime.ts)",
	},
	PI_CREW_STATE_ROOT: {
		name: "PI_CREW_STATE_ROOT",
		doc: "run stateRoot for the ask-tool mailbox poll (<stateRoot>/mailbox; written by child-pi-spawn.ts, read by prompt-runtime.ts per ADR-0 WP-2 item 2)",
	},
	PI_CREW_BROKER_RUN_ID: {
		name: "PI_CREW_BROKER_RUN_ID",
		doc: "broker run id; aliases PI_CREW_RUN_ID (scratchpad-lifecycle.ts:81, crew-broker-child.ts:51)",
	},
	PI_CREW_AGENT_EVENTS_PATH: {
		name: "PI_CREW_AGENT_EVENTS_PATH",
		doc: "per-agent events log (<stateRoot>/agents/<taskId>/events.jsonl) written by the surface worker recorder (surface-worker.ts; derived by prepareSurfaceSpawn)",
	},
	PI_CREW_AUTO_EXIT: {
		name: "PI_CREW_AUTO_EXIT",
		doc: "'1' → the worker shuts its session down after the final settled turn — spec §5.2 D7 (written by prepareSurfaceSpawn, read by surface-worker.ts)",
	},
	PI_CREW_SURFACE: {
		name: "PI_CREW_SURFACE",
		doc: "surface provider kind for this worker ('tmux'|'herdr') — arms the worker-side recorder/parent-guard (written by prepareSurfaceSpawn.ts:214, read by surface-worker.ts)",
	},
	PI_CREW_PARENT_START_TIME: {
		name: "PI_CREW_PARENT_START_TIME",
		doc: "parent starttime ticks (/proc/<pid>/stat field 22) captured at spawn — pid-reuse-safe parent-guard comparison (written by prepareSurfaceSpawn.ts:223, read by surface-worker.ts)",
	},
	PI_CREW_ARTIFACTS_ROOT: {
		name: "PI_CREW_ARTIFACTS_ROOT",
		doc: "artifacts root for scratchpad containment (scratchpad-lifecycle.ts:228/281)",
	},
	PI_CREW_SCRATCHPAD_SNAPSHOT: {
		name: "PI_CREW_SCRATCHPAD_SNAPSHOT",
		doc: "snapshot path for the post-cell snapshot (scratchpad-lifecycle.ts:229)",
	},
	PI_CREW_ATTEMPT: {
		name: "PI_CREW_ATTEMPT",
		default: "0",
		doc: "current attempt number (scratchpad-lifecycle.ts:230 reads ?? '0')",
	},
	PI_CREW_SCRATCHPAD_RESTORE: {
		name: "PI_CREW_SCRATCHPAD_RESTORE",
		doc: "parent-set restore hint: previous attempt snapshot (scratchpad-lifecycle.ts:653)",
	},
	PI_CREW_SCRATCHPAD_RESTORE_MTIME: {
		name: "PI_CREW_SCRATCHPAD_RESTORE_MTIME",
		parser: "number",
		doc: "swap-detection mtime pin for restore snapshots (scratchpad-lifecycle.ts:302)",
	},
	PI_CREW_MAX_AUTO_FALLBACKS: {
		name: "PI_CREW_MAX_AUTO_FALLBACKS",
		parser: "int",
		doc: "max automatic model fallbacks (model-fallback.ts:527)",
	},
	PI_CREW_MODEL_FALLBACK_ORDER: {
		name: "PI_CREW_MODEL_FALLBACK_ORDER",
		doc: "'parentFirst' | 'asIs' fallback order (model-fallback.ts:555)",
	},
	PI_CREW_MODEL_REQUIRE_CREDENTIALS: {
		name: "PI_CREW_MODEL_REQUIRE_CREDENTIALS",
		parser: "boolean",
		doc: "'1'/'0' override requireCredentials (model-fallback.ts:557/559)",
	},
	PI_CREW_MODEL: {
		name: "PI_CREW_MODEL",
		doc: "model override for subagents (model-fallback.ts:584)",
	},
	PI_CREW_BROKER_SOCKET: {
		name: "PI_CREW_BROKER_SOCKET",
		doc: "broker unix socket path for child handshake (crew-broker-child.ts:49)",
	},
	PI_CREW_BROKER_TOKEN: {
		name: "PI_CREW_BROKER_TOKEN",
		doc: "broker handshake token (crew-broker-child.ts:50)",
	},
	PI_CREW_BROKER_TASK_ID: {
		name: "PI_CREW_BROKER_TASK_ID",
		doc: "broker task id for child handshake (crew-broker-child.ts:51)",
	},
	PI_CREW_GUEST: {
		name: "PI_CREW_GUEST",
		doc: "'1' marks the guest scratchpad process (written by scratchpad-lifecycle.ts:167)",
	},

	// ── Docs/tests-only (best-effort; not read via process.env in src/) ───
	PI_CREW_USE_BUNDLE: {
		name: "PI_CREW_USE_BUNDLE",
		doc: "read at root index.ts:78 (outside src/ gate scope): force strip-types loading when 0",
	},
	PI_CREW_SMOKE: {
		name: "PI_CREW_SMOKE",
		doc: "test-only: smoke-test helper flag (test/smoke/_helpers.ts)",
	},
	PI_CREW_RUN_PLATFORM_TESTS: {
		name: "PI_CREW_RUN_PLATFORM_TESTS",
		doc: "test-only: enables platform tests (test/platform)",
	},
	PI_CREW_HARD_KILL_GRACE_MS: {
		name: "PI_CREW_HARD_KILL_GRACE_MS",
		doc: "scripts-only: watchdog hard-kill grace (scripts/watchdog-harness.ts)",
	},
	PI_CREW_LIVE_MODEL: {
		name: "PI_CREW_LIVE_MODEL",
		doc: "docs/test-only: live-session model selection",
	},
	PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION: {
		name: "PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION",
		doc: "docs/test-only: experimental live-session opt-in",
	},
	PI_CREW_RUN_ID: {
		name: "PI_CREW_RUN_ID",
		doc: "test fixture name; src uses PI_CREW_BROKER_RUN_ID instead",
	},
	PI_TEAMS_CONFIG_KEYS: {
		name: "PI_TEAMS_CONFIG_KEYS",
		doc: "docs/test-only",
	},
	PI_TEAMS_MOCK: {
		name: "PI_TEAMS_MOCK",
		doc: "docs/test-only",
	},
	PI_CREW_VERIFICATION: {
		name: "PI_CREW_VERIFICATION",
		deprecated: "partial fixture name; real vars are PI_CREW_VERIFICATION_*",
		doc: "docs/test-only",
	},
	PI_TEAMS_VERIFICATION: {
		name: "PI_TEAMS_VERIFICATION",
		deprecated: "partial fixture name; real vars are PI_TEAMS_VERIFICATION_*",
		doc: "docs/test-only",
	},
	PI_CREW_ATOMIC_WRITER: {
		name: "PI_CREW_ATOMIC_WRITER",
		deprecated: "superseded by PI_CREW_WORKER_ATOMIC_WRITER",
		doc: "docs/test-only",
	},
	PI_CREW_BROKER_DIAG_UI: {
		name: "PI_CREW_BROKER_DIAG_UI",
		deprecated: "removed",
		doc: "docs/test-only",
	},
	PI_CREW_DEBUG_KILL: {
		name: "PI_CREW_DEBUG_KILL",
		doc: "docs/test-only",
	},
	PI_CREW_DWF_SANDBOX_DRY_RUN: {
		name: "PI_CREW_DWF_SANDBOX_DRY_RUN",
		doc: "docs/test-only",
	},
	PI_CREW_HOOK: {
		name: "PI_CREW_HOOK",
		doc: "docs/test-only",
	},
	PI_CREW_POOL_HEALTH: {
		name: "PI_CREW_POOL_HEALTH",
		doc: "docs/test-only",
	},
	PI_CREW_QUIET_PREFLIGHT: {
		name: "PI_CREW_QUIET_PREFLIGHT",
		doc: "docs/test-only",
	},
	PI_CREW_SAFE_BASH: {
		name: "PI_CREW_SAFE_BASH",
		deprecated: "dead",
		doc: "docs/test-only",
	},
	PI_CREW_SCRATCHPAD_EXPERIMENT: {
		name: "PI_CREW_SCRATCHPAD_EXPERIMENT",
		doc: "docs/test-only",
	},
	PI_CREW_SESSION_DEPTH: {
		name: "PI_CREW_SESSION_DEPTH",
		deprecated: "legacy name; code uses PI_CREW_DEPTH (ADR drift history 2026-08-09)",
		doc: "docs/test-only",
	},
	PI_CREW_SIG: {
		name: "PI_CREW_SIG",
		doc: "docs/test-only",
	},
	PI_CREW_SNAPSHOT_HMAC_KEY: {
		name: "PI_CREW_SNAPSHOT_HMAC_KEY",
		deprecated: "reverted (2026-08-13)",
		doc: "docs/test-only",
	},
	PI_CREW_SNAPSHOT_HMAC_STRICT: {
		name: "PI_CREW_SNAPSHOT_HMAC_STRICT",
		deprecated: "reverted (2026-08-13)",
		doc: "docs/test-only",
	},
	PI_CREW_TEST_REAL_MODEL: {
		name: "PI_CREW_TEST_REAL_MODEL",
		doc: "docs/test-only",
	},
	PI_CREW_TOOLING_429_NOTE: {
		name: "PI_CREW_TOOLING_429_NOTE",
		doc: "docs/test-only",
	},
	PI_CREW_MAX_OUTPUT_TOKENS: {
		name: "PI_CREW_MAX_OUTPUT_TOKENS",
		deprecated: "legacy name; actual var is PI_CREW_MAX_OUTPUT (comment-only in src)",
		doc: "docs/test-only",
	},
	PI_CREW_GOAL_OSCILLATION_EMBEDDINGS: {
		name: "PI_CREW_GOAL_OSCILLATION_EMBEDDINGS",
		doc: "docs/test-only",
	},
	PI_CREW_OPENAI_API_KEY: {
		name: "PI_CREW_OPENAI_API_KEY",
		doc: "comment-only in src (env-filter secret-name example)",
	},
	PI_CREW_SECRET_TOKEN: {
		name: "PI_CREW_SECRET_TOKEN",
		doc: "comment-only in src (env-filter secret-name example)",
	},
	PI_CREW_REFUSE_GATE_PATTERNS: {
		name: "PI_CREW_REFUSE_GATE_PATTERNS",
		doc: "docs-only",
	},
	PI_CREW_PROCEED_PATTERNS: {
		name: "PI_CREW_PROCEED_PATTERNS",
		doc: "docs-only",
	},
	PI_CREW_ENFORCEMENT_PATTERNS: {
		name: "PI_CREW_ENFORCEMENT_PATTERNS",
		doc: "docs-only",
	},
	// Pure test fixtures (placeholder names used by tests to prove isolation).
	PI_CREW_DIR: { name: "PI_CREW_DIR", doc: "test fixture" },
	PI_CREW_ROOT: { name: "PI_CREW_ROOT", doc: "test fixture" },
	PI_CREW_FOO: { name: "PI_CREW_FOO", doc: "test fixture" },
	PI_CREW_VAR: { name: "PI_CREW_VAR", doc: "test fixture" },
	PI_CREW_X: { name: "PI_CREW_X", doc: "test fixture" },
	PI_CREW_TEST_SECRET_VALUE: { name: "PI_CREW_TEST_SECRET_VALUE", doc: "test fixture" },
	PI_TEAMS_BAR: { name: "PI_TEAMS_BAR", doc: "test fixture" },
};

/**
 * Raw crew-env lookup. Returns the raw string (undefined when unset) with
 * mirror-alias fallback applied per the entry's `mirrorPrecedence`. This is
 * the behavior-preserving replacement for `process.env.PI_CREW_X` reads.
 */
export function getCrewEnv(name: string): string | undefined {
	const spec = CREW_ENV_VARS[name];
	if (!spec?.mirror || spec.mirrorPrecedence === "or") {
		return process.env[name];
	}
	const crewName = name.startsWith("PI_TEAMS_") ? spec.mirror : name;
	const teamsName = name.startsWith("PI_TEAMS_") ? name : spec.mirror;
	if (spec.mirrorPrecedence === "teams") {
		return process.env[teamsName] ?? process.env[crewName];
	}
	return process.env[crewName] ?? process.env[teamsName];
}

/**
 * Parsed lookup: applies the registry parser + default. Returns the raw
 * string for string/unparsed entries, `undefined` when unset with no
 * default. Only use where the generic parse matches the call-site semantics;
 * the raw `getCrewEnv` is the default choice for behavior preservation.
 */
export function getCrewEnvParsed(name: string): unknown {
	const spec = CREW_ENV_VARS[name];
	const raw = getCrewEnv(name);
	const fallback = (): unknown => spec?.default;
	if (raw === undefined) return fallback();
	if (!spec?.parser || spec.parser === "string") return raw;
	switch (spec.parser) {
		case "int": {
			const n = Number.parseInt(raw, 10);
			return Number.isNaN(n) ? fallback() : n;
		}
		case "number": {
			const n = Number(raw);
			return Number.isNaN(n) ? fallback() : n;
		}
		case "boolean": {
			const normalized = raw.trim().toLowerCase();
			if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
			if (normalized === "0" || normalized === "false" || normalized === "no") return false;
			return fallback();
		}
		case "json": {
			try {
				return JSON.parse(raw);
			} catch {
				return fallback();
			}
		}
	}
	return raw;
}

/** Typed wrapper: boolean parse of a registered crew env var. */
export function getCrewEnvBool(name: string): boolean | undefined {
	const value = getCrewEnvParsed(name);
	return typeof value === "boolean" ? value : undefined;
}

/** Typed wrapper: integer parse of a registered crew env var. */
export function getCrewEnvInt(name: string): number | undefined {
	const value = getCrewEnvParsed(name);
	return typeof value === "number" ? value : undefined;
}

/** Typed wrapper: string value (raw, mirror-resolved). */
export function getCrewEnvString(name: string): string | undefined {
	return getCrewEnv(name);
}

/** All registered crew env var names (for the gate + completeness tests). */
export function crewEnvNames(): string[] {
	return Object.keys(CREW_ENV_VARS);
}

/** True when the registry covers `name` (mirror or not). */
export function isCrewEnvRegistered(name: string): boolean {
	return Object.hasOwn(CREW_ENV_VARS, name);
}
