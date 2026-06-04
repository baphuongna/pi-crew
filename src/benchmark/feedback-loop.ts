/**
 * Feedback loop - continuous improvement cycle: evaluate → learn → apply → re-evaluate
 */

import type { RunMetrics } from "../state/run-metrics.ts";

/** @internal */
interface FeedbackLoopStats {
	runsObserved: number;
	avgSuccessRate: number;
	recommendations: string[];
}

/** @internal */
class FeedbackLoop {
	private runs: RunMetrics[] = [];
	private static readonly MAX_RUNS = 1000;

	/**
	 * Record a run's metrics for learning.
	 */
	recordRun(metrics: RunMetrics): void {
		this.runs.push(metrics);
		// Trim to MAX_RUNS to prevent unbounded memory growth
		if (this.runs.length > FeedbackLoop.MAX_RUNS) {
			this.runs = this.runs.slice(-FeedbackLoop.MAX_RUNS);
		}
	}

	/**
	 * Get current statistics and recommendations.
	 */
	getStats(): FeedbackLoopStats {
		if (this.runs.length === 0) {
			return {
				runsObserved: 0,
				avgSuccessRate: 0,
				recommendations: ["No runs observed yet. Run some workflows to gather data."],
			};
		}

		const successRates = this.runs.map((r) => (r.taskCount > 0 ? r.completedCount / r.taskCount : 0));
		const avg = successRates.reduce((a, b) => a + b, 0) / successRates.length;

		const recommendations: string[] = [];
		if (avg >= 0.9) {
			recommendations.push(`High success rate (${(avg * 100).toFixed(0)}%). Current configuration is working well.`);
		} else if (avg >= 0.7) {
			recommendations.push(`Moderate success rate (${(avg * 100).toFixed(0)}%). Consider reviewing failed tasks for patterns.`);
		} else {
			recommendations.push(`Low success rate (${(avg * 100).toFixed(0)}%). Investigate failure patterns.`);
		}

		// Cost awareness
		const avgCost = this.runs.reduce((a, b) => a + b.totalCost, 0) / this.runs.length;
		if (avgCost > 10) {
			recommendations.push(`Average cost per run: $${avgCost.toFixed(2)}. Consider optimization.`);
		}

		return {
			runsObserved: this.runs.length,
			avgSuccessRate: avg,
			recommendations,
		};
	}

	/**
	 * Clear recorded runs.
	 */
	clear(): void {
		this.runs = [];
	}
}