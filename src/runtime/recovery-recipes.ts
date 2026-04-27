import type { PolicyDecision, PolicyDecisionReason } from "../state/types.ts";

export type FailureScenario = "trust_prompt_unresolved" | "prompt_misdelivery" | "stale_branch" | "compile_red_cross_crate" | "mcp_handshake_failure" | "partial_plugin_startup" | "provider_failure" | "task_failed" | "worker_stale" | "green_unsatisfied";
export type RecoveryStep = "accept_trust_prompt" | "redirect_prompt_to_agent" | "rebase_branch" | "clean_build" | "retry_mcp_handshake" | "restart_plugin" | "restart_worker" | "rerun_task" | "collect_verification_evidence" | "escalate_to_human";
export type RecoveryResultState = "planned" | "skipped" | "escalation_required";

export interface RecoveryRecipe {
	scenario: FailureScenario;
	steps: RecoveryStep[];
	maxAttempts: number;
	escalationPolicy: "alert_human" | "log_and_continue" | "abort";
}

export interface RecoveryLedgerEntry {
	scenario: FailureScenario;
	taskId?: string;
	decisionReason: PolicyDecisionReason;
	attempt: number;
	state: RecoveryResultState;
	steps: RecoveryStep[];
	message: string;
	createdAt: string;
}

export interface RecoveryLedger {
	entries: RecoveryLedgerEntry[];
}

export function scenarioForPolicyReason(reason: PolicyDecisionReason): FailureScenario {
	switch (reason) {
		case "branch_stale": return "stale_branch";
		case "worker_stale": return "worker_stale";
		case "green_unsatisfied": return "green_unsatisfied";
		case "task_failed": return "task_failed";
		default: return "provider_failure";
	}
}

export function recipeFor(scenario: FailureScenario): RecoveryRecipe {
	switch (scenario) {
		case "trust_prompt_unresolved": return { scenario, steps: ["accept_trust_prompt"], maxAttempts: 1, escalationPolicy: "alert_human" };
		case "prompt_misdelivery": return { scenario, steps: ["redirect_prompt_to_agent"], maxAttempts: 1, escalationPolicy: "alert_human" };
		case "stale_branch": return { scenario, steps: ["rebase_branch", "clean_build"], maxAttempts: 1, escalationPolicy: "alert_human" };
		case "compile_red_cross_crate": return { scenario, steps: ["clean_build"], maxAttempts: 1, escalationPolicy: "alert_human" };
		case "mcp_handshake_failure": return { scenario, steps: ["retry_mcp_handshake"], maxAttempts: 1, escalationPolicy: "abort" };
		case "partial_plugin_startup": return { scenario, steps: ["restart_plugin", "retry_mcp_handshake"], maxAttempts: 1, escalationPolicy: "log_and_continue" };
		case "worker_stale": return { scenario, steps: ["restart_worker"], maxAttempts: 1, escalationPolicy: "alert_human" };
		case "green_unsatisfied": return { scenario, steps: ["collect_verification_evidence"], maxAttempts: 1, escalationPolicy: "alert_human" };
		case "task_failed": return { scenario, steps: ["rerun_task"], maxAttempts: 1, escalationPolicy: "alert_human" };
		case "provider_failure": return { scenario, steps: ["restart_worker"], maxAttempts: 1, escalationPolicy: "alert_human" };
	}
}

export function buildRecoveryLedger(decisions: PolicyDecision[], previous: RecoveryLedger = { entries: [] }): RecoveryLedger {
	const entries = [...previous.entries];
	for (const item of decisions) {
		if (!["retry", "escalate", "block"].includes(item.action)) continue;
		const scenario = scenarioForPolicyReason(item.reason);
		const recipe = recipeFor(scenario);
		const priorAttempts = entries.filter((entry) => entry.scenario === scenario && entry.taskId === item.taskId).length;
		const attempt = priorAttempts + 1;
		entries.push({
			scenario,
			taskId: item.taskId,
			decisionReason: item.reason,
			attempt,
			state: attempt <= recipe.maxAttempts && item.action !== "block" ? "planned" : "escalation_required",
			steps: attempt <= recipe.maxAttempts ? recipe.steps : ["escalate_to_human"],
			message: item.message,
			createdAt: new Date().toISOString(),
		});
	}
	return { entries };
}
