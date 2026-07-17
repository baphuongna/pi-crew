import type { appendEvent } from "../state/event-log.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { checkProcessLiveness } from "./process-status.ts";
import type { CrewAgentRecord } from "./crew-agent-runtime.ts";
import type { IrcMessage } from "./live-irc.ts";

const MAX_PENDING_MESSAGES = 1000;

type LiveSessionHandle = {
	steer?: (text: string) => Promise<void>;
	prompt?: (text: string, options?: Record<string, unknown>) => Promise<void>;
	abort?: () => Promise<void> | void;
	dispose?: () => void;
	/** Upstream session stats (input/output/cacheWrite tokens, context %). */
	getSessionStats?: () => {
		tokens?: {
			input?: number;
			output?: number;
			cacheWrite?: number;
			cacheRead?: number;
		};
		contextUsage?: { percent?: number | null; window?: number };
	};
};

/** Real-time activity state for a live-session agent. */
export interface LiveAgentActivity {
	/** Currently active tools (toolName → description). */
	activeTools: Map<string, string>;
	/** Total tool invocations. */
	toolUses: number;
	/** Current turn count. */
	turnCount: number;
	/** Effective max turns (undefined = unlimited). */
	maxTurns?: number;
	/** Latest assistant text snippet. */
	responseText: string;
	/** Number of context compactions survived. */
	compactionCount: number;
	/** Started-at timestamp (ms epoch). */
	startedAtMs: number;
	/** Completed-at timestamp (ms epoch, 0 = still running). */
	completedAtMs: number;
	/** Model name used for this agent (e.g. "sonnet", "haiku"). */
	modelName?: string;
}

export interface LiveAgentHandle {
	agentId: string;
	taskId: string;
	runId: string;
	/** Workspace where this agent was spawned — used for session-scoped visibility. */
	workspaceId: string;
	role?: string;
	agent?: string;
	description?: string;
	/** Model name used for this agent (e.g. "sonnet", "haiku"). */
	modelName?: string;
	session: LiveSessionHandle;
	createdAt: string;
	updatedAt: string;
	status: CrewAgentRecord["status"];
	pendingSteers: string[];
	pendingFollowUps: string[];
	/** Phase 7: Pending IRC messages for this agent. */
	pendingMessages: IrcMessage[];
	/** G1-G6: Real-time activity tracking (in-memory only). */
	activity: LiveAgentActivity;
}

const liveAgents = new Map<string, LiveAgentHandle>();
// FIX (Round 15): Cap the number of tracked live agents to prevent unbounded
// growth if a caller spawns agents but fails to unregister them. When the
// cap is reached, the oldest completed agent is evicted first; if no
// completed agents are present, the oldest running one is evicted (with a
// warning) to keep memory bounded.
const MAX_LIVE_AGENTS = 5_000;

/**
 * List all live agents for a specific workspace.
 * Only agents belonging to the given workspaceId are returned.
 */
export function listLiveAgentsByWorkspace(workspaceId: string): LiveAgentHandle[] {
	return listLiveAgents().filter((a) => a.workspaceId === workspaceId);
}

