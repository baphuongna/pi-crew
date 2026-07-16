// 2.8 — Adaptive plan parsing/repair/injection extracted from team-runner.ts.
//
// This module owns the full lifecycle of the `implementation` workflow's
// adaptive planner output:
//
//   1. Extract the JSON block from the planner's free-form response (between
//      ADAPTIVE_PLAN_JSON_START / ADAPTIVE_PLAN_JSON_END markers, or a code
//      fence).
//   2. Parse it strictly. If strict parsing fails, attempt repair (close
//      truncated brackets, salvage complete phase objects).
//   3. Validate every role against the team's allowed role set; provide
//      common-name aliases (e.g. "developer" -> "executor").
//   4. Inject the resulting plan into the workflow / task graph.
//
// `__test__parseAdaptivePlan` and `__test__repairAdaptivePlan` are re-exported
// from team-runner.ts so existing test imports keep working.
import * as fs from "node:fs";
import { writeArtifact } from "../state/artifact-store.ts";
import { appendEventAsync, appendEventFireAndForget } from "../state/event-log.ts";
import { saveRunManifestAsync } from "../state/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import type { TeamConfig } from "../teams/team-config.ts";
import type { WorkflowConfig, WorkflowStep } from "../workflows/workflow-config.ts";
import { getPlanTemplate, listPlanTemplates, renderPlanTemplate } from "./plan-templates.ts";
import { refreshTaskGraphQueues } from "./task-graph-scheduler.ts";

export interface AdaptivePlanTask {
	role: string;
	title?: string;
	task: string;
}

export interface AdaptivePlanPhase {
	name: string;
	tasks: AdaptivePlanTask[];
}

export interface AdaptivePlan {
	phases: AdaptivePlanPhase[];
}

const MAX_ADAPTIVE_TASKS = 12;

export function slug(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32) || "task"
	);
}

/** Strip surrounding markdown code fences if present. */
function stripCodeFence(raw: string): string {
	let s = raw.trim();
	// Remove opening fence: ```json or ```
	if (s.startsWith("```")) {
		const firstNewline = s.indexOf("\n");
		if (firstNewline >= 0) s = s.slice(firstNewline + 1);
		else s = s.slice(3); // edge case: ``` alone on one line
	}
	// Remove closing fence
	if (s.endsWith("```")) {
		s = s.slice(0, -3);
	}
	return s.trim();
}

export function extractAdaptivePlanJson(text: string): string | undefined {
	const markerMatch = text.match(/ADAPTIVE_PLAN_JSON_START\s*([\s\S]*?)\s*ADAPTIVE_PLAN_JSON_END/);
	if (markerMatch?.[1]) return stripCodeFence(markerMatch[1]);
	const startIndex = text.indexOf("ADAPTIVE_PLAN_JSON_START");
	if (startIndex >= 0) return stripCodeFence(text.slice(startIndex + "ADAPTIVE_PLAN_JSON_START".length));
	const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	return fencedMatch?.[1];
}

