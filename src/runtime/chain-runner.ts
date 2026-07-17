/**
 * ChainRunner - Execute sequential chains with `->` syntax support.
 *
 * Based on pi-boomerang's parseChain pattern:
 * - Parses "teamA -> teamB -> teamC" syntax
 * - Supports per-step overrides for model, skill, thinking
 * - Accumulates handoffs between steps
 * - Executes steps sequentially with context passing
 *
 * @see docs/pi-boomerang-integration-plan.md
 */

import type { ChainStep as DSLChainStep } from "./chain-parser.ts";
import { parseChainDSL } from "./chain-parser.ts";
import type { HandoffManager, HandoffSummary, TaskPacket, TaskResult } from "./handoff-manager.ts";

/**
 * Single step in a chain.
 */
export interface ChainStep {
	/** Step name/identifier */
	name: string;
	/** Team to execute (if using team reference) */
	team?: string;
	/** Workflow to execute (if using workflow reference) */
	workflow?: string;
	/** Template to execute (if using template reference) */
	template?: string;
	/** Inline goal text (for literal goals) */
	inlineGoal?: string;

	/** Per-step model override */
	model?: string;
	/** Per-step skill override */
	skill?: string;
	/** Thinking mode */
	thinking?: "fast" | "standard" | "deep";

	/** Step-specific context */
	context?: Record<string, unknown>;
	/** Step timeout in milliseconds */
	timeout?: number;

	/** Whether to continue chain on failure */
	continueOnError?: boolean;
}

/**
 * Parsed chain specification.
 */
export interface ChainSpec {
	/** Ordered steps in the chain */
	steps: ChainStep[];
	/** Global arguments applied to all steps */
	globalArgs?: Record<string, unknown>;
	/** Global model override */
	globalModel?: string;
	/** Global skill override */
	globalSkill?: string;
	/** Global thinking mode */
	globalThinking?: "fast" | "standard" | "deep";
	/** Continue chain on step failure */
	continueOnError?: boolean;
}

/**
 * Result of a single chain step execution.
 */
export interface ChainStepResult {
	step: number;
	name: string;
	outcome: "success" | "failure" | "skipped" | "partial";
	result?: TaskResult;
	handoff?: HandoffSummary;
	duration: number;
	error?: string;
}

/**
 * Final chain execution result.
 */
export interface ChainResult {
	steps: ChainStepResult[];
	totalDuration: number;
	success: boolean;
	/** Total tokens used across all steps */
	totalTokens?: number;
	/** All handoffs generated during chain */
	totalHandoffs: HandoffSummary[];
}

/**
 * Task runner interface for chain execution.
 */
export interface ChainTaskRunner {
	runTask(packet: TaskPacket): Promise<TaskResult>;
}

/**
 * ChainRunner executes sequential chains with context passing.
 */
export class ChainRunner {
	/** Maximum number of chain history entries to prevent memory leaks */
	private static readonly MAX_CHAIN_HISTORY_SIZE = 100;

	/** Maximum size per handoff entry to prevent memory issues from large artifacts */
	private static readonly MAX_HANDOFF_ENTRY_SIZE = 5000; // bytes per entry

	private taskRunner: ChainTaskRunner;
	private handoffManager: HandoffManager;

	constructor(taskRunner: ChainTaskRunner, handoffManager: HandoffManager) {
		this.taskRunner = taskRunner;
		this.handoffManager = handoffManager;
	}