export function registerLiveAgent(
	input: Omit<LiveAgentHandle, "createdAt" | "updatedAt" | "pendingSteers" | "pendingFollowUps" | "pendingMessages" | "activity"> & {
		workspaceId: string;
	},
	eventLogFn?: typeof appendEvent,
	eventsPath?: string,
): LiveAgentHandle {
	const now = new Date().toISOString();
	const existing = liveAgents.get(input.agentId);
	const handle: LiveAgentHandle = {
		...input,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		pendingSteers: existing?.pendingSteers ?? [],
		pendingFollowUps: existing?.pendingFollowUps ?? [],
		pendingMessages: existing?.pendingMessages ?? [],
		activity: existing?.activity ?? {
			activeTools: new Map(),
			toolUses: 0,
			turnCount: 0,
			responseText: "",
			compactionCount: 0,
			startedAtMs: Date.now(),
			completedAtMs: 0,
			modelName: undefined,
		},
	};
	// FIX (Round 15): Enforce the live-agent cap before adding. Prefer to
	// evict the oldest completed agent (already finished, so caller no
	// longer needs it). If none exist, evict the oldest running one with
	// a warning so memory stays bounded.
	if (liveAgents.size >= MAX_LIVE_AGENTS) {
		const completed = [...liveAgents.entries()].find(([, h]) => h.activity.completedAtMs > 0);
		if (completed) {
			liveAgents.delete(completed[0]);
		} else {
			const oldestKey = liveAgents.keys().next().value;
			if (oldestKey !== undefined) {
				logInternalError("live-agent-manager.cap", new Error(`liveAgents at cap ${MAX_LIVE_AGENTS}; evicting oldest ${oldestKey}`));
				liveAgents.delete(oldestKey);
			}
		}
	}
	liveAgents.set(input.agentId, handle);
	try {
		if (eventLogFn && eventsPath)
			eventLogFn(eventsPath, {
				type: "live_agent.registered",
				runId: input.runId,
				taskId: input.taskId,
				message: `Live agent registered: ${input.agent} (${input.role})`,
				data: {
					agentId: input.agentId,
					role: input.role,
					agent: input.agent,
					workspaceId: input.workspaceId,
				},
			});
	} catch {
		/* non-critical */
	}
	if (handle.pendingSteers.length && typeof handle.session.steer === "function") {
		const pending = [...handle.pendingSteers];
		handle.pendingSteers.length = 0;
		for (const message of pending)
			void handle.session
				.steer(message)
				.catch((error) => logInternalError("live-agent-manager.steer", error, `agentId=${handle.agentId}`));
	}
	if (handle.pendingFollowUps.length && typeof handle.session.prompt === "function") {
		const pending = [...handle.pendingFollowUps];
		handle.pendingFollowUps.length = 0;
		for (const message of pending)
			void handle.session
				.prompt(message, {
					source: "api",
					expandPromptTemplates: false,
				})
				.catch((error) => logInternalError("live-agent-manager.prompt", error, `agentId=${handle.agentId}`));
	}
	return handle;
}

export function updateLiveAgentStatus(agentId: string, status: CrewAgentRecord["status"]): void {
	const handle = liveAgents.get(agentId);
	if (!handle) return;
	handle.status = status;
	handle.updatedAt = new Date().toISOString();
}

function safeDisposeLiveSession(handle: LiveAgentHandle): void {
	try {
		handle.session.dispose?.();
	} catch (error) {
		logInternalError("live-agent-manager.dispose", error, `agentId=${handle.agentId}`);
	}
}

export function disposeLiveAgentSession(agentIdOrTaskId: string): void {
	const handle = getLiveAgent(agentIdOrTaskId);
	if (!handle) return;
	safeDisposeLiveSession(handle);
}

export async function terminateLiveAgent(
	agentIdOrTaskId: string,
	status: CrewAgentRecord["status"] = "stopped",
	eventLogFn?: typeof appendEvent,
	eventsPath?: string,
): Promise<LiveAgentHandle | undefined> {
	const handle = getLiveAgent(agentIdOrTaskId);
	if (!handle) return undefined;
	handle.status = status;
	handle.updatedAt = new Date().toISOString();
	try {
		if (eventLogFn && eventsPath)
			eventLogFn(eventsPath, {
				type: "live_agent.terminated",
				runId: handle.runId,
				taskId: handle.taskId,
				message: `Live agent terminated: ${handle.agent} status=${status}`,
				data: {
					agentId: handle.agentId,
					status,
					role: handle.role,
					workspaceId: handle.workspaceId,
				},
			});
	} catch {
		/* non-critical */
	}
	try {
		await handle.session.abort?.();
	} finally {
		safeDisposeLiveSession(handle);
		liveAgents.delete(handle.agentId); // Move AFTER abort completes to prevent race
	}
	return handle;
}

export async function terminateLiveAgentsForRun(
	runId: string,
	status: CrewAgentRecord["status"] = "failed",
	eventLogFn?: typeof appendEvent,
	eventsPath?: string,
): Promise<number> {
	const agents = [...liveAgents.values()].filter((agent) => agent.runId === runId);
	await Promise.all(agents.map((agent) => terminateLiveAgent(agent.agentId, status, eventLogFn, eventsPath)));
	return agents.length;
}

