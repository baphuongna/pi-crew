/**
 * Manifest/tasks load paths with corruption recovery and quarantine
 * (ST-4, ST-9, STATE-3). Extracted verbatim from state-store.ts (Phase 2.5
 * god-file decomposition — pure code motion, no behavior change).
 *
 * Import direction is one-way: state-store.ts imports from this module;
 * this module does NOT import values from state-store.ts.
 */
import * as fs from "node:fs";
import { logInternalError } from "../../utils/internal-error.ts";
import { atomicWriteJson, atomicWriteJsonAsync } from "../atomic-write.ts";
import { isTeamTaskStatus } from "../contracts.ts";
import { reconstructTasksFromEvents } from "../event-log/event-reconstructor.ts";
import type { TeamRunManifest, TeamTaskState } from "../types.ts";
import { CURRENT_TASKS_SCHEMA_VERSION } from "../types.ts";

/**
 * ST-4: Rename a corrupt file to a quarantine path (`.corrupt-<ts>`) so it is
 * preserved for debugging but no longer read as the primary source of truth.
 */
/** @internal — Phase 2.5 split: also used by state-store.ts (loadRunManifestById loaders). */
export function quarantineCorruptFile(filePath: string): void {
	try {
		fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
	} catch {
		// Best-effort — if rename fails (file already gone, permission, etc.),
		// we still proceed with reconstruction from the event log.
	}
}

/**
 * R39-M2 (fix-wave 6, EP3): per-run report of a tasks.json corruption recovery.
 * Corruption previously DROPPED tasks silently (events.jsonl only holds tasks
 * that already emitted events) and the run then reported "completed 100%" with
 * no trace of the loss. This record makes the loss observable.
 */
export interface TasksCorruptionReport {
	runId: string;
	/** Path the corrupt file was moved to (best-effort — may be empty on rename failure). */
	quarantinedPath: string;
	/** Number of tasks recovered from events.jsonl. */
	reconstructedCount: number;
	/** Number of task ids salvageable from the corrupt payload (best-effort). */
	salvagedCount: number;
	/** Task ids present in the corrupt payload that could NOT be recovered. */
	droppedIds: string[];
	at: number;
}

const tasksCorruptionReports = new Map<string, TasksCorruptionReport>();

/** R39-M2: the last tasks.json corruption report for a run, if any (this process). */
export function getTasksCorruptionReport(runId: string): TasksCorruptionReport | undefined {
	return tasksCorruptionReports.get(runId);
}

/** R39-M2: all tasks.json corruption reports recorded in this process. */
export function listTasksCorruptionReports(): TasksCorruptionReport[] {
	return [...tasksCorruptionReports.values()];
}

/** @internal test hook */
export function __test__clearTasksCorruptionReports(): void {
	tasksCorruptionReports.clear();
}

/**
 * R39-M2: best-effort salvage of task ids from a corrupt tasks.json payload.
 *
 * Scans for top-level (brace-depth 0) `{...}` objects — i.e. elements of the
 * bare-array write format — and keeps the `id` of every candidate that parses
 * as JSON. Nested objects (depth >= 1) are ignored, so an unrelated nested
 * `id` (routing/usage/etc.) cannot inflate the count. Returns [] for a payload
 * with no salvageable task objects (the total-loss case).
 */
export function salvageTaskIds(raw: string): string[] {
	const ids: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}" && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) {
				const candidate = raw.slice(start, i + 1);
				start = -1;
				try {
					const obj = JSON.parse(candidate) as { id?: unknown };
					if (obj && typeof obj.id === "string") ids.push(obj.id);
				} catch {
					/* partial/truncated object — not salvageable */
				}
			}
		}
	}
	return ids;
}

/**
 * R39-M2: shared corruption-recovery step for both sync and async load paths.
 * Quarantines, reconstructs from events, DETECTS + RECORDS the dropped task
 * count, and logs loudly so a silent task-drop can no longer masquerade as a
 * clean "completed 100%" run. Returns the reconstructed tasks (persisted by
 * the caller).
 */
