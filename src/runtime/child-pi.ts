import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agent-config.ts";
import { buildPiWorkerArgs, cleanupTempDir } from "./pi-args.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";

export interface ChildPiRunInput {
	cwd: string;
	task: string;
	agent: AgentConfig;
	model?: string;
	signal?: AbortSignal;
	transcriptPath?: string;
	onStdoutLine?: (line: string) => void;
	onJsonEvent?: (event: unknown) => void;
}

export interface ChildPiRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	error?: string;
}

function appendTranscript(input: ChildPiRunInput, line: string): void {
	if (!input.transcriptPath) return;
	fs.mkdirSync(path.dirname(input.transcriptPath), { recursive: true });
	fs.appendFileSync(input.transcriptPath, `${line}\n`, "utf-8");
}

function observeStdoutChunk(input: ChildPiRunInput, text: string): void {
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		appendTranscript(input, line);
		input.onStdoutLine?.(line);
		try {
			input.onJsonEvent?.(JSON.parse(line));
		} catch {
			// Raw stdout is allowed.
		}
	}
}

export async function runChildPi(input: ChildPiRunInput): Promise<ChildPiRunResult> {
	const mock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	if (mock) {
		if (mock === "success") {
			const stdout = `Mock child Pi success for ${input.agent.name}\n`;
			observeStdoutChunk(input, stdout);
			return { exitCode: 0, stdout, stderr: "" };
		}
		if (mock === "json-success") {
			const stdout = `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `Mock JSON success for ${input.agent.name}` }] } })}\n${JSON.stringify({ type: "message_end", usage: { input: 10, output: 5, cost: 0.001, turns: 1 } })}\n`;
			observeStdoutChunk(input, stdout);
			return { exitCode: 0, stdout, stderr: "" };
		}
		if (mock === "retryable-failure") return { exitCode: 1, stdout: "", stderr: "rate limit: mock failure" };
		return { exitCode: 1, stdout: "", stderr: `mock failure: ${mock}` };
	}
	const built = buildPiWorkerArgs({ task: input.task, agent: input.agent, model: input.model, sessionEnabled: false });
	const spawnSpec = getPiSpawnCommand(built.args);
	try {
		return await new Promise<ChildPiRunResult>((resolve) => {
			const child = spawn(spawnSpec.command, spawnSpec.args, {
				cwd: input.cwd,
				env: { ...process.env, ...built.env },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			let settled = false;

			const settle = (result: ChildPiRunResult): void => {
				if (settled) return;
				settled = true;
				cleanupTempDir(built.tempDir);
				resolve(result);
			};

			const abort = (): void => {
				try {
					child.kill(process.platform === "win32" ? undefined : "SIGTERM");
				} catch {
					// Ignore kill races.
				}
			};

			input.signal?.addEventListener("abort", abort, { once: true });
			child.stdout?.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf-8");
				stdout += text;
				observeStdoutChunk(input, text);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf-8");
			});
			child.on("error", (error) => {
				settle({ exitCode: null, stdout, stderr, error: error.message });
			});
			child.on("close", (exitCode) => {
				input.signal?.removeEventListener("abort", abort);
				settle({ exitCode, stdout, stderr });
			});
		});
	} finally {
		cleanupTempDir(built.tempDir);
	}
}
