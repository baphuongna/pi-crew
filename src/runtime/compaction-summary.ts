/**
 * Deterministic compaction summary — builds a markdown summary of a pi-crew run
 * from manifest.json, tasks.json, and the tail of events.jsonl.
 *
 * Distilled from pi-autoresearch's compaction-summary pattern.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { readJsonFile } from "../state/atomic-write.ts";
import type { TeamEvent } from "../state/event-log.ts";

/** Maximum number of events to read from the tail of events.jsonl. */
const MAX_TAIL_EVENTS = 100;

/** Maximum number of completed tasks to include in the "Recent Results" section. */
const MAX_RECENT_RESULTS = 10;

/** Paths relevant to building a compaction summary for a run. */
export interface SummaryPaths {
	manifestPath: string;
	tasksPath: string;
	eventsPath: string;
	stateRoot: string;
}

/**
 * Derive the standard summary-relevant paths from a state root directory.
 * Mirrors pi-autoresearch's `autoresearchSummaryPathsFor()`.
 */
export function summaryPathsFor(stateRoot: string): SummaryPaths {
	return {
		stateRoot,
		manifestPath: path.join(stateRoot, "manifest.json"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
	};
}

/**
 * Read the last N lines from a text file.
 * Uses reverse buffer reading to avoid loading the entire file into memory.
 * For files larger than TAIL_MAX_READ bytes, only the last chunk is read.
 */
const TAIL_MAX_READ = 256 * 1024; // 256KB — enough for ~1000 lines of JSONL
const MAX_FALLBACK_READ = 2 * 1024 * 1024; // 2MB — safety limit for giant-line fallback
function readTailLines(filePath: string, maxLines: number): string[] {
	if (!fs.existsSync(filePath)) return [];
	try {
		const stat = fs.statSync(filePath);
		const fileSize = stat.size;
		if (fileSize === 0) return [];

		// For small files, just read everything
		if (fileSize <= TAIL_MAX_READ) {
			const content = fs.readFileSync(filePath, "utf-8");
			return content.split("\n").filter((line) => line.trim().length > 0).slice(-maxLines);
		}

		// For large files, read only the last chunk.
		// Search backwards from the read boundary for a newline to avoid
		// splitting mid-line or mid-multibyte UTF-8 character.
		const fd = fs.openSync(filePath, "r");
		try {
			const readSize = Math.min(fileSize, TAIL_MAX_READ);
			const readOffset = fileSize - readSize;
			const buf = Buffer.alloc(readSize);
			fs.readSync(fd, buf, 0, readSize, readOffset);

			// Find the first newline in the buffer to avoid partial lines.
			// This also handles multibyte UTF-8 safety — we start after a
			// newline boundary which is always a clean character boundary.
			let start = 0;
			if (readOffset > 0) {
				const firstNewline = buf.indexOf("\n");
				if (firstNewline >= 0) {
					start = firstNewline + 1;
				} else {
					// No newline found in the entire tail chunk — single giant line.
					// Fall back to reading the full file to avoid data loss.
					// Note: fd will be closed by the outer finally block.
					throw new Error("__GIANT_LINE_FALLBACK__");
				}
			}

			const content = buf.toString("utf-8", start, readSize);
			const lines = content.split("\n").filter((line) => line.trim().length > 0);
			return lines.slice(-maxLines);
		} finally {
			fs.closeSync(fd);
		}
	} catch (err) {
		// Giant-line fallback: fd already closed by finally above.
		if (err instanceof Error && err.message === "__GIANT_LINE_FALLBACK__") {
			const stat = fs.statSync(filePath);
			if (stat.size > MAX_FALLBACK_READ) return [];
			const content = fs.readFileSync(filePath, "utf-8");
			return content.split("\n").filter((line) => line.trim().length > 0).slice(-maxLines);
		}
		return [];
	}
}

/**
 * Parse JSONL lines into TeamEvent objects, skipping malformed lines.
 */
function parseEvents(lines: string[]): TeamEvent[] {
	const events: TeamEvent[] = [];
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line.trim());
			if (typeof parsed === "object" && parsed !== null && typeof parsed.type === "string" && typeof parsed.runId === "string") {
				events.push(parsed as TeamEvent);
			}
		} catch {
			// Skip malformed lines
		}
	}
	return events;
}

/**
 * Compute a human-readable duration between two ISO timestamp strings.
 */
