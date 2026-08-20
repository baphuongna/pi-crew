import type { ResourceSource } from "../agents/agent-config.ts";

export interface WorkflowStep {
	id: string;
	role: string;
	task: string;
	/** Security (F-02): provenance of the workflow file that declared this step.
	 *  Populated during discovery by discover-workflows.ts. Used by task-runner.ts
	 *  to gate preStepScript execution — project-sourced workflows may NOT run
	 *  pre-step scripts (RCE prevention). Undefined for manually-constructed steps. */
	source?: ResourceSource;
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
	/** T4/R6 (ADR-6): workspace SpecRecord ids this step is held to; frozen
	 *  into the task packet at dispatch (specStrict per workflow frontmatter). */
	specRefs?: string[];
	/** T4/R6 (ADR-6 §7): per-step strict-mode opt-in. Normally inherited from
	 *  the workflow-level frontmatter flag (merged at dispatch). */
	specStrict?: boolean;
	/** Path to a deterministic script to run before dispatching the LLM worker.
	 * Script stdout is injected into the worker's prompt as context.
	 * Pattern origin: Understand-Anything deterministic pre-step pattern. */
	preStepScript?: string;
	/** Arguments for preStepScript. Passed as positional args. */
	preStepArgs?: string[];
	/** Timeout in ms for preStepScript. Default: 30000. */
	preStepTimeout?: number;
	/** Round 21 (E4): if true, a failing preStepScript does NOT abort the task.
	 * The failure is logged as a warning and the task proceeds without the
	 * pre-step output. Use for advisory hooks (e.g. optional test runs) whose
	 * failure shouldn't block the workflow. Default: false (fail-fast). */
	preStepOptional?: boolean;
}

export interface WorkflowConfig {
	name: string;
	description: string;
	source: ResourceSource;
	filePath: string;
	steps: WorkflowStep[];
	maxConcurrency?: number;
	/** P2 dynamic-workflow discriminator. Default "static" (the .workflow.md step-list model).
	 *  "dynamic" = the workflow is a JS/TS script (.dwf.ts) run via dynamic-workflow-runner.
	 *  Backward-compatible: absent = "static". */
	runtime?: "static" | "dynamic";
	/** For runtime:"dynamic" — relative/absolute path to the .dwf.ts script. Unused for static. */
	dynamicScript?: string;
	/** For runtime:"dynamic" — per-workflow token budget. When set, ctx.agent() auto-rejects with
	 *  ok:false once exhausted. Accumulated from each agent run's reported usage. */
	maxTokenBudget?: number;
	/** Explicit topology classification from frontmatter `topology:` field.
	 *  When set, overrides the auto-classified topology in analyzeWorkflowTopology().
	 *  Used by preflight-validator to enforce "don't use pi-crew for sequential chains".
	 *  Valid values: 'single' | 'sequential' | 'concurrent' | 'complex-dag' | 'dynamic'.
	 *  Absent = auto-classify from step structure (default). */
	topology?: "single" | "sequential" | "concurrent" | "complex-dag" | "dynamic";
	/** Round 25 (M6): coalesce micro-tasks. Default false (off). When true,
	 *  multiple ready tasks sharing role + cwd are grouped into a single
	 *  multi-task worker prompt to reduce per-task cold-start cost. Disabled
	 *  in v0.9.17 unless the workflow author opts in. See
	 *  src/runtime/scheduling/coalesce-tasks.ts. */
	coalesceMicroTasks?: boolean;
	/** T4/R6 (ADR-6 §7): strict spec mode opt-in (frontmatter `specStrict: true`).
	 *  Requires a verifier-role step (reject-start, §5) and fails the write-gate
	 *  on coverage gaps or machine-check failures (§4). */
	specStrict?: boolean;
}

/** A dynamic workflow (runtime === "dynamic"). steps is empty — the script is the source of truth. */
export interface DynamicWorkflowConfig extends WorkflowConfig {
	runtime: "dynamic";
	dynamicScript: string;
	steps: [];
}
