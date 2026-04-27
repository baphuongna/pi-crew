export type WorkerLifecycleState = "spawning" | "trust_required" | "ready_for_prompt" | "running" | "finished" | "failed";
export type StartupFailureClassification = "trust_required" | "prompt_misdelivery" | "prompt_acceptance_timeout" | "transport_dead" | "worker_crashed" | "unknown";

export interface WorkerStartupEvidence {
	lastLifecycleState: WorkerLifecycleState;
	command: string;
	promptSentAt?: string;
	promptAccepted: boolean;
	trustPromptDetected: boolean;
	transportHealthy: boolean;
	childProcessAlive: boolean;
	elapsedMs: number;
	classification: StartupFailureClassification;
	stderrPreview?: string;
}

export function detectTrustPrompt(text: string): boolean {
	const lowered = text.toLowerCase();
	return lowered.includes("do you trust") || lowered.includes("trust this") || lowered.includes("untrusted") || lowered.includes("workspace trust") || lowered.includes("allow this folder");
}

export function classifyStartupFailure(evidence: Omit<WorkerStartupEvidence, "classification">): StartupFailureClassification {
	if (!evidence.transportHealthy) return "transport_dead";
	if (evidence.trustPromptDetected || evidence.lastLifecycleState === "trust_required") return "trust_required";
	if (evidence.promptSentAt && !evidence.promptAccepted && evidence.childProcessAlive) return "prompt_acceptance_timeout";
	if (evidence.promptSentAt && !evidence.promptAccepted && !evidence.childProcessAlive) return "worker_crashed";
	if (evidence.stderrPreview?.toLowerCase().includes("command not found") || evidence.stderrPreview?.toLowerCase().includes("not recognized")) return "prompt_misdelivery";
	if (!evidence.childProcessAlive && evidence.lastLifecycleState !== "finished") return "worker_crashed";
	return "unknown";
}

export function createStartupEvidence(input: {
	command: string;
	startedAt: Date;
	finishedAt?: Date;
	promptSentAt?: Date;
	promptAccepted?: boolean;
	stderr?: string;
	error?: string;
	exitCode?: number | null;
}): WorkerStartupEvidence {
	const stderrPreview = (input.error || input.stderr || "").slice(0, 500) || undefined;
	const trustPromptDetected = detectTrustPrompt(stderrPreview ?? "");
	const childProcessAlive = input.exitCode === undefined || input.exitCode === null ? !input.finishedAt : false;
	const base: Omit<WorkerStartupEvidence, "classification"> = {
		lastLifecycleState: input.error || (input.exitCode !== undefined && input.exitCode !== null && input.exitCode !== 0) ? "failed" : input.finishedAt ? "finished" : "running",
		command: input.command,
		promptSentAt: input.promptSentAt?.toISOString(),
		promptAccepted: input.promptAccepted ?? !input.error,
		trustPromptDetected,
		transportHealthy: !input.error || !/enoent|spawn|transport/i.test(input.error),
		childProcessAlive,
		elapsedMs: Math.max(0, (input.finishedAt ?? new Date()).getTime() - input.startedAt.getTime()),
		stderrPreview,
	};
	return { ...base, classification: classifyStartupFailure(base) };
}
