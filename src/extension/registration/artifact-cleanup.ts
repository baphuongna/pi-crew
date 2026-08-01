import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_ARTIFACT_CLEANUP, DEFAULT_PATHS } from "../../config/defaults.ts";
import { CLEANUP_MARKER_FILE, cleanupOldArtifacts, pruneExpiredArtifacts } from "../../state/artifact-store.ts";
import type { ArtifactDescriptor, TeamRunManifest } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { projectCrewRoot, userCrewRoot } from "../../utils/paths.ts";

/**
 * ST-10: Load artifact descriptors from all manifests in a runs directory.
 * Returns a flat list of every ArtifactDescriptor across all runs.
 * Best-effort: unreadable or corrupt manifests are silently skipped.
 */
function collectArtifactDescriptors(runsDir: string): ArtifactDescriptor[] {
	const descriptors: ArtifactDescriptor[] = [];
	let dirs: fs.Dirent[];
	try {
		dirs = fs.readdirSync(runsDir, { withFileTypes: true });
	} catch {
		return descriptors;
	}
	for (const dir of dirs) {
		if (!dir.isDirectory()) continue;
		const manifestPath = path.join(runsDir, dir.name, DEFAULT_PATHS.state.manifestFile);
		try {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as TeamRunManifest;
			if (Array.isArray(manifest.artifacts)) {
				descriptors.push(...manifest.artifacts);
			}
		} catch {
			// Skip unreadable/corrupt manifests — best-effort.
		}
	}
	return descriptors;
}

export function runArtifactCleanup(cwd: string): void {
	try {
		const userArtifactsRoot = path.join(userCrewRoot(), DEFAULT_PATHS.state.artifactsSubdir);
		const projectArtifactsRoot = path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.artifactsSubdir);

		// Existing age-based filesystem cleanup.
		cleanupOldArtifacts(userArtifactsRoot, {
			maxAgeDays: DEFAULT_ARTIFACT_CLEANUP.maxAgeDays,
			markerFile: CLEANUP_MARKER_FILE,
		});
		cleanupOldArtifacts(projectArtifactsRoot, {
			maxAgeDays: DEFAULT_ARTIFACT_CLEANUP.maxAgeDays,
			markerFile: CLEANUP_MARKER_FILE,
		});

		// ST-10: Enforce retention/expiresAt from manifest metadata.
		pruneExpiredArtifacts(collectArtifactDescriptors(path.join(userCrewRoot(), DEFAULT_PATHS.state.runsSubdir)));
		pruneExpiredArtifacts(collectArtifactDescriptors(path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.runsSubdir)));
	} catch (error) {
		logInternalError("register.artifact-cleanup", error, `cwd=${cwd}`);
	}
}
