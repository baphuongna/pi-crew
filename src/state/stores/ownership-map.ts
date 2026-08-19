/**
 * WP-1/R1 — Unified agent identity (H6): the ownership map store.
 *
 * One ownership map PER RUN, persisted at `<manifest.stateRoot>/ownership-map.json`
 * (stateRoot is already on `TeamRunManifest`). It records the
 * `task ⇄ subagentId ⇄ pid ⇄ artifactsDir` links that both spawn paths contribute:
 *   - one-shot Agent-tool spawn (subagent-tools.ts): taskId + subagentId + artifactsDir (+ depth)
 *   - team-run child executor dispatch (child-executor.ts, onSpawn hook): taskId + pid + artifactsDir
 *
 * Because the file is scoped to a single run, `withRunLockSync(manifest)` (which
 * locks `<stateRoot>/run.lock`) is the correct mutual-exclusion primitive: lock
 * scope === file scope, so two runs never contend on the same lock for this file.
 *
 * DESIGN DECISION (documented deviation from the explorer-2 sketch): a
 * workspace-wide map keyed by taskId was REJECTED because task ids are per-run
 * (createTaskId output repeats across runs) — a workspace-wide
 * `Record<taskId, entry>` would collide between concurrent runs, and a run-scoped
 * lock would not serialize a workspace-scoped file. Consequently ALL read/write
 * APIs are manifest-scoped; there is no cwd-only resolution path.
 *
 * Readers (widget/status/steer) use the read APIs, which are best-effort and
 * lock-free (mirroring the `loadRunManifestById` precedent). Writers never throw
 * (log + continue) — a failure must never break spawn/steer paths — and there is
 * no `throw` inside any `finally`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logInternalError } from "../../utils/internal-error.ts";
import { atomicWriteJson, flushPendingAtomicWrites } from "../atomic-write.ts";
import { withRunLockSync } from "../coordination/locks.ts";
import type { TeamRunManifest } from "../types.ts";

/** One ownership link: task ⇄ subagentId ⇄ pid ⇄ artifacts dir, per run. */
export interface OwnershipEntry {
	/** Key — team-run task id (createTaskId output; unique within a run). */
	taskId: string;
	/** The run this task belongs to (manifest.runId). */
	runId: string;
	/** Set by the one-shot Agent-tool spawn path (subagent-tools.ts). */
	subagentId?: string;
	/** Set by the child-executor onSpawn hook (real spawns only; last spawn
	 * attempt wins — model-fallback retries overwrite with the live pid). */
	pid?: number;
	/** manifest.artifactsRoot — where the task's steering/<taskId>.jsonl lives. */
	artifactsDir: string;
	/** Spawn depth (0 for a root one-shot). Optional for back-compat. */
	depth?: number;
	/** ISO-8601 timestamp; stamped at merge time when the caller omits it. */
	updatedAt?: string;
}

export interface OwnershipMapFile {
	version: 1;
	entries: Record<string, OwnershipEntry>;
}

/** Fresh empty map — NEVER a shared singleton: callers may mutate the returned
 * object's entries in upsert paths (fresh.entries[x] = ...), and a module-level
 * constant would leak that mutation across runs (review finding R3: cross-run
 * contamination of ownership-map.json). Allocate per call. */
function emptyOwnershipMap(): OwnershipMapFile {
	return { version: 1, entries: {} };
}

/** Per-run ownership-map file, co-located with manifest.json / tasks.json. */
export function ownershipMapPath(manifest: TeamRunManifest): string {
	return path.join(manifest.stateRoot, "ownership-map.json");
}

/**
 * Best-effort read of the ownership map. Lock-free (readers only). ENOENT and
 * corrupt JSON both yield the empty map — the store is regenerable, so it is
 * never quarantined (unlike manifest STATE-3 handling). Never throws.
 */