export function parseAdaptivePlan(text: string, allowedRoles: string[]): AdaptivePlan | undefined {
	// Check if the text is a plan template reference: "template:<name>" with optional JSON variables
	const templateRefMatch = text.match(/^template:([a-zA-Z0-9_-]+)/);
	if (templateRefMatch?.[1]) {
		const template = getPlanTemplate(templateRefMatch[1]);
		if (template) {
			// Try to extract variables from the remaining text
			let variables: Record<string, string> = {};
			try {
				const varsJson = text.slice(templateRefMatch[0].length).trim();
				if (varsJson) variables = JSON.parse(varsJson);
			} catch {
				/* use empty variables */
			}
			const rendered = renderPlanTemplate(templateRefMatch[1], variables);
			if (rendered) {
				// Convert RenderedPlan → AdaptivePlan
				const phases: AdaptivePlanPhase[] = rendered.phases.map((phase) => ({
					name: phase.name,
					tasks: [{ role: phase.role, task: phase.task }],
				}));
				return phases.length ? { phases } : undefined;
			}
		}
	}

	const raw = extractAdaptivePlanJson(text);
	if (!raw) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const phasesRaw = Array.isArray((parsed as { phases?: unknown }).phases)
		? (parsed as { phases: unknown[] }).phases
		: Array.isArray((parsed as { tasks?: unknown }).tasks)
			? [
					{
						name: "adaptive",
						tasks: (parsed as { tasks: unknown[] }).tasks,
					},
				]
			: undefined;
	if (!phasesRaw) return undefined;
	const allowed = new Set(allowedRoles);
	const phases: AdaptivePlanPhase[] = [];
	let total = 0;
	for (const [phaseIndex, phaseRaw] of phasesRaw.entries()) {
		if (!phaseRaw || typeof phaseRaw !== "object" || Array.isArray(phaseRaw)) return undefined;
		const phaseObj = phaseRaw as { name?: unknown; tasks?: unknown };
		if (!Array.isArray(phaseObj.tasks) || phaseObj.tasks.length === 0) return undefined;
		const tasks: AdaptivePlanTask[] = [];
		for (const taskRaw of phaseObj.tasks) {
			if (!taskRaw || typeof taskRaw !== "object" || Array.isArray(taskRaw)) return undefined;
			const taskObj = taskRaw as {
				role?: unknown;
				title?: unknown;
				task?: unknown;
			};
			if (typeof taskObj.role !== "string" || !allowed.has(taskObj.role)) return undefined;
			if (typeof taskObj.task !== "string" || !taskObj.task.trim()) return undefined;
			if (total >= MAX_ADAPTIVE_TASKS) return undefined;
			tasks.push({
				role: taskObj.role,
				title: typeof taskObj.title === "string" ? taskObj.title : undefined,
				task: taskObj.task.trim(),
			});
			total++;
		}
		phases.push({
			name: typeof phaseObj.name === "string" && phaseObj.name.trim() ? phaseObj.name.trim() : `phase-${phaseIndex + 1}`,
			tasks,
		});
	}
	return phases.length ? { phases } : undefined;
}

interface CloseUnbalancedJsonResult {
	text: string;
	status: "repaired" | "unstable";
	warning?: string;
}

function closeUnbalancedJson(raw: string): CloseUnbalancedJsonResult {
	let result = raw.trim();
	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	for (const char of result) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && inString) {
			escaped = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (char === "{") stack.push("}");
		else if (char === "[") stack.push("]");
		else if ((char === "}" || char === "]") && stack.at(-1) === char) stack.pop();
	}
	while (stack.length) result += stack.pop();
	if (inString) {
		return {
			text: result,
			status: "unstable",
			warning: "JSON string was truncated — values may be incorrect",
		};
	}
	return { text: result, status: "repaired" };
}

function salvageCompletePhaseObjects(raw: string): unknown | undefined {
	const phasesIndex = raw.indexOf('"phases"');
	if (phasesIndex < 0) return undefined;
	const arrayStart = raw.indexOf("[", phasesIndex);
	if (arrayStart < 0) return undefined;
	const phases: unknown[] = [];
	let objectStart = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = arrayStart + 1; index < raw.length; index++) {
		const char = raw[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && inString) {
			escaped = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (char === "{") {
			if (depth === 0) objectStart = index;
			depth++;
			continue;
		}
		if (char === "}") {
			if (depth <= 0) continue;
			depth--;
			if (depth === 0 && objectStart >= 0) {
				try {
					phases.push(JSON.parse(raw.slice(objectStart, index + 1)));
				} catch {
					// Ignore malformed trailing phase objects and keep earlier complete phases.
				}
				objectStart = -1;
			}
		}
	}
	return phases.length ? { phases } : undefined;
}