function recoverCorruptTasks(tasksPath: string, eventsPath: string, runId: string, raw: string): TeamTaskState[] {
	const quarantinedPath = `${tasksPath}.corrupt-${Date.now()}`;
	quarantineCorruptFile(tasksPath);
	const reconstructed = reconstructTasksFromEventLog(eventsPath, runId);
	const reconstructedIds = new Set(reconstructed.map((task) => task.id));
	const salvagedIds = salvageTaskIds(raw);
	const droppedIds = salvagedIds.filter((id) => !reconstructedIds.has(id));

	tasksCorruptionReports.set(runId, {
		runId,
		quarantinedPath,
		reconstructedCount: reconstructed.length,
		salvagedCount: salvagedIds.length,
		droppedIds,
		at: Date.now(),
	});

	const dropDetail =
		droppedIds.length > 0
			? `; ${droppedIds.length} task(s) present in the corrupt file were NOT recoverable (dropped: ${droppedIds.join(",")}) — run state is DEGRADED`
			: " (no dropped task ids detected)";
	logInternalError(
		"state-store",
		new Error(
			`R39-M2: tasks.json for run ${runId} is corrupt — quarantined; reconstructed ${reconstructed.length} task(s) from events.jsonl${dropDetail}. Preserve the .corrupt-* file for diagnosis.`,
		),
		undefined,
		droppedIds.length > 0 ? "error" : "warn",
	);
	return reconstructed;
}

/**
 * ST-4: Convert event-reconstructor output into TeamTaskState[].
 * Reconstructed tasks carry lifecycle data (id, status, timing) from the
 * event log; auxiliary fields (role, agent, title) are filled with defaults
 * since they are not present in lifecycle events.
 */
function reconstructTasksFromEventLog(eventsPath: string, runId: string): TeamTaskState[] {
	try {
		const result = reconstructTasksFromEvents(eventsPath);
		const tasks: TeamTaskState[] = [];
		for (const [, rt] of result.tasks) {
			tasks.push({
				id: rt.id,
				runId,
				role: "unknown",
				agent: "unknown",
				title: "reconstructed from events",
				status: isTeamTaskStatus(rt.status) ? rt.status : "queued",
				dependsOn: [],
				cwd: "",
				startedAt: rt.startedAt,
				finishedAt: rt.finishedAt,
				error: rt.error,
				segment: rt.segment,
				diagnostics: rt.diagnostics,
				metrics: rt.metrics,
			});
		}
		return tasks;
	} catch {
		return [];
	}
}

/**
 * N3 (security-audit run-1, 2026-10-29 — w9 loader-level hardening):
 * tasks.json and manifest.json live under the shared-cwd state root, i.e. they
 * are same-uid writable by WRITE-role workers (verify-gate.ts treats shared-cwd
 * files as worker-mutable attacker input for exactly this reason). Before this
 * fix the load seam cast whatever JSON.parse produced straight to
 * TeamTaskState[]/TeamRunManifest, so poisoned fields flowed into resume /
 * crash-recovery dispatch as execution authority (forged role →
 * permissionForRole at pre-execution.ts:248; forged runKind selects the resume
 * engine at team-tool.ts:673). The validators below are the bounded,
 * backward-compatible answer: fail-closed on structurally poisoned entries
 * (drop, never crash the load), permissive on well-formed legacy state.
 * Provenance/integrity (HMAC) and role re-authorization vs team composition
 * are explicitly deferred (need secret-management + dispatch-side context).
 */

/** N3: loader DoG guard — a tasks array beyond this cap is truncated with an
 * anomaly log. The maxTasksPerRun admission gate (state-store) caps dispatch
 * cardinality; this bound merely stops an inflated file from dominating load
 * time / memory before admission ever runs. 10_000 mirrors the default
 * limits.maxTasksPerRun ceiling. */
export const MAX_LOADED_TASKS = 10_000;

const MAX_ANOMALY_EXAMPLES = 5;

