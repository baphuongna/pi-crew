import * as fs from "node:fs";
import type { TeamRunManifest } from "../state/types.ts";

interface DashboardComponent {
	invalidate(): void;
	render(width: number): string[];
	handleInput(data: string): void;
}

export type RunDashboardAction = "status" | "summary" | "artifacts" | "api" | "events" | "agents" | "agent-events" | "agent-output" | "agent-transcript" | "reload";
export interface RunDashboardSelection {
	runId: string;
	action: RunDashboardAction;
}

function truncate(value: string, width: number): string {
	if (width <= 0) return "";
	if (value.length <= width) return value;
	if (width <= 1) return "…";
	return `${value.slice(0, width - 1)}…`;
}

function statusIcon(status: string): string {
	if (status === "completed") return "✓";
	if (status === "failed") return "✗";
	if (status === "cancelled") return "!";
	if (status === "running") return "▶";
	if (status === "blocked") return "■";
	return "·";
}

function readProgressPreview(run: TeamRunManifest, maxLines = 5): string[] {
	const progress = [...run.artifacts].reverse().find((artifact) => artifact.kind === "progress");
	if (!progress || !fs.existsSync(progress.path)) return ["Progress: (none)"];
	try {
		return ["Progress:", ...fs.readFileSync(progress.path, "utf-8").split(/\r?\n/).filter(Boolean).slice(0, maxLines)];
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [`Progress: failed to read (${message})`];
	}
}

function countByStatus(runs: TeamRunManifest[]): string {
	const counts = new Map<string, number>();
	for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
	return [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ") || "none";
}

export class RunDashboard implements DashboardComponent {
	private selected = 0;
	private showFullProgress = false;
	private readonly runs: TeamRunManifest[];
	private readonly done: (selection: RunDashboardSelection | undefined) => void;

	constructor(runs: TeamRunManifest[], done: (selection: RunDashboardSelection | undefined) => void) {
		this.runs = runs;
		this.done = done;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const innerWidth = Math.max(20, width - 4);
		const borderWidth = Math.min(innerWidth, Math.max(0, width - 2));
		const lines = [
			`╭${"─".repeat(borderWidth)}╮`,
			`│ ${truncate("pi-crew dashboard", innerWidth - 1).padEnd(innerWidth - 1)}│`,
			`│ ${truncate("↑/↓/j/k select • r reload • p progress • s/u/a/i actions • d agents • e/v/o viewers • q close", innerWidth - 1).padEnd(innerWidth - 1)}│`,
			`│ ${truncate(`Runs: ${this.runs.length} • ${countByStatus(this.runs)}`, innerWidth - 1).padEnd(innerWidth - 1)}│`,
			`├${"─".repeat(borderWidth)}┤`,
		];
		if (this.runs.length === 0) {
			lines.push(`│ ${truncate("No runs found.", innerWidth - 1).padEnd(innerWidth - 1)}│`);
		} else {
			for (let i = 0; i < Math.min(this.runs.length, 10); i++) {
				const run = this.runs[i]!;
				const marker = i === this.selected ? "›" : " ";
				const text = `${marker} ${statusIcon(run.status)} ${run.runId} ${run.status} ${run.team}/${run.workflow ?? "none"} ${run.goal}`;
				lines.push(`│ ${truncate(text, innerWidth - 1).padEnd(innerWidth - 1)}│`);
			}
			const selectedRun = this.runs[this.selected];
			if (selectedRun) {
				lines.push(`├${"─".repeat(borderWidth)}┤`);
				const details = [
					`Selected: ${selectedRun.runId}`,
					`Status: ${selectedRun.status} | Team: ${selectedRun.team} | Workflow: ${selectedRun.workflow ?? "none"}`,
					`Created: ${selectedRun.createdAt}`,
					`Updated: ${selectedRun.updatedAt}`,
					`Artifacts: ${selectedRun.artifacts.length} | Workspace: ${selectedRun.workspaceMode}`,
					selectedRun.async ? `Async: pid=${selectedRun.async.pid ?? "unknown"} log=${selectedRun.async.logPath}` : "Async: no",
					`Goal: ${selectedRun.goal}`,
				];
				for (const detail of [...details, ...readProgressPreview(selectedRun, this.showFullProgress ? 20 : 5)]) {
					lines.push(`│ ${truncate(detail, innerWidth - 1).padEnd(innerWidth - 1)}│`);
				}
			}
		}
		lines.push(`╰${"─".repeat(borderWidth)}╯`);
		return lines.map((line) => truncate(line, width));
	}

	handleInput(data: string): void {
		if (data === "q" || data === "\u001b") {
			this.done(undefined);
			return;
		}
		if (data === "\r" || data === "\n" || data === "s") {
			const runId = this.runs[this.selected]?.runId;
			this.done(runId ? { runId, action: "status" } : undefined);
			return;
		}
		if (data === "u") {
			const runId = this.runs[this.selected]?.runId;
			this.done(runId ? { runId, action: "summary" } : undefined);
			return;
		}
		if (data === "a") {
			const runId = this.runs[this.selected]?.runId;
			this.done(runId ? { runId, action: "artifacts" } : undefined);
			return;
		}
		if (data === "i") {
			const runId = this.runs[this.selected]?.runId;
			this.done(runId ? { runId, action: "api" } : undefined);
			return;
		}
		if (data === "d") {
			const runId = this.runs[this.selected]?.runId;
			this.done(runId ? { runId, action: "agents" } : undefined);
			return;
		}
		if (data === "e") {
			const runId = this.runs[this.selected]?.runId;
			this.done(runId ? { runId, action: "agent-events" } : undefined);
			return;
		}
		if (data === "o") {
			const runId = this.runs[this.selected]?.runId;
			this.done(runId ? { runId, action: "agent-output" } : undefined);
			return;
		}
		if (data === "v") {
			const runId = this.runs[this.selected]?.runId;
			this.done(runId ? { runId, action: "agent-transcript" } : undefined);
			return;
		}
		if (data === "r") {
			this.done({ runId: this.runs[this.selected]?.runId ?? "", action: "reload" });
			return;
		}
		if (data === "p") {
			this.showFullProgress = !this.showFullProgress;
			return;
		}
		if (data === "k" || data === "\u001b[A") {
			this.selected = Math.max(0, this.selected - 1);
			return;
		}
		if (data === "j" || data === "\u001b[B") {
			this.selected = Math.min(Math.max(0, this.runs.length - 1), this.selected + 1);
		}
	}
}
