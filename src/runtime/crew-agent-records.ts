import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { atomicWriteJson, readJsonFile } from "../state/atomic-write.ts";
import type { CrewAgentProgress, CrewAgentRecord, CrewRuntimeKind } from "./crew-agent-runtime.ts";
import { taskStatusToAgentStatus } from "./crew-agent-runtime.ts";

export function agentsPath(manifest: TeamRunManifest): string {
	return path.join(manifest.stateRoot, "agents.json");
}

export function agentStateDir(manifest: TeamRunManifest, taskId: string): string {
	return path.join(manifest.stateRoot, "agents", taskId);
}

export function agentStatusPath(manifest: TeamRunManifest, taskId: string): string {
	return path.join(agentStateDir(manifest, taskId), "status.json");
}

export function agentEventsPath(manifest: TeamRunManifest, taskId: string): string {
	return path.join(agentStateDir(manifest, taskId), "events.jsonl");
}

export function agentOutputPath(manifest: TeamRunManifest, taskId: string): string {
	return path.join(agentStateDir(manifest, taskId), "output.log");
}

export function readCrewAgents(manifest: TeamRunManifest): CrewAgentRecord[] {
	return readJsonFile<CrewAgentRecord[]>(agentsPath(manifest)) ?? [];
}

export function saveCrewAgents(manifest: TeamRunManifest, records: CrewAgentRecord[]): void {
	fs.mkdirSync(manifest.stateRoot, { recursive: true });
	atomicWriteJson(agentsPath(manifest), records);
	for (const record of records) writeCrewAgentStatus(manifest, record);
}

export function upsertCrewAgent(manifest: TeamRunManifest, record: CrewAgentRecord): void {
	const records = readCrewAgents(manifest).filter((item) => item.id !== record.id);
	records.push(record);
	saveCrewAgents(manifest, records);
	writeCrewAgentStatus(manifest, record);
}

export function writeCrewAgentStatus(manifest: TeamRunManifest, record: CrewAgentRecord): void {
	fs.mkdirSync(agentStateDir(manifest, record.taskId), { recursive: true });
	atomicWriteJson(agentStatusPath(manifest, record.taskId), record);
}

export function readCrewAgentStatus(manifest: TeamRunManifest, taskOrAgentId: string): CrewAgentRecord | undefined {
	const taskId = taskOrAgentId.includes(":") ? taskOrAgentId.split(":").pop()! : taskOrAgentId;
	return readJsonFile<CrewAgentRecord>(agentStatusPath(manifest, taskId));
}

const agentEventSeqCache = new Map<string, { size: number; mtimeMs: number; seq: number }>();

function nextAgentEventSeq(filePath: string): number {
	if (!fs.existsSync(filePath)) return 1;
	const stat = fs.statSync(filePath);
	const cached = agentEventSeqCache.get(filePath);
	if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.seq + 1;
	let max = 0;
	for (const line of fs.readFileSync(filePath, "utf-8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as { seq?: unknown };
			if (typeof parsed.seq === "number" && Number.isFinite(parsed.seq)) max = Math.max(max, parsed.seq);
			else max += 1;
		} catch {
			max += 1;
		}
	}
	agentEventSeqCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, seq: max });
	return max + 1;
}

export function appendCrewAgentEvent(manifest: TeamRunManifest, taskId: string, event: unknown): void {
	fs.mkdirSync(agentStateDir(manifest, taskId), { recursive: true });
	const filePath = agentEventsPath(manifest, taskId);
	const seq = nextAgentEventSeq(filePath);
	fs.appendFileSync(filePath, `${JSON.stringify({ seq, time: new Date().toISOString(), event })}\n`, "utf-8");
	try {
		const stat = fs.statSync(filePath);
		agentEventSeqCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, seq });
	} catch {}
}

export interface CrewAgentEventCursorOptions {
	sinceSeq?: number;
	limit?: number;
}

export function readCrewAgentEvents(manifest: TeamRunManifest, taskId: string): unknown[] {
	return readCrewAgentEventsCursor(manifest, taskId).events;
}

export function readCrewAgentEventsCursor(manifest: TeamRunManifest, taskId: string, options: CrewAgentEventCursorOptions = {}): { path: string; events: unknown[]; nextSeq: number; total: number } {
	const filePath = agentEventsPath(manifest, taskId);
	if (!fs.existsSync(filePath)) return { path: filePath, events: [], nextSeq: options.sinceSeq ?? 0, total: 0 };
	const sinceSeq = typeof options.sinceSeq === "number" && Number.isInteger(options.sinceSeq) && options.sinceSeq >= 0 ? options.sinceSeq : 0;
	const limit = typeof options.limit === "number" && Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : undefined;
	const parsed = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean).map((line, index) => {
		try {
			const event = JSON.parse(line) as Record<string, unknown>;
			if (typeof event.seq !== "number") event.seq = index + 1;
			return event;
		} catch {
			return { seq: index + 1, raw: line };
		}
	});
	const filtered = parsed.filter((event) => typeof event.seq === "number" && event.seq > sinceSeq);
	const events = limit !== undefined ? filtered.slice(0, limit) : filtered;
	const returnedMaxSeq = events.reduce((max, event) => typeof event.seq === "number" ? Math.max(max, event.seq) : max, sinceSeq);
	return { path: filePath, events, nextSeq: returnedMaxSeq, total: filtered.length };
}

export function appendCrewAgentOutput(manifest: TeamRunManifest, taskId: string, text: string): void {
	if (!text.trim()) return;
	fs.mkdirSync(agentStateDir(manifest, taskId), { recursive: true });
	fs.appendFileSync(agentOutputPath(manifest, taskId), `${text}\n`, "utf-8");
}

export function emptyCrewAgentProgress(): CrewAgentProgress {
	return { recentTools: [], recentOutput: [], toolCount: 0 };
}

export function recordFromTask(manifest: TeamRunManifest, task: TeamTaskState, runtime: CrewRuntimeKind): CrewAgentRecord {
	return {
		id: `${manifest.runId}:${task.id}`,
		runId: manifest.runId,
		taskId: task.id,
		agent: task.agent,
		role: task.role,
		runtime,
		status: taskStatusToAgentStatus(task.status),
		startedAt: task.startedAt ?? new Date().toISOString(),
		completedAt: task.finishedAt,
		resultArtifactPath: task.resultArtifact?.path,
		transcriptPath: task.transcriptArtifact?.path ?? task.logArtifact?.path,
		statusPath: agentStatusPath(manifest, task.id),
		eventsPath: agentEventsPath(manifest, task.id),
		outputPath: agentOutputPath(manifest, task.id),
		toolUses: task.agentProgress?.toolCount,
		jsonEvents: task.jsonEvents,
		progress: task.agentProgress,
		error: task.error,
	};
}