/** N3: per-entry shape check — a plausible TeamTaskState is a non-null,
 * non-array object whose id/runId/role/agent/title/status are strings, whose
 * dependsOn is absent or an array of strings, and whose cwd is absent or a
 * string. Deliberately shape-only: values (role names, cwd targets, status
 * enums) are NOT re-authorized here — the loader has no dispatch-side context
 * for what the approved composition was. */
function plausibleTaskShape(entry: unknown): entry is TeamTaskState {
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
	const task = entry as Record<string, unknown>;
	if (typeof task.id !== "string") return false;
	if (typeof task.runId !== "string") return false;
	if (typeof task.role !== "string") return false;
	if (typeof task.agent !== "string") return false;
	if (typeof task.title !== "string") return false;
	if (typeof task.status !== "string") return false;
	if (task.dependsOn !== undefined) {
		if (!Array.isArray(task.dependsOn) || task.dependsOn.some((dep) => typeof dep !== "string")) return false;
	}
	if (task.cwd !== undefined && typeof task.cwd !== "string") return false;
	return true;
}

/**
 * N3: validate a tasks array loaded from disk before it re-enters dispatch.
 *
 * - Entries failing the plausible-shape check are DROPPED with an anomaly log
 *   (fail-closed on poison) instead of crashing the load or leaking through.
 * - Entries whose runId does not match the loading run's runId are DROPPED —
 *   mirrors the w3 DwfStore.load(expectedRunId) binding in
 *   dwf-state-store.ts: a foreign/stale/planted entry never hydrates as this
 *   run's execution authority.
 * - Arrays longer than {@link MAX_LOADED_TASKS} are truncated (DoG guard).
 *
 * Clean input is returned UNCHANGED (same array reference, same entry objects)
 * so legitimate legacy v0/v1 state loads byte-identical.
 */
/** @internal — exported for tests pinning the N3 loader contract. */
export function sanitizeLoadedTasks(tasks: TeamTaskState[], runId: string): TeamTaskState[] {
	const truncated = tasks.length > MAX_LOADED_TASKS;
	const limit = truncated ? MAX_LOADED_TASKS : tasks.length;
	const kept: TeamTaskState[] = [];
	const shapeInvalid: string[] = [];
	const foreignRunId: string[] = [];
	for (let i = 0; i < limit; i++) {
		const entry: unknown = tasks[i];
		if (!plausibleTaskShape(entry)) {
			const id = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? (entry as { id?: unknown }).id : undefined;
			shapeInvalid.push(typeof id === "string" ? id : `#${i}`);
			continue;
		}
		// RunId binding (entry.runId is a string — the shape check above already
		// failed entries without one, so legacy entries missing runId cannot
		// masquerade as this run's tasks either).
		if (entry.runId !== runId) {
			foreignRunId.push(entry.id);
			continue;
		}
		kept.push(entry);
	}
	if (truncated) {
		logInternalError(
			"state-store",
			new Error(
				`N3: tasks.json for run ${runId} holds ${tasks.length} entries — beyond the ${MAX_LOADED_TASKS} loader cap. Truncated to the first ${MAX_LOADED_TASKS} (dispatch admission caps are enforced separately).`,
			),
			undefined,
			"error",
		);
	}
	if (shapeInvalid.length > 0) {
		logInternalError(
			"state-store",
			new Error(
				`N3: ${shapeInvalid.length} task entr${shapeInvalid.length === 1 ? "y" : "ies"} in tasks.json for run ${runId} failed shape validation and ${shapeInvalid.length === 1 ? "was" : "were"} DROPPED (worker-writable state is untrusted input; example id(s): ${shapeInvalid.slice(0, MAX_ANOMALY_EXAMPLES).join(",")}).`,
			),
			undefined,
			"error",
		);
	}
	if (foreignRunId.length > 0) {
		logInternalError(
			"state-store",
			new Error(
				`N3: ${foreignRunId.length} task entr${foreignRunId.length === 1 ? "y" : "ies"} in tasks.json for run ${runId} carry a foreign runId and ${foreignRunId.length === 1 ? "was" : "were"} DROPPED (runId binding, mirrors DwfStore.load; example id(s): ${foreignRunId.slice(0, MAX_ANOMALY_EXAMPLES).join(",")}).`,
			),
			undefined,
			"error",
		);
	}
	return truncated || shapeInvalid.length > 0 || foreignRunId.length > 0 ? kept : tasks;
}

