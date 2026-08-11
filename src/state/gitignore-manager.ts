/**
 * Manage .gitignore entries for the crew state directory.
 *
 * Supports BOTH layouts that `projectCrewRoot` (src/utils/paths.ts) can
 * resolve to:
 *   - `.crew/` (default, created when neither .crew/ nor .pi/ exists)
 *   - `.pi/teams/` (legacy layout, reused when .pi/ already exists)
 *
 * Before this fix (2026-08-10, improvement-plan G12), only `.crew/`
 * entries were written — so projects on the `.pi/teams/` layout silently
 * committed their run state, artifacts, and logs to git. The layout is
 * detected from the repo root (parent dir of the .gitignore path).
 *
 * Only adds entries if not already present; preserves existing content.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "./atomic-write.ts";

/**
 * Entries to add to .gitignore for the `.crew/` layout.
 *
 * - `/.crew/` and `/.crew` ignore the core state directory.
 * - Exceptions allow optional commit of artifacts/ and graphs/.
 */
const CREW_GITIGNORE_ENTRIES = [
	"/.crew/",
	"/.crew",
	"!.crew/artifacts/",
	"!.crew/graphs/",
	"!.crew/artifacts/.gitkeep",
	"!.crew/graphs/.gitkeep",
];

/**
 * Entries to add to .gitignore for the `.pi/teams/` legacy layout.
 *
 * `.pi/` is shared with other pi-crew-unrelated pi tooling, so we ignore
 * ONLY the specific pi-crew state subdirs rather than the whole `.pi/teams/`
 * tree. `artifacts/` and `graphs/` stay committable (mirroring the `.crew/`
 * exception policy).
 */
const PI_TEAMS_GITIGNORE_ENTRIES = [
	"/.pi/teams/state/",
	"/.pi/teams/cache/",
	"/.pi/teams/worktrees/",
	"/.pi/teams/imports/",
	"/.pi/teams/audit/",
	"!/.pi/teams/artifacts/",
	"!/.pi/teams/graphs/",
];

/**
 * Resolve which gitignore entry set applies. The repo root is the parent
 * directory of the `.gitignore` path. If `.crew/` exists there, use the
 * `.crew/` entries; else if `.pi/` exists, use the `.pi/teams/` entries;
 * else fall through to the default `.crew/` set (forward-looking for fresh
 * projects — the crew-init step will create `.crew/`).
 */
function resolveEntries(gitignorePath: string): string[] {
	const repoRoot = path.dirname(gitignorePath);
	try {
		if (fs.existsSync(path.join(repoRoot, ".crew"))) return CREW_GITIGNORE_ENTRIES;
		if (fs.existsSync(path.join(repoRoot, ".pi"))) return PI_TEAMS_GITIGNORE_ENTRIES;
	} catch {
		// Filesystem error — fall through to default. The crew-init step
		// creates .crew/ anyway, so the default entries are correct.
	}
	return CREW_GITIGNORE_ENTRIES;
}

/**
 * Update .gitignore with the appropriate crew entries. Creates the file if it
 * doesn't exist. Preserves all existing content.
 *
 * Layout detection: if `.pi/` exists at the repo root and `.crew/` does not,
 * the `.pi/teams/` entries are written instead (mirrors `projectCrewRoot`).
 */
export async function updateGitignore(gitignorePath: string): Promise<void> {
	const entries = resolveEntries(gitignorePath);

	if (!fs.existsSync(gitignorePath)) {
		atomicWriteFile(gitignorePath, entries.join("\n") + "\n");
		return;
	}

	const current = fs.readFileSync(gitignorePath, "utf-8");
	const existingLines = new Set(current.split("\n").map((line) => line.trim()));

	let appended = "";
	for (const entry of entries) {
		if (!existingLines.has(entry)) {
			appended += `\n${entry}`;
		}
	}

	if (appended) {
		// NEW-R5: atomic read-modify-write of the user-visible .gitignore — the old
		// writeFileSync left a truncate-then-write window (crash ⇒ empty/partial file)
		// and a TOCTOU race with concurrent readers. atomicWriteFile (temp+rename)
		// makes the final write atomic while preserving the read-append logic above.
		atomicWriteFile(gitignorePath, current + appended);
	}
}
