import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";

export const PI_TEAMS_INHERIT_PROJECT_CONTEXT_ENV = "PI_TEAMS_INHERIT_PROJECT_CONTEXT";
export const PI_TEAMS_INHERIT_SKILLS_ENV = "PI_TEAMS_INHERIT_SKILLS";
export const PI_CREW_INHERIT_PROJECT_CONTEXT_ENV = "PI_CREW_INHERIT_PROJECT_CONTEXT";
export const PI_CREW_INHERIT_SKILLS_ENV = "PI_CREW_INHERIT_SKILLS";
const PI_CREW_MAX_OUTPUT_TOKENS_ENV = "PI_CREW_MAX_OUTPUT_TOKENS";
const PI_CREW_STEERING_FILE_ENV = "PI_CREW_STEERING_FILE";

const PROJECT_CONTEXT_HEADER = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
const SKILLS_HEADER = "\n\nThe following skills provide specialized instructions for specific tasks.";
const DATE_HEADER = "\nCurrent date:";

function readBooleanEnv(name: string): boolean | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
	if (normalized === "0" || normalized === "false" || normalized === "no") return false;
	// Ambiguous value — treat as undefined so callers apply their default.
	return undefined;
}

function readBooleanEnvAny(...names: string[]): boolean | undefined {
	for (const name of names) {
		const value = readBooleanEnv(name);
		if (value !== undefined) return value;
	}
	return undefined;
}

function findSectionEnd(prompt: string, startIndex: number, nextHeaders: string[]): number {
	let endIndex = prompt.length;
	for (const header of nextHeaders) {
		const index = prompt.indexOf(header, startIndex);
		if (index !== -1 && index < endIndex) endIndex = index;
	}
	return endIndex;
}

export function stripProjectContext(prompt: string): string {
	const startIndex = prompt.indexOf(PROJECT_CONTEXT_HEADER);
	if (startIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, startIndex + PROJECT_CONTEXT_HEADER.length, [SKILLS_HEADER, DATE_HEADER]);
	return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function stripInheritedSkills(prompt: string): string {
	const startIndex = prompt.indexOf(SKILLS_HEADER);
	if (startIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, startIndex + SKILLS_HEADER.length, [DATE_HEADER]);
	return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function rewriteTeamWorkerPrompt(prompt: string, options: { inheritProjectContext: boolean; inheritSkills: boolean }): string {
	let rewritten = prompt;
	if (!options.inheritProjectContext) rewritten = stripProjectContext(rewritten);
	if (!options.inheritSkills) rewritten = stripInheritedSkills(rewritten);
	return rewritten;
}

export default function registerPiTeamsPromptRuntime(pi: ExtensionAPI): void {
	// ── Feature 1: maxTokens cap ──────────────────────────────────────────
	// Cap output tokens per API call for background workers. Reads
	// PI_CREW_MAX_OUTPUT_TOKENS env (set by pi-args.ts from agent.maxTokens).
	const maxTokensEnv = process.env[PI_CREW_MAX_OUTPUT_TOKENS_ENV];
	const maxTokensCap = maxTokensEnv ? Number.parseInt(maxTokensEnv, 10) : undefined;
	if (maxTokensCap && maxTokensCap > 0) {
		pi.on("before_provider_request", (event) => {
			const payload = event.payload as Record<string, unknown> | undefined;
			if (!payload || typeof payload !== "object") return;
			// Cap both OpenAI-style max_tokens and Anthropic-style max_tokens
			if (typeof payload.max_tokens === "number" && payload.max_tokens > maxTokensCap) {
				payload.max_tokens = maxTokensCap;
			}
		});
	}

	// ── Feature 2: real-time steering ──────────────────────────────────────
	// Poll the steering JSONL file for new steer messages. The parent (team
	// tool) writes steers here in real-time; this reader injects them into
	// the active session via pi.sendMessage with deliverAs:"steer".
	const steeringFile = process.env[PI_CREW_STEERING_FILE_ENV];
	if (steeringFile) {
		let lastOffset = 0;
		const pollSteering = (): void => {
			try {
				const stat = fs.statSync(steeringFile, { throwIfNoEntry: false });
				if (!stat || stat.size <= lastOffset) return;
				const fd = fs.openSync(steeringFile, "r");
				try {
					const buf = Buffer.alloc(stat.size - lastOffset);
					fs.readSync(fd, buf, 0, buf.length, lastOffset);
					lastOffset = stat.size;
					const lines = buf.toString("utf8").split("\n").filter(Boolean);
					for (const line of lines) {
						try {
							const entry = JSON.parse(line) as { type?: string; message?: string };
							if (entry.type === "steer" && entry.message) {
								pi.sendMessage({ customType: "crew-steer", content: entry.message, display: false }, { deliverAs: "steer" });
							}
						} catch {
							// Malformed line — skip
						}
					}
				} finally {
					try { fs.closeSync(fd); } catch { /* already closed */ }
				}
			} catch {
				// File doesn't exist yet or read error — will retry next tick
			}
		};
		const timer = setInterval(pollSteering, 500);
		timer.unref?.();
	}

	// ── Prompt rewriting (existing) ────────────────────────────────────────
	pi.on("before_agent_start", (event) => {
		const inheritProjectContext = readBooleanEnvAny(PI_CREW_INHERIT_PROJECT_CONTEXT_ENV, PI_TEAMS_INHERIT_PROJECT_CONTEXT_ENV);
		const inheritSkills = readBooleanEnvAny(PI_CREW_INHERIT_SKILLS_ENV, PI_TEAMS_INHERIT_SKILLS_ENV);
		if (inheritProjectContext === undefined && inheritSkills === undefined) return;
		const rewritten = rewriteTeamWorkerPrompt(event.systemPrompt, {
			inheritProjectContext: inheritProjectContext ?? true,
			inheritSkills: inheritSkills ?? true,
		});
		if (rewritten === event.systemPrompt) return;
		return { systemPrompt: rewritten };
	});
}
