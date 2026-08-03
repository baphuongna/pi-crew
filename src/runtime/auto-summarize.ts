/**
 * AutoSummarizeService - Enables auto-summarization with token/tool thresholds.
 *
 * Based on pi-boomerang's autoBoomerang pattern:
 * - toggle() enables/disables auto-summarization
 * - shouldAutoSummarize() checks if task should auto-summarize
 * - Token and tool thresholds control when summarization triggers
 */

import type { TaskPacket, TaskResult } from "./handoff-manager.ts";

/**
 * Configuration for AutoSummarizeService.
 */
export interface AutoSummarizeConfig {
	/** Whether auto-summarize is enabled */
	enabled: boolean;
	/** Token threshold to trigger summarization */
	threshold: number;
	/** Minimum tools used to trigger summarization (default: 5) */
	minToolsUsed?: number;
	/** Whether to collapse context after summarization */
	collapseContext?: boolean;
}

/**
 * Default configuration values.
 */
export const DEFAULT_AUTO_SUMMARIZE_CONFIG: Required<Omit<AutoSummarizeConfig, "enabled">> = {
	threshold: 5000,
	minToolsUsed: 5,
	collapseContext: true,
};

/**
 * Options for AutoSummarizeService.
 */
export interface AutoSummarizeServiceOptions {
	/** Initial configuration */
	config?: Partial<AutoSummarizeConfig>;
	/** Custom event emitter */
	eventEmitter?: AutoSummarizeEventEmitter;
}

/**
 * Event emitter for auto-summarize events.
 */
export interface AutoSummarizeEventEmitter {
	emit(event: string, data: unknown): void;
}

/**
 * Event data for auto-summarize toggle event.
 */
export interface AutoSummarizeToggledEventData {
	enabled: boolean;
	previousEnabled: boolean;
}

/**
 * Event data for auto-summarize triggered event.
 */
export interface AutoSummarizeTriggeredEventData {
	packet: TaskPacket;
	result: TaskResult;
	trigger: AutoSummarizeTrigger;
	tokenCount: number;
}

/**
 * What triggered the auto-summarize.
 */
export type AutoSummarizeTrigger = "token_threshold" | "tools_threshold" | "manual" | "high_usage";

/**
 * AutoSummarizeService enables automatic summarization based on configurable thresholds.
 * When enabled, it monitors task completion and triggers summarization for tasks
 * that exceed token or tool usage thresholds.
 */
export class AutoSummarizeService {
	private config: AutoSummarizeConfig & Required<Omit<AutoSummarizeConfig, "enabled">>;
	private eventEmitter: AutoSummarizeEventEmitter | null = null;

	constructor(options: AutoSummarizeServiceOptions = {}) {
		this.config = {
			enabled: options.config?.enabled ?? false,
			threshold: options.config?.threshold ?? DEFAULT_AUTO_SUMMARIZE_CONFIG.threshold,
			minToolsUsed: options.config?.minToolsUsed ?? DEFAULT_AUTO_SUMMARIZE_CONFIG.minToolsUsed,
			collapseContext: options.config?.collapseContext ?? DEFAULT_AUTO_SUMMARIZE_CONFIG.collapseContext,
		};

		if (options.eventEmitter) {
			this.eventEmitter = options.eventEmitter;
		}
	}

	/**
	 * Check if auto-summarization is currently enabled.
	 */
	isEnabled(): boolean {
		return this.config.enabled;
	}

	/**
	 * Toggle auto-summarize mode.
	 * Returns the new enabled state.
	 */
	toggle(): boolean {
		const previousEnabled = this.config.enabled;
		this.config.enabled = !this.config.enabled;

		this.eventEmitter?.emit("auto-summarize:toggled", {
			enabled: this.config.enabled,
			previousEnabled,
		} as AutoSummarizeToggledEventData);

		return this.config.enabled;
	}

	/**
	 * Enable auto-summarize.
	 */
	enable(): void {
		if (!this.config.enabled) {
			this.toggle();
		}
	}

	/**
	 * Disable auto-summarize.
	 */
	disable(): void {
		if (this.config.enabled) {
			this.toggle();
		}
	}