/** N3: the run kinds a persisted manifest may legally select. Unknown values
 * normalize to "team-run" (see sanitizeLoadedManifest) — matching the
 * `manifest.runKind ?? "team-run"` consumer at team-tool.ts:673, so a poisoned
 * runKind can only ever select the DEFAULT resume engine. */
const KNOWN_RUN_KINDS = new Set<string>(["team-run", "goal-loop", "dynamic-workflow"]);

/**
 * N3: validate a manifest loaded from disk before it re-enters dispatch.
 *
 * - A payload that is not a JSON object at all (null/number/string/array) is
 *   NOT a manifest → undefined (fail-closed; previously the raw cast was
 *   returned and downstream field access was undefined behavior).
 * - runKind is checked against {@link KNOWN_RUN_KINDS}: unknown values are
 *   normalized to "team-run" with a warn anomaly — deliberately NOT a throw,
 *   so poison degrades to the default engine instead of hiding the run.
 *   Absent runKind (legacy manifests) passes through unchanged: the consumer
 *   already defaults it.
 * - Identity fields (runId/stateRoot/tasksPath/eventsPath/artifactsRoot) are
 *   intentionally NOT re-checked here — validateRunManifestPaths
 *   (state-store.ts) already owns that contract.
 *
 * Clean input is returned UNCHANGED (same object reference); normalization
 * returns a shallow copy so parsed/cached objects are never mutated in place.
 */
/** @internal — exported for tests pinning the N3 loader contract. */
export function sanitizeLoadedManifest(manifest: TeamRunManifest | undefined, runId: string): TeamRunManifest | undefined {
	if (manifest === undefined) return undefined;
	const raw: unknown = manifest;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		logInternalError(
			"state-store",
			new Error(
				`N3: manifest.json for run ${runId} parsed to a non-object — not a manifest, failing closed (run treated as corrupt/missing).`,
			),
			undefined,
			"error",
		);
		return undefined;
	}
	const kind: unknown = (raw as { runKind?: unknown }).runKind;
	if (kind === undefined) return manifest;
	if (typeof kind === "string" && KNOWN_RUN_KINDS.has(kind)) return manifest;
	logInternalError(
		"state-store",
		new Error(
			`N3: manifest runKind ${JSON.stringify(kind)} for run ${runId} is not a known run kind (team-run|goal-loop|dynamic-workflow) — normalizing to 'team-run' so only the default resume engine can be selected.`,
		),
		undefined,
		"warn",
	);
	return { ...manifest, runKind: "team-run" };
}

/**
 * ST-4: Load tasks.json with corruption recovery (sync path).
 *
 * Distinguishes:
 * - ENOENT / ENOTDIR → legitimate empty → [] (NOT quarantined).
 * - SyntaxError (parse failure) → corrupt → quarantine `.corrupt-<ts>` AND
 *   reconstruct from events.jsonl. If reconstruction yields tasks, persist
 *   them so subsequent loads see a valid file.
 * - Non-array JSON (e.g. `{}`) → corrupt → same as SyntaxError.
 * - Valid array → return as-is.
 */

/**
 * ST-9: Extract the task array from a tasks.json payload.
 *
 * Accepts both the v0 legacy bare-array format and the v1+ envelope
 * `{ schemaVersion, tasks }`. Returns [] for unrecognized shapes.
 */
