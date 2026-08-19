/**
 * T2/R4 (ADR-4 §7, erratum D-1) — `team action='plans'` handler.
 *
 * Read sub-actions (get/list/diff) render the revision list at
 * `<stateRoot>/plans/plans.json` with DERIVED per-item progress. Mutating
 * sub-actions (approve/reject) delegate to the existing api plan-approval ops
 * (approve-plan / cancel-plan), which already dual-write manifest + record
 * (ADR-4 §8) — one approval implementation, no drift.
 *
 * Usage:
 *   team action='plans' runId='<id>'                     → get (current rev)
 *   team action='plans' runId='<id>' config='{subAction:"get", rev:2}'
 *   team action='plans' runId='<id>' config='{subAction:"list"}'
 *   team action='plans' runId='<id>' config='{subAction:"diff", a:1, b:2}'
 *   team action='plans' runId='<id>' config='{subAction:"approve"}' | reject
 */
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { deriveItemProgress, getCurrentPlanRecord, loadPlanRecords } from "../../state/stores/plan-store.ts";
import { loadRunManifestById } from "../../state/stores/state-store.ts";
import type { PlanItemRecord, PlanRecord, TeamTaskState } from "../../state/types.ts";
import { handleTeamTool, locateRunCwd } from "../team-tool.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { result, type TeamContext } from "./context.ts";

const RUN_NOT_FOUND_HINT = "Use team action='list' to discover runs.";

function renderRecord(record: PlanRecord, tasks: TeamTaskState[]): string {
	const progress = deriveItemProgress(record, tasks);
	const lines: string[] = [];
	lines.push(`Plan ${record.id} v${record.version}${record.revisionOf ? ` (revision of v${record.revisionOf.version})` : ""}`);
	lines.push(`Title: ${record.title}`);
	lines.push(`Run: ${record.runId} · created ${record.createdAt}${record.authorTaskId ? ` · author task ${record.authorTaskId}` : ""}`);
	if (record.approval) {
		lines.push(
			`Approval: ${record.approval.status} (v${record.approval.planVersion}${record.approval.by ? ` by ${record.approval.by}` : ""} at ${record.approval.at})`,
		);
	}
	lines.push("");
	for (const phase of record.phases) {
		lines.push(`[${phase.status}] Phase ${phase.id} — ${phase.title} (${phase.itemIds.length} item(s))`);
		for (const itemId of phase.itemIds) {
			const item = record.items.find((i: PlanItemRecord) => i.id === itemId);
			if (!item) continue;
			const p = progress.get(item.id);
			const prog =
				p && p.total > 0
					? ` · ${p.done}/${p.total} done${p.failed ? `, ${p.failed} failed` : ""}${p.running ? `, ${p.running} running` : ""}`
					: "";
			lines.push(`  - [${item.status}] ${item.id}: ${item.title}${prog}`);
			if (item.taskIds.length > 0) lines.push(`      tasks: ${item.taskIds.join(", ")}`);
			if (item.acceptance.length > 0) lines.push(`      acceptance: ${item.acceptance.join("; ")}`);
		}
	}
	return lines.join("\n");
}

interface PlanDiff {
	added: string[];
	removed: string[];
	dropped: string[];
	statusChanged: Array<{ id: string; from: string; to: string }>;
	retitled: Array<{ id: string; from: string; to: string }>;
}

function diffRecords(a: PlanRecord, b: PlanRecord): PlanDiff {
	const aById = new Map(a.items.map((i) => [i.id, i]));
	const bById = new Map(b.items.map((i) => [i.id, i]));
	const diff: PlanDiff = { added: [], removed: [], dropped: [], statusChanged: [], retitled: [] };
	for (const [id, item] of bById) {
		const prior = aById.get(id);
		if (!prior) {
			diff.added.push(id);
			continue;
		}
		if (prior.status !== item.status) diff.statusChanged.push({ id, from: prior.status, to: item.status });
		if (prior.title !== item.title) diff.retitled.push({ id, from: prior.title, to: item.title });
		if (item.status === "dropped" && prior.status !== "dropped") diff.dropped.push(id);
	}
	for (const id of aById.keys()) if (!bById.has(id)) diff.removed.push(id);
	return diff;
}

