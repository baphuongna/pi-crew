/**
 * knowledge-injection.ts — Project knowledge that accumulates across runs (O4).
 *
 * ROADMAP Phase 1 / T1.3 ("downsized memory"): a deliberately minimal
 * replacement for the deleted 244-LOC MemoryStore. Crews and the main
 * session read `.crew/knowledge.md` and have it injected into the system
 * prompt, so pi-crew "remembers" project context across runs.
 *
 * Philosophy (Round 6 stress-test): radically downsized. Just a Markdown
 * file the user can edit, surfaced into every run. No vector DB, no
 * embeddings, no graph. Simple = trustworthy.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { BeforeAgentStartEvent, ExtensionAPI } from "./pi-api.ts";
import { projectCrewRoot } from "../utils/paths.ts";

/** The knowledge file, relative to the project crew root. */
export const KNOWLEDGE_FILENAME = "knowledge.md";
/** Cap injected knowledge to avoid unbounded system-prompt growth. */
const MAX_KNOWLEDGE_BYTES = 16_000;

/** Resolve the knowledge file path for a cwd (may not exist yet). */
export function knowledgePath(cwd: string): string {
	return path.join(projectCrewRoot(cwd), KNOWLEDGE_FILENAME);
}

/** Read knowledge content, truncated to a safe size. "" if absent/empty. */
export function readKnowledge(cwd: string): string {
	try {
		const p = knowledgePath(cwd);
		if (!fs.existsSync(p)) return "";
		let content = fs.readFileSync(p, "utf8").trim();
		if (content.length > MAX_KNOWLEDGE_BYTES) {
			content = `${content.slice(0, MAX_KNOWLEDGE_BYTES)}\n\n<!-- knowledge.md truncated at ${MAX_KNOWLEDGE_BYTES} bytes -->`;
		}
		return content;
	} catch {
		return "";
	}
}

/** Build the injected prompt fragment (empty if no knowledge). */
export function buildKnowledgeFragment(cwd: string): string {
	const content = readKnowledge(cwd);
	if (!content) return "";
	return [
		"",
		"# Project knowledge (from .crew/knowledge.md)",
		"The following project knowledge was captured by pi-crew from prior runs.",
		"Use it to avoid repeating past mistakes and to respect project conventions.",
		"You may update .crew/knowledge.md when you learn something durable.",
		"",
		content,
	].join("\n");
}

/**
 * Register the knowledge-injection hook. Appends project knowledge to the
 * system prompt on every agent start (main session + each crew worker,
 * since workers are child Pi processes that also fire before_agent_start).
 */
export function registerKnowledgeInjection(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
		const options = (event as BeforeAgentStartEvent & { systemPromptOptions?: { cwd?: unknown } }).systemPromptOptions ?? {};
		const cwd = typeof options.cwd === "string" ? options.cwd : process.cwd();
		const fragment = buildKnowledgeFragment(cwd);
		if (!fragment) return undefined;
		return { systemPrompt: `${event.systemPrompt}${fragment}` };
	});
}
