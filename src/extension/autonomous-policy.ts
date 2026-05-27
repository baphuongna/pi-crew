import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { effectiveAutonomousConfig, loadConfig, type PiTeamsAutonomousConfig } from "../config/config.ts";
import { allAgents, discoverAgents } from "../agents/discover-agents.ts";
import { allTeams, discoverTeams } from "../teams/discover-teams.ts";
import { allWorkflows, discoverWorkflows } from "../workflows/discover-workflows.ts";

const DEFAULT_MAGIC_KEYWORDS: Record<string, string[]> = {
	implementation: ["autoteam", "team:", "implementation-team", "pi-crew", "dùng team", "use team"],
	review: ["review-team", "security review", "code review"],
	fastFix: ["fast-fix", "quick fix"],
	research: ["research-team", "deep research"],
};

const BULLET_OR_NUMBERED_TASK_RE = /^\s*(?:[-*•]|\d+[.)])\s+\S+/;
const ACTIONABLE_TASK_TERMS: readonly string[] = Array.from(new Set([
	"implement",
	"refactor",
	"migrate",
	"fix",
	"add",
	"update",
	"test",
	"review",
	"research",
	"analyze",
	"document",
	"docs",
	"sửa",
	"thêm",
	"cập nhật",
	"kiểm thử",
	"nghiên cứu",
	"phân tích",
	"viết docs",
]));

function mergeMagicKeywords(configured: Record<string, string[]> | undefined): Record<string, string[]> {
	return { ...DEFAULT_MAGIC_KEYWORDS, ...(configured ?? {}) };
}

function actionableLineCount(prompt: string): number {
	return prompt
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => BULLET_OR_NUMBERED_TASK_RE.test(line) && ACTIONABLE_TASK_TERMS.some((term) => line.toLowerCase().includes(term)))
		.length;
}

function hasTaskListSignal(prompt: string): boolean {
	const lower = prompt.toLowerCase();
	const bulletCount = prompt.split(/\r?\n/).filter((line) => BULLET_OR_NUMBERED_TASK_RE.test(line)).length;
	const explicitList = ["các task", "danh sách task", "todo", "tasks sau", "task list", "làm lần lượt"].some((term) => lower.includes(term));
	return bulletCount >= 3 || actionableLineCount(prompt) >= 2 || (explicitList && bulletCount >= 2);
}

export function detectTeamIntent(prompt: string, config: PiTeamsAutonomousConfig = {}): string[] {
	const lower = prompt.toLowerCase();
	const matches: string[] = [];
	for (const [intent, keywords] of Object.entries(mergeMagicKeywords(config.magicKeywords))) {
		if (keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) matches.push(intent);
	}
	if (hasTaskListSignal(prompt) && !matches.includes("taskList")) matches.push("taskList");
	return matches;
}

export function buildAutonomousPolicy(prompt: string, config: PiTeamsAutonomousConfig = {}): string {
	const effective = effectiveAutonomousConfig(config);
	const intents = detectTeamIntent(prompt, config);
	const asyncGuidance = effective.preferAsyncForLongTasks
		? "For long-running team runs, prefer async: true unless the user needs immediate foreground progress."
		: "Use async: true only when the task is clearly long-running or the user asks for background execution.";
	const worktreeGuidance = effective.allowWorktreeSuggestion === false
		? "Do not suggest worktree mode unless the user explicitly asks for it."
		: "Consider workspaceMode: 'worktree' for parallel or risky code-changing work in clean git repositories.";
	return [
		"# pi-crew Delegation Policy (MANDATORY)",
		"",
		`Autonomy profile: ${effective.profile}.`,
		"You MUST evaluate EVERY user request against the delegation decision table below BEFORE acting.",
		"",
		"## Decision Table — Do I delegate?",
		"",
		"| Task characteristic | Delegate? | Method |",
		"|---|---|---|",
		"| Read/edit 1-2 files, simple question | NO | Do it directly |",
		"| User explicitly says \"do it yourself\" / \"no team\" | NO | Do it directly |",
		"| Destructive action (delete/prune/forget) | NO | Ask for confirmation first |",
		"| Research / deep-read / source audit / \"nghiên cứu\" | YES | `team action='research'` |",
		"| Multi-file implementation / feature / refactor | YES | `team action='run', team='implementation'` |",
		"| Small bug fix (1-2 files, clear cause) | YES | `team action='run', team='fast-fix'` |",
		"| Code review / security review | YES | `team action='run', team='review'` |",
		"| Task list with 2+ actionable items | YES | `team action='plan'` or `action='run'` |",
		"| Need exploration before knowing scope | YES | `Agent(explorer)` or `team action='recommend'` |",
		"| Parallel independent subtasks | YES | `team action='parallel'` or multiple `Agent` background |",
		"| Unsure which team/workflow fits | YES | `team action='recommend'` first |",
		"",
		"## Rules",
		"",
		"1. If the task needs reading >3 files OR editing >2 files OR has a research/review/planning component → you MUST delegate via `team` or `Agent`. Do not do it yourself.",
		"2. After delegating, do NOT duplicate the same exploration/reading/review manually. Continue only with non-overlapping work.",
		"3. Before claiming delegated work is complete, verify with `team action='status'` or `action='summary'`.",
		"4. If unsure whether subtasks conflict, use `team action='recommend'` first.",
		"5. For parallel implementation, prefer `workspaceMode: 'worktree'` in clean git repos.",
		"",
		"## Conflict-safe task splitting",
		"- Do not parallelize subtasks that may edit the same file, same symbol, or same lockfile.",
		"- Assign one owner per file/symbol. Workers must report intended changed files before editing.",
		"- If workers discover overlap, they must pause and ask the leader to resolve.",
		"",
		asyncGuidance,
		worktreeGuidance,
		intents.length > 0 ? `Detected pi-crew routing signals/intents in the user prompt: ${intents.join(", ")}. Consider the matching team workflow if appropriate.` : "No explicit pi-crew routing signal was detected; decide based on complexity, risk, task-list structure, and conflict potential.",
	].join("\n");
}

