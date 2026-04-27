import * as fs from "node:fs";
import type { TeamRunManifest } from "../state/types.ts";
import { agentOutputPath, readCrewAgents } from "./crew-agent-records.ts";
import type { CrewAgentRecord } from "./crew-agent-runtime.ts";

export interface TextTailResult {
	path: string;
	text: string;
	bytes: number;
	truncated: boolean;
}

export function readTextTail(filePath: string, maxBytes = 64_000): TextTailResult {
	if (!fs.existsSync(filePath)) return { path: filePath, text: "", bytes: 0, truncated: false };
	const stat = fs.statSync(filePath);
	const bytesToRead = Math.min(stat.size, Math.max(0, maxBytes));
	const fd = fs.openSync(filePath, "r");
	try {
		const buffer = Buffer.alloc(bytesToRead);
		fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
		return { path: filePath, text: buffer.toString("utf-8"), bytes: stat.size, truncated: stat.size > bytesToRead };
	} finally {
		fs.closeSync(fd);
	}
}

function activityText(agent: CrewAgentRecord): string {
	const parts: string[] = [];
	if (agent.progress?.activityState) parts.push(agent.progress.activityState);
	if (agent.progress?.currentTool) parts.push(`tool=${agent.progress.currentTool}`);
	if (agent.toolUses !== undefined) parts.push(`tools=${agent.toolUses}`);
	if (agent.progress?.tokens !== undefined) parts.push(`tokens=${agent.progress.tokens}`);
	if (agent.progress?.turns !== undefined) parts.push(`turns=${agent.progress.turns}`);
	if (agent.progress?.recentOutput?.length) parts.push(`last=${agent.progress.recentOutput.at(-1)}`);
	return parts.join(" ") || "idle";
}

function agentLine(agent: CrewAgentRecord): string {
	return `- ${agent.taskId} [${agent.status}] ${agent.role}->${agent.agent} runtime=${agent.runtime} ${activityText(agent)}${agent.error ? ` error=${agent.error}` : ""}`;
}

export function buildAgentDashboard(manifest: TeamRunManifest): { text: string; groups: Record<string, CrewAgentRecord[]> } {
	const agents = readCrewAgents(manifest);
	const groups: Record<string, CrewAgentRecord[]> = {
		running: agents.filter((agent) => agent.status === "running"),
		queued: agents.filter((agent) => agent.status === "queued"),
		recent: agents.filter((agent) => agent.status !== "running" && agent.status !== "queued"),
	};
	const lines = [
		`Crew agents for ${manifest.runId}`,
		`Run status: ${manifest.status}`,
		`Counts: running=${groups.running.length}, queued=${groups.queued.length}, recent=${groups.recent.length}`,
		"",
		"## Running",
		...(groups.running.length ? groups.running.map(agentLine) : ["- (none)"]),
		"",
		"## Queued",
		...(groups.queued.length ? groups.queued.map(agentLine) : ["- (none)"]),
		"",
		"## Recent",
		...(groups.recent.length ? groups.recent.slice(-10).map(agentLine) : ["- (none)"]),
	];
	return { text: lines.join("\n"), groups };
}

export function readAgentOutput(manifest: TeamRunManifest, taskId: string, maxBytes?: number): TextTailResult {
	return readTextTail(agentOutputPath(manifest, taskId), maxBytes);
}
