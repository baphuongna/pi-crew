// 2.9 — config interface types extracted from src/config/config.ts.
//
// All public surface types live here so that hot-path callers (loadConfig,
// merging helpers, schema validators) can import just the types without
// pulling in the parser graph. config.ts re-exports every name from this
// file for backwards compat — existing `import { CrewUiConfig } from "../config/config.ts"`
// continues to work.

export type PiTeamsAutonomyProfile = "manual" | "suggested" | "assisted" | "aggressive";

export interface PiTeamsAutonomousConfig {
	profile?: PiTeamsAutonomyProfile;
	enabled?: boolean;
	injectPolicy?: boolean;
	preferAsyncForLongTasks?: boolean;
	allowWorktreeSuggestion?: boolean;
	magicKeywords?: Record<string, string[]>;
}

export interface CrewLimitsConfig {
	maxConcurrentWorkers?: number;
	allowUnboundedConcurrency?: boolean;
	maxTaskDepth?: number;
	maxChildrenPerTask?: number;
	maxRunMinutes?: number;
	maxRetriesPerTask?: number;
	maxTasksPerRun?: number;
	heartbeatStaleMs?: number;
	/** Round 25 (M5): serialize on write-path overlap. Default false (off).
	 *  When true, the scheduler skips ready tasks whose declared `step.output`
	 *  overlaps with already-picked tasks, so two workers never write the same
	 *  file in parallel. See src/runtime/path-overlap.ts. */
	serializeOnPathOverlap?: boolean;
}

export type CrewRuntimeMode = "auto" | "scaffold" | "child-process" | "live-session";

export type CompletionMutationGuardMode = "off" | "warn" | "fail";
export type EffectivenessGuardMode = "off" | "warn" | "block" | "fail";

