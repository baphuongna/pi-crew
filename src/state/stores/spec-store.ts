/**
 * spec-store.ts — SpecRecord store + provenance mint (ADR-6 §1/§4, WP-6 step 2;
 * round-1 security fix: provenance v2).
 *
 * TWO stores, split by trust:
 * - WORKSPACE store `<projectCrewRoot(cwd)>/state/specs/<id>.json` — the
 *   generated/worker-influenced store. NEVER trusted by the strict gate.
 * - USER store `~/.pi/agent/specs/<projectSlug>/<id>.json` — the ONLY store a
 *   user action (CLI import / explicit command) mints into. Trust lives here
 *   because `.crew/state/` is worker-writable runtime state: any prompt-injected
 *   worker can write a workspace `*.json` + `*.trusted` pair (round-1 P1).
 *   Raising the anchor out of the workspace makes workspace tampering
 *   structurally insufficient — no documented worker path writes `~/.pi/agent/specs`.
 *
 * Digest-bound sidecar: the user-store `<id>.trusted` marker contains the
 * sha-256 of the canonical record JSON. `isSpecTrusted` verifies the binding,
 * so editing a legitimately-minted record while keeping its real sidecar
 * (content-swap attack) degrades to untrusted. Residual (documented in ADR
 * erratum): a fully malicious same-user process can forge both files in
 * `~/.pi/agent/specs` — but such a process already has arbitrary exec as the
 * user; the gate defends against prompt-injected WORKERS via documented paths.
 *
 * Trust is evaluated ONCE at freeze (dispatch): `freezeSpecSnapshot` records
 * `trustedAtFreeze` into the snapshot, and the strict gate reads ONLY that
 * frozen bit — post-freeze mint/delete cannot affect a running task (TOCTOU
 * window closed, round-1 P1 variant c).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { projectCrewRoot } from "../../utils/paths.ts";
import { atomicWriteJson } from "../atomic-write.ts";
import type { SpecRecord, SpecSnapshot } from "../types.ts";

function specsDir(cwd: string): string {
	return path.join(projectCrewRoot(cwd), "state", "specs");
}

function userSpecsDir(cwd: string): string {
	const slugSource = (() => {
		try {
			return fs.realpathSync(path.resolve(cwd));
		} catch {
			return path.resolve(cwd);
		}
	})();
	const slug = createHash("sha256").update(slugSource).digest("hex").slice(0, 16);
	return path.join(os.homedir(), ".pi", "agent", "specs", slug);
}

function recordPath(dir: string, id: string): string {
	assertSafeSpecId(id);
	return path.join(dir, `${id}.json`);
}

function sidecarPath(dir: string, id: string): string {
	assertSafeSpecId(id);
	return path.join(dir, `${id}.trusted`);
}

const SPEC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSafeSpecId(id: string): void {
	if (!SPEC_ID_PATTERN.test(id)) throw new Error(`Invalid spec id: ${id}`);
}

/** Stable canonical JSON (sorted keys, recursive) — the digest basis. */
export function canonicalSpecJson(value: unknown): string {
	const sort = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(sort);
		if (v && typeof v === "object") {
			return Object.fromEntries(
				Object.entries(v as Record<string, unknown>)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([k, val]) => [k, sort(val)]),
			);
		}
		return v;
	};
	return JSON.stringify(sort(value));
}

export interface SaveSpecOptions {
	/** Only USER-facing actions (CLI import / explicit user command) may mint. */
	userAction?: boolean;
}

export function saveSpecRecord(cwd: string, record: SpecRecord, options: SaveSpecOptions = {}): SpecRecord {
	assertSafeSpecId(record.id);
	const userAction = options.userAction === true;
	if (userAction && record.source.kind === "manual") {
		// USER store mint — the only trusted path. persisted.trusted mirrors the
		// digest sidecar (informational); the gate reads the sidecar digest.
		const persisted: SpecRecord = { ...record, trusted: true };
		const dir = userSpecsDir(cwd);
		fs.mkdirSync(dir, { recursive: true });
		atomicWriteJson(recordPath(dir, record.id), persisted);
		const digest = createHash("sha256").update(canonicalSpecJson(persisted), "utf8").digest("hex");
		fs.writeFileSync(sidecarPath(dir, record.id), `${digest}\n`, "utf-8");
		return persisted;
	}
	// Workspace store — the worker/skill path AND user-imported generated
	// records. ALWAYS persisted generated + untrusted regardless of payload.
	const persisted: SpecRecord = {
		...record,
		source: { ...record.source, kind: "generated" },
		trusted: false,
	};
	fs.mkdirSync(specsDir(cwd), { recursive: true });
	atomicWriteJson(recordPath(specsDir(cwd), record.id), persisted);
	// Teardown any stale workspace sidecar (defense in depth: a hand-forged
	// workspace sidecar must never resurrect trust).
	try {
		fs.unlinkSync(sidecarPath(specsDir(cwd), record.id));
	} catch {
		/* absent — fine */
	}
	return persisted;
}

function readRecordAt(file: string, id: string): SpecRecord | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as SpecRecord;
		if (parsed?.id !== id) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

/** User store first (authoritative for trusted specs), then workspace.
 *  Invalid/unsafe ids degrade to undefined (read path never throws). */
export function loadSpecRecord(cwd: string, id: string): SpecRecord | undefined {
	if (!SPEC_ID_PATTERN.test(id)) return undefined;
	const fromUser = readRecordAt(recordPath(userSpecsDir(cwd), id), id);
	if (fromUser) return fromUser;
	return readRecordAt(recordPath(specsDir(cwd), id), id);
}

/** Strict-gate trust check — USER-store sidecar exists AND its sha-256 digest
 *  binds to the record content. When `record` is provided (freeze path) the
 *  binding is checked against THAT record, killing the content-swap attack on
 *  legitimately-minted specs. */
export function isSpecTrusted(cwd: string, id: string, record?: SpecRecord): boolean {
	if (!SPEC_ID_PATTERN.test(id)) return false;
	const dir = userSpecsDir(cwd);
	const candidate = record ?? readRecordAt(recordPath(dir, id), id);
	if (!candidate) return false;
	try {
		const sidecar = fs.readFileSync(sidecarPath(dir, id), "utf-8").trim();
		const digest = createHash("sha256").update(canonicalSpecJson(candidate), "utf8").digest("hex");
		return sidecar === digest;
	} catch {
		return false;
	}
}

export function listSpecIds(cwd: string): string[] {
	const ids = new Set<string>();
	for (const dir of [userSpecsDir(cwd), specsDir(cwd)]) {
		try {
			for (const f of fs.readdirSync(dir)) {
				if (!f.endsWith(".json")) continue;
				const id = f.slice(0, -".json".length);
				if (SPEC_ID_PATTERN.test(id)) ids.add(id);
			}
		} catch {
			/* absent dir — fine */
		}
	}
	return [...ids];
}

/** Freeze the current record into an immutable SpecSnapshot (dispatch time).
 *  `trustedAtFreeze` is decided HERE — the strict gate never re-reads the live
 *  sidecar, so post-freeze mint/delete cannot change a running task's trust. */
export function freezeSpecSnapshot(record: SpecRecord, cwd: string): SpecSnapshot {
	return {
		specId: record.id,
		version: record.version,
		frozenAt: new Date().toISOString(),
		trustedAtFreeze: isSpecTrusted(cwd, record.id, record),
		items: record.requirements.flatMap((requirement) =>
			record.acceptance.filter((a) => a.requirementId === requirement.id).map((acceptance) => ({ requirement, acceptance })),
		),
	};
}