/** @internal — Phase 2.5 split: also used by state-store.ts (shouldPersistTasks). */
export function extractTaskArray(raw: unknown): TeamTaskState[] {
	if (Array.isArray(raw)) return raw as TeamTaskState[];
	if (raw !== null && typeof raw === "object" && "tasks" in raw) {
		const envelope = raw as { tasks?: unknown };
		if (Array.isArray(envelope.tasks)) return envelope.tasks as TeamTaskState[];
	}
	return [];
}

/**
 * ST-9: Whether `parsed` is a recognizable tasks.json shape (v0 bare array
 * or v1+ envelope). Used to distinguish legitimate formats from corruption.
 */
function isRecognizableTasksPayload(parsed: unknown): boolean {
	if (Array.isArray(parsed)) return true;
	if (parsed !== null && typeof parsed === "object" && "tasks" in parsed) {
		return Array.isArray((parsed as { tasks?: unknown }).tasks);
	}
	return false;
}

/**
 * ST-9: Version-check + migration hook for tasks.json.
 *
 * tasks.json has two on-disk shapes:
 * - v0 (current): bare JSON array `TeamTaskState[]` — what saveRunTasks*
 *   write today (backward-compatible; no schemaVersion envelope).
 * - v1+ (future): envelope `{ schemaVersion: number, tasks: TeamTaskState[] }`
 *   — read-supported defensively for a future write-side switch.
 *
 * This detects the shape and returns the task array. v0 needs NO migration
 * (it IS the current write format). For v1+ envelopes, a schemaVersion
 * mismatch warns (mirroring the manifest check). Future breaking changes
 * add real migration logic here.
 */
function migrateTasksFile(parsed: unknown, runId: string): TeamTaskState[] {
	// v0 current: bare array (no schemaVersion envelope) — what writers produce.
	if (Array.isArray(parsed)) {
		// v0 bare array is the CURRENT write format (saveRunTasks* write the
		// array directly, by design — backward compat). Nothing to migrate:
		// return as-is. (v1+ envelope read-support below is defensive, for a
		// future write-side switch.) Do NOT warn here — it would fire for 100%
		// of runs on every load and flood the UI on startup.
		return parsed as TeamTaskState[];
	}
	// v1+ envelope: { schemaVersion, tasks }.
	if (parsed !== null && typeof parsed === "object" && "tasks" in parsed) {
		const envelope = parsed as { schemaVersion?: unknown; tasks?: unknown };
		const detected = typeof envelope.schemaVersion === "number" ? envelope.schemaVersion : 0;
		if (detected !== CURRENT_TASKS_SCHEMA_VERSION) {
			// N3 note: schemaVersion mismatch stays WARN-ONLY deliberately —
			// forward compatibility is a design requirement (a newer-but-
			// well-formed tasks.json must still load). Field-level poison is
			// handled by sanitizeLoadedTasks (shape + runId binding + count cap)
			// downstream, NOT by version rejection.
			logInternalError(
				"state-store",
				new Error(
					`tasks.json schemaVersion mismatch: expected ${CURRENT_TASKS_SCHEMA_VERSION}, got ${detected}. Run ${runId} may be incompatible.`,
				),
				undefined,
				"warn",
			);
		}
	}
	return extractTaskArray(parsed);
}
export function loadTasksWithRecovery(tasksPath: string, eventsPath: string, runId: string): TeamTaskState[] {
	let content: string;
	try {
		content = fs.readFileSync(tasksPath, "utf-8");
	} catch {
		// ENOENT / ENOTDIR / other read errors → empty (retry loop handles
		// transient instability; ENOENT is a legitimate empty run).
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		// SyntaxError — corrupt file.
		const reconstructed = sanitizeLoadedTasks(recoverCorruptTasks(tasksPath, eventsPath, runId, content), runId);
		if (reconstructed.length > 0) atomicWriteJson(tasksPath, reconstructed, { compact: true });
		return reconstructed;
	}
	if (!isRecognizableTasksPayload(parsed)) {
		// Neither v0 bare array nor v1+ envelope (e.g. `{}`) — corrupt.
		const reconstructed = sanitizeLoadedTasks(recoverCorruptTasks(tasksPath, eventsPath, runId, content), runId);
		if (reconstructed.length > 0) atomicWriteJson(tasksPath, reconstructed, { compact: true });
		return reconstructed;
	}
	// N3: fail-closed validation of the migrated array before it re-enters
	// dispatch (shape-check + runId binding + count cap) — see
	// sanitizeLoadedTasks above.
	return sanitizeLoadedTasks(migrateTasksFile(parsed, runId), runId);
}

