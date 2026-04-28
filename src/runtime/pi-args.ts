import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../agents/agent-config.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const PROMPT_RUNTIME_EXTENSION_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prompt", "prompt-runtime.ts");
const TASK_ARG_LIMIT = 8000;
const DEFAULT_MAX_CREW_DEPTH = 2;

export interface BuildPiWorkerArgsInput {
	task: string;
	agent: AgentConfig;
	model?: string;
	sessionEnabled?: boolean;
	maxDepth?: number;
	env?: NodeJS.ProcessEnv;
}

export interface BuildPiWorkerArgsResult {
	args: string[];
	env: Record<string, string | undefined>;
	tempDir?: string;
}

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model;
	return `${model}:${thinking}`;
}

export function currentCrewDepth(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_CREW_DEPTH ?? env.PI_TEAMS_DEPTH ?? "0";
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function resolveCrewMaxDepth(inputMaxDepth?: number, env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_CREW_MAX_DEPTH ?? env.PI_TEAMS_MAX_DEPTH;
	const envDepth = raw !== undefined ? Number(raw) : NaN;
	if (Number.isInteger(envDepth) && envDepth >= 0) return envDepth;
	return Number.isInteger(inputMaxDepth) && inputMaxDepth !== undefined && inputMaxDepth >= 0 ? inputMaxDepth : DEFAULT_MAX_CREW_DEPTH;
}

export function checkCrewDepth(inputMaxDepth?: number, env: NodeJS.ProcessEnv = process.env): { blocked: boolean; depth: number; maxDepth: number } {
	const depth = currentCrewDepth(env);
	const maxDepth = resolveCrewMaxDepth(inputMaxDepth, env);
	return { depth, maxDepth, blocked: depth >= maxDepth };
}

export function buildPiWorkerArgs(input: BuildPiWorkerArgsInput): BuildPiWorkerArgsResult {
	const args = ["--mode", "json", "-p"];
	if (input.sessionEnabled === false) args.push("--no-session");

	const model = applyThinkingSuffix(input.model ?? input.agent.model, input.agent.thinking);
	if (model) args.push("--model", model);

	if (input.agent.tools?.length) args.push("--tools", input.agent.tools.join(","));
	if (input.agent.extensions !== undefined) {
		args.push("--no-extensions");
		for (const extension of [PROMPT_RUNTIME_EXTENSION_PATH, ...input.agent.extensions]) args.push("--extension", extension);
	} else {
		args.push("--extension", PROMPT_RUNTIME_EXTENSION_PATH);
	}
	if (!input.agent.inheritSkills) args.push("--no-skills");

	let tempDir: string | undefined;
	if (input.agent.systemPrompt) {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-"));
		const promptPath = path.join(tempDir, `${input.agent.name.replace(/[^\w.-]/g, "_")}.md`);
		fs.writeFileSync(promptPath, input.agent.systemPrompt, { mode: 0o600 });
		args.push(input.agent.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt", promptPath);
	}

	if (input.task.length > TASK_ARG_LIMIT) {
		if (!tempDir) tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-"));
		const taskPath = path.join(tempDir, "task.md");
		fs.writeFileSync(taskPath, input.task, { mode: 0o600 });
		args.push(`@${taskPath}`);
	} else {
		args.push(`Task: ${input.task}`);
	}

	const env = input.env ?? process.env;
	const parentDepth = currentCrewDepth(env);
	const maxDepth = resolveCrewMaxDepth(input.maxDepth, env);
	return {
		args,
		env: {
			PI_CREW_INHERIT_PROJECT_CONTEXT: input.agent.inheritProjectContext ? "1" : "0",
			PI_CREW_INHERIT_SKILLS: input.agent.inheritSkills ? "1" : "0",
			PI_CREW_DEPTH: String(parentDepth + 1),
			PI_CREW_MAX_DEPTH: String(maxDepth),
			PI_CREW_ROLE: input.agent.name,
			PI_TEAMS_INHERIT_PROJECT_CONTEXT: input.agent.inheritProjectContext ? "1" : "0",
			PI_TEAMS_INHERIT_SKILLS: input.agent.inheritSkills ? "1" : "0",
			PI_TEAMS_DEPTH: String(parentDepth + 1),
			PI_TEAMS_MAX_DEPTH: String(maxDepth),
			PI_TEAMS_ROLE: input.agent.name,
		},
		tempDir,
	};
}

export function cleanupTempDir(tempDir: string | undefined): void {
	if (!tempDir) return;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Best effort.
	}
}