function sourcePriority(source: string): number {
	if (source === "project") return 0;
	if (source === "user" || source === "git") return 1;
	return 2;
}

function capLines(lines: string[], maxChars: number): string[] {
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		const next = used + line.length + 1;
		if (next > maxChars) {
			kept.push("- ...resource guidance truncated to stay within prompt budget");
			break;
		}
		kept.push(line);
		used = next;
	}
	return kept;
}

export function buildResourceRoutingGuidance(cwd: string, maxChars = 5000): string {
	const teams = allTeams(discoverTeams(cwd)).sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source)).slice(0, 12);
	const workflows = allWorkflows(discoverWorkflows(cwd)).sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source)).slice(0, 12);
	const agents = allAgents(discoverAgents(cwd)).sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source)).slice(0, 16);
	const lines = [
		"# pi-crew Available Resources",
		"Use project-scoped resources over user/builtin resources when names overlap.",
		"Teams:",
		...(teams.length ? teams.map((team) => `- ${team.name} (${team.source}): ${team.description}; defaultWorkflow=${team.defaultWorkflow ?? "default"}; roles=${team.roles.map((role) => `${role.name}->${role.agent}`).join(", ") || "none"}${team.routing?.triggers?.length ? `; triggers=${team.routing.triggers.join(",")}` : ""}${team.routing?.useWhen?.length ? `; useWhen=${team.routing.useWhen.join(";")}` : ""}`) : ["- (none)"]),
		"Workflows:",
		...(workflows.length ? workflows.map((workflow) => `- ${workflow.name} (${workflow.source}): ${workflow.description}; steps=${workflow.steps.map((step) => `${step.id}:${step.role}`).join(", ") || "none"}`) : ["- (none)"]),
		"Agents:",
		...(agents.length ? agents.map((agent) => `- ${agent.name} (${agent.source}): ${agent.description}${agent.routing?.triggers?.length ? `; triggers=${agent.routing.triggers.join(",")}` : ""}${agent.routing?.useWhen?.length ? `; useWhen=${agent.routing.useWhen.join(";")}` : ""}${agent.routing?.avoidWhen?.length ? `; avoidWhen=${agent.routing.avoidWhen.join(";")}` : ""}${agent.routing?.cost ? `; cost=${agent.routing.cost}` : ""}${agent.routing?.category ? `; category=${agent.routing.category}` : ""}`) : ["- (none)"]),
	];
	return capLines(lines, maxChars).join("\n");
}

export function appendAutonomousPolicy(systemPrompt: string, userPrompt: string, config: PiTeamsAutonomousConfig = {}, cwd?: string): string {
	const resourceGuidance = cwd ? `\n\n${buildResourceRoutingGuidance(cwd)}` : "";
	return `${systemPrompt}\n\n${buildAutonomousPolicy(userPrompt, config)}${resourceGuidance}`;
}

export function registerAutonomousPolicy(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
		const options = (event as BeforeAgentStartEvent & { systemPromptOptions?: { cwd?: unknown } }).systemPromptOptions ?? {};
		const cwd = typeof options.cwd === "string" ? options.cwd : undefined;
		const loaded = loadConfig(cwd);
		const autonomous = effectiveAutonomousConfig(loaded.config.autonomous);
		if (!autonomous.enabled) return undefined;
		if (!autonomous.injectPolicy) return undefined;
		return { systemPrompt: appendAutonomousPolicy(event.systemPrompt, event.prompt, autonomous, cwd) };
	});
}
