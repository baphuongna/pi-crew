/**
 * Plan Orchestrate — Decompose plan documents into agent chain commands.
 *
 * Parses tagged sections from markdown plan documents and builds commands
 * for sequential agent chain execution based on ECC recommendations.
 */

import * as fs from "node:fs";

/**
 * Tag → Agent chain mapping from ECC recommendations.
 */
export const TAG_TO_CHAIN: Record<string, string[]> = {
	design: ["planner", "architect"],
	impl: ["tdd-guide", "lang-reviewer"],
	security: ["security-reviewer", "lang-reviewer"],
	build: ["build-error-resolver"],
	test: ["test-engineer", "verifier"],
	review: ["reviewer"],
} as const;

/**
 * Options for plan orchestration.
 */
export interface OrchestrateOptions {
	/** Path to the plan markdown document. */
	planPath: string;
}

/**
 * A single orchestrated step parsed from a plan section.
 */
export interface OrchestratedStep {
	/** Unique step identifier. */
	stepId: string;
	/** Tag from the parsed section. */
	tag: string;
	/** Agent chain for this step. */
	chain: string[];
	/** Prompt/goal text extracted from the section. */
	prompt: string;
	/** Raw heading text if present. */
	heading?: string;
}

/**
 * Parse tagged sections from a plan markdown document.
 *
 * Expected format:
 * ```markdown
 * # Design Phase
 * <!-- tag: design -->
 * Design the authentication system...
 *
 * # Implementation
 * <!-- tag: impl -->
 * Implement the JWT auth...
 * ```
 *
 * @param planPath - Path to the plan markdown document.
 * @returns Array of OrchestratedStep parsed from the document.
 */
export function parsePlanDocument(planPath: string): OrchestratedStep[] {
	if (!fs.existsSync(planPath)) {
		throw new Error(`Plan document not found: ${planPath}`);
	}

	const content = fs.readFileSync(planPath, "utf-8");
	return parsePlanDocumentContent(content);
}

/**
 * Parse tagged sections from plan content string.
 * This is the core parsing logic used by both parsePlanDocument and parsePlanDocumentSimple.
 */
