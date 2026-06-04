import type { ResourceSource } from "../agents/agent-config.ts";

export interface WorkflowStep {
	id: string;
	role: string;
	task: string;
	dependsOn?: string[];
	parallelGroup?: string;
	output?: string | false;
	reads?: string[] | false;
	model?: string;
	/** Additional skills for this step; false disables role-default injected skills for this step. */
	skills?: string[] | false;
	progress?: boolean;
	worktree?: boolean;
	verify?: boolean;
	/** Per-step files to overlay into the worktree (in addition to global worktree.seedPaths).
	 * Useful when only certain steps need access to local drafts or scripts. */
	seedPaths?: string[];
	/** Path to a deterministic script to run before dispatching the LLM worker.
	 * Script stdout is injected into the worker's prompt as context.
	 * Pattern origin: Understand-Anything deterministic pre-step pattern. */
	preStepScript?: string;
	/** Arguments for preStepScript. Passed as positional args. */
	preStepArgs?: string[];
	/** Timeout in ms for preStepScript. Default: 30000. */
	preStepTimeout?: number;
}

export interface WorkflowConfig {
	name: string;
	description: string;
	source: ResourceSource;
	filePath: string;
	steps: WorkflowStep[];
	maxConcurrency?: number;
}
