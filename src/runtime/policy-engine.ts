import type { CrewLimitsConfig } from "../config/config.ts";
import type { PolicyDecision, PolicyDecisionAction, PolicyDecisionReason, TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { evaluateGreenContract } from "./green-contract.ts";
import { isWorkerHeartbeatStale } from "./worker-heartbeat.ts";

export interface PolicyEngineInput {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	limits?: CrewLimitsConfig;
	now?: Date;
}

function decision(action: PolicyDecisionAction, reason: PolicyDecisionReason, message: string, taskId?: string): PolicyDecision {
	return {
		action,
		reason,
		message,
		taskId,
		createdAt: new Date().toISOString(),
	};
}

function taskDepth(task: TeamTaskState, tasksById: Map<string, TeamTaskState>): number {
	let depth = 0;
	let current = task.graph?.parentId;
	const seen = new Set<string>();
	while (current && !seen.has(current)) {
		seen.add(current);
		depth += 1;
		current = tasksById.get(current)?.graph?.parentId;
	}
	return depth;
}

export function evaluateCrewPolicy(input: PolicyEngineInput): PolicyDecision[] {
	const decisions: PolicyDecision[] = [];
	const maxTasksPerRun = input.limits?.maxTasksPerRun;
	if (maxTasksPerRun !== undefined && input.tasks.length > maxTasksPerRun) {
		decisions.push(decision("block", "limit_exceeded", `Run has ${input.tasks.length} tasks, exceeding maxTasksPerRun=${maxTasksPerRun}.`));
	}
	const runningCount = input.tasks.filter((task) => task.status === "running").length;
	if (input.limits?.maxConcurrentWorkers !== undefined && runningCount > input.limits.maxConcurrentWorkers) {
		decisions.push(decision("block", "limit_exceeded", `Run has ${runningCount} running workers, exceeding maxConcurrentWorkers=${input.limits.maxConcurrentWorkers}.`));
	}
	const tasksById = new Map(input.tasks.map((task) => [task.id, task]));

	for (const task of input.tasks) {
		if (input.limits?.maxChildrenPerTask !== undefined && (task.graph?.children.length ?? 0) > input.limits.maxChildrenPerTask) {
			decisions.push(decision("block", "limit_exceeded", `Task has ${task.graph?.children.length ?? 0} children, exceeding maxChildrenPerTask=${input.limits.maxChildrenPerTask}.`, task.id));
		}
		if (input.limits?.maxTaskDepth !== undefined && taskDepth(task, tasksById) > input.limits.maxTaskDepth) {
			decisions.push(decision("block", "limit_exceeded", `Task graph depth exceeds maxTaskDepth=${input.limits.maxTaskDepth}.`, task.id));
		}
		if (task.status === "failed") {
			const retryCount = task.policy?.retryCount ?? 0;
			const maxRetries = input.limits?.maxRetriesPerTask ?? 0;
			decisions.push(decision(retryCount < maxRetries ? "retry" : "escalate", "task_failed", task.error ? `Task failed: ${task.error}` : "Task failed.", task.id));
		}
		if (task.heartbeat && isWorkerHeartbeatStale(task.heartbeat, input.limits?.heartbeatStaleMs ?? 60_000, input.now)) {
			decisions.push(decision("escalate", "worker_stale", "Worker heartbeat is stale.", task.id));
		}
		if (task.taskPacket?.verification) {
			const outcome = evaluateGreenContract(task.taskPacket.verification, task.verification);
			if (!outcome.satisfied && task.status === "completed") {
				decisions.push(decision("block", "green_unsatisfied", `Green contract unsatisfied: required=${outcome.requiredGreenLevel}, observed=${outcome.observedGreenLevel}.`, task.id));
			}
		}
	}

	if (decisions.length === 0 && input.tasks.length > 0 && input.tasks.every((task) => task.status === "completed")) {
		decisions.push(decision("closeout", "run_complete", "All tasks completed and no policy blockers were found."));
	}
	return decisions;
}

export function summarizePolicyDecisions(decisions: PolicyDecision[]): string[] {
	return decisions.map((item) => `- ${item.action} (${item.reason})${item.taskId ? ` ${item.taskId}` : ""}: ${item.message}`);
}
