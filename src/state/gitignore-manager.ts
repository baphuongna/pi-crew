/**
 * Manage .gitignore entries for the .crew directory.
 * Only adds entries if not already present; preserves existing content.
 */
import * as fs from "node:fs";
import { atomicWriteFile } from "./atomic-write.ts";

/**
 * Entries to add to .gitignore for .crew directory management.
 *
 * - `/.crew/` and `/.crew` ignore the core state directory.
 * - Exceptions allow optional commit of artifacts/ and graphs/ (including their .gitkeep).
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
 * Update .gitignore with .crew entries. Creates the file if it doesn't exist.
 * Preserves all existing content.
 */
export async function updateGitignore(gitignorePath: string): Promise<void> {
	if (!fs.existsSync(gitignorePath)) {
		atomicWriteFile(gitignorePath, CREW_GITIGNORE_ENTRIES.join("\n") + "\n");
		return;
	}

	const current = fs.readFileSync(gitignorePath, "utf-8");
	const existingLines = new Set(current.split("\n").map((line) => line.trim()));

	let appended = "";
	for (const entry of CREW_GITIGNORE_ENTRIES) {
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
