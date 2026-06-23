/**
 * Command argument autocomplete helpers (Round 13 UX quick-win).
 *
 * Pi's built-in slash-command autocomplete calls a command's
 * `getArgumentCompletions(argumentPrefix)` when the user types
 * `/command <prefix><TAB>`. Returning AutocompleteItem[] surfaces those
 * suggestions; returning null falls back to file completion.
 *
 * These helpers provide run-id, team, and workflow completions without
 * requiring the user to memorize long generated IDs.
 */
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { listRecentRuns } from "./run-index.ts";
import { discoverTeams, allTeams } from "../teams/discover-teams.ts";
import { discoverWorkflows, allWorkflows } from "../workflows/discover-workflows.ts";
import { discoverAgents, allAgents } from "../agents/discover-agents.ts";
import type { TeamRunManifest } from "../state/types.ts";

const MAX_RUN_SUGGESTIONS = 15;

function filterByPrefix(items: AutocompleteItem[], prefix: string): AutocompleteItem[] | null {
	const trimmed = prefix.trim();
	const filtered = trimmed === ""
		? items
		: items.filter((item) => item.value.startsWith(trimmed) || item.label.toLowerCase().includes(trimmed.toLowerCase()));
	return filtered.length > 0 ? filtered.slice(0, MAX_RUN_SUGGESTIONS) : null;
}

function statusIcon(status: TeamRunManifest["status"]): string {
	switch (status) {
		case "running":
		case "planning":
			return "▶";
		case "queued":
			return "⏳";
		case "completed":
			return "✓";
		case "failed":
		case "blocked":
			return "✗";
		case "cancelled":
			return "⊘";
		default:
			return "•";
	}
}

/**
 * Suggest recent run IDs for run-scoped commands (/team-status, /team-cancel, …).
 * Falls back to `process.cwd()` because Pi does not pass cwd into
 * `getArgumentCompletions` — this is correct in the interactive TUI where the
 * process cwd matches the session cwd.
 */
export function suggestRunIds(_prefix: string, cwd?: string): AutocompleteItem[] | null {
	const resolvedCwd = cwd ?? process.cwd();
	const runs = listRecentRuns(resolvedCwd, MAX_RUN_SUGGESTIONS);
	if (runs.length === 0) return null;
	const items: AutocompleteItem[] = runs.map((run) => ({
		value: run.runId,
		label: run.runId,
		description: `${statusIcon(run.status)} ${run.status} · ${run.team} · ${(run.goal ?? "").slice(0, 48)}`,
	}));
	return filterByPrefix(items, _prefix);
}

/** Suggest task IDs within a specific run (for /team-result <runId> <taskId>). */
export async function suggestTaskIds(runId: string, prefix: string, cwd?: string): Promise<AutocompleteItem[] | null> {
	const resolvedCwd = cwd ?? process.cwd();
	// Dynamic import to avoid pulling state-store into the hot command-registration path.
		// LAZY: defer dynamic import of ../state/state-store.ts to its call site.
	const { loadRunManifestById } = await import("../state/state-store.ts");
	const loaded = loadRunManifestById(resolvedCwd, runId);
	if (!loaded) return null;
	const items: AutocompleteItem[] = loaded.tasks.map((task) => ({
		value: task.id,
		label: task.id,
		description: `${task.status} · ${task.role} · ${task.title?.slice(0, 40) ?? ""}`,
	}));
	return filterByPrefix(items, prefix);
}

/** Suggest available teams for /team-run <team>. */
export function suggestTeams(prefix: string, cwd?: string): AutocompleteItem[] | null {
	const resolvedCwd = cwd ?? process.cwd();
	const teams = allTeams(discoverTeams(resolvedCwd));
	if (teams.length === 0) return null;
	const items: AutocompleteItem[] = teams.map((team) => ({
		value: team.name,
		label: team.name,
		description: team.defaultWorkflow ? `workflow=${team.defaultWorkflow}` : undefined,
	}));
	return filterByPrefix(items, prefix);
}

/** Suggest available workflows. */
export function suggestWorkflows(prefix: string, cwd?: string): AutocompleteItem[] | null {
	const resolvedCwd = cwd ?? process.cwd();
	const workflows = allWorkflows(discoverWorkflows(resolvedCwd));
	if (workflows.length === 0) return null;
	const items: AutocompleteItem[] = workflows.map((wf) => ({
		value: wf.name,
		label: wf.name,
		description: `${wf.steps?.length ?? 0} steps`,
	}));
	return filterByPrefix(items, prefix);
}

/** Suggest available agents. */
export function suggestAgents(prefix: string, cwd?: string): AutocompleteItem[] | null {
	const resolvedCwd = cwd ?? process.cwd();
	const agents = allAgents(discoverAgents(resolvedCwd));
	if (agents.length === 0) return null;
	const items: AutocompleteItem[] = agents.map((agent) => ({
		value: agent.name,
		label: agent.name,
		description: agent.description?.slice(0, 60),
	}));
	return filterByPrefix(items, prefix);
}
