/**
 * Phase 8: Monitoring and observability for live-session workers.
 *
 * Provides health checks, metrics collection, and diagnostics
 * for live-session workers running in-process.
 */

export interface LiveSessionHealth {
	/** Total number of registered live agents. */
	totalAgents: number;
	/** Number of agents currently running. */
	runningAgents: number;
	/** Number of agents in idle state. */
	idleAgents: number;
	/** Number of agents that have completed. */
	completedAgents: number;
	/** Number of agents that have failed. */
	failedAgents: number;
	/** Total tokens consumed across all live sessions. */
	totalTokens: number;
	/** Timestamp of this health snapshot. */
	timestamp: string;
}

export interface LiveSessionMetrics {
	agentId: string;
	taskId: string;
	status: string;
	/** Accumulated usage from session stats. */
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: number;
		turns?: number;
	};
	/** Session duration in milliseconds. */
	durationMs?: number;
	/** Number of IRC messages received. */
	ircMessagesReceived?: number;
	/** Number of yield reminders sent. */
	yieldReminders?: number;
	/** Whether yield was called. */
	yieldCalled: boolean;
}

/**
 * Collect health snapshot from live agent handles.
 */
export function collectLiveSessionHealth(
	agents: Array<{ status: string }>,
	getUsage: (agentId: string) => { input?: number; output?: number; turns?: number } | undefined,
): LiveSessionHealth {
	let running = 0;
	let idle = 0;
	let completed = 0;
	let failed = 0;
	let totalTokens = 0;

	for (const agent of agents) {
		switch (agent.status) {
			case "running":
				running++;
				break;
			case "idle":
				idle++;
				break;
			case "completed":
				completed++;
				break;
			case "failed":
				failed++;
				break;
		}
	}

	// Sum tokens from usage data
	for (const agent of agents) {
		const agentAny = agent as Record<string, unknown>;
		const agentId = agentAny.agentId as string | undefined;
		if (agentId) {
			const usage = getUsage(agentId);
			if (usage) {
				totalTokens += (usage.input ?? 0) + (usage.output ?? 0);
			}
		}
	}

	return {
		totalAgents: agents.length,
		runningAgents: running,
		idleAgents: idle,
		completedAgents: completed,
		failedAgents: failed,
		totalTokens,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Build a diagnostic summary string for logging.
 */
export function formatLiveSessionDiagnostics(health: LiveSessionHealth): string {
	return [
		`[Live-Session Health] agents=${health.totalAgents} running=${health.runningAgents} idle=${health.idleAgents} completed=${health.completedAgents} failed=${health.failedAgents} tokens=${health.totalTokens}`,
	].join("\n");
}
