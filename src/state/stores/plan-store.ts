/**
 * T2/R4 (ADR-4 docs/decisions/2026-08-17-plan-object.md) — first-class Plan
 * object: the revision-list store.
 *
 * One file per run at `<manifest.stateRoot>/plans/plans.json` holding an
 * APPEND-ONLY list of PlanRecord snapshots. Because the file is run-scoped,
 * `withRunLockSync(manifest)` is the correct mutual-exclusion primitive (lock
 * scope === file scope — same reasoning as ownership-map.ts).
 *
 * Write discipline:
 *  - Revision/approval mutations append an event (ADR-4 §9: plan.created /
 *    plan.revised / plan.approved / plan.rejected / plan.item.dropped).
 *  - The scheduler's `items[].taskIds` linkage (linkTaskToPlanItem) is a
 *    single-writer mutation of the CURRENT revision only and appends NO event
 *    (task dispatch already logs its own worker.* events).
 *  - Reads are lock-free: atomicWriteJson's tmp+rename means readers observe
 *    either the full old or the full new file, never a torn one.
 *
 * Migration (ADR-4 §2): `manifest.plan` is the pointer to the current
 * revision. If the pointer is absent but records exist (crash between the
 * plans.json append and the manifest save), `getCurrentPlanRecord` degrades to
 * the highest-version record — the crash window is benign. Readers that must
 * behave like the pre-v2 gate use `effectivePlanApprovalPending`
 * (plan-record-first, manifest-fallback).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logInternalError } from "../../utils/internal-error.ts";
import { atomicWriteJson } from "../atomic-write.ts";
import { withRunLockSync } from "../coordination/locks.ts";
import { appendEvent } from "../event-log/event-log.ts";
import type { PlanItemRecord, PlanRecord, TeamRunManifest, TeamTaskState } from "../types.ts";

interface PlanFile {
	version: 1;
	revisions: PlanRecord[];
}

const PLAN_SUBPATH = path.join("plans", "plans.json");

export function planFilePath(manifest: TeamRunManifest): string {
	return path.join(manifest.stateRoot, PLAN_SUBPATH);
}

/** Lock-free best-effort read: missing file → []; corrupt file → [] + internal
 *  error log (readers must degrade, never throw — `loadRunManifestById`
 *  precedent). Never returns a shared mutable object. */