export interface CrewRuntimeConfig {
	mode?: CrewRuntimeMode;
	preferLiveSession?: boolean;
	allowChildProcessFallback?: boolean;
	maxTurns?: number;
	graceTurns?: number;
	/**
	 * Global extension allowlist (default: none). Paths (file paths or npm
	 * extension entry points) to load in EVERY spawned child-pi worker, on top
	 * of pi-crew's own prompt-runtime extension. Despite `--no-extensions`
	 * being set for child spawns (to prevent untrusted user extensions from
	 * auto-loading), Pi loads explicitly-passed `--extension <path>` entries.
	 * This is the sanctioned channel for provider extensions that register
	 * models (e.g. `pi-commandcode-provider`) so those models stay resolvable
	 * inside subagents. Applies to all agents; agent-level `extensions:`
	 * frontmatter (user sources) can still add per-agent extensions.
	 */
	agentExtensions?: string[];
	/**
	 * W2 fix — wall-clock timeout per task in milliseconds. When the task
	 * exceeds this limit, input.signal is aborted which triggers the existing
	 * SIGTERM → SIGKILL escalation in child-pi.ts. Default 0 (no timeout).
	 * Prevents runaway agent loops (e.g. 11_build in oh-my-pi distill run that
	 * re-verified completed files 14+ times).
	 */
	taskTimeoutMs?: number;
	inheritContext?: boolean;
	/**
	 * W2 (session-file recovery): when a worker dies without a final assistant
	 * event (exitCode null / killed), tail-replay its session JSONL (written by
	 * the worker under `<artifactsRoot>/sessions/<taskId>/`) and attach the last
	 * COMPLETE assistant record to the task result (`recoveredFromSession`).
	 * Default: enabled. The env var PI_CREW_SESSION_RECOVERY overrides this
	 * flag in either direction (see session-recovery.ts:resolveSessionRecoveryEnabled).
	 * Manifest polling is NOT replaced — this only augments the settle-time result.
	 */
	sessionRecovery?: boolean;
	/**
	 * R3-19/D5 reversal (2026-10-04): hermetic worker spawns — pass
	 * `--no-extensions` on worker argv. Explicit `-e prompt-runtime` and agent
	 * `extensions:` still load (cli.md:186-187: "Disables discovered, configured,
	 * and built-in extensions. Explicit -e paths still load"), and `--skill`
	 * flags are independent — what gets cut is the ~1.37s/spawn ambient package
	 * stack (pi-crew host ext + configured packages; probe C §R3b.6: 431ms vs
	 * 1806ms to first stdout record) plus the ambient tool surface (team/
	 * crew_agent/Agent host tools + 8 direct-exposure MCP tools).
	 * Default: true. Env PI_CREW_HERMETIC_WORKERS overrides in either
	 * direction (pi-args.ts resolveHermeticWorkers). Surface TUI spawns strip
	 * the flag — panes keep the full interactive session.
	 */
	hermeticWorkers?: boolean;
	/**
	 * P2-1 (pi 1.0.4 adoption, 2026-10-07): host-process retry-triage
	 * classifier seam (src/runtime/classifier/classifier-service.ts —
	 * wrapper around ctx.modelRegistry.classify(), host process only).
	 * DORMANT by design: default false, and the consumer (child-executor
	 * retry loop) falls back to the pre-existing retry behavior on every
	 * classifier failure mode (unavailable / threw / stopReason!=='stop').
	 * Enabling opts INTO transient-vs-permanent classification before a
	 * queued re-attempt burns a full worker spawn. Env
	 * PI_CREW_CLASSIFIER_ENABLED overrides in either direction
	 * (resolveClassifierEnabled). Behavior pick, not authority — no
	 * sensitive mark.
	 */
	classifierEnabled?: boolean;
	/**
	 * P2-1: classifier model id ("provider/id" form) for the seam above.
	 * Availability is credential-dependent at runtime (getAvailableOfType);
	 * a configured-but-uncredentialed id degrades to the fallback decision,
	 * never to an error. Default "opencode/jev-1.13-free"
	 * (DEFAULT_CLASSIFIER_MODEL); env PI_CREW_CLASSIFIER_MODEL overrides
	 * (resolveClassifierModel).
	 */
	classifierModel?: string;
	promptMode?: "replace" | "append";
	groupJoin?: "off" | "group" | "smart";
	groupJoinAckTimeoutMs?: number;
	requirePlanApproval?: boolean;
	completionMutationGuard?: CompletionMutationGuardMode;
	effectivenessGuard?: EffectivenessGuardMode;
	yield?: {
		enabled?: boolean;
		maxReminders?: number;
		reminderPrompt?: string;
	};
	/** Policy for per-role runtime selection. Not sensitive — safe to keep in project config. */
	isolationPolicy?: {
		/** Roles that should use child-process for crash isolation. Default: no roles. */
		isolatedRoles?: string[];
		/** Default runtime for roles not in isolatedRoles. Default: "live-session" (uses live-session). */
		defaultRuntime?: "live-session" | "child-process";
	};
	/** Mark certain bash commands as excludeFromContext to reduce context tokens. Default: false */
	excludeContextBash?: boolean;
	/**
	 * Est-token budget for the dynamic.dependencyContext prompt layer
	 * (handoff budget). When the rendered dependency output exceeds this many
	 * estimated tokens (chars/4 — the same heuristic the prompt breakdown
	 * uses), dependencies are trimmed IN DECLARATION ORDER: earlier deps keep
	 * their full output, later ones are downgraded to taskId/role/status + a
	 * ≤240-char summary head + an artifact pointer
	 * (`artifacts/<runId>/results/<taskId>.txt`) the worker can `read` back.
	 * Long sharedRead bodies are dropped the same way. Valid range 1..1_000_000;
	 * a RESOLVED value ≤0 or >1_000_000 disables the trim entirely
	 * (off-switch). Env override PI_CREW_HANDOFF_BUDGET_TOKENS beats this
	 * config. Default: 1800.
	 */
	handoffBudgetTokens?: number;
	/**
	 * W7 (P2-3) EXPERIMENTAL: transport used to spawn child-pi workers.
	 * "stdio" (default) — the production print-mode path, unchanged.
	 * "rpc" — prototype RPC frame-client (src/runtime/rpc/), wired at the
	 * run-worker seam since e2728f68 (D1/DR2 plumbing, 2026-10-06): callers
	 * carrying runtimeConfig thread it to the seam. Env
	 * PI_CREW_WORKER_TRANSPORT=rpc overrides this config (env wins —
	 * established precedence; invalid env fails safe to stdio).
	 */
	workerTransport?: "stdio" | "rpc";
	/**
	 * Mux-surface policy (mux-surface spec v0.7 §8.1): WHERE worker processes
	 * live — a pane in tmux/herdr or headless child processes. Surface only
	 * picks the process home; scheduler, broker, and state-on-disk are
	 * unaffected. Not sensitive — any config tier may set it.
	 */
	surface?: {
		/** auto = detect tmux/herdr and use panes when present, else headless.
		 *  "tmux"/"herdr" force a backend (detect fail → headless + warning
		 *  event, never a throw). "off" disables panes entirely. Default: "auto". */
		mode?: "auto" | "tmux" | "herdr" | "off";
		/** Exact-match agent/role names that get a surface pane; ["*"] = all.
		 *  Default: [] in A1 (surface visible to nobody until opted in). */
		visibleAgents?: string[];
	};
	/** Subagent model fallback policy: auto-tail ordering, cap, credential filtering, default model. */
	modelFallback?: CrewModelFallbackConfig;
}

