import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readEvents, type TeamEvent } from "../state/event-log/event-log.ts";
import { writeArtifact } from "../state/stores/artifact-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { aggregateUsage, formatCost, formatTokens } from "../state/usage.ts";
import { formatDuration } from "../ui/format-helpers.ts";
import { redactSecrets } from "../utils/redaction.ts";

/** Replace absolute paths containing home directory with ~/ */
/** Escape special regex characters in a string */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Only redact home directory at path boundaries to avoid corrupting substrings */
function redactHomePathInString(str: string, home: string): string {
	return str.replace(new RegExp(`(^|(?<=[:=/]))${escapeRegex(home)}`, "g"), "$1~");
}

/** Replace absolute paths containing home directory with ~/ at path boundaries only */
function redactHomePaths<T>(obj: T): T {
	const home = os.homedir();
	if (!home) return redactSecrets(obj) as T;
	const json = JSON.stringify(obj);
	const safe = redactHomePathInString(json, home);
	return redactSecrets(JSON.parse(safe)) as T;
}

export interface ExportedRunBundle {
	schemaVersion: 1;
	exportedAt: string;
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	events: TeamEvent[];
	artifactPaths: string[];
}

/**
 * Export a run bundle (JSON + markdown report).
 *
 * US-022 (2026-09-22): `now` is injectable so repeated exports of the same run
 * are byte-identical. `exportedAt` sits INSIDE the hashed payload, so a
 * wall-clock stamp made both the JSON and its sha256 (and the markdown
 * `Exported:` line) drift on every export — harmless for import (run-import
 * recomputes the hash minus `sha256`) but fatal for byte-diffing and for
 * reproducing a bundle in tests. Mirrors `createRunManifest`'s `now?: () => Date`.
 */
export function exportRunBundle(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
	now?: () => Date,
): { jsonPath: string; markdownPath: string } {
	const events = readEvents(manifest.eventsPath);
	const safeManifest = redactHomePaths(manifest);
	const safeTasks = redactHomePaths(tasks);
	const safeEvents = redactHomePaths(events);
	// US-022: aggregate usage once (tasks already in hand) for the Cost section.
	const usageTotal = aggregateUsage(safeTasks as TeamTaskState[]);
	const bundle: ExportedRunBundle = {
		schemaVersion: 1,
		exportedAt: (now ? now() : new Date()).toISOString(),
		manifest: safeManifest as TeamRunManifest,
		tasks: safeTasks as TeamTaskState[],
		events: safeEvents as TeamEvent[],
		artifactPaths: safeManifest.artifacts.map((artifact) => artifact.path),
	};
	// Compute SHA-256 integrity hash of the bundle and store in manifest
	const sha256 = crypto.createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
	(bundle.manifest as unknown as Record<string, unknown>).sha256 = sha256;
	const json = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: "export/run-export.json",
		producer: "run-export",
		content: `${JSON.stringify(bundle, null, 2)}\n`,
	});
	const markdown = writeArtifact(manifest.artifactsRoot, {
		kind: "summary",
		relativePath: "export/run-export.md",
		producer: "run-export",
		content: [
			`# pi-crew export ${safeManifest.runId}`,
			"",
			`Exported: ${bundle.exportedAt}`,
			`Status: ${safeManifest.status}`,
			`Team: ${safeManifest.team}`,
			`Workflow: ${safeManifest.workflow ?? "(none)"}`,
			`Goal: ${safeManifest.goal}`,
			"",
			"## Cost",
			...(usageTotal
				? [
						`- tokens: ${formatTokens((usageTotal.input ?? 0) + (usageTotal.output ?? 0))} (in ${formatTokens(usageTotal.input ?? 0)} / out ${formatTokens(usageTotal.output ?? 0)})`,
						`- cost: ${formatCost(usageTotal.cost)}`,
					]
				: ["- (no usage recorded)"]),
			"",
			"## Tasks",
			...safeTasks.map((task) => {
				// US-022: surface model + duration inline (data was already in hand).
				const duration =
					task.startedAt && task.finishedAt
						? ` [${formatDuration(new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime())}]`
						: "";
				const model = task.model ? ` <${task.model}>` : "";
				return `- ${task.id}: ${task.status} (${task.role} -> ${task.agent})${model}${duration}${task.error ? ` - ${task.error}` : ""}`;
			}),
			"",
			"## Artifacts",
			...(safeManifest.artifacts.length
				? safeManifest.artifacts.map((artifact) => `- ${artifact.kind}: ${artifact.path}`)
				: ["- (none)"]),
			"",
			"## Recent Events",
			...safeEvents
				.slice(-20)
				.map(
					(event) =>
						`- ${event.time} ${event.type}${event.taskId ? ` ${event.taskId}` : ""}${event.message ? `: ${event.message}` : ""}`,
				),
			"",
		].join("\n"),
	});
	// Ensure artifact dirs are materialized before returning paths on filesystems with delayed metadata.
	fs.statSync(path.dirname(json.path));
	return { jsonPath: json.path, markdownPath: markdown.path };
}
