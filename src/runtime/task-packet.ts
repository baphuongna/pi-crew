import * as path from "node:path";
import { freezeSpecSnapshot, loadSpecRecord } from "../state/stores/spec-store.ts";
import type { SpecRecord, TaskPacket, TaskScope, TeamRunManifest, VerificationContract } from "../state/types.ts";
import type { WorkflowStep } from "../workflows/workflow-config.ts";
import { generateTaskHashId } from "./task-id.ts";

// ═══════════════════════════════════════════════════════════════════════════
// SEC-007 Fix: Workflow Step Task Sanitization
// Context provided by workers comes from workflow definitions that could
// be user-controlled. Sanitize task text to prevent injection.
// See: SECURITY-ISSUES.md SEC-007
// ═══════════════════════════════════════════════════════════════════════════

export interface TaskTextSanitizeResult {
	/** Sanitized text WITHOUT the redaction note (the note is composed by the
	 *  caller — see {@link sanitizeTaskText} / {@link appendSecurityRedactionNote}). */
	text: string;
	/** G7 (DR-02 round-5): number of content redactions applied by rules 1b–9
	 *  (each replaced match counts 1 — marker substitutions AND strip-to-empty
	 *  removals). Zero-width stripping (rule 1) and blank-line collapse
	 *  (rule 10) are cosmetic and never counted. */
	redactionCount: number;
}

/** G7 (DR-02 round-5): the single trailing note line appended when ≥1
 *  security redaction fired. Silent redaction left sanitized objectives
 *  like "do not [suspicious-write-redacted]s to logs" with no explanation —
 *  the worker could not tell meaning was removed. Count = number of
 *  replacements made. No note when nothing was redacted (byte-identical to
 *  the pre-G7 output for clean inputs). */
export function appendSecurityRedactionNote(text: string, redactionCount: number): string {
	if (redactionCount <= 0) return text;
	return `${text}\n\n(${redactionCount} security redaction(s) applied by task-text sanitizer — rephrase constraints avoiding trigger patterns if this removed intended meaning)`;
}

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
 *
 * G7: every content redaction is counted; `sanitizeTaskText` appends ONE
 * trailing note line when ≥1 fired (see {@link appendSecurityRedactionNote}).
 */