function parsePlanDocumentContent(content: string): OrchestratedStep[] {
	const steps: OrchestratedStep[] = [];

	// Find all tag matches with their positions
	const tagRegex = /<!--\s*tag:\s*(\w+)\s*-->/g;
	const tagMatches: Array<{ tag: string; start: number; end: number }> = [];

	let match: RegExpExecArray | null;
	while ((match = tagRegex.exec(content)) !== null) {
		tagMatches.push({
			tag: match[1],
			start: match.index,
			end: match.index + match[0].length,
		});
	}

	if (tagMatches.length === 0) {
		return [];
	}

	// For each tag, extract the content before it (to get heading)
	// and the content after it until either another tag or section
	for (let i = 0; i < tagMatches.length; i++) {
		const current = tagMatches[i];
		const nextTagStart = i < tagMatches.length - 1 ? tagMatches[i + 1].start : content.length;

		// Find the heading by looking back from the tag position.
		// Use global regex to find ALL headings in the window, then take the LAST
		// (nearest to the tag) — simple `.match()` only finds the FIRST heading.
		const textBeforeTag = content.slice(
			Math.max(0, current.start - 500),
			current.start,
		);
		const headingRegex = /(^|\n)(#{1,6})\s+(.+?)(\n|$)/g;
		let lastHeadingMatch: RegExpExecArray | null = null;
		let hm: RegExpExecArray | null;
		while ((hm = headingRegex.exec(textBeforeTag)) !== null) {
			lastHeadingMatch = hm;
		}
		const heading = lastHeadingMatch ? lastHeadingMatch[3].trim() : undefined;

		// Get content after the tag until next tag or heading
		// Start from end of tag comment, skip any whitespace/newline
		const afterTagContent = content.slice(current.end);

		// Find the section content: capture until next heading (##) or next tag
		const sectionEndMatch = afterTagContent.search(/(^|\n)(#{1,6}\s|\n<!--\s*tag:)/m);
		const sectionContent =
			sectionEndMatch >= 0
				? afterTagContent.slice(0, sectionEndMatch)
				: afterTagContent;

		// Extract prompt text - remove the tag comment lines and empty lines
		const promptLines: string[] = [];
		const lines = sectionContent.split("\n");
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("<!--")) continue;
			promptLines.push(trimmed);
		}

		const prompt = promptLines.join("\n").trim();
		if (!prompt) continue;

		const chain = TAG_TO_CHAIN[current.tag] ?? [];

		steps.push({
			stepId: `step-${(i + 1).toString().padStart(2, "0")}-${current.tag}`,
			tag: current.tag,
			chain,
			prompt,
			heading,
		});
	}

	return steps;
}

/**
 * Alternative simpler parser for plans that use explicit tag blocks.
 * Actually uses the same core logic as parsePlanDocument.
 *
 * @param planPath - Path to the plan markdown document.
 * @returns Array of OrchestratedStep parsed from the document.
 */
export function parsePlanDocumentSimple(planPath: string): OrchestratedStep[] {
	if (!fs.existsSync(planPath)) {
		throw new Error(`Plan document not found: ${planPath}`);
	}

	const content = fs.readFileSync(planPath, "utf-8");
	const steps = parsePlanDocumentContent(content);

	if (steps.length === 0) {
		// Try implicit detection
		const tag = detectImplicitTag(content);
		if (tag) {
			return [
				{
					stepId: "step-01-unknown",
					tag,
					chain: TAG_TO_CHAIN[tag] ?? [],
					prompt: content.trim(),
				},
			];
		}
	}

	return steps;
}

/**
 * Detect implicit tag from content keywords when no explicit tag is present.
 */
function detectImplicitTag(content: string): string | undefined {
	const lowerContent = content.toLowerCase();
	// Use word-boundary regex to avoid substring false matches.
	// E.g., "implementation" must NOT trigger "impl" — only the word "implement" should.
	const hasWord = (word: string): boolean =>
		new RegExp(`\\b${word}\\b`).test(lowerContent);

	if (hasWord("design") || hasWord("architecture")) return "design";
	if (hasWord("implement") || hasWord("coding")) return "impl";
	if (hasWord("security") || hasWord("audit")) return "security";
	if (hasWord("build") || hasWord("compile")) return "build";
	if (hasWord("test") || hasWord("verify")) return "test";
	if (hasWord("review") || hasWord("feedback")) return "review";
	return undefined;
}

/**
 * Build agent chain command strings from orchestrated steps.
 *
 * @param steps - Array of OrchestratedStep to convert to commands.
 * @returns Array of command strings for execution.
 */
export function buildAgentChain(steps: OrchestratedStep[]): string[] {
	return steps.map((step) => {
		const agentList = step.chain.join(",");
		// Escape single quotes in the goal for shell safety
		const escapedGoal = step.prompt.replace(/'/g, "'\\''");
		return `team action='run' agent='${agentList}' goal='${escapedGoal}'`;
	});
}

/**
 * Build structured chain data (useful for programmatic use).
 *
 * @param steps - Array of OrchestratedStep to convert.
 * @returns Array of chain objects with step data and commands.
 */
export function buildChainData(
	steps: OrchestratedStep[],
): Array<{
	step: OrchestratedStep;
	commands: string[];
}> {
	return steps.map((step) => ({
		step,
		commands: buildAgentChain([step]),
	}));
}

/**
 * Parse and return a formatted overview of the plan.
 *
 * @param planPath - Path to the plan markdown document.
 * @returns Summary string with step count and breakdown by tag.
 */
export function formatPlanOverview(planPath: string): string {
	const steps = parsePlanDocument(planPath);

	if (steps.length === 0) {
		// Try simple parser
		const simpleSteps = parsePlanDocumentSimple(planPath);
		if (simpleSteps.length === 0) {
			return "No tagged sections found in plan document.";
		}
		return formatStepsOverview(simpleSteps);
	}

	return formatStepsOverview(steps);
}

function formatStepsOverview(steps: OrchestratedStep[]): string {
	const lines: string[] = [
		`Plan Orchestration: ${steps.length} step(s)`,
		"",
	];

	const tagCounts: Record<string, number> = {};
	for (const step of steps) {
		tagCounts[step.tag] = (tagCounts[step.tag] ?? 0) + 1;
	}

	lines.push("Summary by tag:");
	for (const [tag, count] of Object.entries(tagCounts)) {
		const chain = TAG_TO_CHAIN[tag]?.join(", ") ?? "(unknown)";
		lines.push(`  - ${tag}: ${count} step(s) → agents: ${chain}`);
	}

	lines.push("", "Steps:");
	for (const step of steps) {
		const preview =
			step.prompt.length > 60
				? step.prompt.slice(0, 60) + "..."
				: step.prompt;
		// Include heading if available (e.g., "Security Review" from the plan's heading)
		const headingPrefix = step.heading ? `${step.heading}: ` : "";
		lines.push(
			`  ${step.stepId} [${step.tag}] ${step.chain.join(",")}: ${headingPrefix}${preview}`,
		);
	}

	return lines.join("\n");
}

/**
 * Main orchestration function that parses a plan and returns pre-formatted output.
 */
export async function orchestratePlan(
	options: OrchestrateOptions,
): Promise<{
	steps: OrchestratedStep[];
	chain: string[];
	overview: string;
}> {
	const { planPath } = options;

	// Try primary parser first
	let steps = parsePlanDocument(planPath);

	// Fall back to simple parser if no results
	if (steps.length === 0) {
		steps = parsePlanDocumentSimple(planPath);
	}

	if (steps.length === 0) {
		throw new Error(`No tagged sections found in plan document: ${planPath}`);
	}

	const chain = buildAgentChain(steps);
	const overview = formatPlanOverview(planPath);

	return { steps, chain, overview };
}