function adaptiveRoleAlias(role: string, allowed: Set<string>): string | undefined {
	if (allowed.has(role)) return role;
	const normalized = slug(role);
	const aliases: Record<string, string[]> = {
		reviewer: ["code-reviewer", "review", "code-review", "critic"],
		"security-reviewer": ["security", "security-review", "sec-review"],
		"test-engineer": ["tester", "qa", "test"],
		executor: ["developer", "implementer", "coder", "engineer"],
		explorer: ["researcher", "scout"],
		analyst: ["analysis", "analyzer"],
	};
	for (const [target, names] of Object.entries(aliases)) if (allowed.has(target) && names.includes(normalized)) return target;
	return undefined;
}

export function repairAdaptivePlan(text: string, allowedRoles: string[]): { plan?: AdaptivePlan; repaired: boolean; reason?: string } {
	const raw = extractAdaptivePlanJson(text);
	if (!raw) return { repaired: false, reason: "missing-json" };
	const closeResult = closeUnbalancedJson(raw);
	const candidates = [raw, closeResult.text];
	let parsed: unknown;
	let salvageUsed = false;
	for (const candidate of candidates) {
		try {
			parsed = JSON.parse(candidate);
			break;
		} catch {
			// Try the next repair candidate.
		}
	}
	if (!parsed) {
		parsed = salvageCompletePhaseObjects(raw);
		salvageUsed = parsed !== undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { repaired: false, reason: "invalid-json" };
	const phasesRaw = Array.isArray((parsed as { phases?: unknown }).phases)
		? (parsed as { phases: unknown[] }).phases
		: Array.isArray((parsed as { tasks?: unknown }).tasks)
			? [
					{
						name: "adaptive",
						tasks: (parsed as { tasks: unknown[] }).tasks,
					},
				]
			: undefined;
	if (!phasesRaw) return { repaired: false, reason: "missing-phases" };
	const allowed = new Set(allowedRoles);
	const phases: AdaptivePlanPhase[] = [];
	let total = 0;
	let repaired = salvageUsed || raw !== closeResult.text;
	for (const [phaseIndex, phaseRaw] of phasesRaw.entries()) {
		if (!phaseRaw || typeof phaseRaw !== "object" || Array.isArray(phaseRaw)) continue;
		const phaseObj = phaseRaw as { name?: unknown; tasks?: unknown };
		if (!Array.isArray(phaseObj.tasks)) continue;
		const tasks: AdaptivePlanTask[] = [];
		for (const taskRaw of phaseObj.tasks) {
			if (total >= MAX_ADAPTIVE_TASKS) {
				repaired = true;
				break;
			}
			if (!taskRaw || typeof taskRaw !== "object" || Array.isArray(taskRaw)) {
				repaired = true;
				continue;
			}
			const taskObj = taskRaw as {
				role?: unknown;
				title?: unknown;
				task?: unknown;
			};
			const role = typeof taskObj.role === "string" ? adaptiveRoleAlias(taskObj.role, allowed) : undefined;
			const taskText = typeof taskObj.task === "string" ? taskObj.task.trim() : "";
			if (!role || !taskText) {
				repaired = true;
				continue;
			}
			tasks.push({
				role,
				title: typeof taskObj.title === "string" ? taskObj.title : undefined,
				task: taskText,
			});
			total++;
		}
		if (tasks.length)
			phases.push({
				name: typeof phaseObj.name === "string" && phaseObj.name.trim() ? phaseObj.name.trim() : `phase-${phaseIndex + 1}`,
				tasks,
			});
		if (total >= MAX_ADAPTIVE_TASKS) break;
	}
	return phases.length
		? {
				plan: { phases },
				repaired: true,
				reason: repaired ? "repaired" : "normalized",
			}
		: { repaired: false, reason: "empty-plan" };
}

function reconstructAdaptiveWorkflow(workflow: WorkflowConfig, tasks: TeamTaskState[]): WorkflowConfig {
	const existing = new Set(workflow.steps.map((step) => step.id));
	const steps: WorkflowStep[] = [];
	for (const task of tasks) {
		if (!task.stepId?.startsWith("adaptive-") || !task.adaptive?.task || existing.has(task.stepId)) continue;
		steps.push({
			id: task.stepId,
			role: task.role,
			dependsOn: task.graph?.dependencies ?? task.dependsOn,
			parallelGroup: `adaptive-${slug(task.adaptive.phase)}`,
			task: task.adaptive.task,
		});
	}
	return steps.length ? { ...workflow, steps: [...workflow.steps, ...steps] } : workflow;
}

export interface InjectAdaptivePlanInput {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	workflow: WorkflowConfig;
	team: TeamConfig;
}

export interface InjectAdaptivePlanResult {
	tasks: TeamTaskState[];
	workflow: WorkflowConfig;
	injected: boolean;
	missingPlan: boolean;
}

export async function injectAdaptivePlanIfReady(input: InjectAdaptivePlanInput): Promise<InjectAdaptivePlanResult> {
	if (input.workflow.name !== "implementation")
		return {
			tasks: input.tasks,
			workflow: input.workflow,
			injected: false,
			missingPlan: false,
		};
	if (input.tasks.some((task) => task.stepId?.startsWith("adaptive-")))
		return {
			tasks: input.tasks,
			workflow: reconstructAdaptiveWorkflow(input.workflow, input.tasks),
			injected: false,
			missingPlan: false,
		};
	const completedAssess = input.tasks.find(
		(task) => task.stepId === "assess" && (task.status === "completed" || task.status === "needs_attention"),
	);
	if (!completedAssess)
		return {
			tasks: input.tasks,
			workflow: input.workflow,
			injected: false,
			missingPlan: false,
		};
	if (!completedAssess.resultArtifact?.path) {
		appendEventFireAndForget(input.manifest.eventsPath, {
			type: "adaptive.plan_missing",
			runId: input.manifest.runId,
			taskId: completedAssess.id,
			message: "Adaptive planner result artifact is missing.",
		});
		return {
			tasks: input.tasks,
			workflow: input.workflow,
			injected: false,
			missingPlan: true,
		};
	}
	const assessTask = completedAssess;
	const resultPath = completedAssess.resultArtifact.path;
	let text = "";
	try {
		text = fs.readFileSync(resultPath, "utf-8");
	} catch {
		appendEventFireAndForget(input.manifest.eventsPath, {
			type: "adaptive.plan_missing",
			runId: input.manifest.runId,
			taskId: assessTask.id,
			message: "Adaptive planner result artifact could not be read.",
		});
		return {
			tasks: input.tasks,
			workflow: input.workflow,
			injected: false,
			missingPlan: true,
		};
	}
	const allowedRoles = input.team.roles.map((role) => role.name);
	let plan = parseAdaptivePlan(text, allowedRoles);
	if (!plan) {
		const repair =
			process.env.PI_CREW_ADAPTIVE_REPAIR === "0" || process.env.PI_TEAMS_ADAPTIVE_REPAIR === "0"
				? { repaired: false, reason: "disabled" }
				: repairAdaptivePlan(text, allowedRoles);
		if (repair.plan) {
			plan = repair.plan;
			const repairArtifact = writeArtifact(input.manifest.artifactsRoot, {
				kind: "metadata",
				relativePath: "metadata/adaptive-repair.json",
				producer: assessTask.id,
				content: `${JSON.stringify({ reason: repair.reason, phases: repair.plan.phases.map((phase) => ({ name: phase.name, count: phase.tasks.length, roles: phase.tasks.map((task) => task.role) })) }, null, 2)}\n`,
			});
			await saveRunManifestAsync({
				...input.manifest,
				updatedAt: new Date().toISOString(),
				artifacts: [...input.manifest.artifacts, repairArtifact],
			});
			appendEventFireAndForget(input.manifest.eventsPath, {
				type: "adaptive.plan_repaired",
				runId: input.manifest.runId,
				taskId: assessTask.id,
				message: "Adaptive planner output was repaired before dynamic subagents were spawned.",
				data: { reason: repair.reason },
			});
		} else {
			appendEventFireAndForget(input.manifest.eventsPath, {
				type: "adaptive.plan_repair_failed",
				runId: input.manifest.runId,
				taskId: assessTask.id,
				message: "Adaptive planner output could not be repaired.",
				data: { reason: repair.reason },
			});
			appendEventFireAndForget(input.manifest.eventsPath, {
				type: "adaptive.plan_missing",
				runId: input.manifest.runId,
				taskId: assessTask.id,
				message: "Adaptive planner did not produce a valid plan; no dynamic subagents were spawned.",
			});
			return {
				tasks: input.tasks,
				workflow: input.workflow,
				injected: false,
				missingPlan: true,
			};
		}
	}
	const steps: WorkflowStep[] = [];
	const tasks: TeamTaskState[] = [];
	let previousStepIds = ["assess"];
	let counter = 0;
	for (const [phaseIndex, phase] of plan.phases.entries()) {
		const currentStepIds: string[] = [];
		for (const [taskIndex, planned] of phase.tasks.entries()) {
			counter++;
			const stepId = `adaptive-${phaseIndex + 1}-${taskIndex + 1}-${slug(planned.role)}`;
			const taskId = `adaptive-${String(counter).padStart(2, "0")}-${slug(planned.role)}`;
			steps.push({
				id: stepId,
				role: planned.role,
				dependsOn: previousStepIds,
				parallelGroup: `adaptive-${slug(phase.name)}`,
				task: planned.task,
			});
			tasks.push({
				id: taskId,
				runId: input.manifest.runId,
				stepId,
				role: planned.role,
				agent: input.team.roles.find((role) => role.name === planned.role)?.agent ?? planned.role,
				title: planned.title ?? stepId,
				status: "queued",
				dependsOn: previousStepIds,
				cwd: input.manifest.cwd,
				adaptive: { phase: phase.name, task: planned.task },
				graph: {
					taskId,
					dependencies: previousStepIds,
					children: [],
					queue: "blocked",
				},
			});
			currentStepIds.push(stepId);
		}
		previousStepIds = currentStepIds;
	}
	const dependencyTaskIdByStep = new Map<string, string>([
		["assess", assessTask.id],
		...tasks.map((task) => [task.stepId ?? task.id, task.id] as const),
	]);
	const withGraph = tasks.map((task) => ({
		...task,
		dependsOn: task.dependsOn.map((dep) => dependencyTaskIdByStep.get(dep) ?? dep),
		graph: task.graph
			? {
					...task.graph,
					dependencies: task.dependsOn.map((dep) => dependencyTaskIdByStep.get(dep) ?? dep),
					queue: "blocked" as const,
				}
			: task.graph,
	}));
	const allTasks = refreshTaskGraphQueues([...input.tasks, ...withGraph]);
	await appendEventAsync(input.manifest.eventsPath, {
		type: "adaptive.plan_injected",
		runId: input.manifest.runId,
		taskId: assessTask.id,
		message: `Injected ${withGraph.length} adaptive subagent task(s) across ${plan.phases.length} phase(s).`,
		data: {
			phases: plan.phases.map((phase) => ({
				name: phase.name,
				count: phase.tasks.length,
				roles: phase.tasks.map((task) => task.role),
			})),
		},
	});
	return {
		tasks: allTasks,
		workflow: {
			...input.workflow,
			steps: [...input.workflow.steps, ...steps],
		},
		injected: true,
		missingPlan: false,
	};
}

// Test compatibility: original team-runner.ts exposed these names. Keep
// matching exports here; team-runner.ts re-exports them so existing test
// imports (`import { __test__parseAdaptivePlan } from "../../src/runtime/team-runner.ts"`)
// keep working without churn.
export const __test__parseAdaptivePlan = parseAdaptivePlan;
export const __test__repairAdaptivePlan = repairAdaptivePlan;