export function getLiveAgent(agentIdOrTaskId: string): LiveAgentHandle | undefined {
	return liveAgents.get(agentIdOrTaskId) ?? [...liveAgents.values()].find((entry) => entry.taskId === agentIdOrTaskId);
}

/** Maximum time a terminal live agent handle stays in memory (10 minutes). */
const STALE_HANDLE_MS = 10 * 60 * 1000;
/** Maximum time a running/queued live agent handle stays without any update (30 minutes).
 * After this, the agent is presumed dead — the real process would have updated the handle. */
const STALE_RUNNING_HANDLE_MS = 30 * 60 * 1000;

/** Remove dead live agent handles.
 * Evicts: (1) terminal-status handles older than STALE_HANDLE_MS, and
 *         (2) running/queued handles with no update for STALE_RUNNING_HANDLE_MS.
 * Called periodically by the widget refresh cycle.
 * Returns the number of handles evicted.
 */
export function evictStaleLiveAgentHandles(now = Date.now()): number {
	let evicted = 0;
	for (const [agentId, handle] of liveAgents) {
		const age = now - new Date(handle.updatedAt).getTime();
		const isActive = handle.status === "running" || handle.status === "queued" || handle.status === "waiting";
		if (!isActive) {
			// Terminal handle — evict after grace period
			if (age > STALE_HANDLE_MS) {
				liveAgents.delete(agentId);
				safeDisposeLiveSession(handle);
				evicted++;
			}
		} else if (age > STALE_RUNNING_HANDLE_MS) {
			// Active-status handle with no update for 30min — check process liveness
			// before evicting. Only evict if the process is dead, to avoid evicting
			// slow-but-alive agents.
			const sessionPid = (handle.session as Record<string, unknown>)?.pid as number | undefined;
			const liveness = checkProcessLiveness(sessionPid);
			if (!liveness.alive) {
				liveAgents.delete(agentId);
				safeDisposeLiveSession(handle);
				evicted++;
			}
		}
	}
	return evicted;
}