export function sanitizeTaskTextWithRedactionCount(task: string): TaskTextSanitizeResult {
	let sanitized = task;
	let redactionCount = 0;
	// Counting replacer: each replacement the pattern performs (marker
	// substitution or strip-to-empty removal) counts as one redaction hit.
	const counted = (replacement: string) => (): string => {
		redactionCount += 1;
		return replacement;
	};

	// 1. Strip zero-width and invisible Unicode characters (cosmetic — never
	// counted: removing invisible chars cannot change intended meaning).
	sanitized = sanitized.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, "");

	// 1b. Strip HTML/JS comments and script tags (instruction hiding).
	// SEC-4: bounded quantifier {0,8192} prevents polynomial O(n²) backtracking
	// DoS on pathological inputs (e.g. an unclosed `<!--` with no matching `-->`).
	sanitized = sanitized.replace(/<!--[\s\S]{0,8192}?-->|<\/?script[^>]*>/gi, counted(""));

	// 2. Strip known prompt injection directive patterns
	sanitized = sanitized.replace(
		/^\s*(?:SYSTEM|INSTRUCTION|IGNORE(?:\s+ALL)?\s+(?:PREVIOUS|INSTRUCTIONS)?|OVERRIDE|YOUR\s+ROLE\s+IS|MALICIOUS)\s*:.*$/gim,
		counted(""),
	);

	// 3. Strip base64/hex encoded command payloads
	sanitized = sanitized.replace(/\b(?:base64|base32|hex)\s*['":]\s*([A-Za-z0-9+\/=]{16,})/gi, counted("[encoded-redacted]"));

	// 4. Strip embedded instruction patterns in brackets (incl. MALICIOUS to match agent sanitizer)
	sanitized = sanitized.replace(/\[(?:SYSTEM|INSTRUCTION|OVERRIDE|MALICIOUS)\s*:[^\]]*\]/gi, counted(""));

	// 5. Strip eval/exec patterns with encoded content
	sanitized = sanitized.replace(
		/\b(?:eval|exec|spawn|subprocess)\s*\(\s*(?:base64|Buffer\.from)\s*\(/gi,
		counted("[suspicious-call-redacted]"),
	);

	// 6. Strip markdown codeblocks that attempt to hide instructions.
	// SEC-4: bounded quantifier {0,8192} prevents polynomial backtracking DoS.
	sanitized = sanitized.replace(/```\s*(?:system|instruction|prompt)\n[\s\S]{0,8192}?```/gi, counted(""));

	// 7. Strip YAML-like assignment patterns that could override behavior.
	// Applied unconditionally — task text is always untrusted.
	sanitized = sanitized.replace(/^\s*(?:role|persona|behavior|directive)\s*[=:].*$/gim, counted(""));

	// 8. Strip potential exfiltration patterns
	sanitized = sanitized.replace(/\b(?:write|append)\s+.*(?:secrets?|keys?|token|credential)/gi, counted("[suspicious-write-redacted]"));

	// 9. Strip network exfiltration patterns
	sanitized = sanitized.replace(/\b(?:fetch|curl|wget|axios)\s+.*(?:exfil|steal|leak|send)/gi, counted("[suspicious-network-redacted]"));

	// 10. Collapse multiple blank lines (cleanup after removals — cosmetic, never counted)
	sanitized = sanitized.replace(/\n{3,}/g, "\n\n");

	return { text: sanitized.trim(), redactionCount };
}

/**
 * Sanitize task text and, when any content redaction fired, append ONE
 * trailing note line explaining it (G7, DR-02 round-5).
 */
export function sanitizeTaskText(task: string): string {
	const { text, redactionCount } = sanitizeTaskTextWithRedactionCount(task);
	return appendSecurityRedactionNote(text, redactionCount);
}

export interface BuildTaskPacketInput {
	/** T4/R6 (ADR-6 §2): workspace spec ids — loaded + FROZEN into the packet. */
	specRefs?: string[];
	/** T4/R6 (ADR-6 §7): strict mode — coverage AND machine-check (§4). */
	specStrict?: boolean;
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
	// T4/R6 (ADR-6 §1/§2): the ONLY packet-creation path is also the freeze
	// point — specRefs load from the workspace store and freeze into immutable
	// snapshots embedded in the packet (later spec edits never rewrite them).
	// Round-1 review (fail-closed freeze): declared-but-unresolvable ids are
	// kept on the packet as unresolvedSpecRefs instead of being dropped — the
	// gate surfaces them (badge non-strict / failure strict), never a silent
	// no-op. Snapshots freeze trust via the store at THIS moment.
	const declaredSpecRefs = input.specRefs ?? [];
	const resolvedRecords = declaredSpecRefs
		.map((id) => loadSpecRecord(input.manifest.cwd, id))
		.filter((r): r is SpecRecord => r !== undefined);
	const specSnapshots = resolvedRecords.map((r) => freezeSpecSnapshot(r, input.manifest.cwd));
	const unresolvedSpecRefs = declaredSpecRefs.filter((id) => !specSnapshots.some((s) => s.specId === id));

	const scope = inferTaskScope(input.step);
	const reads = input.step.reads === false ? [] : (input.step.reads ?? []);
	const scopePath = reads.length === 1 ? reads[0] : reads.length > 1 ? reads.join(", ") : undefined;
	// SEC-007: Sanitize task text before inserting into task packet.
	// G7 (DR-02 round-5): count redactions on BOTH the task and the goal — the
	// packet objective carries ONE combined trailing note so the worker knows
	// meaning may have been removed (per-text notes inside the {goal}
	// substitution could land mid-objective and stack to two notes).
	const sanitizedTaskResult = sanitizeTaskTextWithRedactionCount(input.step.task);
	const sanitizedGoalResult = sanitizeTaskTextWithRedactionCount(input.manifest.goal);
	const objective = appendSecurityRedactionNote(
		sanitizedTaskResult.text.replaceAll("{goal}", sanitizedGoalResult.text),
		sanitizedTaskResult.redactionCount + sanitizedGoalResult.redactionCount,
	);

	// Generate a deterministic hash-based task ID for traceability and logging.
	// Uses goal + step ID + run ID as content parts.
	// TODO(hashId): tracked — add hashId to TaskPacket when the schema supports it.
	const _taskHashId = generateTaskHashId([input.manifest.goal, input.step.id, input.manifest.runId]);

	return {
		objective,
		...(declaredSpecRefs.length > 0 ? { specRefs: declaredSpecRefs, specSnapshots } : {}),
		...(unresolvedSpecRefs.length > 0 ? { unresolvedSpecRefs } : {}),
		...(input.specStrict === true ? { specStrict: true } : {}),
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
 * Structured handoff template for task completion reports (U10).
 * Restructured to the 6 PINNED sections of durable's SUMMARIZATION_PROMPT
 * (pi-durable compaction.ts:68-103 — Goal / Constraints & Preferences /
 * Progress (Done·In Progress·Blocked) / Key Decisions / Next Steps /
 * Critical Context), ported per spec U10 so downstream workers and the
 * leader can parse output predictably. The R3-2 `### Provenance` identity
 * footer is retained as the final section — it is an orthogonal pinned
 * contract (worker PI_* self-report, see task-handoff-provenance.test.ts),
 * not one of the 6 content sections.
 */
export const HANDOFF_TEMPLATE = [
	"## Handoff",
	"",
	"### Goal",
	"<!-- One line: the goal this task served, from the Task Packet objective -->",
	"",
	"### Constraints & Preferences",
	"<!-- Constraints that shaped the work: branch/commit policy, file ownership, style, risk tiers -->",
	"",
	"### Progress",
	"<!-- Report the state of the work in three groups, each as bullet lists:",
	"Done: completed items, with file paths",
	"In Progress: items underway when this task ended",
	"Blocked: blockers, with the exact reason and owner -->",
	"",
	"### Key Decisions",
	"<!-- Decisions made and why, with file:line anchors where useful -->",
	"",
	"### Next Steps",
	"<!-- Remaining work, follow-ups, and the recommended next action -->",
	"",
	"### Critical Context",
	"<!-- Verification evidence (commands + outcomes), changed/read files, risks the next worker must know -->",
	"",
	"### Provenance",
	"<!-- Self-report your runtime identity (pre-set in your bash tool env, one line): PI_SESSION_ID, PI_SESSION_FILE, PI_MODEL, PI_PROVIDER, PI_REASONING_LEVEL — e.g. `session=<id> model=<provider>/<model> reasoning=<level>` -->",
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
 *
 * U10 note: targets the LEGACY section names (Summary / Files Changed /
 * Tests / Verification / Follow-ups) for backward compatibility with
 * outputs persisted before the 6-section template; the current
 * HANDOFF_TEMPLATE (Goal / Constraints & Preferences / Progress /
 * Key Decisions / Next Steps / Critical Context) has no dedicated parser
 * yet — see spec U10 follow-ups.
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

/** R3 (adaptive-04, 2026-11-04): render options for the prompt seam.
 * `omitObjective` swaps the packet's `objective` field for a POINTER line —
 * the worker prompt already carries the task body as the canonical `Task:`
 * narrative (prompt-builder.ts taskAndHandoff), and the JSON re-embed
 * duplicated it verbatim (measured ~0.5-1K est-tok/worker, the "task body
 * ×3" finding). Default (no options) keeps the full objective so non-prompt
 * consumers and the direct unit contract (task-handoff-template.test.ts)
 * are unchanged. The substitution is render-only: `TaskPacket` state and
 * `validateTaskPacket` still see the real objective. */
export interface RenderTaskPacketOptions {
	omitObjective?: boolean;
}

const OMITTED_OBJECTIVE_POINTER = "(see the 'Task:' section below — task body rendered once, not re-embedded here)";

export function renderTaskPacket(packet: TaskPacket, options?: RenderTaskPacketOptions): string {
	const body = options?.omitObjective ? { ...packet, objective: OMITTED_OBJECTIVE_POINTER } : packet;
	return ["# Task Packet", "", "```json", JSON.stringify(body, null, 2), "```", ""].join("\n");
}