/**
 * Model fallback policy for subagent model chains. Controls how the auto-tail
 * (models appended from the registry/pi-config that nobody explicitly declared)
 * is ordered, capped, and filtered. Explicit declarations (tool override, step
 * model, team role, agent model, declared fallbackModels) are never affected.
 */
export interface CrewModelFallbackConfig {
	/** Cap on auto-appended models. undefined = keep all (legacy). */
	maxAutoFallbacks?: number;
	/** "parentFirst" keeps the auto tail on the same provider as the running model when a policy is configured or quota data enriches it. "asIs" = catalogue order. Without explicit configuration, auto tail stays catalogue order. */
	order?: "parentFirst" | "asIs";
	/** Drop pi-config models whose provider has no discoverable credential. Default: false. */
	requireCredentials?: boolean;
	/**
	 * Opt-in quota-aware ordering. When true, provider quota data (when available)
	 * influences the auto-tail order — providers near their quota limit are deprioritized.
	 * Default: true (default-on with cache, per user preference).
	 */
	quotaAwareOrdering?: boolean;
	/**
	 * Default model for subagents when neither the caller (--model) nor the agent
	 * frontmatter specifies one. Accepts "provider/id" or bare id. Overrides
	 * parent-model inheritance; the inherited parent model becomes the first fallback.
	 */
	defaultSubagentModel?: string;
}

export interface CrewControlConfig {
	enabled?: boolean;
	needsAttentionAfterMs?: number;
	/** Consecutive tool-failure threshold before a worker is flagged. Default 3 (applied at read site). */
	consecutiveFailureThreshold?: number;
	/** Minutes after which a running worker is flagged long-running. Default 10 (applied at read site). */
	longRunningMinutes?: number;
}

export interface CrewWorktreeConfig {
	setupHook?: string;
	setupHookTimeoutMs?: number;
	linkNodeModules?: boolean;
	seedPaths?: string[];
}

/** Goal-wrap config (RFC v0.5 vision: apply `goal` completion-guarantee to builtin workflows). */
export interface GoalWrapWorkflowConfig {
	enabled?: boolean;
	maxTurns?: number;
	evaluatorModel?: string;
	verification?: { commands: string[]; mode?: "text-only" };
	budgetTotal?: number;
	budgetUnlimited?: boolean;
}

