import type { CrewAgentRecord } from "./crew-agent-runtime.ts";
import type { IrcMessage } from "./live-irc.ts";
import { logInternalError } from "../utils/internal-error.ts";
import type { appendEvent } from "../state/event-log.ts";

type LiveSessionHandle = {
	steer?: (text: string) => Promise<void>;
	prompt?: (text: string, options?: Record<string, unknown>) => Promise<void>;
	abort?: () => Promise<void> | void;
	dispose?: () => void;
	/** Upstream session stats (input/output/cacheWrite tokens, context %). */
	getSessionStats?: () => {
		tokens?: { input?: number; output?: number; cacheWrite?: number; cacheRead?: number };
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

/**
 * List all live agents for a specific workspace.
 * Only agents belonging to the given workspaceId are returned.
 */
export function listLiveAgentsByWorkspace(workspaceId: string): LiveAgentHandle[] {
	return listLiveAgents().filter((a) => a.workspaceId === workspaceId);
}

/**
 * List only active agents (running/queued/waiting) for a specific workspace.
 */
export function listActiveLiveAgentsByWorkspace(workspaceId: string): LiveAgentHandle[] {
	return listActiveLiveAgents().filter((a) => a.workspaceId === workspaceId);
}

export function registerLiveAgent(input: Omit<LiveAgentHandle, "createdAt" | "updatedAt" | "pendingSteers" | "pendingFollowUps" | "pendingMessages" | "activity"> & { workspaceId: string }, eventLogFn?: typeof appendEvent, eventsPath?: string): LiveAgentHandle {
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
	liveAgents.set(input.agentId, handle);
	try { if (eventLogFn && eventsPath) eventLogFn(eventsPath, { type: "live_agent.registered", runId: input.runId, taskId: input.taskId, message: `Live agent registered: ${input.agent} (${input.role})`, data: { agentId: input.agentId, role: input.role, agent: input.agent, workspaceId: input.workspaceId } }); } catch { /* non-critical */ }
	if (handle.pendingSteers.length && typeof handle.session.steer === "function") {
		const pending = [...handle.pendingSteers];
		handle.pendingSteers.length = 0;
		for (const message of pending) void handle.session.steer(message).catch(() => {});
	}
	if (handle.pendingFollowUps.length && typeof handle.session.prompt === "function") {
		const pending = [...handle.pendingFollowUps];
		handle.pendingFollowUps.length = 0;
		for (const message of pending) void handle.session.prompt(message, { source: "api", expandPromptTemplates: false }).catch(() => {});
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
	try { handle.session.dispose?.(); } catch (error) {
		logInternalError("live-agent-manager.dispose", error, `agentId=${handle.agentId}`);
	}
}

export function removeLiveAgentHandle(agentId: string): LiveAgentHandle | undefined {
	const handle = liveAgents.get(agentId);
	if (!handle) return undefined;
	liveAgents.delete(agentId);
	safeDisposeLiveSession(handle);
	return handle;
}

export function disposeLiveAgentSession(agentIdOrTaskId: string): void {
	const handle = getLiveAgent(agentIdOrTaskId);
	if (!handle) return;
	safeDisposeLiveSession(handle);
}

export async function terminateLiveAgent(agentIdOrTaskId: string, status: CrewAgentRecord["status"] = "stopped", eventLogFn?: typeof appendEvent, eventsPath?: string): Promise<LiveAgentHandle | undefined> {
	const handle = getLiveAgent(agentIdOrTaskId);
	if (!handle) return undefined;
	handle.status = status;
	handle.updatedAt = new Date().toISOString();
	liveAgents.delete(handle.agentId);
	try { if (eventLogFn && eventsPath) eventLogFn(eventsPath, { type: "live_agent.terminated", runId: handle.runId, taskId: handle.taskId, message: `Live agent terminated: ${handle.agent} status=${status}`, data: { agentId: handle.agentId, status, role: handle.role, workspaceId: handle.workspaceId } }); } catch { /* non-critical */ }
	try {
		await handle.session.abort?.();
	} finally {
		safeDisposeLiveSession(handle);
	}
	return handle;
}

export async function terminateLiveAgentsForRun(runId: string, status: CrewAgentRecord["status"] = "failed", eventLogFn?: typeof appendEvent, eventsPath?: string): Promise<number> {
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
			// Active-status handle with no update for 30min — presumed dead
			liveAgents.delete(agentId);
			safeDisposeLiveSession(handle);
			evicted++;
		}
	}
	return evicted;
}

export function listLiveAgents(): LiveAgentHandle[] {
	return [...liveAgents.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
	await handle.session.prompt(prompt, { source: "api", expandPromptTemplates: false });
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
	await handle.session.prompt(prompt, { source: "api", expandPromptTemplates: false });
	handle.status = "completed";
	handle.updatedAt = new Date().toISOString();
	return handle;
}

/** G2: Track tool start for a live agent. */
export function trackLiveAgentToolStart(agentIdOrTaskId: string, toolName: string): void {
	const handle = getLiveAgent(agentIdOrTaskId);
	if (!handle) return;
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
	handle.pendingMessages.push(message);
	handle.updatedAt = new Date().toISOString();
	// G4: Try non-blocking delivery via sendCustomMessage
	const session = handle.session as Record<string, unknown>;
	if (typeof session.sendCustomMessage === "function") {
		try {
			(session.sendCustomMessage as (msg: unknown, opts?: unknown) => void)(
				{ customType: "irc", content: `[DM from ${message.from}] ${message.content}`, display: "collapsed" },
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
		void handle.session.prompt(ircPrompt, { source: "api", expandPromptTemplates: false }).catch(() => {});
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
		handle.pendingMessages.push(message);
		handle.updatedAt = new Date().toISOString();
		// G4: Try non-blocking delivery
		const session = handle.session as Record<string, unknown>;
		if (typeof session.sendCustomMessage === "function") {
			try {
				(session.sendCustomMessage as (msg: unknown, opts?: unknown) => void)(
					{ customType: "irc", content: `[Broadcast from ${message.from}] ${message.content}`, display: "collapsed" },
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
			void handle.session.prompt(ircPrompt, { source: "api", expandPromptTemplates: false }).catch(() => {});
		}
		recipients.push(handle.agentId);
	}
	return recipients;
}

/** Phase 7: Get pending IRC messages for an agent (and clear them). */
export function drainIrcMessages(agentIdOrTaskId: string): IrcMessage[] {
	const handle = getLiveAgent(agentIdOrTaskId);
	if (!handle) return [];
	const messages = [...handle.pendingMessages];
	handle.pendingMessages.length = 0;
	return messages;
}