	/**
	 * Parse chain syntax: step1 -> step2 -> step3
	 *
	 * Supports multiple syntaxes:
	 * - Team reference: @teamName
	 * - Workflow reference: workflow:name
	 * - Template reference: template:name
	 * - Inline goal: "goal description"
	 *
	 * @example
	 * parseChain("@research -> @implement -> @review")
	 * parseChain('"Research AI trends" -> "Analyze findings"')
	 * parseChain("@step1 --model claude-opus-3 -> @step2")
	 *
	 * Also supports DSL syntax from chain-parser for advanced constructs:
	 * parseChain("step1 -> parallel(step2, step3) -> step4")
	 * parseChain("step1:3 -> step2 --with-context -> step3")
	 *
	 * @param chainString - The chain string to parse
	 * @returns Parsed chain specification
	 */
	parseChain(chainString: string): ChainSpec {
		// Try DSL parser first for advanced syntax (parallel groups, loop counts, flags)
		// Falls back to the simple split parser if DSL parsing fails
		if (this.hasDSLConstructs(chainString)) {
			try {
				const dslSteps = parseChainDSL(chainString);
				return this.dslToChainSpec(dslSteps, chainString);
			} catch {
				// DSL parse failed; fall through to simple parser
			}
		}

		const stepStrings = chainString.split("->").map((s) => s.trim());

		const steps: ChainStep[] = stepStrings.map((step, index) => {
			return this.parseStep(step, index);
		});

		// Extract global overrides
		const globalModel = this.extractGlobalFlag(chainString, "global-model");
		const globalSkill = this.extractGlobalFlag(chainString, "global-skill");
		const globalThinking = this.extractGlobalFlag(chainString, "global-thinking") as "fast" | "standard" | "deep" | undefined;
		const continueOnError = this.extractGlobalFlag(chainString, "continue-on-error") === "true";

		return {
			steps,
			globalModel,
			globalSkill,
			globalThinking,
			continueOnError,
		};
	}

	/**
	 * Execute chain sequentially.
	 * Each step receives handoff from previous step.
	 *
	 * @param spec - Parsed chain specification
	 * @param initialContext - Initial context for the chain
	 * @param eventsPath - Optional event log path for events
	 * @returns Final chain result
	 */
	async runChain(spec: ChainSpec, initialContext: Record<string, unknown> = {}, eventsPath?: string): Promise<ChainResult> {
		const stepResults: ChainStepResult[] = [];
		let accumulatedContext = { ...initialContext };
		const startTime = Date.now();
		let totalTokens = 0;
		const allHandoffs: HandoffSummary[] = [];

		for (let i = 0; i < spec.steps.length; i++) {
			const step = spec.steps[i];
			const stepStart = Date.now();

			try {
				// Resolve effective config (step overrides global)
				const effectiveConfig = this.getEffectiveConfig(step, spec);

				// Enrich context with previous handoffs
				const stepContext = this.enrichContextFromHandoffs(accumulatedContext, stepResults);

				// Execute step
				const result = await this.executeStep(effectiveConfig, stepContext);

				// Track tokens
				if (result.usage?.totalTokens) {
					totalTokens += result.usage.totalTokens;
				}

				// Generate handoff for next step
				const handoff = await this.handoffManager.generateSummary(this.createMinimalPacket(step, i), result);

				stepResults.push({
					step: i + 1,
					name: step.name,
					outcome: result.outcome,
					result,
					handoff,
					duration: Date.now() - stepStart,
				});

				if (handoff !== null) {
					allHandoffs.push(handoff);
				}

				// Update accumulated context on success
				if (result.outcome === "success") {
					accumulatedContext = {
						...accumulatedContext,
						[`step_${i}_result`]: result,
						[`step_${i}_handoff`]: handoff,
					};
				} else {
					// Stop chain on step failure unless configured to continue
					if (!spec.continueOnError && !step.continueOnError) {
						break;
					}
				}

				// Emit progress event if eventsPath provided
				if (eventsPath) {
					// LAZY: defer dynamic import of ../state/event-log.ts to its call site.
					const { appendEventAsync } = await import("../state/event-log.ts");
					await appendEventAsync(eventsPath, {
						type: "chain.step_completed",
						runId: "chain",
						taskId: `step-${i + 1}`,
						data: {
							step: i + 1,
							name: step.name,
							outcome: result.outcome,
							duration: Date.now() - stepStart,
						},
					});
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);

				stepResults.push({
					step: i + 1,
					name: step.name,
					outcome: "failure",
					duration: Date.now() - stepStart,
					error: errorMessage,
				});

				// Stop chain on failure unless configured to continue
				if (!spec.continueOnError && !step.continueOnError) {
					break;
				}
			}
		}

		return {
			steps: stepResults,
			totalDuration: Date.now() - startTime,
			success: stepResults.every((s) => s.outcome !== "failure"),
			totalTokens: totalTokens > 0 ? totalTokens : undefined,
			totalHandoffs: allHandoffs,
		};
	}

