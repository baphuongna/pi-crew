/**
 * spec-store.ts — workspace-level SpecRecord store (ADR-6 §1, WP-6 step 2).
 *
 * Layout: <projectCrewRoot(cwd)>/state/specs/<id>.json + a provenance sidecar
 * `<id>.trusted` marker. Provenance enforcement (ADR-6 §4, review P1):
 * - `saveSpecRecord(..., { userAction: true })` (CLI import / explicit user
 *   command) may persist kind:"manual" and mints the sidecar.
 * - The skill/worker path (`userAction: false`, the default) ALWAYS persists
 *   kind:"generated" + trusted:false regardless of the declared payload —
 *   a worker must never be able to author a record the strict gate re-runs.
 * - `isSpecTrusted` reads the SIDECAR, never the record's own fields — a
 *   hand-edited file claiming manual/trusted degrades to generated.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { projectCrewRoot } from "../../utils/paths.ts";
import { atomicWriteJson } from "../atomic-write.ts";
import type { SpecRecord, SpecSnapshot } from "../types.ts";

function specsDir(cwd: string): string {
	return path.join(projectCrewRoot(cwd), "state", "specs");
}

function recordPath(cwd: string, id: string): string {
	assertSafeSpecId(id);
	return path.join(specsDir(cwd), `${id}.json`);
}

function sidecarPath(cwd: string, id: string): string {
	assertSafeSpecId(id);
	return path.join(specsDir(cwd), `${id}.trusted`);
}

const SPEC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSafeSpecId(id: string): void {
	if (!SPEC_ID_PATTERN.test(id)) throw new Error(`Invalid spec id: ${id}`);
}

export interface SaveSpecOptions {
	/** Only USER-facing actions may persist manual/trusted (provenance mint). */
	userAction?: boolean;
}

export function saveSpecRecord(cwd: string, record: SpecRecord, options: SaveSpecOptions = {}): SpecRecord {
	assertSafeSpecId(record.id);
	const userAction = options.userAction === true;
	// Provenance enforcement: the worker/skill path can NEVER produce a
	// manual/trusted record, regardless of the declared payload. A USER action
	// on a manual record mints trust (the persisted `trusted` field is the
	// informational copy of the sidecar — the gate reads the sidecar).
	const persisted: SpecRecord = userAction
		? record.source.kind === "manual"
			? { ...record, trusted: true }
			: { ...record, trusted: false }
		: {
				...record,
				source: { ...record.source, kind: "generated" },
				trusted: false,
			};
	fs.mkdirSync(specsDir(cwd), { recursive: true });
	atomicWriteJson(recordPath(cwd, record.id), persisted);
	// Sidecar mint/teardown mirrors the persisted trust state.
	if (userAction && persisted.source.kind === "manual") {
		fs.writeFileSync(sidecarPath(cwd, record.id), `${new Date().toISOString()}\n`, "utf-8");
	} else {
		try {
			fs.unlinkSync(sidecarPath(cwd, record.id));
		} catch {
			/* absent — fine */
		}
	}
	return persisted;
}

export function loadSpecRecord(cwd: string, id: string): SpecRecord | undefined {
	try {
		const raw = fs.readFileSync(recordPath(cwd, id), "utf-8");
		const parsed = JSON.parse(raw) as SpecRecord;
		if (parsed.id !== id) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

/** Strict-gate trust check — reads the SIDECAR only (never record fields). */
export function isSpecTrusted(cwd: string, id: string): boolean {
	try {
		return fs.existsSync(sidecarPath(cwd, id));
	} catch {
		return false;
	}
}

/** Load every revision's latest? v1: the store keeps one file per id; the
 *  record's `version` + `revisionOf` carry the linkage (ADR-4 §1 pattern). */
export function listSpecIds(cwd: string): string[] {
	try {
		return fs
			.readdirSync(specsDir(cwd))
			.filter((f) => f.endsWith(".json"))
			.map((f) => f.slice(0, -".json".length))
			.filter((id) => SPEC_ID_PATTERN.test(id));
	} catch {
		return [];
	}
}

/** Freeze the current record into an immutable SpecSnapshot (dispatch time). */
export function freezeSpecSnapshot(record: SpecRecord): SpecSnapshot {
	return {
		specId: record.id,
		version: record.version,
		frozenAt: new Date().toISOString(),
		items: record.requirements.flatMap((requirement) =>
			record.acceptance.filter((a) => a.requirementId === requirement.id).map((acceptance) => ({ requirement, acceptance })),
		),
	};
}