export interface CrewUiConfig {
	/**
	 * Where the crew dock (agents list) renders:
	 *  - `aboveEditor` / `belowEditor`: pi's widget slots around the prompt;
	 *  - `bottom`: inside the crew-vibes footer, BELOW the quota/meter lines
	 *    (the very bottom of the screen). Falls back to `belowEditor` when
	 *    crew-vibes is not active (no footer sink).
	 */
	widgetPlacement?: "aboveEditor" | "belowEditor" | "bottom";
	widgetMaxLines?: number;
	/**
	 * Keyboard-navigable agent rows under the prompt (`↓` from an empty prompt).
	 * Requires owning pi's editor component, so it yields to any other extension
	 * that already installed a custom editor.
	 */
	inlinePanel?: boolean;
	powerbar?: boolean;
	dashboardPlacement?: "center" | "right";
	dashboardWidth?: number;
	dashboardLiveRefreshMs?: number;
	autoOpenDashboard?: boolean;
	autoOpenDashboardForForegroundRuns?: boolean;
	autoCloseDashboardMs?: number;
	showModel?: boolean;
	showTokens?: boolean;
	showTools?: boolean;
	transcriptTailBytes?: number;
	mascotStyle?: "cat" | "armin";
	mascotEffect?: "random" | "none" | "typewriter" | "scanline" | "rain" | "fade" | "crt" | "glitch" | "dissolve";
}

export interface AgentOverrideConfig {
	disabled?: boolean;
	model?: string | false;
	fallbackModels?: string[] | false;
	thinking?: string | false;
	tools?: string[] | false;
	skills?: string[] | false;
}

export interface CrewAgentsConfig {
	disableBuiltins?: boolean;
	overrides?: Record<string, AgentOverrideConfig>;
}

export interface CrewToolsConfig {
	enableClaudeStyleAliases?: boolean;
	enableSteer?: boolean;
	terminateOnForeground?: boolean;
}

export interface CrewTelemetryConfig {
	enabled?: boolean;
}

export interface CrewPolicyConfig {
	requireIntentForDestructiveActions?: boolean;
	disabledCapabilities?: string[];
}

export type CrewNotificationSeverity = "info" | "warning" | "error" | "critical";

/**
 * US-030: opt-in outbound webhook on run terminal transitions.
 * SENSITIVE (user config only — the schema marks this block `sensitive`):
 * a project-level webhook URL would let an untrusted repo exfiltrate run
 * metadata (incl. the goal first line) to an attacker-controlled endpoint.
 */
export interface CrewWebhookConfig {
	/** Target URL. Must be http(s); localhost/loopback/link-local refused unless `allowLocalhost`. */
	url: string;
	/** Master switch. Absent + url set = enabled; `false` disables (zero network). */
	enabled?: boolean;
	/** Shared secret → `x-pi-crew-signature: sha256=<hmac-sha256(body, secret)>` header. */
	secret?: string;
	/** Explicit SSRF-guard bypass for localhost/127.0.0.0/8/[::1]/169.254.0.0/16 targets. */
	allowLocalhost?: boolean;
}

export interface CrewNotificationsConfig {
	enabled?: boolean;
	severityFilter?: CrewNotificationSeverity[];
	dedupWindowMs?: number;
	batchWindowMs?: number;
	quietHours?: string;
	sinkRetentionDays?: number;
	/** US-030: outbound webhook on run terminal transitions. Opt-in only — no URL configured means disabled (zero network calls). */
	webhook?: CrewWebhookConfig;
}

export interface CrewObservabilityConfig {
	enabled?: boolean;
	pollIntervalMs?: number;
	metricRetentionDays?: number;
}

export interface CrewRetryPolicyConfig {
	maxAttempts?: number;
	backoffMs?: number;
	jitterRatio?: number;
	exponentialFactor?: number;
	retryableErrors?: string[];
	/** CORE-3: flat override for per-task spawn budget. 0/omitted = auto-compute. */
	maxTotalSpawns?: number;
}

