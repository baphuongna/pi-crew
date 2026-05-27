import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PI_TEAMS_INHERIT_PROJECT_CONTEXT_ENV = "PI_TEAMS_INHERIT_PROJECT_CONTEXT";
export const PI_TEAMS_INHERIT_SKILLS_ENV = "PI_TEAMS_INHERIT_SKILLS";
export const PI_CREW_INHERIT_PROJECT_CONTEXT_ENV = "PI_CREW_INHERIT_PROJECT_CONTEXT";
export const PI_CREW_INHERIT_SKILLS_ENV = "PI_CREW_INHERIT_SKILLS";

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
