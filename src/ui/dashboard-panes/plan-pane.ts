/**
 * plan-pane.ts — dashboard pane 7 "Plan" (WP-7 / R7, H4).
 *
 * Tree: phase → item → tasks, with per-item progress derived from linked
 * tasks (deriveItemProgress) and a depth badge on grandchild tasks (depth>1,
 * T3/R5). Approval pending → `A approve · n deny` hint line (same actions the
 * progress pane exposes — plan-approve/plan-deny are pane-scoped to BOTH
 * panes in keybinding-map). `X` toggles the multi-revision diff view
 * (pane-scoped; V collides with root liveConversation, e with root events —
 * X verified free).
 *
 * Flag-off: the dashboard never mounts this pane (key 7 still switches, but
 * the snapshot carries no plans slice — the pane degrades to a hint line).
 * Uncolored by design, mirroring the other dashboard panes.
 */

import { isPlanApprovalPending } from "../../runtime/plan-approval.ts";
import { deriveItemProgress } from "../../state/stores/plan-store.ts";
import type { PlanItemStatus, TeamTaskState } from "../../state/types.ts";
import type { RunUiSnapshot } from "../snapshot-types.ts";

const ITEM_GLYPH: Record<PlanItemStatus, string> = {
	pending: "○",
	active: "▸",
	done: "✓",
	dropped: "✗",
};

const TASK_GLYPH: Record<string, string> = {
	queued: "○",
	running: "▸",
	waiting: "◷",
	needs_attention: "⚠",
	completed: "✓",
	failed: "✗",
	cancelled: "⊘",
	skipped: "·",
};

function taskLine(task: TeamTaskState, indent: string): string {
	const glyph = TASK_GLYPH[task.status] ?? "?";
	// T3/R5 depth badge: grandchildren (depth 2+) surface explicitly so the
	// tree shows delegation nesting without another pane.
	const depth = typeof task.depth === "number" && task.depth > 1 ? ` d${task.depth}` : "";
	const role = task.displayName ?? task.role;
	return `${indent}${glyph} ${task.id}${depth} ${role} [${task.status}]`;
}

export interface PlanPaneOptions {
	/** X-toggled multi-revision diff view (current vs previous revision). */
	diff?: boolean;
}

/** Item-level diff between the current revision and its predecessor. */
export function planRevisionDiff(snapshot: RunUiSnapshot): string[] {
	const records = snapshot.plans ?? [];
	// Current = highest-version record in the SNAPSHOT slice (in-memory truth —
	// the pane must not re-read disk for what it already has).
	const current = records.length ? records.reduce((a, b) => (b.version > a.version ? b : a)) : undefined;
	if (!current) return ["Plan diff: no plan records"];
	const prevVersion = current.revisionOf?.version;
	const previous = prevVersion !== undefined ? records.find((r) => r.version === prevVersion) : undefined;
	if (!previous) {
		return [`Plan diff: v${current.version} has no prior revision`];
	}
	const prevItems = new Map(previous.items.map((i) => [i.id, i]));
	const lines = [`Plan diff: v${previous.version} → v${current.version}`];
	for (const item of current.items) {
		const before = prevItems.get(item.id);
		if (!before) {
			lines.push(`  + ${item.id} ${item.title} [${item.status}]`);
			continue;
		}
		if (before.status !== item.status || before.taskIds.length !== item.taskIds.length) {
			lines.push(
				`  ~ ${item.id} ${item.title} [${before.status}→${item.status} · ${before.taskIds.length}→${item.taskIds.length} tasks]`,
			);
		}
		prevItems.delete(item.id);
	}
	for (const dropped of prevItems.values()) {
		lines.push(`  - ${dropped.id} ${dropped.title} (dropped in v${current.version})`);
	}
	return lines;
}

export function renderPlanPane(snapshot: RunUiSnapshot, options: PlanPaneOptions = {}): string[] {
	const records = snapshot.plans;
	if (!records || records.length === 0) {
		// Flag-off or plan-less run — one honest line, no I/O.
		return ["Plan pane: no plan records (PI_CREW_PLAN_UI=1; plan-producing runs only)"];
	}
	if (options.diff) return planRevisionDiff(snapshot);

	// Highest-version record in the snapshot slice (no disk re-read).
	const current = records.reduce((a, b) => (b.version > a.version ? b : a));
	if (!current) return ["Plan pane: no plan records"];
	const progress = deriveItemProgress(current, snapshot.tasks);
	const tasksById = new Map(snapshot.tasks.map((t) => [t.id, t]));
	const itemById = new Map(current.items.map((i) => [i.id, i]));

	const pending = isPlanApprovalPending(snapshot.manifest);
	const header = `Plan pane: ${current.title} @v${current.version} (${current.phases.length} phases · ${current.items.length} items)`;
	const approval = pending ? ["⚠ plan approval pending — A approve · n deny"] : [];

	const lines: string[] = [header, ...approval];
	for (const phase of current.phases) {
		const glyph = ITEM_GLYPH[phase.status] ?? "?";
		lines.push(`${glyph} ${phase.title}`);
		for (const itemId of phase.itemIds) {
			const item = itemById.get(itemId);
			if (!item) continue;
			const p = progress.get(itemId);
			const counts = p ? ` ${p.done}/${p.total}${p.failed ? ` ✗${p.failed}` : ""}${p.running ? ` ▸${p.running}` : ""}` : "";
			const droppedTag = item.status === "dropped" ? " ✗ dropped" : "";
			lines.push(`  ${ITEM_GLYPH[item.status] ?? "?"} ${item.title}${counts}${droppedTag}`);
			for (const taskId of item.taskIds) {
				const task = tasksById.get(taskId);
				if (task) lines.push(taskLine(task, "    "));
			}
		}
	}
	// Items not linked to any phase (producer-free-format plans) — still visible.
	const phased = new Set(current.phases.flatMap((p) => p.itemIds));
	const orphans = current.items.filter((i) => !phased.has(i.id));
	if (orphans.length) {
		lines.push("(unphased)");
		for (const item of orphans) {
			const p = progress.get(item.id);
			const droppedTag = item.status === "dropped" ? " ✗ dropped" : "";
			lines.push(`  ${ITEM_GLYPH[item.status] ?? "?"} ${item.title}${p ? ` ${p.done}/${p.total}` : ""}${droppedTag}`);
		}
	}
	lines.push("X revision diff");
	return lines;
}
