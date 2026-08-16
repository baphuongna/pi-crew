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
		quarantineCorruptFile(tasksPath);
		const reconstructed = reconstructTasksFromEventLog(eventsPath, runId);
		if (reconstructed.length > 0) atomicWriteJson(tasksPath, reconstructed, { compact: true });
		return reconstructed;
	}
	if (!isRecognizableTasksPayload(parsed)) {
		// Neither v0 bare array nor v1+ envelope (e.g. `{}`) — corrupt.
		quarantineCorruptFile(tasksPath);
		const reconstructed = reconstructTasksFromEventLog(eventsPath, runId);
		if (reconstructed.length > 0) atomicWriteJson(tasksPath, reconstructed, { compact: true });
		return reconstructed;
	}
	return migrateTasksFile(parsed, runId);
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
	try {
		return JSON.parse(content) as TeamRunManifest;
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
		quarantineCorruptFile(tasksPath);
		const reconstructed = reconstructTasksFromEventLog(eventsPath, runId);
		if (reconstructed.length > 0) await atomicWriteJsonAsync(tasksPath, reconstructed, { compact: true });
		return reconstructed;
	}
	if (!isRecognizableTasksPayload(parsed)) {
		quarantineCorruptFile(tasksPath);
		const reconstructed = reconstructTasksFromEventLog(eventsPath, runId);
		if (reconstructed.length > 0) await atomicWriteJsonAsync(tasksPath, reconstructed, { compact: true });
		return reconstructed;
	}
	return migrateTasksFile(parsed, runId);
}
