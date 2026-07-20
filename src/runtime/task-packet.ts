import * as path from "node:path";
import type { TaskPacket, TaskScope, TeamRunManifest, VerificationContract } from "../state/types.ts";
import type { WorkflowStep } from "../workflows/workflow-config.ts";
import { generateTaskHashId } from "./task-id.ts";

// ═══════════════════════════════════════════════════════════════════════════
// SEC-007 Fix: Workflow Step Task Sanitization
// Context provided by workers comes from workflow definitions that could
// be user-controlled. Sanitize task text to prevent injection.
// See: SECURITY-ISSUES.md SEC-007
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sanitize workflow step task text to reduce injection risk.
 *
 * The task text is used as a prompt for worker agents. In a multi-tenant
 * or shared workflow scenario, malicious workflow definitions could
 * embed injection instructions.
 *
 * Sanitization:
 * - Strip zero-width Unicode characters
 * - Strip known prompt injection directive patterns
 * - Strip base64/hex encoded payloads
 * - Collapse excessive whitespace
 */
export function sanitizeTaskText(task: string): string {
	let sanitized = task;

	// 1. Strip zero-width and invisible Unicode characters
	sanitized = sanitized.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, "");

	// 2. Strip known prompt injection directive patterns
	sanitized = sanitized.replace(
		/^\s*(?:SYSTEM|INSTRUCTION|IGNORE(?:\s+ALL)?\s+INSTRUCTIONS|OVERRIDE|YOUR\s+ROLE\s+IS|MALICIOUS)\s*:.*$/gim,
		"",
	);

	// 3. Strip base64/hex encoded command payloads
	sanitized = sanitized.replace(/\b(?:base64|base32|hex)\s*['":]\s*([A-Za-z0-9+\/=]{16,})/gi, "[encoded-redacted]");

	// 4. Strip embedded instruction patterns in brackets
	sanitized = sanitized.replace(/\[(?:SYSTEM|INSTRUCTION|OVERRIDE)\s*:[^\]]*\]/gi, "");

	// 5. Collapse multiple blank lines
	sanitized = sanitized.replace(/\n{3,}/g, "\n\n");

	return sanitized.trim();
}

export interface BuildTaskPacketInput {
	manifest: TeamRunManifest;
	step: WorkflowStep;
	taskId: string;
	cwd: string;
	worktreePath?: string;
}

export interface TaskPacketValidationResult {
	valid: boolean;
	errors: string[];
}

export function inferTaskScope(step: WorkflowStep): TaskScope {
	const reads = step.reads === false ? [] : (step.reads ?? []);
	if (reads.length === 1) return "single_file";
	if (reads.length > 1) return "module";
	return "workspace";
}

export function defaultVerificationContract(step: WorkflowStep): VerificationContract {
	return {
		requiredGreenLevel: step.verify ? "targeted" : "none",
		commands: [],
		allowManualEvidence: true,
	};
}

export function buildTaskPacket(input: BuildTaskPacketInput): TaskPacket {
	const scope = inferTaskScope(input.step);
	const reads = input.step.reads === false ? [] : (input.step.reads ?? []);
	const scopePath = reads.length === 1 ? reads[0] : reads.length > 1 ? reads.join(", ") : undefined;
	// SEC-007: Sanitize task text before inserting into task packet
	const sanitizedTask = sanitizeTaskText(input.step.task);
	const sanitizedGoal = sanitizeTaskText(input.manifest.goal);

	// Generate a deterministic hash-based task ID for traceability and logging.
	// Uses goal + step ID + run ID as content parts.
	// TODO(hashId): tracked — add hashId to TaskPacket when the schema supports it.
	const _taskHashId = generateTaskHashId([input.manifest.goal, input.step.id, input.manifest.runId]);

	return {
		objective: sanitizedTask.replaceAll("{goal}", sanitizedGoal),
		scope,
		scopePath,
		repo: path.basename(input.manifest.cwd) || input.manifest.cwd,
		worktree: input.worktreePath,
		branchPolicy:
			input.manifest.workspaceMode === "worktree"
				? "Use the assigned task worktree and avoid modifying the leader checkout."
				: "Use the current checkout; do not create branches unless explicitly requested.",
		acceptanceTests: [],
		commitPolicy: "Do not commit unless explicitly requested by the user or workflow.",
		reportingContract: "Report intended/changed files, verification evidence, blockers, conflict risks, and next recommended action.",
		escalationPolicy:
			"Stop and report if scope is ambiguous, destructive action is needed, permissions are missing, verification cannot be completed, or edits may overlap with another worker/task.",
		constraints: [
			"Stay within the assigned task scope.",
			"Do not claim completion without verification evidence.",
			"Use mailbox/API state for coordination when available.",
			"Do not make overlapping edits to the same file/symbol without explicit leader sequencing or ownership guidance.",
		],
		expectedArtifacts: ["prompt", "result", "verification"],
		verification: defaultVerificationContract(input.step),
	};
}

