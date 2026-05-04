import * as fs from "node:fs";
import type { TeamTaskState, TeamRunManifest } from "../state/types.ts";

// ============================================================================
// Phase 1.2: Completion Mutation Guard — detects tasks that claim success but
// made no observable mutations. Used by task-runner.ts.
// ============================================================================

export interface CompletionMutationGuardInput {
	role: string;
	taskText?: string;
	transcriptPath?: string;
	stdout?: string;
}

export interface CompletionMutationGuardResult {
	expectedMutation: boolean;
	observedMutation: boolean;
	reason?: "no_mutation_observed";
	observedTools: string[];
}

const MUTATING_ROLES = new Set(["executor", "test-engineer"]);
const MUTATING_TOOLS = new Set(["edit", "write", "multi_edit", "apply_patch", "replace_in_file", "insert", "delete_files", "create_file", "overwrite", "patch"]);
const READ_ONLY_COMMANDS = /^(pwd|ls|dir|cat|type|sed|grep|rg|find|git\s+(status|diff|log|show|branch|remote|rev-parse|ls-files)|npm\s+(test|run\s+(typecheck|check|lint|test|ci))|node\s+--test)\b/i;
const MUTATING_COMMANDS = /\b(rm\s+-|del\s+|erase\s+|mv\s+|move\s+|cp\s+|copy\s+|mkdir\b|touch\b|git\s+(add|commit|push|reset|clean|checkout|switch|merge|rebase|stash)|npm\s+(install|i|uninstall|publish|version)|pnpm\s+(add|install|remove)|yarn\s+(add|install|remove)|python\b.*>|node\b.*>|echo\b.*>|Set-Content|Out-File|sed\s+-i|tee\b|dd\b.*of=|wget\b.*-O|curl\b.*-o)\b/i;
const READ_ONLY_HINTS = /\b(read-only|no edits?|do not edit|không sửa|khong sua|chỉ đọc|chi doc|plan only|chỉ lập plan|review only|audit only)\b/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function commandText(value: unknown): string {
	const record = asRecord(value);
	if (!record) return typeof value === "string" ? value : "";
	for (const key of ["command", "cmd", "script", "input"]) {
		const raw = record[key];
		if (typeof raw === "string") return raw;
	}
	return JSON.stringify(record);
}

function isMutatingTool(tool: string, args: unknown): boolean {
	const normalized = tool.toLowerCase();
	if (MUTATING_TOOLS.has(normalized)) return true;
	if (normalized === "bash" || normalized === "shell" || normalized === "powershell") {
		const command = commandText(args).trim();
		if (!command) return false;
		// Check mutating patterns first: sed -i is mutating even though plain sed is read-only.
		if (MUTATING_COMMANDS.test(command)) return true;
		if (READ_ONLY_COMMANDS.test(command)) return false;
		// If the command doesn't match either list, treat unknown bash calls as potentially mutating.
		return true;
	}
	return false;
}

function collectToolCallsFromEvent(event: unknown): Array<{ tool: string; args?: unknown }> {
	const record = asRecord(event);
	if (!record) return [];
	const calls: Array<{ tool: string; args?: unknown }> = [];
	const directTool = record.toolName ?? record.name ?? record.tool;
	if (typeof directTool === "string" && (record.type === "tool_execution_start" || record.type === "toolCall" || record.type === "tool_call")) {
		calls.push({ tool: directTool, args: record.args ?? record.input });
	}
	const content = Array.isArray(record.content) ? record.content : asRecord(record.message)?.content;
	if (Array.isArray(content)) {
		for (const part of content) {
			const item = asRecord(part);
			if (!item) continue;
			const tool = item.name ?? item.toolName ?? item.tool;
			if (typeof tool === "string" && (item.type === "toolCall" || item.type === "tool_call" || item.type === "tool_execution_start")) calls.push({ tool, args: item.input ?? item.args });
		}
	}
	return calls;
}

function transcriptText(input: CompletionMutationGuardInput): string {
	if (input.transcriptPath && fs.existsSync(input.transcriptPath)) return fs.readFileSync(input.transcriptPath, "utf-8");
	return input.stdout ?? "";
}

export function expectsImplementationMutation(input: Pick<CompletionMutationGuardInput, "role" | "taskText">): boolean {
	if (!MUTATING_ROLES.has(input.role)) return false;
	return !READ_ONLY_HINTS.test(input.taskText ?? "");
}

export function evaluateCompletionMutationGuard(input: CompletionMutationGuardInput): CompletionMutationGuardResult {
	const expectedMutation = expectsImplementationMutation(input);
	const observedTools: string[] = [];
	let observedMutation = false;
	const text = transcriptText(input);
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: unknown;
		try { event = JSON.parse(trimmed); } catch { continue; }
		for (const call of collectToolCallsFromEvent(event)) {
			observedTools.push(call.tool);
			if (isMutatingTool(call.tool, call.args)) observedMutation = true;
		}
	}
	return {
		expectedMutation,
		observedMutation,
		observedTools,
		...(expectedMutation && !observedMutation ? { reason: "no_mutation_observed" as const } : {}),
	};
}

// ============================================================================
// Phase 11a: Artifact-based Completion Verification — a second layer that
// checks whether a completed task actually produced meaningful artifacts.
// ============================================================================

/**
 * Guard against false-positive task completions.
 *
 * Checks whether a task that claims success actually produced meaningful output.
 * Returns a verification result with the green level (0-3) and any warnings.
 */
export interface CompletionVerifyResult {
	/** 0 = no output, 1 = minimal, 2 = moderate, 3 = strong */
	greenLevel: number;
	/** Warnings about potentially incomplete work */
	warnings: string[];
}

const MAX_OUTPUT_PREVIEW = 200;

function isTrivialError(error: string | undefined): boolean {
	if (!error) return false;
	return error.trim().length === 0;
}

export function verifyTaskCompletion(
	task: TeamTaskState,
	manifest: TeamRunManifest,
): CompletionVerifyResult {
	const warnings: string[] = [];
	let greenLevel = 0;

	// Check 1: Has an error?
	if (task.error && !isTrivialError(task.error)) {
		return { greenLevel: 0, warnings: [`Task has error: ${task.error}`] };
	}

	// Check 2: Has result artifact?
	if (task.resultArtifact) {
		greenLevel += 1;
	}

	// Check 3: Has transcript?
	if (task.transcriptArtifact) {
		greenLevel += 1;
	}

	// Check 4: For implementation tasks, verify artifacts were actually produced
	const runArtifacts = manifest.artifacts.filter(
		(a) => a.producer === task.id || a.producer === task.agent,
	);
	if (runArtifacts.length > 0) {
		greenLevel += 1;
	} else if (greenLevel < 3) {
		warnings.push("No run-level artifacts produced by this task");
	}

	// Check 5: Usage tracking — did the task actually consume tokens?
	if (task.usage) {
		const totalTokens = (task.usage.input ?? 0) + (task.usage.output ?? 0);
		if (totalTokens === 0 && greenLevel < 3) {
			warnings.push("Task reports zero token usage — may not have executed");
		}
	}

	return {
		greenLevel: Math.min(greenLevel, 3),
		warnings,
	};
}

/**
 * Format a preview of task output for diagnostic display.
 */
export function formatOutputPreview(output: string | undefined): string {
	if (!output) return "(no output)";
	const trimmed = output.trim();
	if (trimmed.length <= MAX_OUTPUT_PREVIEW) return trimmed;
	return trimmed.slice(0, MAX_OUTPUT_PREVIEW) + "...";
}
