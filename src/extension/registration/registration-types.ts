/**
 * Shared types for the registration modules under `src/extension/registration/`.
 *
 * The orchestrator (`src/extension/register.ts`) builds a single mutable
 * `RegistrationContext` object once and threads it through each install
 * function. This avoids passing 20+ parameters to every module and keeps
 * the orchestrator's mutable state in one place where each module can read
 * it without ceremony.
 *
 * Every field is described inline so refactors can keep the contract
 * observable. If you add a new dependency here, document it; future
 * contributors will look at this file to discover the seam between the
 * orchestrator and its extracted modules.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BatchBarrier } from "../../runtime/batch-barrier.ts";
import type { createManifestCache } from "../../runtime/manifest-cache.ts";
import type { CrewScheduler } from "../../runtime/scheduler.ts";
import type { SubagentManager } from "../../subagents/manager.ts";
import type { RenderScheduler } from "../../ui/render-scheduler.ts";
import type { createRunSnapshotCache } from "../../ui/run-snapshot-cache.ts";
import type { TerminalStatusController } from "../../ui/terminal-status.ts";
import type { CrewWidgetState } from "../../ui/widget/index.ts";
import type { RunWatcherRegistry } from "../../utils/run-watcher-registry.ts";
import type { AsyncNotifierState } from "../async-notifier.ts";
import type { PiCrewRpcHandle } from "../cross-extension-rpc.ts";
import type { NotificationDescriptor } from "../notification-router.ts";
import type { CrashRecoveryCache } from "./crash-recovery-cache.ts";
import type { LifecycleState } from "./lifecycle.ts";
import type { ObservabilityState } from "./observability.ts";
import type { UiState } from "./ui.ts";

/** Foreground team-run & subagent abort controllers. */
export type AbortKey = string | symbol;
export type AbortControllerMap = Map<AbortKey, AbortController>;

/**
 * Single auto-recovery cooldown gate entry. Tracked by the render-tick
 * health notifier so the same warning doesn't fire repeatedly within a
 * 5-minute cooldown. Uses LRU-like semantics — see register.ts.
 */
export interface AutoRecoveryEntry {
	insertedAt: number;
	lastAccessAt: number;
}

/**
 * Mutable context bag passed from the orchestrator to every
 * registration module. Treat as a shared object: modules read
 * `ctx.X` to consume orchestrator state and may write back to
 * fields like `ctx.currentCtx` to keep it fresh.
 *
 * Splitting this into many interfaces would buy little — the
 * modules genuinely share this state, and TypeScript's structural
 * typing means each module only sees the fields it imports.
 */
export interface RegistrationContext {
	pi: ExtensionAPI;

	// ── Mutable session/runtime state ──────────────────────────────────
	/** Current ExtensionContext (set on session_start, cleared on cleanup). */
	currentCtx: ExtensionContext | undefined;
	/** Bumped on session_start + cleanup. Owner tokens compare against this. */
	sessionGeneration: number;
	/** Idempotency flag for cleanup. */
	cleanedUp: boolean;
	/** Active RPC handle (set once at registration, cleared on cleanup). */
	rpcHandle: PiCrewRpcHandle | undefined;

	// ── Caches (per-cwd, lazily swapped) ────────────────────────────────
	manifestCache: ReturnType<typeof createManifestCache>;
	runSnapshotCache: ReturnType<typeof createRunSnapshotCache>;
	cacheCwd: string;
	getManifestCache: (cwd: string) => ReturnType<typeof createManifestCache>;
	getRunSnapshotCache: (cwd: string) => ReturnType<typeof createRunSnapshotCache>;

	// ── UI / widget state ──────────────────────────────────────────────
	widgetState: CrewWidgetState;
	uiState: UiState;

	// ── Observability + lifecycle state ────────────────────────────────
	observabilityState: ObservabilityState;
	lifecycleState: LifecycleState;

	// ── Async notifier ─────────────────────────────────────────────────
	notifierState: AsyncNotifierState;

	// ── Abort controllers ──────────────────────────────────────────────
	foregroundControllers: AbortControllerMap;
	foregroundTeamRunControllers: AbortControllerMap;

	// ── Render & terminal state ────────────────────────────────────────
	renderScheduler: RenderScheduler | undefined;
	renderSchedulerUnsubscribers: Array<() => void>;
	terminalStatus: TerminalStatusController | undefined;
	terminalStatusActive: boolean;

	// ── Scheduler + watch timers ───────────────────────────────────────
	crewScheduler: CrewScheduler | undefined;
	preloadTimer: ReturnType<typeof setTimeout> | undefined;
	crewRunWatchers: RunWatcherRegistry | undefined;
	userCrewWatchers: RunWatcherRegistry | undefined;

	// ── Subagents + batching ───────────────────────────────────────────
	subagentManager: SubagentManager;
	batchBarrier: BatchBarrier;

	// ── Autocomplete guard (register-once) ─────────────────────────────
	crewAutocompleteRegistered: boolean;

	// ── Cooldown map for health notifications ──────────────────────────
	autoRecoveryLast: Map<string, AutoRecoveryEntry>;
	/** Defensive cap on autoRecoveryLast size (LRU eviction). */
	AUTO_RECOVERY_LAST_MAX_ENTRIES: number;

	// ── i18n teardown ──────────────────────────────────────────────────
	disposeI18n: () => void;

	// ── Global store for cross-instance cleanup handoff ────────────────
	globalStore: Record<string | symbol, unknown>;
	runtimeCleanupStoreKey: symbol;

	// ── Bound predicates ───────────────────────────────────────────────
	captureSessionGeneration: () => number;
	isOwnerSessionCurrent: (ownerGeneration: number | undefined) => boolean;
	isContextCurrent: (ctx: ExtensionContext, ownerGeneration: number) => boolean;
	telemetryEnabled: () => boolean;

	// ── Bound notification sink ────────────────────────────────────────
	notifyOperator: (notification: NotificationDescriptor) => void;

	// ── Bound cleanup + lifecycle methods ──────────────────────────────
	cleanupSessionResourcesOnly: () => void;
	cleanupRuntime: () => void;
	disposeRenderSchedulerSubscriptions: () => void;
	stopSessionBoundSubagents: () => void;

	// ── Bound helpers (configure* lazily install lifecycle/observability) ──
	configureNotifications: (ctx: ExtensionContext) => void;
	configureObservability: (ctx: ExtensionContext) => void;
	configureDeliveryCoordinator: () => void;
	importCrashRecovery: () => Promise<CrashRecoveryCache>;
	purgeStaleActiveRunIndexSyncIfLoaded: () => void;

	// ── Foreground helpers (consumed by tools + commands) ─────────────
	startForegroundRun: (ctx: ExtensionContext, runner: (signal?: AbortSignal) => Promise<void>, runId?: string) => void;
	abortForegroundRun: (runId: string) => boolean;
	openLiveSidebar: (ctx: ExtensionContext, runId: string) => void;
	/**
	 * Phase 0 inter-pi broker lifecycle controller. Set by `register.ts`
	 * after `installSessionLifecycleHandlers`. The controller is a no-op
	 * when the broker is disabled or the current process is a subagent;
	 * callers (e.g. child-pi-spawn consumers) MUST handle the case where
	 * `issueForChild` returns undefined. The controller is stopped
	 * during session_shutdown via `stop()`.
	 */
	brokerController: import("./lifecycle-handlers.ts").CrewBrokerLifecycleController | undefined;
}