export function validateTaskPacket(packet: TaskPacket): TaskPacketValidationResult {
	const errors: string[] = [];
	if (!packet.objective.trim()) errors.push("objective must not be empty");
	if (!packet.repo.trim()) errors.push("repo must not be empty");
	if (!packet.branchPolicy.trim()) errors.push("branchPolicy must not be empty");
	if (!packet.commitPolicy.trim()) errors.push("commitPolicy must not be empty");
	if (!packet.reportingContract.trim()) errors.push("reportingContract must not be empty");
	if (!packet.escalationPolicy.trim()) errors.push("escalationPolicy must not be empty");
	if ((packet.scope === "module" || packet.scope === "single_file" || packet.scope === "custom") && !packet.scopePath?.trim()) {
		errors.push(`scopePath is required for scope '${packet.scope}'`);
	}
	if (packet.constraints.length === 0) errors.push("constraints must contain at least one entry");
	for (const [index, constraint] of packet.constraints.entries()) {
		if (!constraint.trim()) errors.push(`constraints contains an empty value at index ${index}`);
	}
	if (packet.expectedArtifacts.length === 0) errors.push("expectedArtifacts must contain at least one entry");
	for (const [index, artifact] of packet.expectedArtifacts.entries()) {
		if (!artifact.trim()) errors.push(`expectedArtifacts contains an empty value at index ${index}`);
	}
	for (const [index, test] of packet.acceptanceTests.entries()) {
		if (!test.trim()) errors.push(`acceptanceTests contains an empty value at index ${index}`);
	}
	return { valid: errors.length === 0, errors };
}

/**
 * Structured handoff template for task completion reports.
 * Distilled from ECC dmux-workflows pattern — workers use this format
 * so verifiers and downstream consumers can parse output predictably.
 */
export const HANDOFF_TEMPLATE = [
	"## Handoff",
	"",
	"### Summary",
	"<!-- 2-3 sentences describing what was done -->",
	"",
	"### Files Changed",
	"<!-- List each file changed with brief description -->",
	"<!-- - path/to/file.ts: description -->",
	"",
	"### Tests / Verification",
	"<!-- What tests pass? What was manually verified? -->",
	"",
	"### Follow-ups",
	"<!-- Any remaining issues or next steps -->",
].join("\n");

export interface ParsedHandoff {
	summary: string[];
	filesChanged: string[];
	tests: string[];
	followups: string[];
}

/**
 * Extract text between a ### heading and the next ### heading or end of text.
 */
function extractSection(content: string, heading: string): string {
	const lines = content.split("\n");
	const headingMarker = `### ${heading}`;
	const startIndex = lines.findIndex((line) => line.trim() === headingMarker);
	if (startIndex === -1) return "";

	const collected: string[] = [];
	for (let i = startIndex + 1; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed.startsWith("### ") || trimmed.startsWith("## ")) break;
		// Stop at paragraph text (non-bullet, non-comment, non-empty) that follows
		// a blank line — signals end of subsection content.
		if (
			trimmed.length > 0 &&
			!trimmed.startsWith("- ") &&
			!trimmed.startsWith("<!--") &&
			i > startIndex + 1 &&
			lines[i - 1].trim() === "" &&
			collected.some((l) => l.trim().length > 0)
		) {
			break;
		}
		collected.push(lines[i]);
	}

	return collected.join("\n").trim();
}

/**
 * Parse bullet list items from a section, stripping leading "- " and backtick wrapping.
 */
function parseBullets(section: string): string[] {
	if (!section) return [];
	return section
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- "))
		.map((line) => {
			let item = line.replace(/^- /, "").trim();
			// Strip surrounding backticks
			if (item.startsWith("`") && item.endsWith("`") && item.length >= 2) {
				item = item.slice(1, -1);
			}
			return item;
		});
}

/**
 * Parse a handoff section that may contain bullets AND free-text paragraphs.
 * Returns all non-empty lines as individual items (bullets get their marker stripped).
 */
function parseMixedContent(section: string): string[] {
	if (!section) return [];
	return section
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("<!--")) // skip HTML comments
		.map((line) => {
			if (line.startsWith("- ")) return line.slice(2).trim();
			return line;
		})
		.map((item) => {
			// Strip surrounding backticks
			if (item.startsWith("`") && item.endsWith("`") && item.length >= 2) {
				return item.slice(1, -1);
			}
			return item;
		});
}

/**
 * Parse structured handoff data from agent output text.
 * Looks for the "## Handoff" heading and extracts subsections.
 * Returns empty arrays for sections not found.
 */
export function parseHandoffFromOutput(output: string): ParsedHandoff {
	if (!output || typeof output !== "string") {
		return { summary: [], filesChanged: [], tests: [], followups: [] };
	}

	// Find the handoff section — look for ## Handoff
	const handoffIndex = output.indexOf("## Handoff");
	const content = handoffIndex >= 0 ? output.slice(handoffIndex) : output;

	return {
		summary: parseMixedContent(extractSection(content, "Summary")),
		filesChanged: parseMixedContent(extractSection(content, "Files Changed")),
		tests: parseMixedContent(extractSection(content, "Tests / Verification")),
		followups: parseMixedContent(extractSection(content, "Follow-ups")),
	};
}

export function renderTaskPacket(packet: TaskPacket): string {
	return ["# Task Packet", "", "```json", JSON.stringify(packet, null, 2), "```", ""].join("\n");
}
