import type { ResourceSource, RoutingMetadata } from "../agents/agent-config.ts";

export interface TeamRole {
	name: string;
	agent: string;
	description?: string;
	model?: string;
	/** Comma-separated fallback models declared on the role line. */
	fallbackModels?: string[];
	/** Thinking level for this role (e.g. "high", "medium", "low", "off"). */
	thinking?: string;
	/** Additional skills for this role; false disables role-default injected skills for tasks using this role. */
	skills?: string[] | false;
	maxConcurrency?: number;
}

export interface TeamConfig {
	name: string;
	description: string;
	source: ResourceSource;
	filePath: string;
	roles: TeamRole[];
	defaultWorkflow?: string;
	workspaceMode?: "single" | "worktree";
	maxConcurrency?: number;
	/**
	 * Perf observability: when true (default), the run auto-attaches the
	 * resource sampler (scripts/resource-sampler.mjs --watch-run) and runs
	 * analyze-run after completion. Set `observability: false` in the team
	 * frontmatter to disable.
	 */
	observability?: boolean;
	routing?: RoutingMetadata;
	/**
	 * Optional git-based source URL when this team config is sourced from a remote URL.
	 */
	sourceUrl?: string;
}