export function readOwnershipMap(manifest: TeamRunManifest): OwnershipMapFile {
	try {
		const raw = fs.readFileSync(ownershipMapPath(manifest), "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyOwnershipMap();
		const entries = (parsed as { entries?: unknown }).entries;
		if (!entries || typeof entries !== "object" || Array.isArray(entries)) return emptyOwnershipMap();
		return { version: 1, entries: entries as Record<string, OwnershipEntry> };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			logInternalError("ownership-map.read", error, ownershipMapPath(manifest), "warn");
		}
		return emptyOwnershipMap();
	}
}

/**
 * Upsert one entry under the run lock (withRunLockSync + fresh-reload pattern,
 * mirroring persistSingleTaskUpdate in state-helpers.ts).
 *
 * Merge-not-overwrite: only the provided fields change, so the one-shot writer
 * (subagentId) and the dispatch writer (pid) never clobber each other.
 * Fresh-reload INSIDE the lock (BUG-028 lesson) + atomicWriteJson (temp+rename)
 * keeps the write crash-safe. Best-effort: never throws into spawn/steer paths.
 */
export function upsertOwnershipEntry(manifest: TeamRunManifest, entry: OwnershipEntry): void {
	try {
		withRunLockSync(manifest, () => {
			// Defeat the atomic-write coalescer's stale-read window: force any
			// pending buffered write for THIS file to land before we reload.
			flushPendingAtomicWrites(ownershipMapPath(manifest));
			const fresh = readOwnershipMap(manifest);
			const prev = fresh.entries[entry.taskId] ?? {};
			const merged: OwnershipEntry = {
				...prev,
				...entry,
				taskId: entry.taskId,
				updatedAt: entry.updatedAt ?? new Date().toISOString(),
			};
			// Merge contract: undefined-valued fields mean "not provided" — never
			// persist them, or a later partial write (e.g. the dispatch writer
			// adding pid) would clobber a value set by the other spawn path
			// (e.g. subagentId). JSON.stringify would drop them anyway, but
			// filtering here keeps the in-memory merge honest.
			const clean = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as OwnershipEntry;
			fresh.entries[entry.taskId] = clean;
			atomicWriteJson(ownershipMapPath(manifest), fresh, { compact: true });
		});
	} catch (error) {
		// Best-effort — a failure here must not break the spawn/steer caller.
		logInternalError("ownership-map.write", error, `taskId=${entry.taskId}, runId=${entry.runId}`);
	}
}

/** Resolve an entry by its task id (the map's key). Lock-free read. */
export function resolveEntryByTaskId(manifest: TeamRunManifest, taskId: string): OwnershipEntry | undefined {
	return readOwnershipMap(manifest).entries[taskId];
}

/** Resolve an entry by subagent id (scan). Used by steer to find the taskId. */
export function resolveEntryBySubagentId(manifest: TeamRunManifest, subagentId: string): OwnershipEntry | undefined {
	const entries = readOwnershipMap(manifest).entries;
	for (const entry of Object.values(entries)) {
		if (entry.subagentId === subagentId) return entry;
	}
	return undefined;
}

/**
 * Explorer-2 contract alias for the dispatch writer: `recordOwnership(cwd,
 * manifest, entry)`. The per-run file location derives from the manifest alone
 * (task ids are per-run, so a cwd-only path cannot locate the map), so `cwd` is
 * retained only for caller ergonomics and is not used for path resolution.
 */
export function recordOwnership(_cwd: string, manifest: TeamRunManifest, entry: Partial<OwnershipEntry> & { taskId: string }): void {
	const merged: OwnershipEntry = {
		taskId: entry.taskId,
		runId: entry.runId ?? manifest.runId,
		artifactsDir: entry.artifactsDir ?? manifest.artifactsRoot,
		updatedAt: entry.updatedAt ?? new Date().toISOString(),
	};
	// Only carry through the fields the caller actually provided — an explicit
	// undefined must not clobber a value written by the other spawn path.
	if (entry.subagentId !== undefined) merged.subagentId = entry.subagentId;
	if (entry.pid !== undefined) merged.pid = entry.pid;
	if (entry.depth !== undefined) merged.depth = entry.depth;
	upsertOwnershipEntry(manifest, merged);
}