function renderDiff(a: PlanRecord, b: PlanRecord): string {
	const diff = diffRecords(a, b);
	const lines = [
		`Diff v${a.version} → v${b.version} (${a.id})`,
		`  added:         ${diff.added.length ? diff.added.join(", ") : "—"}`,
		`  removed:       ${diff.removed.length ? diff.removed.join(", ") : "—"}`,
		`  dropped:       ${diff.dropped.length ? diff.dropped.join(", ") : "—"}`,
		`  status change: ${diff.statusChanged.length ? diff.statusChanged.map((s) => `${s.id} ${s.from}→${s.to}`).join(", ") : "—"}`,
		`  retitled:      ${diff.retitled.length ? diff.retitled.map((s) => `${s.id}`).join(", ") : "—"}`,
	];
	if (diff.added.length + diff.removed.length + diff.dropped.length + diff.statusChanged.length + diff.retitled.length === 0) {
		lines.push("  (no item-level changes)");
	}
	return lines.join("\n");
}

export async function handlePlans(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	const subAction = (typeof params.subAction === "string" && params.subAction.trim() ? params.subAction.trim() : "get") as
		| "get"
		| "list"
		| "diff"
		| "approve"
		| "reject";
	const runId = typeof params.runId === "string" && params.runId.trim() ? params.runId.trim() : "";
	if (!runId) return result("plans requires runId.", { action: "plans", status: "error" }, true);
	const runCwd = locateRunCwd(runId, ctx.cwd);
	const loaded = runCwd ? loadRunManifestById(runCwd, runId) : undefined;
	if (!loaded) return result(`Run '${runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "plans", status: "error" }, true);
	const { manifest, tasks } = loaded;

	// Mutating sub-actions delegate to the api plan-approval ops (single
	// implementation of the dual-write + permission checks).
	if (subAction === "approve" || subAction === "reject") {
		return await handleTeamTool(
			{
				action: "api",
				runId,
				config: { operation: subAction === "approve" ? "approve-plan" : "cancel-plan" },
			},
			{ cwd: runCwd ?? ctx.cwd },
		);
	}

	const revisions = loadPlanRecords(manifest);
	if (revisions.length === 0) {
		// ADR-4 §2 fallback: pre-v2 run — degrade gracefully, manifest gate info.
		const gate = manifest.planApproval;
		return result(
			`Run '${runId}' has no plan record (pre-v2 run).${gate ? ` Manifest gate: ${gate.status}${gate.required ? " (required)" : ""}.` : ""}`,
			{ action: "plans", status: "ok", runId },
		);
	}

	if (subAction === "list") {
		const lines = revisions.map(
			(r) =>
				`v${r.version} · ${r.createdAt} · ${r.items.length} item(s), ${r.items.filter((i) => i.status === "dropped").length} dropped · ${r.title}` +
				(r.approval ? ` · approval ${r.approval.status}` : ""),
		);
		const current = manifest.plan ? ` (current: v${manifest.plan.version})` : " (current: highest — no manifest pointer)";
		return result(`Plan revisions for ${runId}${current}:\n${lines.join("\n")}`, {
			action: "plans",
			status: "ok",
			runId,
			data: { revisions: revisions.length, current: manifest.plan?.version ?? revisions[revisions.length - 1]?.version },
		});
	}

	if (subAction === "diff") {
		const a = typeof params.a === "number" ? params.a : Number(params.a);
		const b = typeof params.b === "number" ? params.b : Number(params.b);
		if (!Number.isFinite(a) || !Number.isFinite(b)) {
			return result(
				"diff requires numeric revision params: config='{subAction:\"diff\", a:1, b:2}'.",
				{ action: "plans", status: "error" },
				true,
			);
		}
		const recA = revisions.find((r) => r.version === a);
		const recB = revisions.find((r) => r.version === b);
		if (!recA || !recB) {
			return result(
				`Revision(s) not found: available versions are ${revisions.map((r) => `v${r.version}`).join(", ")}.`,
				{ action: "plans", status: "error" },
				true,
			);
		}
		return result(renderDiff(recA, recB), { action: "plans", status: "ok", runId, data: { a, b } });
	}

	// get (default)
	const rev = params.rev === undefined ? undefined : Number(params.rev);
	const record = rev === undefined || Number.isNaN(rev) ? getCurrentPlanRecord(manifest) : revisions.find((r) => r.version === rev);
	if (!record) {
		return result(
			`Revision v${rev} not found: available versions are ${revisions.map((r) => `v${r.version}`).join(", ")}.`,
			{ action: "plans", status: "error" },
			true,
		);
	}
	return result(renderRecord(record, tasks), {
		action: "plans",
		status: "ok",
		runId,
		data: { planId: record.id, version: record.version, items: record.items.length },
	});
}
