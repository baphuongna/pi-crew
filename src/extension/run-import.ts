import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_PATHS } from "../config/defaults.ts";
import { type ConflictReport, detectImportConflicts } from "../runtime/delta-conflict.ts";
import { atomicWriteFile } from "../state/atomic-write.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { projectCrewRoot, userCrewRoot } from "../utils/paths.ts";
import { assertSafePathId, resolveContainedRelativePath, resolveRealContainedPath } from "../utils/safe-paths.ts";
import { assertRunBundle } from "./run-bundle-schema.ts";

export interface ImportedRunBundleInfo {
	runId: string;
	importedAt: string;
	bundlePath: string;
	summaryPath: string;
	conflictReport?: ConflictReport;
}

function importRoot(cwd: string, scope: "project" | "user"): string {
	const base = scope === "project" ? projectCrewRoot(cwd) : userCrewRoot();
	// SECURITY NOTE: `DEFAULT_PATHS.state.importsSubdir` is a constant (not user-controlled).
	// If this constant ever becomes user-influenced, this function could become a path
	// traversal risk. Always keep `importsSubdir` as a hardcoded constant. Do NOT accept
	// `importsSubdir` as a parameter or from config.
	return path.join(base, DEFAULT_PATHS.state.importsSubdir);
}

export function importRunBundle(cwd: string, bundlePath: string, scope: "project" | "user" = "project"): ImportedRunBundleInfo {
	const resolvedPath = path.isAbsolute(bundlePath) ? bundlePath : path.resolve(cwd, bundlePath);
	// Path containment: use resolveRealContainedPath for canonical real-path check
	// to prevent symlink/../ bypass of the startsWith string comparison.
	const allowedBases: string[] = [];
	try {
		allowedBases.push(userCrewRoot());
	} catch {
		/* ignore */
	}
	try {
		allowedBases.push(projectCrewRoot(cwd));
	} catch {
		/* ignore */
	}
	allowedBases.push(cwd); // always include cwd last (highest priority)
	let isContained = false;
	for (const base of allowedBases) {
		try {
			resolveRealContainedPath(base, resolvedPath);
			isContained = true;
			break;
		} catch {
			/* not contained — try next base */
		}
	}
	if (!isContained) throw new Error(`Import path must be within project directory or crew root: ${resolvedPath}`);
	const raw = JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as unknown;
	assertRunBundle(raw);

	// Integrity check: verify SHA-256 hash if present in manifest.
	// SECURITY NOTE: This SHA-256 is a CORRUPTION-DETECTION hash only — it
	// detects accidental bit-rot or truncation during transfer. It is NOT an
	// authenticity or tamper-resistance guarantee: the hash is stored INSIDE the
	// bundle (self-referential), so an attacker who can modify the bundle file
	// can also recompute and embed a matching hash. For tamper-evidence, an
	// external HMAC or detached signature would be needed (out of scope).
	// Blast radius is bounded: imports write to imports/<runId>/ only, execute
	// no code, and are validated by isContained + assertSafePathId.
	const bundleJson = fs.readFileSync(resolvedPath, "utf-8");
	const parsedForHash = JSON.parse(bundleJson) as {
		manifest?: { sha256?: string };
	};
	if (parsedForHash.manifest?.sha256) {
		const expectedHash = parsedForHash.manifest.sha256;
		// Recompute hash by stringifying the bundle without the sha256 field
		const { sha256: _sha256, ...manifestWithoutHash } = parsedForHash.manifest as Record<string, unknown> & {
			sha256?: string;
		};
		const bundleForHash = {
			...parsedForHash,
			manifest: manifestWithoutHash,
		};
		const recomputedHash = crypto.createHash("sha256").update(JSON.stringify(bundleForHash)).digest("hex");
		if (recomputedHash !== expectedHash) {
			throw new Error(`Integrity check failed: SHA-256 mismatch. Expected ${expectedHash}, got ${recomputedHash}`);
		}
	}

	const runId = assertSafePathId("runId", raw.manifest.runId);
	const importedAt = new Date().toISOString();

	// FIND-11: audit the import for security traceability. The SHA-256 check
	// above is corruption-detection only (NOT authenticity/tamper-resistance) —
	// a tampered bundle carries a matching/absent hash. Use "warn" severity so
	// this ALWAYS emits ("debug" is gated behind PI_TEAMS_DEBUG → no-op in prod).
	logInternalError(
		"security.bundle_imported",
		new Error("bundle imported"),
		`runId="${runId}" source="${resolvedPath}" scope="${scope}"`,
		"warn",
	);

	// Non-blocking conflict detection: compare incoming bundle against any existing state.
	let conflictReport: ConflictReport | undefined;
	try {
		const existingManifestPath = path.join(importRoot(cwd, scope), runId, "run-export.json");
		if (fs.existsSync(existingManifestPath)) {
			const existingRaw = JSON.parse(fs.readFileSync(existingManifestPath, "utf-8")) as {
				manifest?: Record<string, unknown>;
				tasks?: unknown[];
			};
			conflictReport = detectImportConflicts(
				{
					manifest: raw.manifest as unknown as Record<string, unknown>,
					tasks: raw.tasks as unknown[],
				},
				{ manifest: existingRaw.manifest, tasks: existingRaw.tasks },
			);
		}
	} catch {
		// Conflict detection is best-effort; do not block import on failure.
	}

	const importsRoot = importRoot(cwd, scope);
	fs.mkdirSync(importsRoot, { recursive: true });
	if (fs.lstatSync(importsRoot).isSymbolicLink()) throw new Error(`Invalid import root: ${importsRoot}`);
	resolveRealContainedPath(path.dirname(importsRoot), path.basename(importsRoot));
	const root = resolveContainedRelativePath(importsRoot, runId, "runId");
	fs.mkdirSync(root, { recursive: true });
	// TOCTOU note: mkdirSync would throw EEXIST if a symlink already existed.
	// The lstatSync check catches a symlink swapped in between mkdirSync and the check
	// (theoretically possible but requires local attacker with exact timing).
	// resolveRealContainedPath provides an additional real-path containment barrier.
	if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`Invalid import directory: ${root}`);
	resolveRealContainedPath(importsRoot, runId);
	const targetJson = path.join(root, "run-export.json");
	const targetSummary = path.join(root, "README.md");
	for (const target of [targetJson, targetSummary]) {
		if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(`Invalid import target: ${target}`);
	}
	atomicWriteFile(targetJson, `${JSON.stringify({ ...raw, importedAt, importedFrom: resolvedPath }, null, 2)}\n`);
	atomicWriteFile(
		targetSummary,
		[
			`# Imported pi-crew run ${runId}`,
			"",
			`Imported: ${importedAt}`,
			`Source: ${resolvedPath}`,
			`Original export: ${raw.exportedAt}`,
			`Status: ${raw.manifest.status}`,
			`Team: ${raw.manifest.team}`,
			`Workflow: ${raw.manifest.workflow ?? "(none)"}`,
			`Goal: ${raw.manifest.goal}`,
			"",
			"## Tasks",
			...raw.tasks.map(
				(task) => `- ${task.id}: ${task.status} (${task.role} -> ${task.agent})${task.error ? ` - ${task.error}` : ""}`,
			),
			"",
		].join("\n"),
	);
	return {
		runId,
		importedAt,
		bundlePath: targetJson,
		summaryPath: targetSummary,
		...(conflictReport?.hasConflicts ? { conflictReport } : {}),
	};
}