export interface CrewReliabilityConfig {
	autoRetry?: boolean;
	retryPolicy?: CrewRetryPolicyConfig;
	autoRecover?: boolean;
	deadletterThreshold?: number;
	/** Interval (ms) for periodic stale-run auto-repair. Default 60_000 (60s). Set to 0 to disable. */
	autoRepairIntervalMs?: number;
	/** Remove /tmp/pi-crew-* directories after their orphaned runs are reconciled. Default: true. */
	cleanupOrphanedTempDirs?: boolean;
	/** Bypass the preflight topology validator (workflow threshold rule, .crew/knowledge.md
	 *  'pi-crew USAGE THRESHOLD RULE'). When true, runs that would be BLOCKED or WARNED
	 *  proceed without intervention. Audit-trail the override via events.jsonl.
	 *  Default: false (enforce). Use only for legitimate audit/debug sessions. */
	forcePreflight?: boolean;
	/** Inject a compact ambient crew-status note into the agent's context on every LLM call while crew runs are in-flight, so the agent stays continuously aware of active runs without calling the `team` tool. No-op when no runs are active. Default: true. */
	ambientStatusInjection?: boolean;
	/**
	 * Per-write validation (T5). On every `write`/`edit` tool result, run a
	 * zero-cost synchronous validator for the file type and append a `🔴`
	 * blocker to the tool result on failure (e.g. malformed JSON). v1 ships
	 * JSON only (`JSON.parse` — instant, no process spawn); process-spawning
	 * validators (.js/.sh/.py) are a future opt-in. Default: true (opt-out).
	 * Set to `false` to disable.
	 */
	perWriteValidation?: boolean;
	/**
	 * Tool loop guard (ARCH-1). Warns at 3 consecutive identical tool results
	 * (identical args + byte-identical output) and hard-blocks read-only file
	 * tools (read/grep/glob/find/ls) at 5 — the model-side infinite-loop
	 * failure mode. `ask` repeats within a turn are warned at 2 and the 3rd
	 * call refused. Default: true (opt-out). Set to `false` to disable.
	 */
	loopGuard?: boolean;
	/**
	 * Opt-in model scope enforcement (F7). When true, subagent model choices
	 * that fall outside the user's pi `enabledModels` allowlist are flagged:
	 * caller-supplied out-of-scope → hard error before spawn; frontmatter-
	 * pinned out-of-scope → warning + runs anyway. Default: false (no
	 * enforcement, fully back-compat).
	 */
	scopeModels?: boolean;
}

export interface CrewOtlpConfig {
	enabled?: boolean;
	endpoint?: string;
	headers?: Record<string, string>;
	intervalMs?: number;
}

export interface PiTeamsConfig {
	asyncByDefault?: boolean;
	executeWorkers?: boolean;
	notifierIntervalMs?: number;
	requireCleanWorktreeLeader?: boolean;
	ignoreMethod?: "gitignore" | "exclude";
	autonomous?: PiTeamsAutonomousConfig;
	limits?: CrewLimitsConfig;
	runtime?: CrewRuntimeConfig;
	control?: CrewControlConfig;
	worktree?: CrewWorktreeConfig;
	goalWrap?: Record<string, GoalWrapWorkflowConfig>;
	agents?: CrewAgentsConfig;
	tools?: CrewToolsConfig;
	telemetry?: CrewTelemetryConfig;
	policy?: CrewPolicyConfig;
	notifications?: CrewNotificationsConfig;
	observability?: CrewObservabilityConfig;
	reliability?: CrewReliabilityConfig;
	otlp?: CrewOtlpConfig;
	ui?: CrewUiConfig;
	/**
	 * Inter-pi broker (Phase 0). Local-only socket transport between parent
	 * and child pi workers. Default is OFF (`enabled:false`) — keep it that
	 * way until Phase 4 soak completes. Numeric limits are bounded by the
	 * schema (`src/schema/config-schema.ts`).
	 */
	broker?: CrewBrokerConfig;
	/**
	 * Governed nesting (ADR-5 docs/decisions/2026-08-17-governed-nesting.md).
	 * Worker→grandchild delegation via the `delegate` tool. Default is OFF
	 * (`enabled:false`) — fail-closed until WP-5 completes (B3 battery +
	 * security sign-off), then flipped to true. While false, `delegate`
	 * admission is rejected with a structured policy message and a
	 * `delegate.rejected` event (never silent).
	 */
	nesting?: CrewNestingConfig;
	/** State-layer persistence knobs (perf round 2, Task 3). Opt-in only. */
	persistence?: PersistenceConfig;
}

