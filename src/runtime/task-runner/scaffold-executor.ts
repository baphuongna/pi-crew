/**
 * CORE-5 extraction 1: scaffold task executor.
 *
 * Writes a placeholder `.md` result artifact for scaffold-safe runs
 * (executeWorkers=false). No worker is spawned — the prompt artifact
 * captures the exact task that would be sent to a child Pi worker.
 *
 * Extracted verbatim from the `else` (scaffold) branch of `runTeamTask`.
 */
import { writeArtifact } from "../../state/artifact-store.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../../state/types.ts";

export function runScaffoldTask(manifest: TeamRunManifest, task: TeamTaskState): ArtifactDescriptor {
	return writeArtifact(manifest.artifactsRoot, {
		kind: "result",
		relativePath: `results/${task.id}.md`,
		content: [
			`# ${task.id}`,
			"",
			"Worker execution is disabled in this scaffold-safe run.",
			"The prompt artifact contains the exact task that will be sent to a child Pi worker when execution is enabled.",
		].join("\n"),
		producer: task.id,
	});
}
