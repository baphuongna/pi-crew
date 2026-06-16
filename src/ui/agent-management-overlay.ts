/**
 * Agent Management Overlay — displays discovered agents with their configuration.
 * Read-only view of agent definitions from builtin/user/project sources.
 * Future: enable/disable toggle, model override editing.
 */
import type { AgentConfig, ResourceSource } from "../agents/agent-config.ts";
import { truncate } from "../utils/visual.ts";

export interface AgentEntry {
	name: string;
	description: string;
	source: ResourceSource;
	model?: string;
	thinking?: string;
	loadMode?: string;
	contextMode?: string;
	disabled?: boolean;
	filePath: string;
}

export function agentToEntry(agent: AgentConfig): AgentEntry {
	return {
		name: agent.name,
		description: agent.description,
		source: agent.source,
		model: agent.model,
		thinking: agent.thinking,
		loadMode: agent.loadMode,
		contextMode: agent.contextMode,
		disabled: agent.disabled,
		filePath: agent.filePath,
	};
}

function sourceIcon(source: ResourceSource): string {
	switch (source) {
		case "builtin": return "📦";
		case "user": return "👤";
		case "project": return "📂";
		case "git": return "🔗";
		case "dynamic": return "⚡";
		default: return "❓";
	}
}

function sourceLabel(source: ResourceSource): string {
	switch (source) {
		case "builtin": return "builtin";
		case "user": return "user";
		case "project": return "project";
		case "git": return "git";
		case "dynamic": return "dynamic";
		default: return "unknown";
	}
}

export interface AgentOverlayState {
	entries: AgentEntry[];
	selectedIndex: number;
	scrollOffset: number;
	expanded: Set<number>;
	maxVisible: number;
}

export function createAgentOverlayState(entries: AgentEntry[], maxVisible = 20): AgentOverlayState {
	return {
		entries: entries.sort((a, b) => {
			const order: Record<ResourceSource, number> = { project: 0, "project-pi": 1, user: 2, git: 3, builtin: 4, dynamic: 5 };
			const diff = (order[a.source] ?? 4) - (order[b.source] ?? 4);
			return diff !== 0 ? diff : a.name.localeCompare(b.name);
		}),
		selectedIndex: 0,
		scrollOffset: 0,
		expanded: new Set(),
		maxVisible,
	};
}

export function moveSelection(state: AgentOverlayState, direction: -1 | 1): AgentOverlayState {
	const next = Math.max(0, Math.min(state.entries.length - 1, state.selectedIndex + direction));
	const visibleStart = state.scrollOffset;
	const visibleEnd = state.scrollOffset + state.maxVisible;
	const newScroll = next < visibleStart
		? next
		: next >= visibleEnd
			? Math.max(0, next - state.maxVisible + 1)
			: state.scrollOffset;
	return { ...state, selectedIndex: next, scrollOffset: newScroll };
}

export function toggleExpand(state: AgentOverlayState): AgentOverlayState {
	const expanded = new Set(state.expanded);
	if (expanded.has(state.selectedIndex)) {
		expanded.delete(state.selectedIndex);
	} else {
		expanded.add(state.selectedIndex);
	}
	return { ...state, expanded };
}

export function renderAgentOverlay(state: AgentOverlayState, width: number): string[] {
	const lines: string[] = [];
	const header = ` Agent Configuration (${state.entries.length} agents)`;
	lines.push(truncate(header, width));
	lines.push(truncate("─".repeat(Math.min(width, 60)), width));

	if (state.entries.length === 0) {
		lines.push(truncate(" No agents discovered.", width));
		return lines;
	}

	const visible = state.entries.slice(
		state.scrollOffset,
		state.scrollOffset + state.maxVisible,
	);

	for (const [i, entry] of visible.entries()) {
		const globalIndex = state.scrollOffset + i;
		const isSelected = globalIndex === state.selectedIndex;
		const isExpanded = state.expanded.has(globalIndex);
		const cursor = isSelected ? "▸" : " ";
	const disabled = entry.disabled ? " [disabled]" : "";
	const model = entry.model ? ` (${entry.model})` : "";

	const summary = `${cursor} ${sourceIcon(entry.source)} ${entry.name}${model}${disabled}`;
	lines.push(truncate(summary, width));

	if (isExpanded) {
		const desc = `    ${entry.description}`;
		lines.push(truncate(desc, width));
		const meta: string[] = [`    source: ${sourceLabel(entry.source)}`];
		if (entry.model) meta.push(`model: ${entry.model}`);
		if (entry.thinking) meta.push(`thinking: ${entry.thinking}`);
		if (entry.loadMode) meta.push(`loadMode: ${entry.loadMode}`);
		if (entry.contextMode) meta.push(`context: ${entry.contextMode}`);
		meta.push(`file: ${entry.filePath}`);
		lines.push(truncate(meta.join(" · "), width));
		lines.push(truncate("─".repeat(Math.min(width - 4, 50)), width));
	}
	}

	if (state.scrollOffset + state.maxVisible < state.entries.length) {
		const remaining = state.entries.length - state.scrollOffset - state.maxVisible;
		lines.push(truncate(`  … +${remaining} more`, width));
	}

	return lines;
}
