/**
 * Verification Integrity — manifest bookend snapshot helper (RFC §P1a).
 *
 * Hashes a FIXED set of project-manifest files so the goal loop can detect
 * drift between T_snap (before verification runs) and T_verify_done (after the
 * command exits). This closes the PERSISTENT-edit subcase of workspace
 * tampering (a worker that rewrites package.json / lockfile and leaves it
 * changed). See RFC §P1a / §6 STRIDE for the full threat model.
 *
 * RESIDUALS (documented; closed by Phase 1.5 git-worktree sandbox, NOT here):
 *  - Round-trip tamper: a worker can edit a manifest, run the test, then REVERT
 *    before T_verify_done so the hash matches T_snap. Content-addressed
 *    execution (git-worktree) is required to close this. Not fixable by hashing.
 *  - Invoked-script tampering: only the manifest files in MANIFEST_FILES are
 *    hashed. A worker that overwrites a script the verification command invokes
 *    is NOT caught. Phase 1.5 git-worktree closes this.
 *  - node_modules/ and transitive deps are deliberately NOT hashed (size +
 *    churn); package-lock.json IS hashed, which transitively pins resolved
 *    dependency versions.
 *
 * Pure leaf module: depends only on node: built-ins. Does NOT import
 * goal-loop-runner or goal-evaluator (keeps the P1a helper unit-testable in
 * isolation and avoids pulling the conflict-zone modules into this file).
 *
 * @module verification-integrity
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { logInternalError } from "../utils/internal-error.ts";

/**
 * Fixed set of project-manifest files considered by {@link snapshotManifests}.
 * Only files from this set that EXIST in the target directory are hashed.
 * (RFC §P1a: package.json, package-lock.json, pyproject.toml, setup.py,
 * Cargo.toml, Cargo.lock, go.mod, tsconfig.json.)
 */
export const MANIFEST_FILES = [
	"package.json",
	"package-lock.json",
	"pyproject.toml",
	"setup.py",
	"Cargo.toml",
	"Cargo.lock",
	"go.mod",
	"tsconfig.json",
] as const;

/**
 * sha256-hash the manifest files from the fixed set that EXIST in `cwd`.
 *
 * - Missing files are SKIPPED silently (not errors): a Python project has no
 *   package.json, a JS project has no Cargo.toml, etc.
 * - Non-regular files (directories, etc.) are skipped.
 * - node_modules is NEVER hashed.
 *
 * @returns A map of relative manifest path -> sha256 hex digest for each
 * present file. Stable key order = MANIFEST_FILES order (insertion order).
 */
export function snapshotManifests(cwd: string): Record<string, string> {
	const snapshot: Record<string, string> = {};
	for (const rel of MANIFEST_FILES) {
		const abs = path.join(cwd, rel);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(abs);
		} catch {
			continue; // missing file — skip gracefully
		}
		if (!stat.isFile()) continue; // directory / special — skip
		try {
			const content = fs.readFileSync(abs);
			snapshot[rel] = createHash("sha256").update(content).digest("hex");
		} catch (error) {
			logInternalError("verification-integrity.snapshot", error, `rel=${rel}`, "debug");
		}
	}
	return snapshot;
}

/**
 * Compare two snapshots and return the list of DRIFTED file paths.
 *
 * A file is considered drifted if:
 *  - its hash differs between `a` and `b`, OR
 *  - it is present in only one of the two snapshots (added or removed).
 *
 * @returns Sorted array of relative manifest paths that drifted. Identical
 * snapshots yield `[]`.
 */
export function compareSnapshot(a: Record<string, string>, b: Record<string, string>): string[] {
	const drifted = new Set<string>();
	for (const [key, hash] of Object.entries(a)) {
		const other = b[key];
		if (other === undefined) {
			drifted.add(key); // removed between a -> b
		} else if (other !== hash) {
			drifted.add(key); // content changed
		}
	}
	for (const key of Object.keys(b)) {
		if (a[key] === undefined) {
			drifted.add(key); // added between a -> b
		}
	}
	return [...drifted].sort();
}