export function loadPlanRecords(manifest: TeamRunManifest): PlanRecord[] {
	try {
		const raw = fs.readFileSync(planFilePath(manifest), "utf-8");
		const parsed = JSON.parse(raw) as Partial<PlanFile>;
		if (!parsed || !Array.isArray(parsed.revisions)) return [];
		return parsed.revisions.filter((r): r is PlanRecord => Boolean(r && r.id && typeof r.version === "number"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		logInternalError("plan-store.read-failed", err instanceof Error ? err : new Error(String(err)), `run=${manifest.runId}`);
		return [];
	}
}

/** Current revision = manifest.plan pointer when resolvable; else the highest
 *  version (benign crash-window fallback, header note). */
export function getCurrentPlanRecord(manifest: TeamRunManifest): PlanRecord | undefined {
	const revisions = loadPlanRecords(manifest);
	if (revisions.length === 0) return undefined;
	const pointer = manifest.plan;
	if (pointer) {
		const pointed = revisions.find((r) => r.id === pointer.id && r.version === pointer.version);
		if (pointed) return pointed;
	}
	return revisions.reduce((acc, r) => (r.version > acc.version ? r : acc), revisions[0] as PlanRecord);
}

function writePlanFile(manifest: TeamRunManifest, revisions: PlanRecord[]): void {
	const file: PlanFile = { version: 1, revisions };
	fs.mkdirSync(path.dirname(planFilePath(manifest)), { recursive: true });
	atomicWriteJson(planFilePath(manifest), file);
}

/** ADR-4 §3: item ids are unique per revision; carried-over items keep their
 *  id across revisions (producer contract checked here — duplicate ids reject
 *  the append rather than corrupt linkage). */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TITLE_MAX = 512;

/** Security hardening (review S4/S5): producer-supplied ids/titles are
 *  untrusted worker-influenced text — constrain charset/length at the store
 *  boundary so a poisoned record can't smuggle control chars, path
 *  separators, or unbounded blobs into downstream renders and events. */
function assertRecordWellFormed(record: PlanRecord): void {
	const ids = new Set<string>();
	for (const item of record.items) {
		if (!ID_PATTERN.test(item.id))
			throw new Error(`plan-store: item id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127} — got "${item.id.slice(0, 40)}"`);
		if (item.title.length > TITLE_MAX) throw new Error(`plan-store: item title exceeds ${TITLE_MAX} chars`);
		if (ids.has(item.id)) throw new Error(`plan-store: duplicate item id "${item.id}" in revision v${record.version}`);
		ids.add(item.id);
	}
	const known = new Set(record.items.map((i) => i.id));
	for (const phase of record.phases) {
		for (const itemId of phase.itemIds) {
			if (!known.has(itemId)) throw new Error(`plan-store: phase "${phase.id}" references unknown item "${itemId}"`);
		}
	}
}

/**
 * Append a new revision under the run lock (withRunLockSync + fresh reload).
 * Lineage rules: first record has version 1 and no revisionOf; later records
 * reuse the SAME id, version = last + 1, and revisionOf must match the last
 * revision (auto-filled when omitted). Throws on violation — callers are
 * producers inside team-runner and a corrupt lineage must fail loudly, not
 * silently fork history.
 * Returns the stored record. Emits `plan.created` (v1) or `plan.revised` (v2+).
 */
export function appendPlanRevision(manifest: TeamRunManifest, record: PlanRecord): PlanRecord {
	return withRunLockSync(manifest, () => {
		const revisions = loadPlanRecords(manifest);
		if (revisions.length === 0) {
			if (record.version !== 1) throw new Error(`plan-store: first revision must be v1, got v${record.version}`);
			if (record.revisionOf) throw new Error("plan-store: first revision must not set revisionOf");
		} else {
			const last = revisions[revisions.length - 1] as PlanRecord;
			if (record.id !== last.id) throw new Error(`plan-store: lineage break — expected id ${last.id}, got ${record.id}`);
			if (record.version !== last.version + 1)
				throw new Error(`plan-store: version must be ${last.version + 1}, got ${record.version}`);
			if (!record.revisionOf) record.revisionOf = { id: last.id, version: last.version };
			else if (record.revisionOf.id !== last.id || record.revisionOf.version !== last.version)
				throw new Error(`plan-store: revisionOf must point at v${last.version} of ${last.id}`);
			// ADR-4 §3 (review F1): item ids are stable across revisions — copy
			// carried-over linkage forward INTO the new revision before it becomes
			// current, under the same lock (producers never set taskIds; the union
			// here is the scheduler-side re-link step the ADR specifies).
			const carried = new Map(last.items.map((i) => [i.id, i.taskIds]));
			for (const item of record.items) {
				const prior = carried.get(item.id);
				if (prior) item.taskIds = [...new Set([...prior, ...item.taskIds])];
			}
		}
		assertRecordWellFormed(record);
		revisions.push(record);
		writePlanFile(manifest, revisions);
		const dropped = record.items.filter((i) => i.status === "dropped").length;
		appendEvent(manifest.eventsPath, {
			type: record.version === 1 ? "plan.created" : "plan.revised",
			runId: manifest.runId,
			message:
				record.version === 1
					? `Plan v1 created: ${record.items.length} item(s) in ${record.phases.length} phase(s)`
					: `Plan v${record.version} revised (${record.items.length} item(s), ${dropped} dropped)`,
			data: { planId: record.id, version: record.version, dropped },
		});
		return record;
	});
}

/**
 * ADR-4 §3 single-writer linkage: append a taskId to the CURRENT revision's
 * item (dedup; idempotent). Dropped items refuse linkage (they are never
 * re-dispatched). No event — see header. Returns true when the file changed.
 */
export function linkTaskToPlanItem(manifest: TeamRunManifest, itemId: string, taskId: string): boolean {
	return withRunLockSync(manifest, () => {
		const revisions = loadPlanRecords(manifest);
		if (revisions.length === 0) return false;
		const current = revisions[revisions.length - 1] as PlanRecord;
		const item = current.items.find((i: PlanItemRecord) => i.id === itemId);
		if (!item || item.status === "dropped" || item.taskIds.includes(taskId)) return false;
		item.taskIds.push(taskId);
		writePlanFile(manifest, revisions);
		return true;
	});
}

/**
 * ADR-4 §8 dual-write (record side): set approval on the current revision.
 * `planVersion` must match the current revision — approving a superseded
 * revision is a stale-write bug and throws. `plans reject` calls this with
 * status "rejected" AND writes manifest.planApproval.status = "cancelled"
 * (vocabulary mapping, §8). Emits plan.approved / plan.rejected.
 */
export function setPlanApproval(
	manifest: TeamRunManifest,
	approval: { status: "approved" | "rejected" | "pending"; by?: string; planVersion: number },
): PlanRecord | undefined {
	return withRunLockSync(manifest, () => {
		const revisions = loadPlanRecords(manifest);
		if (revisions.length === 0) return undefined;
		const current = revisions[revisions.length - 1] as PlanRecord;
		if (approval.planVersion !== current.version)
			throw new Error(`plan-store: approval targets v${approval.planVersion} but current is v${current.version}`);
		current.approval = {
			status: approval.status,
			by: approval.by,
			at: new Date().toISOString(),
			planVersion: approval.planVersion,
		};
		writePlanFile(manifest, revisions);
		// ADR-4 §9: events for approval MUTATIONS. `pending` emits none — the
		// request surface (ensurePlanApprovalRequested) appends its own
		// plan.approval_required event.
		if (approval.status !== "pending") {
			appendEvent(manifest.eventsPath, {
				type: approval.status === "approved" ? "plan.approved" : "plan.rejected",
				runId: manifest.runId,
				message: `Plan v${approval.planVersion} ${approval.status}${approval.by ? ` by ${approval.by}` : ""}`,
				data: { planId: current.id, version: approval.planVersion, status: approval.status },
			});
		}
		return current;
	});
}

/** Derived, never stored (ADR-4 §1): per-item progress from linked task statuses. */
export interface PlanItemProgress {
	itemId: string;
	total: number;
	done: number;
	failed: number;
	running: number;
	pending: number;
}

export function deriveItemProgress(record: PlanRecord, tasks: TeamTaskState[]): Map<string, PlanItemProgress> {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const out = new Map<string, PlanItemProgress>();
	for (const item of record.items) {
		const p: PlanItemProgress = { itemId: item.id, total: item.taskIds.length, done: 0, failed: 0, running: 0, pending: 0 };
		for (const taskId of item.taskIds) {
			const status = byId.get(taskId)?.status;
			if (status === "completed") p.done++;
			else if (status === "failed") p.failed++;
			else if (status === "running" || status === "waiting" || status === "needs_attention") p.running++;
			else if (status === "queued") p.pending++;
			// cancelled/skipped: linked but resolved neither done nor pending — counted
			// in `total` only (honest derivation; re-plan drops land here).
		}
		out.set(item.id, p);
	}
	return out;
}