	/**
	 * Parse a single step from the chain string.
	 * Includes type safety checks for ChainStep parsing (H3).
	 */
	private parseStep(step: string, index: number): ChainStep {
		// Parse team reference: @teamName
		const teamMatch = step.match(/^@([a-zA-Z][a-zA-Z0-9_]*)/);

		// Parse workflow reference: workflow:name
		const workflowMatch = step.match(/^workflow:([a-zA-Z][a-zA-Z0-9_]*)/);

		// Parse template reference: template:name
		const templateMatch = step.match(/^template:([a-zA-Z][a-zA-Z0-9_]*)/);

		// Parse inline goal: "goal description" (can follow other patterns)
		const inlineMatch = step.match(/"([^"]{1,10000})"/);

		const nameParts = step.split(/\s+/);
		const name = nameParts[0] && nameParts[0].length > 0 && nameParts[0].length <= 100 ? nameParts[0] : `step-${index}`;

		const parsed: ChainStep = {
			name,
		};

		// Set step type based on matching pattern with type safety
		if (teamMatch?.[1]) {
			parsed.team = this.sanitizeIdentifier(teamMatch[1]);
		}
		if (workflowMatch?.[1]) {
			parsed.workflow = this.sanitizeIdentifier(workflowMatch[1]);
		}
		if (templateMatch?.[1]) {
			parsed.template = this.sanitizeIdentifier(templateMatch[1]);
		}
		if (inlineMatch?.[1]) {
			parsed.inlineGoal = this.sanitizeInlineGoal(inlineMatch[1]);
		}

		// Parse per-step overrides with type safety
		const modelVal = this.extractFlag(step, "model");
		if (modelVal && this.isValidModelName(modelVal)) {
			parsed.model = modelVal;
		}

		const skillVal = this.extractFlag(step, "skill");
		if (skillVal && this.isValidIdentifier(skillVal)) {
			parsed.skill = skillVal;
		}

		const thinkingVal = this.extractFlag(step, "thinking");
		if (thinkingVal && this.isValidThinkingMode(thinkingVal)) {
			parsed.thinking = thinkingVal;
		}

		// Parse step timeout
		const timeoutStr = this.extractFlag(step, "timeout");
		if (timeoutStr) {
			const timeoutMs = parseInt(timeoutStr, 10);
			if (!Number.isNaN(timeoutMs) && timeoutMs > 0 && timeoutMs <= 86400000) {
				parsed.timeout = timeoutMs * 1000; // Convert seconds to ms
			}
		}

		// Parse continueOnError for step
		if (this.extractFlag(step, "continue-on-error") === "true") {
			parsed.continueOnError = true;
		}

