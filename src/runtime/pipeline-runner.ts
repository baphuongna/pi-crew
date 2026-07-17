
import { errors } from "../errors.ts";
import { appendEventAsync, flushEventLogBuffer } from "../state/event-log.ts";
import type { WorkflowConfig, } from "../workflows/workflow-config.ts";
import { mapConcurrent } from "./parallel-utils.ts";

/**
 * Pipeline stage configuration.
 */
export interface PipelineStage {
	name: string;
	team: string;
	inputs: unknown;
	/** Enable fan-out when inputs is an array (default: true) */
	fanOut?: boolean;
	/** Maximum concurrent executions for fan-out (default: 5) */
	maxConcurrency?: number;
	/** Stop pipeline if this stage fails (default: true) */
	stopOnError?: boolean;
	/** Pass previous stage results as inputs (default: true) */
	usePreviousResults?: boolean;
}

/**
 * Pipeline workflow configuration.
 */
export interface PipelineWorkflow {
	name: string;
	description: string;
	goal: string;
	stages: PipelineStage[];
	/** Stop pipeline if any stage fails (default: true) */
	stopOnError?: boolean;
	/** Default max concurrency for fan-out stages */
	defaultMaxConcurrency?: number;
	/** Context passed to all stages */
	context?: Record<string, unknown>;
}

/**
 * Context passed to each stage execution.
 */
export interface PipelineContext {
	stageIndex: number;
	stageName: string;
	previousResults: unknown[];
	totalStages: number;
	runId: string;
}

/**
 * Result of a single stage execution.
 */
export interface StageResult {
	name: string;
	status: "completed" | "failed" | "skipped";
	results: unknown[];
	error?: string;
	duration: number;
	fanOutItems?: number;
}

/**
 * Complete pipeline execution result.
 */
export interface PipelineResult {
	stages: StageResult[];
	totalDuration: number;
	finalResults: unknown[];
	status: "completed" | "failed" | "partial";
}

/**
 * PipelineRunner executes multi-stage workflows with automatic fan-out
 * for array inputs.
 */
export class PipelineRunner {
	private stopOnError: boolean;
	private defaultMaxConcurrency: number;

	constructor(options?: {
		stopOnError?: boolean;
		defaultMaxConcurrency?: number;
	}) {
		this.stopOnError = options?.stopOnError ?? true;
		this.defaultMaxConcurrency = options?.defaultMaxConcurrency ?? 5;
	}

	/**
	 * Execute a pipeline workflow.
	 * @param workflow - The pipeline workflow definition
	 * @param context - Additional context for execution
	 * @param executeStage - Function to execute a single stage
	 * @param runId - Run identifier for event logging
	 * @param eventsPath - Path to event log file
	 */
	async run(
		workflow: PipelineWorkflow,
		context: Record<string, unknown>,
		executeStage: (stage: PipelineStage, inputs: unknown, stageContext: PipelineContext) => Promise<unknown>,
		runId: string,
		eventsPath: string,
	): Promise<PipelineResult> {
		const stages: StageResult[] = [];
		let previousResults: unknown[] = [];
		const startTime = Date.now();

		try {
			await appendEventAsync(eventsPath, {
				type: "pipeline:started",
				runId,
				message: `Pipeline '${workflow.name}' started`,
				data: { stages: workflow.stages.map((s) => s.name) },
			});

			for (let i = 0; i < workflow.stages.length; i++) {
				const stage = workflow.stages[i];
				const stageStartTime = Date.now();

				// Determine stop behavior for this stage
				const effectiveStopOnError = stage.stopOnError ?? workflow.stopOnError ?? this.stopOnError;

				await appendEventAsync(eventsPath, {
					type: "pipeline:stage_started",
					runId,
					message: `Stage '${stage.name}' started`,
					data: { stageIndex: i, stageName: stage.name },
				});

				try {
					// Build stage context
					const stageContext: PipelineContext = {
						stageIndex: i,
						stageName: stage.name,
						previousResults,
						totalStages: workflow.stages.length,
						runId,
					};

					// Resolve inputs
					const inputs = this.resolveInputs(stage.inputs, previousResults, context);

					// Execute stage (handle fan-out if enabled)
					const results = await this.executeStageInternal(stage, inputs, stageContext, executeStage);

					const duration = Date.now() - stageStartTime;
					stages.push({
						name: stage.name,
						status: "completed",
						results,
						duration,
						fanOutItems: Array.isArray(inputs) ? inputs.length : undefined,
					});

					previousResults = results;

					await appendEventAsync(eventsPath, {
						type: "pipeline:stage_completed",
						runId,
						message: `Stage '${stage.name}' completed`,
						data: {
							stageIndex: i,
							stageName: stage.name,
							duration,
							resultCount: results.length,
						},
					});
				} catch (error) {
					const duration = Date.now() - stageStartTime;
					const errorMessage = error instanceof Error ? error.message : String(error);

					if (effectiveStopOnError) {
						stages.push({
							name: stage.name,
							status: "failed",
							results: [],
							error: errorMessage,
							duration,
						});

						await appendEventAsync(eventsPath, {
							type: "pipeline:stage_failed",
							runId,
							message: `Stage '${stage.name}' failed: ${errorMessage}`,
							data: {
								stageIndex: i,
								stageName: stage.name,
								duration,
								error: errorMessage,
							},
						});

						await appendEventAsync(eventsPath, {
							type: "pipeline:failed",
							runId,
							message: `Pipeline '${workflow.name}' failed at stage '${stage.name}'`,
							data: { failedStage: stage.name, error: errorMessage },
						});

						return {
							stages,
							totalDuration: Date.now() - startTime,
							finalResults: previousResults,
							status: "failed",
						};
					} else {
						stages.push({
							name: stage.name,
							status: "failed",
							results: [],
							error: errorMessage,
							duration,
						});

						await appendEventAsync(eventsPath, {
							type: "pipeline:stage_skipped",
							runId,
							message: `Stage '${stage.name}' skipped due to error`,
							data: {
								stageIndex: i,
								stageName: stage.name,
								duration,
								error: errorMessage,
							},
						});
					}
				}
			}

			await appendEventAsync(eventsPath, {
				type: "pipeline:completed",
				runId,
				message: `Pipeline '${workflow.name}' completed`,
				data: {
					stages: stages.map((s) => ({ name: s.name, status: s.status })),
				},
			});

			return {
				stages,
				totalDuration: Date.now() - startTime,
				finalResults: previousResults,
				status: stages.some((s) => s.status === "failed") ? "partial" : "completed",
			};
		} finally {
			// FIX (P0 follow-up): Drain the event-log buffer before returning so
			// --test-force-exit does not detect "Promise resolution is still
			// pending". The buffered flush uses a 20ms ref'd timer that fires
			// asynchronously; without this explicit drain, the test runner sees
			// pending appendEventAsync promises and cancels the test file.
			await flushEventLogBuffer();
		}
	}

