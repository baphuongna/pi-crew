import * as path from "node:path";
import { DEFAULT_ARTIFACT_CLEANUP } from "../../config/defaults.ts";
import { CLEANUP_MARKER_FILE, cleanupOldArtifacts } from "../../state/artifact-store.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { projectCrewRoot, userCrewRoot } from "../../utils/paths.ts";
import { DEFAULT_PATHS } from "../../config/defaults.ts";

export function runArtifactCleanup(cwd: string): void {
	try {
		cleanupOldArtifacts(path.join(userCrewRoot(), DEFAULT_PATHS.state.artifactsSubdir), { maxAgeDays: DEFAULT_ARTIFACT_CLEANUP.maxAgeDays, markerFile: CLEANUP_MARKER_FILE });
		cleanupOldArtifacts(path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.artifactsSubdir), { maxAgeDays: DEFAULT_ARTIFACT_CLEANUP.maxAgeDays, markerFile: CLEANUP_MARKER_FILE });
	} catch (error) {
		logInternalError("register.artifact-cleanup", error, `cwd=${cwd}`);
	}
}
