/**
 * panel-rows.ts — project the widget's run list into navigable panel rows.
 *
 * The order here MUST match what the widget paints, otherwise the cursor index
 * drifts from the visible rows and `enter`/`x` act on the wrong agent. Both
 * sides therefore call the same `orderWidgetAgents` helper; this module only
 * flattens the per-run sections into one list.
 */

import { isFinishedRunStatus } from "../../runtime/process-status.ts";
import { orderWidgetAgents } from "../widget/widget-renderer.ts";
import type { WidgetRun } from "../widget/widget-types.ts";
import type { PanelRow } from "./panel-selection.ts";

/**
 * Flatten runs → rows in paint order: per run, active agents (running > queued >
 * waiting) followed by the finished agents still inside their linger window.
 */
export function panelRowsFromRuns(runs: readonly WidgetRun[], now = Date.now()): PanelRow[] {
	const rows: PanelRow[] = [];
	for (const entry of runs) {
		const { active, finished } = orderWidgetAgents(entry, now);
		for (const agent of active) {
			rows.push({ runId: entry.run.runId, taskId: agent.taskId, finished: false, name: agent.agent });
		}
		for (const agent of finished) {
			rows.push({ runId: entry.run.runId, taskId: agent.taskId, finished: true, name: agent.agent });
		}
	}
	return rows;
}

/** True when the row's run has reached a terminal status (nothing left to cancel). */
export function isRunFinished(runs: readonly WidgetRun[], runId: string): boolean {
	const entry = runs.find((item) => item.run.runId === runId);
	return entry ? isFinishedRunStatus(entry.run.status) : true;
}