	/**
	 * Execute a single stage, handling fan-out for array inputs.
	 * Uses depth parameter to prevent stack overflow from deep recursion.
	 */
	private async executeStageInternal(
		stage: PipelineStage,
		inputs: unknown,
		stageContext: PipelineContext,
		callback: (stage: PipelineStage, inputs: unknown, stageContext: PipelineContext) => Promise<unknown>,
		depth: number = 0,
	): Promise<unknown[]> {
		// CRITICAL-6: Prevent stack overflow from deep recursion
		if (depth > 50) {
			// E1 (Round 15): structured CrewError (E011) with help hint.
			throw errors.depthLimitExceeded(depth, "pipeline");
		}

		const fanOut = stage.fanOut ?? true;
		const maxConcurrency = stage.maxConcurrency ?? this.defaultMaxConcurrency;

		// Fan-out if inputs is an array with multiple items to process.
		// We don't fan-out for single-element arrays as they typically represent
		// the result of a previous stage that returned a single value.
		const shouldFanOut = fanOut && Array.isArray(inputs) && inputs.length > 1;

		// Increment depth for non-fan-out path
		const nextDepth = depth + 1;

		if (shouldFanOut) {
			const tasks = (inputs as unknown[]).map((item, index) => ({
				item,
				index,
				name: `${stage.name}[${index}]`,
			}));

			// Execute with concurrency limit - pass each item to callback
			const results = await mapConcurrent(tasks, maxConcurrency, async (task) => {
				// Call the user-provided callback with each item
				const result = await this.executeStageInternal(
					stage,
					task.item,
					{
						...stageContext,
						stageName: task.name,
					},
					callback,
					nextDepth,
				);
				return result;
			});

			return results;
		}

		// Single execution - pass inputs directly to callback
		const result = await callback(stage, inputs, stageContext);
		return [result];
	}

	/**
	 * Resolve inputs from template strings and previous results.
	 * Supports JMESPath-like resolution:
	 * - ${previous} -> previousResults
	 * - ${previous[0]} -> previousResults[0]
	 * - ${context.key} -> context.key
	 * - ${args.x} -> context.args.x
	 *
	 * C5: Validates template inputs to prevent injection.
	 */
	private resolveInputs(inputs: unknown, previousResults: unknown[], context: Record<string, unknown>): unknown {
		// If inputs is an array, resolve each element
		if (Array.isArray(inputs)) {
			// H4: Type safety - limit array size to prevent memory issues
			const maxItems = 10000;
			const limitedInputs = inputs.length > maxItems ? inputs.slice(0, maxItems) : inputs;
			return limitedInputs.map((input) => this.resolveInputs(input, previousResults, context));
		}

		// If inputs is a string, check for template patterns
		if (typeof inputs === "string") {
			return this.resolveTemplate(inputs, previousResults, context);
		}

		// If inputs is an object, resolve each value
		if (typeof inputs === "object" && inputs !== null) {
			const resolved: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(inputs)) {
				// C5: Validate key to prevent prototype pollution
				if (this.isValidObjectKey(key)) {
					resolved[key] = this.resolveInputs(value as string | string[] | Record<string, unknown>, previousResults, context);
				}
			}
			return resolved;
		}