export function listLiveAgents(): LiveAgentHandle[] {
	return [...liveAgents.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export function listActiveLiveAgents(): LiveAgentHandle[] {
	return listLiveAgents().filter((agent) => agent.status === "running" || agent.status === "queued" || agent.status === "waiting");
}

export function getLiveAgentContextPercent(agentIdOrTaskId: string): number | null {
	const handle = getLiveAgent(agentIdOrTaskId);
	if (!handle || handle.status !== "running") return null;
	try {
		return handle.session.getSessionStats?.().contextUsage?.percent ?? null;
	} catch {
		return null;
	}
}

export async function steerLiveAgent(agentIdOrTaskId: string, message: string): Promise<LiveAgentHandle> {
	const handle = getLiveAgent(agentIdOrTaskId);
	if (!handle) throw new Error(`Live agent '${agentIdOrTaskId}' is not registered in this process.`);
	if (typeof handle.session.steer !== "function") {
		handle.pendingSteers.push(message);
		return handle;
	}
	await handle.session.steer(message);
	handle.updatedAt = new Date().toISOString();
	return handle;
}

export async function followUpLiveAgent(agentIdOrTaskId: string, prompt: string): Promise<LiveAgentHandle> {
	const handle = getLiveAgent(agentIdOrTaskId);
	if (!handle) throw new Error(`Live agent '${agentIdOrTaskId}' is not registered in this process.`);
	if (typeof handle.session.prompt !== "function") {
		handle.pendingFollowUps.push(prompt);
		return handle;
	}
	await handle.session.prompt(prompt, {
		source: "api",
		expandPromptTemplates: false,
	});
	handle.updatedAt = new Date().toISOString();
	return handle;
}

export async function stopLiveAgent(agentIdOrTaskId: string): Promise<LiveAgentHandle> {
	const stopped = await terminateLiveAgent(agentIdOrTaskId, "stopped");
	if (!stopped) throw new Error(`Live agent '${agentIdOrTaskId}' is not registered in this process.`);
	return stopped;
}

export async function resumeLiveAgent(agentIdOrTaskId: string, prompt: string): Promise<LiveAgentHandle> {
	const handle = getLiveAgent(agentIdOrTaskId);
	if (!handle) throw new Error(`Live agent '${agentIdOrTaskId}' is not registered in this process.`);
	if (typeof handle.session.prompt !== "function") throw new Error(`Live agent '${agentIdOrTaskId}' does not expose prompt().`);
	handle.status = "running";
	await handle.session.prompt(prompt, {
		source: "api",
		expandPromptTemplates: false,
	});
	handle.status = "completed";
	handle.updatedAt = new Date().toISOString();
	return handle;
}

/** G2: Track tool start for a live agent. */
export function trackLiveAgentToolStart(agentIdOrTaskId: string, toolName: string): void {
	const handle = getLiveAgent(agentIdOrTaskId);
	if (!handle) return;
	// Evict oldest entries if at capacity
	const MAX_TRACKED_TOOLS = 1000;
	if (handle.activity.activeTools.size >= MAX_TRACKED_TOOLS) {
		const firstKey = handle.activity.activeTools.keys().next().value;
		if (firstKey !== undefined) {
			handle.activity.activeTools.delete(firstKey);
		}
	}
	handle.activity.activeTools.set(toolName, toolName);
	handle.activity.toolUses++;
	handle.updatedAt = new Date().toISOString();
}

/** G2: Track tool end for a live agent. */
export function trackLiveAgentToolEnd(agentIdOrTaskId: string, toolName: string): void {
	const handle = getLiveAgent(agentIdOrTaskId);
	if (!handle) return;
	handle.activity.activeTools.delete(toolName);
}

/** G3/G6: Track turn end and compaction. */
export function trackLiveAgentTurnEnd(agentIdOrTaskId: string, compaction = false): void {
	const handle = getLiveAgent(agentIdOrTaskId);
	if (!handle) return;
	handle.activity.turnCount++;
	if (compaction) handle.activity.compactionCount++;
	handle.activity.activeTools.clear();
	handle.updatedAt = new Date().toISOString();
}

/** G2: Track assistant response text. */
export function trackLiveAgentResponseText(agentIdOrTaskId: string, text: string): void {
	const handle = getLiveAgent(agentIdOrTaskId);
	if (!handle) return;
	handle.activity.responseText = text.slice(-200);
}

/** Mark live agent completed with timestamp. */
export function markLiveAgentCompleted(agentIdOrTaskId: string): void {
	const handle = getLiveAgent(agentIdOrTaskId);
	if (!handle) return;
	handle.activity.completedAtMs = Date.now();
	handle.activity.activeTools.clear();
}

export function clearLiveAgentsForTest(): void {
	liveAgents.clear();
}

/** Phase 7/G4: Send an IRC message to a specific live agent (DM).
 * Uses non-blocking delivery via sendCustomMessage when available.
 * Falls back to session.prompt (blocking) when not.
 */
export function sendIrcMessage(targetAgentId: string, message: IrcMessage): void {
	const handle = getLiveAgent(targetAgentId);
	if (!handle) return;
	if (handle.pendingMessages.length >= MAX_PENDING_MESSAGES) {
		handle.pendingMessages.shift();
	}
	handle.pendingMessages.push(message);
	handle.updatedAt = new Date().toISOString();
	// G4: Try non-blocking delivery via sendCustomMessage
	const session = handle.session as Record<string, unknown>;
	if (typeof session.sendCustomMessage === "function") {
		try {
			(session.sendCustomMessage as (msg: unknown, opts?: unknown) => void)(
				{
					customType: "irc",
					content: `[DM from ${message.from}] ${message.content}`,
					display: "collapsed",
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);
			return;
		} catch {
			// Fall through to prompt-based delivery
		}
	}
	// Fallback: inject as prompt (blocking)
	if (typeof handle.session.prompt === "function") {
		const ircPrompt = `[Message from ${message.from}] ${message.content}`;
		void handle.session
			.prompt(ircPrompt, { source: "api", expandPromptTemplates: false })
			.catch((error) => logInternalError("live-agent-manager.irc-deliver", error, `agentId=${handle.agentId}`));
	}
}

/** Phase 7/G4: Broadcast an IRC message to all live agents except the sender.
 * Uses non-blocking delivery via sendCustomMessage when available.
 * Returns recipient IDs.
 */
export function broadcastIrcMessage(fromAgentId: string, message: IrcMessage): string[] {
	const recipients: string[] = [];
	for (const handle of liveAgents.values()) {
		if (handle.agentId === fromAgentId) continue;
		if (handle.status !== "running" && handle.status !== "queued") continue;
		if (handle.pendingMessages.length >= MAX_PENDING_MESSAGES) {
			handle.pendingMessages.shift();
		}
		handle.pendingMessages.push(message);
		handle.updatedAt = new Date().toISOString();
		// G4: Try non-blocking delivery
		const session = handle.session as Record<string, unknown>;
		if (typeof session.sendCustomMessage === "function") {
			try {
				(session.sendCustomMessage as (msg: unknown, opts?: unknown) => void)(
					{
						customType: "irc",
						content: `[Broadcast from ${message.from}] ${message.content}`,
						display: "collapsed",
					},
					{ deliverAs: "followUp", triggerTurn: false },
				);
				recipients.push(handle.agentId);
				continue;
			} catch {
				// Fall through to prompt-based delivery
			}
		}
		// Fallback: inject as prompt
		if (typeof handle.session.prompt === "function") {
			const ircPrompt = `[Broadcast from ${message.from}] ${message.content}`;
			void handle.session
				.prompt(ircPrompt, {
					source: "api",
					expandPromptTemplates: false,
				})
				.catch((error) => logInternalError("live-agent-manager.irc-broadcast", error, `agentId=${handle.agentId}`));
		}
		recipients.push(handle.agentId);
	}
	return recipients;
}

/* ── IRC reply support (side-channel Q&A) ─────────────────────────── */

/** Default timeout for awaiting a side-channel reply (60s). */
const DEFAULT_REPLY_TIMEOUT_MS = 60_000;

/** Result of a background reply attempt. */
export interface BackgroundReplyResult {
	ok: boolean;
	/** Correlation id for the pending reply (present once registered). */
	corrId?: string;
	/** Reply prose content (present on success when awaitReply was set). */
	replyContent?: string;
	/** Human-readable error description. */
	error?: string;
	/** True when the reply did not arrive before the timeout. */
	timedOut?: boolean;
}

interface PendingReply {
	corrId: string;
	targetAgentId: string;
	fromId: string;
	deadline: number;
	resolve: (result: BackgroundReplyResult) => void;
	timer?: ReturnType<typeof setTimeout>;
}

/** In-process pending replies keyed by correlation id. */
const pendingReplies = new Map<string, PendingReply>();
/** Reverse index: targetAgentId → set of corrIds awaiting a reply from it. */
const pendingRepliesByTarget = new Map<string, Set<string>>();

function makeCorrelationId(): string {
	return `irc_reply_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Deliver a message to a live agent's session as a *background* turn —
 * without blocking the recipient's main agent loop — and (optionally)
 * await a prose reply via a side-channel.
 *
 * Non-blocking invariant (mirrors gajae-code's `respondAsBackground`):
 * the message is injected via `sendCustomMessage` (triggerTurn:false) or a
 * fire-and-forget `session.prompt`; we NEVER await the recipient's full
 * main-loop turn. When `awaitReply` is set we instead await an event-driven
 * reply resolution (see {@link resolveIrcReply}) bounded by a timeout.
 *
 * Note on mailbox.ts reply fields: those file-based fields
 * (`replyTo`/`replyContent`/`replyDeadline`/`updateMailboxMessageReply`)
 * serve cross-process workers that communicate via on-disk mailbox files.
 * Live-session agents share a single process, so an in-memory event-driven
 * registry is used here — it is lower-latency and trivially non-blocking.
 * Both mechanisms coexist; file-based workers keep using mailbox.ts.
 */
export async function respondAsBackground(
	targetAgentId: string,
	fromId: string,
	message: string,
	opts?: { awaitReply?: boolean; timeoutMs?: number; signal?: AbortSignal },
): Promise<BackgroundReplyResult> {
	const handle = getLiveAgent(targetAgentId);
	if (!handle) return { ok: false, error: `Live agent '${targetAgentId}' not found.` };

	const awaitReply = opts?.awaitReply ?? false;
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
	const corrId = makeCorrelationId();

	// --- Non-blocking delivery -------------------------------------------
	const session = handle.session as Record<string, unknown>;
	const deliveredTag = `[DM from ${fromId}] ${message}`;
	let delivered = false;
	if (typeof session.sendCustomMessage === "function") {
		try {
			(session.sendCustomMessage as (msg: unknown, o?: unknown) => void)(
				{
					customType: "irc",
					content: deliveredTag,
					display: "collapsed",
					corrId,
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);
			delivered = true;
		} catch {
			// fall through to prompt-based delivery
		}
	}
	if (!delivered && typeof handle.session.prompt === "function") {
		const promptText = `${deliveredTag}${awaitReply ? ` (reply correlation: ${corrId})` : ""}`;
		void handle.session
			.prompt(promptText, { source: "api", expandPromptTemplates: false })
			.catch((error) => logInternalError("live-agent-manager.respondAsBackground", error, `agentId=${handle.agentId}`));
		delivered = true;
	}
	if (!delivered)
		return {
			ok: false,
			error: `Target '${targetAgentId}' has no message channel.`,
		};
	handle.updatedAt = new Date().toISOString();

	if (!awaitReply) return { ok: true, corrId };

	// --- Await reply (event-driven, bounded by timeout) ------------------
	return awaitPendingReply(corrId, targetAgentId, fromId, timeoutMs, opts?.signal);
}

/**
 * Register a pending reply and resolve it when the reply arrives, the
 * timeout elapses, or the caller's abort signal fires.
 *
 * @internal exported for testing
 */
export function awaitPendingReply(
	corrId: string,
	targetAgentId: string,
	fromId: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<BackgroundReplyResult> {
	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let signalListener: (() => void) | undefined;

		const finish = (result: BackgroundReplyResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (signalListener && signal) signal.removeEventListener("abort", signalListener);
			pendingReplies.delete(corrId);
			const set = pendingRepliesByTarget.get(targetAgentId);
			set?.delete(corrId);
			if (set && set.size === 0) pendingRepliesByTarget.delete(targetAgentId);
			resolve(result);
		};

		timer = setTimeout(() => finish({ ok: false, corrId, timedOut: true }), timeoutMs);

		if (signal) {
			if (signal.aborted) {
				finish({ ok: false, corrId, error: "cancelled" });
				return;
			}
			signalListener = () => finish({ ok: false, corrId, error: "cancelled" });
			signal.addEventListener("abort", signalListener, { once: true });
		}

		pendingReplies.set(corrId, {
			corrId,
			targetAgentId,
			fromId,
			deadline,
			resolve: finish,
			timer,
		});
		const set = pendingRepliesByTarget.get(targetAgentId) ?? new Set<string>();
		set.add(corrId);
		pendingRepliesByTarget.set(targetAgentId, set);
	});
}

/**
 * Resolve a pending side-channel reply. Called by the reply-routing layer
 * (e.g. irc-tool when the recipient sends a message back referencing the
 * correlation id, or by tests simulating a recipient response).
 *
 * Returns true if a pending reply was resolved, false if none matched
 * (already timed out / cancelled / unknown correlation id).
 */
export function resolveIrcReply(corrId: string, replyContent: string): boolean {
	const pending = pendingReplies.get(corrId);
	if (!pending) return false;
	pending.resolve({ ok: true, corrId, replyContent });
	return true;
}

/**
 * Cancel a pending side-channel reply (e.g. sender gave up).
 * Returns true if a pending reply was cancelled, false if none matched.
 */
export function cancelIrcReply(corrId: string, reason = "cancelled"): boolean {
	const pending = pendingReplies.get(corrId);
	if (!pending) return false;
	pending.resolve({ ok: false, corrId, error: reason });
	return true;
}

/** Correlation ids currently awaiting a reply from the given target agent. */
export function pendingReplyCorrIdsForTarget(targetAgentId: string): string[] {
	return [...(pendingRepliesByTarget.get(targetAgentId) ?? [])];
}

/** Clear all pending replies (test helper). */
export function clearPendingRepliesForTest(): void {
	for (const pending of pendingReplies.values()) {
		if (pending.timer) clearTimeout(pending.timer);
	}
	pendingReplies.clear();
	pendingRepliesByTarget.clear();
}
