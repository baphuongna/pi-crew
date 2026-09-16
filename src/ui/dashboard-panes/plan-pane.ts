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
import { ACTIVE, formatHint, statusIcon } from "../rail.ts";

/**
 * The ONE plan-approval hint line (keys are case-SENSITIVE per
 * keybinding-map.ts:75 — `A` approves, `n` denies, `X` shows the revision
 * diff). `exactKeys` keeps the printed letters truthful; mapping them through
 * the default `keyToken` would advertise `N`, which is not bound.
 */
export const PLAN_APPROVAL_HINT = formatHint(
	[
		["A", "approve"],
		["n", "deny"],
	],
	{ exactKeys: true },
);

import type { RunUiSnapshot } from "../snapshot-types.ts";
import { PANE_THEME } from "./pane-theme.ts";

/**
 * Glyph vocabulary — RAIL (`src/ui/rail.ts`) owns it (design system §2.G).
 * `statusIcon()` covers every state rail names; the four task states it cannot
 * express — `◷` waiting, `⚠` attention, `⊘` cancelled, `·` skipped: rail
 * collapses all four into `○` — stay pane-local ON PURPOSE.
 */
const ITEM_GLYPH: Record<PlanItemStatus, string> = {
	pending: statusIcon("queued", PANE_THEME),
	active: ACTIVE,
	done: statusIcon("completed", PANE_THEME),
	dropped: statusIcon("failed", PANE_THEME),
};

const TASK_GLYPH: Record<string, string> = {
	queued: statusIcon("queued", PANE_THEME),
	running: ACTIVE,
	waiting: "◷",
	needs_attention: "⚠",
	completed: statusIcon("completed", PANE_THEME),
	failed: statusIcon("failed", PANE_THEME),
	cancelled: "⊘",
	skipped: "·",
};

function taskLine(task: TeamTaskState, indent: string): string {
	const glyph = TASK_GLYPH[task.status] ?? "?";
	// T3/R5 depth badge: grandchildren (depth 2+) surface explicitly so the
	// tree shows delegation nesting without another pane.
	const depth = typeof task.depth === "number" && task.depth > 1 ? ` d${task.depth}` : "";
	const role = task.displayName ?? task.role ?? "?";
	return `${indent}${glyph} ${task.id ?? "?"}${depth} ${role} [${task.status}]`;
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
	// Disk-sourced plan records are NOT schema-validated at read time — every
	// array/field below is guarded (`?? []` / `?? "?"`).
	const prevItems = new Map((previous.items ?? []).map((i) => [i.id, i]));
	const lines = [`Plan diff: v${previous.version} → v${current.version}`];
	for (const item of current.items ?? []) {
		const before = prevItems.get(item.id);
		if (!before) {
			lines.push(`  + ${item.id} ${item.title ?? "?"} [${item.status}]`);
			continue;
		}
		const beforeTasks = before.taskIds?.length ?? 0;
		const currentTasks = item.taskIds?.length ?? 0;
		if (before.status !== item.status || beforeTasks !== currentTasks) {
			lines.push(`  ~ ${item.id} ${item.title ?? "?"} [${before.status}→${item.status} · ${beforeTasks}→${currentTasks} tasks]`);
		}
		prevItems.delete(item.id);
	}
	for (const dropped of prevItems.values()) {
		lines.push(`  - ${dropped.id} ${dropped.title ?? "?"} (dropped in v${current.version})`);
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
	// Disk-sourced plan records are NOT schema-validated at read time.
	const phases = current.phases ?? [];
	const items = current.items ?? [];
	const itemById = new Map(items.map((i) => [i.id, i]));

	const pending = isPlanApprovalPending(snapshot.manifest);
	const header = `Plan pane: ${current.title ?? "?"} @v${current.version} (${phases.length} phases · ${items.length} items)`;
	// Hint join format is the rail one (` · `, close/deny last). NOT routed
	// through `formatHint` (yet): its `keyToken` upper-cases a bare letter
	// (`n` → `N`) and the locked pane test
	// (test/unit/ui/plan-ui-slice.test.ts:159) asserts the lowercase spelling —
	// see the E3 report / leader decision needed.
	const approval = pending ? [`⚠ plan approval pending — ${PLAN_APPROVAL_HINT}`] : [];

	const lines: string[] = [header, ...approval];
	for (const phase of phases) {
		const glyph = ITEM_GLYPH[phase.status] ?? "?";
		lines.push(`${glyph} ${phase.title ?? "?"}`);
		for (const itemId of phase.itemIds ?? []) {
			const item = itemById.get(itemId);
			if (!item) continue;
			const p = progress.get(itemId);
			const counts = p ? ` ${p.done}/${p.total}${p.failed ? ` ✗${p.failed}` : ""}${p.running ? ` ▸${p.running}` : ""}` : "";
			const droppedTag = item.status === "dropped" ? " ✗ dropped" : "";
			lines.push(`  ${ITEM_GLYPH[item.status] ?? "?"} ${item.title ?? "?"}${counts}${droppedTag}`);
			for (const taskId of item.taskIds ?? []) {
				const task = tasksById.get(taskId);
				if (task) lines.push(taskLine(task, "    "));
			}
		}
	}
	// Items not linked to any phase (producer-free-format plans) — still visible.
	const phased = new Set(phases.flatMap((p) => p.itemIds ?? []));
	const orphans = items.filter((i) => !phased.has(i.id));
	if (orphans.length) {
		lines.push("(unphased)");
		for (const item of orphans) {
			const p = progress.get(item.id);
			const droppedTag = item.status === "dropped" ? " ✗ dropped" : "";
			lines.push(`  ${ITEM_GLYPH[item.status] ?? "?"} ${item.title ?? "?"}${p ? ` ${p.done}/${p.total}` : ""}${droppedTag}`);
		}
	}
	lines.push(formatHint([["X", "revision diff"]]));
	return lines;
}