/** State-layer persistence knobs (perf round 2, Task 3). */
export interface PersistenceConfig {
	/**
	 * Opt-in (default `false`): write non-terminal tasks checkpoints with
	 * `durability:"best-effort"` (no fsync) while KEEPING the 50ms coalesced
	 * write grouping — only the durability of the flush changes, not its
	 * timing. tasks.json is fully reconstructible from the fsync'd event log,
	 * so a crash loses at most the tail of an in-flight checkpoint and
	 * recovers from events.jsonl. Terminal task transitions (completed/failed/
	 * cancelled/needs_attention/skipped) ALWAYS stay full-durability
	 * regardless of this flag.
	 * Set via env `PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC` (`"1"`/`"true"`) or
	 * config `persistence.skipTasksFsync`. Env beats config; default false.
	 * @see src/state/stores/state-store.ts saveRunTasksCoalesced
	 * @see src/runtime/task-runner/state-helpers.ts persistSingleTaskUpdate
	 */
	skipTasksFsync?: boolean;
}

/** Governed-nesting config (ADR-5). */
export interface CrewNestingConfig {
	/** Master switch. `false` (default) keeps the `delegate` surface dormant. */
	enabled?: boolean;
	/** Nested-slot budget override. Default max(1, floor(globalSem/2)). 1..64. */
	maxSlots?: number;
	/** Max crew depth for delegate-driven nesting. Default 2. 1..10 (mirrors
	 *  the PI_CREW_MAX_DEPTH env clamp). */
	maxDepth?: number;
}

/** CrewBroker config (Phase 0 inter-pi broker). */
export interface CrewBrokerConfig {
	/** Master switch. `false` keeps the broker fully dormant. */
	enabled?: boolean;
	/** Length of the SHA-256 hex prefix used in the socket filename. 4..32. */
	pathHashLen?: number;
	/** Maximum NDJSON frame size in UTF-8 bytes (default 262144 = 256 KiB). 1024..1048576. */
	maxFrameBytes?: number;
	/** Per-connection outbound queue cap. 32..4096 (default 256). */
	outboundQueueCap?: number;
	/** WP-2/R2 (ADR-0 docs/decisions/2026-08-17-waiting-producer-ask item 7):
	 *  capability gate for the broker `wait.*` methods (waiting-producer park
	 *  contract). DEFAULT FALSE — fail-closed until WP-2 completes; while
	 *  false, wait.request/wait.resolve are rejected with a policy-disabled
	 *  error plus a policy.action event in events.jsonl (never silent). */
	waitMethodsEnabled?: boolean;
}

export interface LoadedPiTeamsConfig {
	config: PiTeamsConfig;
	path: string;
	paths: string[];
	error?: string;
	warnings?: string[];
}

export interface ConfigValidationResult {
	config: PiTeamsConfig;
	warnings: string[];
}

export interface SavedPiTeamsConfig {
	config: PiTeamsConfig;
	path: string;
	/** Whether the file was actually rewritten. `false` when a no-op patch hit the skip-write guard. */
	written: boolean;
}

export interface UpdateConfigOptions {
	cwd?: string;
	scope?: "user" | "project";
	unsetPaths?: string[];
}