		return parsed;
	}

	/**
	 * Detect if chainString uses DSL constructs that require chain-parser.
	 * DSL features: parallel(...), :loopCount, --with-context flag
	 */
	private hasDSLConstructs(chainString: string): boolean {
		return /\bparallel\s*\(/.test(chainString) || /\w+:\d+\b/.test(chainString) || /--with-context/.test(chainString);
	}

	/**
	 * Convert DSL AST steps (from chain-parser) to ChainSpec.
	 */
	private dslToChainSpec(dslSteps: DSLChainStep[], chainString: string): ChainSpec {
		const steps: ChainStep[] = dslSteps.map((dslStep, index) => {
			// For parallel groups, use a synthetic step name
			if (dslStep.parallel) {
				return {
					name: dslStep.name,
					context: {
						parallel: dslStep.parallel.map((p) => ({
							name: p.name,
							loopCount: p.loopCount,
							withContext: p.withContext,
							args: p.args,
						})),
					},
					loopCount: dslStep.loopCount,
				};
			}
			const step: ChainStep = { name: dslStep.name };
			if (dslStep.loopCount)
				step.context = {
					...step.context,
					loopCount: dslStep.loopCount,
				};
			if (dslStep.withContext) step.context = { ...step.context, withContext: true };
			if (dslStep.args && dslStep.args.length > 0) step.context = { ...step.context, args: dslStep.args };
			return step;
		});

		// Extract global overrides using existing logic
		const globalModel = this.extractGlobalFlag(chainString, "global-model");
		const globalSkill = this.extractGlobalFlag(chainString, "global-skill");
		const globalThinking = this.extractGlobalFlag(chainString, "global-thinking") as "fast" | "standard" | "deep" | undefined;
		const continueOnError = this.extractGlobalFlag(chainString, "continue-on-error") === "true";

		return {
			steps,
			globalModel,
			globalSkill,
			globalThinking,
			continueOnError,
		};
	}

	/**
	 * Sanitize identifier to prevent injection.
	 */
	private sanitizeIdentifier(value: string): string {
		return value.replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 100);
	}

	/**
	 * Sanitize inline goal to prevent injection.
	 */
	private sanitizeInlineGoal(value: string): string {
		// Remove control characters and limit length
		return value.replace(/[\x00-\x1F\x7F]/g, "").substring(0, 10000);
	}

	/**
	 * Validate model name format.
	 */
	private isValidModelName(value: string): boolean {
		return /^[a-zA-Z][a-zA-Z0-9_-]{0,50}$/.test(value);
	}

	/**
	 * Validate identifier format.
	 */
	private isValidIdentifier(value: string): boolean {
		return /^[a-zA-Z][a-zA-Z0-9_]{0,50}$/.test(value);
	}

	/**
	 * Validate thinking mode value.
	 */
	private isValidThinkingMode(value: string): value is "fast" | "standard" | "deep" {
		return ["fast", "standard", "deep"].includes(value);
	}

	/**
	 * Extract a flag from step string.
	 * Uses escaped flag name to prevent regex injection.
	 */
	private extractFlag(input: string, flag: string): string | undefined {
		// Escape regex special characters in flag name to prevent injection
		const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = input.match(new RegExp(`--${escapedFlag}\\s+(\\S+)`));
		return match?.[1];
	}

	/**
	 * Extract a global flag from the chain string.
	 * Global flags can appear anywhere in the chain string.
	 * Uses escaped flag name to prevent regex injection.
	 */
	private extractGlobalFlag(input: string, flag: string): string | undefined {
		// Escape regex special characters in flag name to prevent injection
		const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const patternEq = "--" + escapedFlag + "=\\s*(\\S+)";
		const match = input.match(new RegExp(patternEq, "i"));
		if (match) return match[1];

		const patternNoEq = "--" + escapedFlag + "\\s+(\\S+)";
		const matchNoEq = input.match(new RegExp(patternNoEq, "i"));
		if (matchNoEq) return matchNoEq[1];

		return undefined;
	}

	/**
	 * Get effective config with step overrides global.
	 */
	private getEffectiveConfig(step: ChainStep, spec: ChainSpec): ChainStep {
		return {
			...step,
			model: step.model ?? spec.globalModel,
			skill: step.skill ?? spec.globalSkill,
			thinking: step.thinking ?? spec.globalThinking,
		};
	}

	/**
	 * Enrich context with previous handoffs.
	 * Limits history size to prevent memory leaks.
	 */
	private enrichContextFromHandoffs(context: Record<string, unknown>, previousResults: ChainStepResult[]): Record<string, unknown> {
		const handoffs = previousResults.filter((r) => r.handoff).map((r) => r.handoff!);

		if (handoffs.length === 0) {
			return context;
		}

		const notes: string[] = [];

		// Limit history size to prevent memory leak (H2). Emit a marker so a dropped
		// entry does not vanish silently — this was the only silent-loss path in the
		// output-handling machinery (see research-findings/output-handling-deep-dive.md §F).
		let limitedHandoffs = handoffs;
		if (handoffs.length > ChainRunner.MAX_CHAIN_HISTORY_SIZE) {
			const dropped = handoffs.length - ChainRunner.MAX_CHAIN_HISTORY_SIZE;
			notes.push(
				`[chain history limited to last ${ChainRunner.MAX_CHAIN_HISTORY_SIZE} entries; ${dropped} older entr${dropped === 1 ? "y" : "ies"} omitted]`,
			);
			limitedHandoffs = handoffs.slice(-ChainRunner.MAX_CHAIN_HISTORY_SIZE);
		}

		// Limit per-entry size to prevent memory issues from large artifacts.
		const filteredHandoffs = limitedHandoffs.filter((h) => {
			const size = JSON.stringify(h).length;
			return size <= ChainRunner.MAX_HANDOFF_ENTRY_SIZE;
		});
		const oversizedDropped = limitedHandoffs.length - filteredHandoffs.length;
		if (oversizedDropped > 0) {
			notes.push(
				`[${oversizedDropped} handoff entr${oversizedDropped === 1 ? "y" : "ies"} omitted (> ${ChainRunner.MAX_HANDOFF_ENTRY_SIZE} bytes each)]`,
			);
		}

		// Track array-cap drops so capped lists do not vanish silently. Each field
		// over its cap records the full count so a reader knows data was elided.
		const arrayCapNotes: string[] = [];
		const mapped = filteredHandoffs.map((h) => {
			const over: string[] = [];
			if (h.filesCreated && h.filesCreated.length > 50) over.push(`filesCreated=${h.filesCreated.length}`);
			if (h.filesModified && h.filesModified.length > 50) over.push(`filesModified=${h.filesModified.length}`);
			if (h.decisions && h.decisions.length > 20) over.push(`decisions=${h.decisions.length}`);
			if (h.nextSteps && h.nextSteps.length > 20) over.push(`nextSteps=${h.nextSteps.length}`);
			if (over.length > 0) arrayCapNotes.push(`step ${h.taskId}: ${over.join(", ")} (capped)`);
			return {
				step: h.taskId,
				outcome: h.outcome,
				filesCreated: h.filesCreated?.slice(0, 50), // Limit array size
				filesModified: h.filesModified?.slice(0, 50), // Limit array size
				decisions: h.decisions?.slice(0, 20), // Limit array size
				nextSteps: h.nextSteps?.slice(0, 20), // Limit array size
				...(h.outputText ? { outputText: h.outputText.slice(0, 5000) } : {}), // Size-capped worker output
			};
		});
		if (arrayCapNotes.length > 0) notes.push(`[list caps applied: ${arrayCapNotes.join("; ")}]`);

		return {
			...context,
			__chainHistory: mapped,
			...(notes.length > 0 ? { __chainHistoryNotes: notes } : {}),
		};
	}

	/**
	 * Execute a single step.
	 */
	private async executeStep(config: ChainStep, context: Record<string, unknown>): Promise<TaskResult> {
		// Pass step config (team/workflow/model) into the packet context so the
		// concrete ChainTaskRunner can resolve which team/workflow to run. Without
		// this, a step parsed to a @teamName reference would lose its team because
		// the only channel from executeStep to runTask is the TaskPacket. Purely
		// additive — adds sibling keys alongside __chainHistory/Notes.
		const packet: TaskPacket = {
			taskId: `chain-${Date.now()}-${config.name}`,
			runId: "chain",
			goal: config.inlineGoal ?? config.name,
			summarizeThreshold: 3000,
			collapseContext: true,
			context: {
				...context,
				__chainStepTeam: config.team,
				__chainStepWorkflow: config.workflow,
				__chainStepModel: config.model,
			},
		};

		return this.taskRunner.runTask(packet);
	}

	/**
	 * Create minimal packet for handoff generation.
	 */
	private createMinimalPacket(step: ChainStep, index: number): TaskPacket {
		return {
			taskId: `chain-step-${index}`,
			runId: "chain",
			sessionId: "chain",
			goal: step.inlineGoal ?? step.name,
		};
	}
}

/**
 * Create a ChainRunner with default dependencies.
 */
export function createChainRunner(taskRunner: ChainTaskRunner, handoffManager: HandoffManager): ChainRunner {
	return new ChainRunner(taskRunner, handoffManager);
}

/**
 * Parse chain from string shorthand.
 */
export function parseChainString(chainString: string): ChainSpec {
	const runner = new ChainRunner(
		{
			runTask: () => Promise.reject(new Error("Not initialized")),
		} as ChainTaskRunner,
		{} as HandoffManager,
	);
	return runner.parseChain(chainString);
}
