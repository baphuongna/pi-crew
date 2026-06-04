import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { readEvents, type TeamEvent } from "../state/event-log.ts";
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

export function exportRunBundle(manifest: TeamRunManifest, tasks: TeamTaskState[]): { jsonPath: string; markdownPath: string } {
	const events = readEvents(manifest.eventsPath);
	const safeManifest = redactHomePaths(manifest);
	const safeTasks = redactHomePaths(tasks);
	const safeEvents = redactHomePaths(events);
	const bundle: ExportedRunBundle = {
		schemaVersion: 1,
		exportedAt: new Date().toISOString(),
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
			"## Tasks",
			...safeTasks.map((task) => `- ${task.id}: ${task.status} (${task.role} -> ${task.agent})${task.error ? ` - ${task.error}` : ""}`),
			"",
			"## Artifacts",
			...(safeManifest.artifacts.length ? safeManifest.artifacts.map((artifact) => `- ${artifact.kind}: ${artifact.path}`) : ["- (none)"]),
			"",
			"## Recent Events",
			...(safeEvents.slice(-20).map((event) => `- ${event.time} ${event.type}${event.taskId ? ` ${event.taskId}` : ""}${event.message ? `: ${event.message}` : ""}`)),
			"",
		].join("\n"),
	});
	// Ensure artifact dirs are materialized before returning paths on filesystems with delayed metadata.
	fs.statSync(path.dirname(json.path));
	return { jsonPath: json.path, markdownPath: markdown.path };
}
