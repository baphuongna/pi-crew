import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../agents/agent-config.ts";
import { getAgentSessionOptions } from "../agents/agent-config.ts";

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
	skillPaths?: string[];
	env?: NodeJS.ProcessEnv;
	/** Role for tool restrictions (uses role-tools.ts config) */
	role?: string;
}

export interface BuildPiWorkerArgsResult {
	args: string[];
	env: Record<string, string | undefined>;
	tempDir?: string;
}

function isValidThinkingLevel(value: string | undefined): value is string {
	return value !== undefined && THINKING_LEVELS.includes(value);
}

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && isValidThinkingLevel(model.substring(colonIdx + 1))) return model;
	// Invalid config values fall back to Pi's default thinking behavior.
	if (!isValidThinkingLevel(thinking)) return model;
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
	if (Number.isInteger(envDepth) && envDepth >= 1 && envDepth <= 10) return envDepth;
	if (Number.isInteger(inputMaxDepth) && inputMaxDepth !== undefined && inputMaxDepth >= 1 && inputMaxDepth <= 10) return inputMaxDepth;
	return DEFAULT_MAX_CREW_DEPTH;
}

export function checkCrewDepth(inputMaxDepth?: number, env: NodeJS.ProcessEnv = process.env): { blocked: boolean; depth: number; maxDepth: number } {
	const depth = currentCrewDepth(env);
	const maxDepth = resolveCrewMaxDepth(inputMaxDepth, env);
	return { depth, maxDepth, blocked: depth >= maxDepth };
}

/**
 * Create a safe temp directory with symlink protection.
 *
 * macOS commonly exposes `/tmp` as a symlink to `/private/tmp`. Refusing every
 * symlinked temp base breaks otherwise-safe child workers. Resolve the base to
 * its canonical directory before creation, then verify the created directory is
 * not itself a symlink and remains contained by the canonical base.
 */
function createSafeTempDir(base: string, prefix: string): string {
	if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
	const resolvedBase = fs.realpathSync(base);
	const rawTempDir = fs.mkdtempSync(path.join(resolvedBase, prefix));
	try {
		const stat = fs.lstatSync(rawTempDir);
		if (stat.isSymbolicLink()) throw new Error("temp dir is a symlink");
		const realTempDir = fs.realpathSync(rawTempDir);
		const relative = path.relative(resolvedBase, realTempDir);
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error("temp dir escapes resolved base");
		}
		return realTempDir;
	} catch (e) {
		fs.rmSync(rawTempDir, { recursive: true, force: true });
		if (e instanceof Error && e.message.includes("symlink")) {
			throw new Error("Refusing to use symlinked temp directory.");
		}
		throw e;
	}
}

export function buildPiWorkerArgs(input: BuildPiWorkerArgsInput): BuildPiWorkerArgsResult {
	const args = ["--mode", "json", "-p"];
	if (input.sessionEnabled === false) args.push("--no-session");

	const resolvedModel = input.model ?? input.agent.model;
	if (resolvedModel) {
		const modelWithThinking = applyThinkingSuffix(resolvedModel, input.agent.thinking);
		if (modelWithThinking) args.push("--model", modelWithThinking);
	}
	// When no model resolved, pass thinking separately so Pi can apply it to the inherited parent model.
	if (!resolvedModel && input.agent.thinking && input.agent.thinking !== "off" && isValidThinkingLevel(input.agent.thinking)) {
		args.push("--thinking", input.agent.thinking);
	}

	// Apply role-based tool restrictions (from role-tools.ts)
	// Role-specific config takes precedence over agent-defined tools
	const toolConfig = input.role ? getAgentSessionOptions(input.role) : {};
	const explicitTools = toolConfig.tools ?? input.agent.tools;
	const excludeTools = toolConfig.excludeTools;

	if (explicitTools?.length) args.push("--tools", explicitTools.join(","));
	if (excludeTools?.length) args.push("--exclude-tools", excludeTools.join(","));
	// Always add --no-extensions before --extension to prevent user extensions from being auto-loaded.
	// User extensions in ~/.pi/agent/extensions/ may fail due to missing dependencies.
	args.push("--no-extensions");
	if (input.agent.extensions !== undefined) {
		for (const extension of [PROMPT_RUNTIME_EXTENSION_PATH, ...input.agent.extensions]) args.push("--extension", extension);
	} else {
		args.push("--extension", PROMPT_RUNTIME_EXTENSION_PATH);
	}
	if (!input.agent.inheritSkills) args.push("--no-skills");
	for (const skillPath of input.skillPaths ?? []) args.push("--skill", skillPath);

	let tempDir: string | undefined;
	if (input.agent.systemPrompt) {
		// On Windows, prefer a subdirectory within the user's profile over system temp
		const tmpBase = process.platform === "win32" && os.homedir()
			? path.join(os.homedir(), ".pi-crew", "tmp")
			: os.tmpdir();
		tempDir = createSafeTempDir(tmpBase, `pi-crew-${process.pid}-`);
		const promptPath = path.join(tempDir, `${input.agent.name.replace(/[^\w.-]/g, "_")}.md`);
		fs.writeFileSync(promptPath, input.agent.systemPrompt, { mode: 0o600 });
		args.push(input.agent.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt", promptPath);
	}

	if (input.task.length > TASK_ARG_LIMIT) {
		if (!tempDir) {
			const tmpBase = process.platform === "win32" && os.homedir()
				? path.join(os.homedir(), ".pi-crew", "tmp")
				: os.tmpdir();
			tempDir = createSafeTempDir(tmpBase, `pi-crew-${process.pid}-`);
		}
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
