/**
 * Structured planning engine — template-based plan generation with verification.
 *
 * Pattern origin: plannotator/ — plan templates with task decomposition,
 * verification constraints, and pre-execution plan verification.
 *
 * Templates provide reusable plan structures that can be specialized
 * for different project types, replacing pure LLM-generated plans with
 * deterministic scaffolding + LLM refinement.
 */

import { logInternalError } from "../utils/internal-error.ts";

// ── Types ────────────────────────────────────────────────────────────────

export interface PlanTemplate {
	/** Template name (e.g., "standard-review", "full-implementation") */
	name: string;
	/** One-line description */
	description: string;
	/** Template phases */
	phases: PlanPhase[];
	/** Verification commands per phase (phaseName → command) */
	verificationCommands: Record<string, string>;
}

export interface PlanPhase {
	/** Phase name (e.g., "explore", "plan", "execute", "verify") */
	name: string;
	/** Agent role for this phase */
	role: string;
	/** Task description template — {{variables}} are substituted */
	taskTemplate: string;
	/** Maximum number of tasks in this phase */
	maxTasks: number;
	/** Dependencies on other phases */
	dependsOn: string[];
	/** Optional verification command */
	verificationCommand?: string;
}

export interface RenderedPlan {
	templateName: string;
	phases: RenderedPhase[];
	variables: Record<string, string>;
}

export interface RenderedPhase {
	name: string;
	role: string;
	task: string;
	dependsOn: string[];
	verificationCommand?: string;
}

// ── Template Registry ────────────────────────────────────────────────────

const templates = new Map<string, PlanTemplate>();

/**
 * Register a plan template.
 */
export function registerPlanTemplate(template: PlanTemplate): void {
	templates.set(template.name, template);
}

/**
 * Get a registered template by name.
 */
export function getPlanTemplate(name: string): PlanTemplate | undefined {
	return templates.get(name);
}

/**
 * List all registered template names.
 */
export function listPlanTemplates(): string[] {
	return [...templates.keys()];
}

// ── Rendering ────────────────────────────────────────────────────────────

/**
 * Render a plan template with variable substitution.
 *
 * Variables in task templates use {{variableName}} syntax.
 *
 * @param templateName - Name of the registered template
 * @param variables - Key-value pairs for substitution
 * @returns Rendered plan, or undefined if template not found
 */
export function renderPlanTemplate(
	templateName: string,
	variables: Record<string, string>,
): RenderedPlan | undefined {
	const template = templates.get(templateName);
	if (!template) {
		logInternalError("plan-templates", new Error(`Template not found: ${templateName}`));
		return undefined;
	}

	const phases: RenderedPhase[] = template.phases.map((phase) => ({
		name: phase.name,
		role: phase.role,
		task: substituteVariables(phase.taskTemplate, variables),
		dependsOn: phase.dependsOn,
		verificationCommand: phase.verificationCommand ?? template.verificationCommands[phase.name],
	}));

	return { templateName, phases, variables };
}

/**
 * Substitute {{variable}} placeholders in a template string.
 */
function substituteVariables(template: string, variables: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
		return variables[key] ?? match;
	});
}

// ── Built-in Templates ───────────────────────────────────────────────────

registerPlanTemplate({
	name: "standard-review",
	description: "Standard code review workflow: explore → review → verify",
	phases: [
		{
			name: "explore",
			role: "explorer",
			taskTemplate: "Map the codebase and identify the key files related to: {{goal}}. Focus on: {{focusAreas}}.",
			maxTasks: 1,
			dependsOn: [],
		},
		{
			name: "review",
			role: "reviewer",
			taskTemplate: "Review the code identified in the explore phase for: {{goal}}. Check correctness, maintainability, and security.",
			maxTasks: 1,
			dependsOn: ["explore"],
		},
		{
			name: "verify",
			role: "verifier",
			taskTemplate: "Verify that all review findings are addressed. Run tests if applicable. Confirm: {{goal}} is achieved.",
			maxTasks: 1,
			dependsOn: ["review"],
			verificationCommand: "npm test",
		},
	],
	verificationCommands: {
		verify: "npm test",
	},
});

registerPlanTemplate({
	name: "full-implementation",
	description: "Full implementation workflow: explore → plan → execute → review → verify",
	phases: [
		{
			name: "explore",
			role: "explorer",
			taskTemplate: "Explore the codebase to understand the current state relevant to: {{goal}}. Identify affected files and patterns.",
			maxTasks: 1,
			dependsOn: [],
		},
		{
			name: "plan",
			role: "planner",
			taskTemplate: "Create a detailed implementation plan for: {{goal}}. Break down into concrete steps with file-level changes.",
			maxTasks: 1,
			dependsOn: ["explore"],
		},
		{
			name: "execute",
			role: "executor",
			taskTemplate: "Implement the plan for: {{goal}}. Make all planned changes, write tests, and ensure TypeScript compiles.",
			maxTasks: 3,
			dependsOn: ["plan"],
		},
		{
			name: "review",
			role: "reviewer",
			taskTemplate: "Review the implementation of: {{goal}}. Check for correctness, security, performance, and code quality.",
			maxTasks: 1,
			dependsOn: ["execute"],
		},
		{
			name: "verify",
			role: "verifier",
			taskTemplate: "Verify the complete implementation of: {{goal}}. Run tests, check types, validate all acceptance criteria.",
			maxTasks: 1,
			dependsOn: ["review"],
			verificationCommand: "npm test && npx tsc --noEmit",
		},
	],
	verificationCommands: {
		verify: "npm test && npx tsc --noEmit",
	},
});