	/**
	 * Check if a task should auto-summarize.
	 *
	 * @param packet - The task packet
	 * @param result - The task result
	 * @returns True if the task should auto-summarize
	 */
	shouldAutoSummarize(packet: TaskPacket, result: TaskResult): boolean {
		if (!this.config.enabled) {
			return false;
		}

		const tokenCount = result.usage?.totalTokens ?? 0;

		// Check token threshold
		if (tokenCount >= this.config.threshold) {
			return true;
		}

		// Check tools threshold
		const toolsUsed = result.toolsUsed?.length ?? 0;
		if (toolsUsed >= (this.config.minToolsUsed ?? 5)) {
			return true;
		}

		// High usage check: high token count relative to tools
		// More tokens per tool suggests complex work that should be summarized
		if (tokenCount > 2000 && toolsUsed >= 3) {
			const tokensPerTool = tokenCount / toolsUsed;
			if (tokensPerTool > 1000) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Get the reason why a task should (or should not) auto-summarize.
	 *
	 * @param packet - The task packet
	 * @param result - The task result
	 * @returns Object with shouldSummarize flag and reason
	 */
	getAutoSummarizeDecision(packet: TaskPacket, result: TaskResult): AutoSummarizeDecision {
		if (!this.config.enabled) {
			return {
				shouldSummarize: false,
				reason: "auto-summarize is disabled",
				trigger: undefined,
				tokenCount: result.usage?.totalTokens ?? 0,
				toolsUsed: result.toolsUsed?.length ?? 0,
			};
		}

		const tokenCount = result.usage?.totalTokens ?? 0;
		const toolsUsed = result.toolsUsed?.length ?? 0;

		// Check token threshold
		if (tokenCount >= this.config.threshold) {
			return {
				shouldSummarize: true,
				reason: `Token count ${tokenCount} exceeds threshold ${this.config.threshold}`,
				trigger: "token_threshold",
				tokenCount,
				toolsUsed,
			};
		}

		// Check tools threshold
		const minTools = this.config.minToolsUsed ?? 5;
		if (toolsUsed >= minTools) {
			return {
				shouldSummarize: true,
				reason: `Tool count ${toolsUsed} meets minimum ${minTools}`,
				trigger: "tools_threshold",
				tokenCount,
				toolsUsed,
			};
		}

		// High usage check
		if (tokenCount > 2000 && toolsUsed >= 3) {
			const tokensPerTool = tokenCount / toolsUsed;
			if (tokensPerTool > 1000) {
				return {
					shouldSummarize: true,
					reason: `High token-to-tool ratio: ${Math.round(tokensPerTool)} tokens/tool`,
					trigger: "high_usage",
					tokenCount,
					toolsUsed,
				};
			}
		}

		return {
			shouldSummarize: false,
			reason: `Below thresholds (tokens: ${tokenCount}/${this.config.threshold}, tools: ${toolsUsed}/${minTools})`,
			trigger: undefined,
			tokenCount,
			toolsUsed,
		};
	}

	/**
	 * Get the current configuration.
	 */
	getConfig(): AutoSummarizeConfig & Required<Omit<AutoSummarizeConfig, "enabled">> {
		return { ...this.config };
	}

	/**
	 * Update configuration.
	 */
	updateConfig(config: Partial<AutoSummarizeConfig>): void {
		const previousEnabled = this.config.enabled;

		if (config.enabled !== undefined) {
			this.config.enabled = config.enabled;
		}
		if (config.threshold !== undefined) {
			this.config.threshold = config.threshold;
		}
		if (config.minToolsUsed !== undefined) {
			this.config.minToolsUsed = config.minToolsUsed;
		}
		if (config.collapseContext !== undefined) {
			this.config.collapseContext = config.collapseContext;
		}

		// Emit event if enabled state changed
		if (config.enabled !== undefined && config.enabled !== previousEnabled) {
			this.eventEmitter?.emit("auto-summarize:toggled", {
				enabled: this.config.enabled,
				previousEnabled,
			} as AutoSummarizeToggledEventData);
		}
	}

	/**
	 * Get current threshold value.
	 */
	getThreshold(): number {
		return this.config.threshold;
	}

	/**
	 * Set token threshold.
	 */
	setThreshold(threshold: number): void {
		if (threshold < 0) {
			throw new Error("Threshold must be non-negative");
		}
		this.config.threshold = threshold;
	}

	/**
	 * Get current minToolsUsed value.
	 */
	getMinToolsUsed(): number {
		return this.config.minToolsUsed ?? 5;
	}

	/**
	 * Set minimum tools threshold.
	 */
	setMinToolsUsed(minTools: number): void {
		if (minTools < 0) {
			throw new Error("minToolsUsed must be non-negative");
		}
		this.config.minToolsUsed = minTools;
	}

	/**
	 * Check if context should be collapsed after summarization.
	 */
	shouldCollapseContext(): boolean {
		return this.config.collapseContext ?? true;
	}

	/**
	 * Set event emitter.
	 */
	setEventEmitter(eventEmitter: AutoSummarizeEventEmitter): void {
		this.eventEmitter = eventEmitter;
	}
}

/**
 * Decision result from shouldAutoSummarize check.
 */
export interface AutoSummarizeDecision {
	shouldSummarize: boolean;
	reason: string;
	trigger: AutoSummarizeTrigger | undefined;
	tokenCount: number;
	toolsUsed: number;
}

/**
 * Create an AutoSummarizeService with default options.
 */
export function createAutoSummarizeService(options?: AutoSummarizeServiceOptions): AutoSummarizeService {
	return new AutoSummarizeService(options);
}