function formatDuration(startIso?: string, endIso?: string): string {
	if (!startIso) return "—";
	const start = new Date(startIso).getTime();
	if (Number.isNaN(start)) return "—";
	const end = endIso ? new Date(endIso).getTime() : Date.now();
	if (Number.isNaN(end)) return "—";
	const diffMs = end - start;
	if (diffMs < 0) return "—";
	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h ${remainingMinutes}m`;
}

/**
 * Build a deterministic compaction summary for a pi-crew run.
 *
 * Reads manifest.json, tasks.json, and the tail of events.jsonl to produce
 * a self-contained markdown summary suitable for context injection.
 *
 * @param stateRoot - Path to the run's state root directory
 * @returns Markdown-formatted compaction summary
 */
export function buildCompactionSummary(stateRoot: string): string {
	const paths = summaryPathsFor(stateRoot);

	// Read manifest
	const manifest = readJsonFile<TeamRunManifest>(paths.manifestPath);

	// Read tasks
	const tasks = readJsonFile<TeamTaskState[]>(paths.tasksPath) ?? [];

	// Read tail events
	const tailLines = readTailLines(paths.eventsPath, MAX_TAIL_EVENTS);
	const tailEvents = parseEvents(tailLines);

	const sections: string[] = [];

	// Section: Run Metadata
	sections.push("# Run Summary");
	if (manifest) {
		sections.push("");
		sections.push("## Run Metadata");
		sections.push(`- **Run ID**: ${manifest.runId}`);
		sections.push(`- **Team**: ${manifest.team}`);
		if (manifest.workflow) {
			sections.push(`- **Workflow**: ${manifest.workflow}`);
		}
		if (manifest.goal) {
			sections.push(`- **Goal**: ${manifest.goal.replace(/\n/g, " ").slice(0, 500)}`);
		}
		sections.push(`- **Status**: ${manifest.status}`);
		sections.push(`- **Created**: ${manifest.createdAt}`);
		sections.push(`- **Updated**: ${manifest.updatedAt}`);
		if (manifest.workspaceMode) {
			sections.push(`- **Workspace Mode**: ${manifest.workspaceMode}`);
		}
	} else {
		sections.push("");
		sections.push("## Run Metadata");
		sections.push("- **Status**: manifest unavailable");
	}

	// Section: Task Progress Table
	sections.push("");
	sections.push("## Task Progress");
	if (tasks.length > 0) {
		sections.push("");
		sections.push("| ID | Role | Status | Duration |");
		sections.push("|---|---|---|---|");
		for (const task of tasks) {
			const taskId = task.id;
			const role = task.role || "—";
			const status = task.status || "—";
			const duration = formatDuration(task.startedAt, task.finishedAt);
			sections.push(`| ${taskId} | ${role} | ${status} | ${duration} |`);
		}
	} else {
		sections.push("");
		sections.push("No tasks recorded.");
	}

	// Section: Recent Task Results
	const completedTasks = tasks
		.filter((t) => t.status === "completed" || t.status === "failed")
		.slice(-MAX_RECENT_RESULTS);

	if (completedTasks.length > 0) {
		sections.push("");
		sections.push("## Recent Task Results");
		for (const task of completedTasks) {
			sections.push("");
			sections.push(`### ${task.id} (${task.status})`);
			if (task.error) {
				sections.push(`- **Error**: ${task.error}`);
			}
			if (task.diagnostics && Object.keys(task.diagnostics).length > 0) {
				sections.push("- **Diagnostics**:");
				for (const [key, value] of Object.entries(task.diagnostics)) {
					sections.push(`  - ${key}: ${JSON.stringify(value)}`);
				}
			}
			if (task.metrics && Object.keys(task.metrics).length > 0) {
				sections.push("- **Metrics**:");
				for (const [key, value] of Object.entries(task.metrics)) {
					sections.push(`  - ${key}: ${value}`);
				}
			}
		}
	}

	// Section: Next Steps (pending/queued tasks)
	const pendingStatuses = new Set(["queued", "waiting", "running"]);
	const pendingTasks = tasks.filter(
		(t) => pendingStatuses.has(t.status),
	);
	if (pendingTasks.length > 0) {
		sections.push("");
		sections.push("## Next Steps");
		sections.push("");
		for (const task of pendingTasks) {
			const title = task.title || task.role || "Untitled";
			sections.push(`- [${task.status}] ${task.id}: ${title}`);
		}
	}

	// Section: Tail Events Summary
	if (tailEvents.length > 0) {
		sections.push("");
		sections.push(`## Recent Events (last ${tailEvents.length})`);
		sections.push("");
		for (const event of tailEvents.slice(-10)) {
			const taskPart = event.taskId ? ` task=${event.taskId}` : "";
			const msgPart = event.message ? ` — ${event.message}` : "";
			sections.push(`- [${event.time}] ${event.type}${taskPart}${msgPart}`);
		}
	}

	return sections.join("\n");
}