		// Primitive value - return as-is
		return inputs;
	}

	/**
	 * C5: Validate object key to prevent prototype pollution and injection.
	 */
	private isValidObjectKey(key: string): boolean {
		// Reject dangerous keys
		const dangerousKeys = [
			"__proto__",
			"constructor",
			"prototype",
			"__defineGetter__",
			"__defineSetter__",
			"__lookupGetter__",
			"__lookupSetter__",
		];
		if (dangerousKeys.includes(key)) {
			return false;
		}
		// Reject keys with null bytes or control characters
		if (/[\x00-\x1F\x7F]/.test(key)) {
			return false;
		}
		// Reject overly long keys
		if (key.length > 256) {
			return false;
		}
		return true;
	}

	/**
	 * C5: Validate nested path (e.g., "nested.deep.value") to prevent injection.
	 * Each part is validated individually.
	 */
	private isValidNestedPath(path: string): boolean {
		// Reject empty paths
		if (!path || path.length === 0) {
			return false;
		}
		// Reject overly long paths
		if (path.length > 512) {
			return false;
		}
		// Reject paths with empty segments
		if (path.includes("..")) {
			return false;
		}
		// Validate each path segment
		const parts = path.split(".");
		for (const part of parts) {
			if (!this.isValidObjectKey(part)) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Resolve a single template string.
	 * C5: Validates template inputs to prevent injection.
	 */
	private resolveTemplate(template: string, previousResults: unknown[], context: Record<string, unknown>): unknown {
		// C5: Validate template length to prevent DoS
		if (template.length > 10000) {
			return template;
		}

		// Check for ${previous} pattern
		const previousMatch = template.match(/^\$\{previous\}$/);
		if (previousMatch) {
			return previousResults;
		}

		// Check for ${previous[N]} pattern with bounds checking
		const previousIndexMatch = template.match(/^\$\{previous\[(\d+)\]\}$/);
		if (previousIndexMatch) {
			const index = parseInt(previousIndexMatch[1], 10);
			// H4: Type safety - validate index bounds
			if (index >= 0 && index < previousResults.length) {
				return previousResults[index];
			}
			return undefined;
		}

		// Check for ${context.key} pattern with sanitized key extraction
		const contextMatch = template.match(/^\$\{context\.([a-zA-Z_][a-zA-Z0-9_.]*)\}$/);
		if (contextMatch) {
			const key = contextMatch[1];
			// C5: Validate the full path (each part validated in getNestedValue)
			if (this.isValidNestedPath(key)) {
				return this.getNestedValue(context, key);
			}
			return undefined;
		}

		// Check for ${args.key} pattern with sanitized key extraction
		const argsMatch = template.match(/^\$\{args\.([a-zA-Z_][a-zA-Z0-9_.]*)\}$/);
		if (argsMatch) {
			const key = argsMatch[1];
			// C5: Validate the full path (each part validated in getNestedValue)
			if (this.isValidNestedPath(key)) {
				const args = (context.args as Record<string, unknown>) ?? {};
				return this.getNestedValue(args, key);
			}
			return undefined;
		}

		// No pattern matched - return template as-is
		return template;
	}

	/**
	 * Get nested value from object using dot notation.
	 * H4: Type safety - validates path and prevents prototype pollution.
	 */
	private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
		const parts = path.split(".");
		let current: unknown = obj;

		for (const part of parts) {
			// H4: Validate each path part
			if (!this.isValidObjectKey(part)) {
				return undefined;
			}
			if (current === null || current === undefined) {
				return undefined;
			}
			if (typeof current !== "object") {
				return undefined;
			}
			current = (current as Record<string, unknown>)[part];
		}

		return current;
	}

	/**
	 * Parse a pipeline workflow from a workflow configuration.
	 * Converts standard WorkflowConfig to PipelineWorkflow.
	 */
	static fromWorkflowConfig(workflow: WorkflowConfig, goal: string): PipelineWorkflow {
		const stages: PipelineStage[] = workflow.steps.map((step) => ({
			name: step.id,
			team: step.role, // Using role as team identifier
			inputs: step.task,
			usePreviousResults: step.dependsOn && step.dependsOn.length > 0,
		}));

		return {
			name: workflow.name,
			description: workflow.description,
			goal,
			stages,
			stopOnError: true,
			defaultMaxConcurrency: workflow.maxConcurrency ?? 5,
		};
	}
}

/**
 * Create a pipeline workflow from a goal and stage definitions.
 */
export function createPipelineWorkflow(name: string, description: string, goal: string, stages: PipelineStage[]): PipelineWorkflow {
	return {
		name,
		description,
		goal,
		stages,
		stopOnError: true,
		defaultMaxConcurrency: 5,
	};
}
