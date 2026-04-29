import * as fs from "node:fs";
import * as path from "node:path";
import type { ResourceSource } from "../agents/agent-config.ts";
import { parseCsv, parseFrontmatter } from "../utils/frontmatter.ts";
import { packageRoot, projectCrewRoot, userPiRoot } from "../utils/paths.ts";
import type { WorkflowConfig, WorkflowStep } from "./workflow-config.ts";

export interface WorkflowDiscoveryResult {
	builtin: WorkflowConfig[];
	user: WorkflowConfig[];
	project: WorkflowConfig[];
}

function parseStepSection(id: string, body: string): WorkflowStep | undefined {
	const lines = body.trim().split("\n");
	const config: Record<string, string> = {};
	const taskLines: string[] = [];
	let inTask = false;
	for (const line of lines) {
		if (!inTask) {
			if (line.trim() === "") {
				inTask = true;
				continue;
			}
			const match = line.match(/^([\w-]+):\s*(.*)$/);
			if (match) {
				config[match[1]!.trim()] = match[2]!.trim();
				continue;
			}
			inTask = true;
		}
		taskLines.push(line);
	}
	const role = config.role || id;
	return {
		id,
		role,
		task: taskLines.join("\n").trim() || config.task || "{goal}",
		dependsOn: parseCsv(config.dependsOn),
		parallelGroup: config.parallelGroup || undefined,
		output: config.output === "false" ? false : config.output || undefined,
		reads: config.reads === "false" ? false : parseCsv(config.reads),
		model: config.model || undefined,
		skills: config.skills === "false" ? false : parseCsv(config.skills),
		progress: config.progress === "true" ? true : config.progress === "false" ? false : undefined,
		worktree: config.worktree === "true" ? true : config.worktree === "false" ? false : undefined,
		verify: config.verify === "true" ? true : config.verify === "false" ? false : undefined,
	};
}

const parseOptionalInteger = (value: string | undefined): number | undefined => {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1) return undefined;
	return Math.trunc(parsed);
};

function parseWorkflowFile(filePath: string, source: ResourceSource): WorkflowConfig | undefined {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter(content);
		const name = frontmatter.name?.trim() || path.basename(filePath, ".workflow.md");
		const matches = [...body.matchAll(/^##\s+(.+)[^\S\n]*$/gm)];
		const steps: WorkflowStep[] = [];
		for (let i = 0; i < matches.length; i++) {
			const match = matches[i]!;
			const id = match[1]!.trim();
			const sectionStart = match.index! + match[0].length + (body[match.index! + match[0].length] === "\n" ? 1 : 0);
			const sectionEnd = i + 1 < matches.length ? matches[i + 1]!.index! : body.length;
			const step = parseStepSection(id, body.slice(sectionStart, sectionEnd));
			if (step) steps.push(step);
		}
		return {
			name,
			description: frontmatter.description?.trim() || "No description provided.",
			source,
			filePath,
			maxConcurrency: parseOptionalInteger(frontmatter.maxConcurrency),
			steps,
		};
	} catch {
		return undefined;
	}
}

function readWorkflowDir(dir: string, source: ResourceSource): WorkflowConfig[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter((entry) => entry.endsWith(".workflow.md"))
		.map((entry) => parseWorkflowFile(path.join(dir, entry), source))
		.filter((workflow): workflow is WorkflowConfig => workflow !== undefined)
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function discoverWorkflows(cwd: string): WorkflowDiscoveryResult {
	return {
		builtin: readWorkflowDir(path.join(packageRoot(), "workflows"), "builtin"),
		user: readWorkflowDir(path.join(userPiRoot(), "workflows"), "user"),
		project: readWorkflowDir(path.join(projectCrewRoot(cwd), "workflows"), "project"),
	};
}

export function allWorkflows(discovery: WorkflowDiscoveryResult): WorkflowConfig[] {
	const byName = new Map<string, WorkflowConfig>();
	for (const workflow of [...discovery.builtin, ...discovery.user, ...discovery.project]) {
		byName.set(workflow.name, workflow);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