/**
 * STATE-3: Load manifest.json with corruption quarantine (sync). Distinguishes:
 * - ENOENT / read error → undefined (legitimate missing run — NOT quarantined).
 * - SyntaxError (unparseable) → CORRUPT → quarantine `.corrupt-<ts>` + log + undefined.
 *   Manifest CANNOT be reconstructed from events.jsonl (run.created only carries
 *   {team, workflow}), so quarantine + visible log is the recovery — do NOT attempt
 *   reconstruction (unlike loadTasksWithRecovery). This prevents a corrupt manifest
 *   from silently making a run invisible (STATE-3).
 */
export function loadManifestWithRecovery(manifestPath: string, runId: string): TeamRunManifest | undefined {
	let content: string;
	try {
		content = fs.readFileSync(manifestPath, "utf-8");
	} catch {
		// ENOENT / ENOTDIR / other read error → legitimate missing run.
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		// SyntaxError → corrupt manifest. Quarantine (preserve for diagnosis) + log,
		// then treat as missing. Do NOT reconstruct (infeasible from events).
		quarantineCorruptFile(manifestPath);
		logInternalError(
			"state-store",
			new Error(
				`STATE-3: manifest.json for run ${runId} is corrupt (unparseable) — quarantined to ${manifestPath}.corrupt-*. Run is now treated as missing. Preserve the .corrupt-* file for diagnosis.`,
			),
			undefined,
			"error",
		);
		return undefined;
	}
	// N3: a payload that parses but is not a JSON object (null/number/string/
	// array) is not a manifest — fail closed the same way as unparseable
	// (quarantine for diagnosis, run treated as missing).
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		quarantineCorruptFile(manifestPath);
		logInternalError(
			"state-store",
			new Error(
				`STATE-3/N3: manifest.json for run ${runId} is not a JSON object — quarantined to ${manifestPath}.corrupt-*. Run is now treated as missing. Preserve the .corrupt-* file for diagnosis.`,
			),
			undefined,
			"error",
		);
		return undefined;
	}
	// N3: runKind allowlist — unknown values normalize to "team-run" with a
	// warn anomaly (never a throw), matching the `?? "team-run"` consumer at
	// team-tool.ts:673.
	return sanitizeLoadedManifest(parsed as TeamRunManifest, runId);
}

/**
 * ST-4: async twin of {@link loadTasksWithRecovery}.
 */
/** @internal — Phase 2.5 split: async twin used by state-store.ts (loadRunManifestByIdAsync). */
export async function loadTasksWithRecoveryAsync(tasksPath: string, eventsPath: string, runId: string): Promise<TeamTaskState[]> {
	let content: string;
	try {
		content = await fs.promises.readFile(tasksPath, "utf-8");
	} catch {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		const reconstructed = sanitizeLoadedTasks(recoverCorruptTasks(tasksPath, eventsPath, runId, content), runId);
		if (reconstructed.length > 0) await atomicWriteJsonAsync(tasksPath, reconstructed, { compact: true });
		return reconstructed;
	}
	if (!isRecognizableTasksPayload(parsed)) {
		const reconstructed = sanitizeLoadedTasks(recoverCorruptTasks(tasksPath, eventsPath, runId, content), runId);
		if (reconstructed.length > 0) await atomicWriteJsonAsync(tasksPath, reconstructed, { compact: true });
		return reconstructed;
	}
	// N3: same fail-closed validation as the sync twin.
	return sanitizeLoadedTasks(migrateTasksFile(parsed, runId), runId);
}
