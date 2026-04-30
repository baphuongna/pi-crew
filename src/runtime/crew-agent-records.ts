import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { atomicWriteJson, readJsonFile } from "../state/atomic-write.ts";
import { readJsonFileCoalesced } from "../utils/file-coalescer.ts";
import type { CrewAgentProgress, CrewAgentRecord, CrewRuntimeKind } from "./crew-agent-runtime.ts";
import { taskStatusToAgentStatus } from "./crew-agent-runtime.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { assertSafePathId, resolveRealContainedPath } from "../utils/safe-paths.ts";
import { redactSecretString, redactSecrets } from "../utils/redaction.ts";

export function agentsPath(manifest: TeamRunManifest): string {
	return path.join(manifest.stateRoot, "agents.json");
}

export function agentsRoot(manifest: TeamRunManifest): string {
	return path.join(manifest.stateRoot, "agents");
}

function safeAgentTaskId(taskId: string): string {
	return assertSafePathId("taskId", taskId.includes(":") ? taskId.split(":").pop()! : taskId);
}

export function agentStateDir(manifest: TeamRunManifest, taskId: string): string {
	return path.join(agentsRoot(manifest), safeAgentTaskId(taskId));
}

export function ensureAgentStateDir(manifest: TeamRunManifest, taskId: string): string {
	const root = agentsRoot(manifest);
	fs.mkdirSync(root, { recursive: true });
	if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`Invalid agents root: ${root}`);
	const dir = agentStateDir(manifest, taskId);
	fs.mkdirSync(dir, { recursive: true });
	if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Invalid agent state directory: ${dir}`);
	resolveRealContainedPath(root, path.basename(dir));
	return dir;
}

function safeExistingAgentFile(manifest: TeamRunManifest, taskId: string, fileName: string): string {
	const filePath = path.join(agentStateDir(manifest, taskId), fileName);
	if (!fs.existsSync(filePath)) return filePath;
	if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`Invalid agent state file: ${filePath}`);
	return resolveRealContainedPath(agentsRoot(manifest), path.join(safeAgentTaskId(taskId), fileName));
}

export function agentStateFile(manifest: TeamRunManifest, taskId: string, fileName: string): string {
	ensureAgentStateDir(manifest, taskId);
	return safeExistingAgentFile(manifest, taskId, fileName);
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

const AGENT_READER_TTL_MS = 200;

export function readCrewAgents(manifest: TeamRunManifest): CrewAgentRecord[] {
	try {
		return readJsonFileCoalesced(agentsPath(manifest), AGENT_READER_TTL_MS, () => readJsonFile<CrewAgentRecord[]>(agentsPath(manifest)) ?? []);
	} catch {
		return [];
	}
}

export function saveCrewAgents(manifest: TeamRunManifest, records: CrewAgentRecord[]): void {
	fs.mkdirSync(manifest.stateRoot, { recursive: true });
	atomicWriteJson(agentsPath(manifest), redactSecrets(records));
	for (const record of records) writeCrewAgentStatus(manifest, record);
}

export function upsertCrewAgent(manifest: TeamRunManifest, record: CrewAgentRecord): void {
	const records = readCrewAgents(manifest).filter((item) => item.id !== record.id);
	records.push(record);
	saveCrewAgents(manifest, records);
	writeCrewAgentStatus(manifest, record);
}

export function writeCrewAgentStatus(manifest: TeamRunManifest, record: CrewAgentRecord): void {
	ensureAgentStateDir(manifest, record.taskId);
	atomicWriteJson(agentStatusPath(manifest, record.taskId), redactSecrets(record));
}

export function readCrewAgentStatus(manifest: TeamRunManifest, taskOrAgentId: string): CrewAgentRecord | undefined {
	try {
		return readJsonFile<CrewAgentRecord>(safeExistingAgentFile(manifest, taskOrAgentId, "status.json"));
	} catch {
		return undefined;
	}
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
	ensureAgentStateDir(manifest, taskId);
	const filePath = agentStateFile(manifest, taskId, "events.jsonl");
	const seq = nextAgentEventSeq(filePath);
	fs.appendFileSync(filePath, `${JSON.stringify(redactSecrets({ seq, time: new Date().toISOString(), event }))}\n`, "utf-8");
	try {
		const stat = fs.statSync(filePath);
		agentEventSeqCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, seq });
	} catch (error) {
		logInternalError("crew-agent-records.stat", error, `filePath=${filePath}`);
	}
}

export interface CrewAgentEventCursorOptions {
	sinceSeq?: number;
	limit?: number;
}

export function readCrewAgentEvents(manifest: TeamRunManifest, taskId: string): unknown[] {
	return readCrewAgentEventsCursor(manifest, taskId).events;
}

export function readCrewAgentEventsCursor(manifest: TeamRunManifest, taskId: string, options: CrewAgentEventCursorOptions = {}): { path: string; events: unknown[]; nextSeq: number; total: number } {
	let filePath: string;
	try {
		filePath = agentEventsPath(manifest, taskId);
	} catch {
		return { path: "", events: [], nextSeq: options.sinceSeq ?? 0, total: 0 };
	}
	if (!fs.existsSync(filePath)) return { path: filePath, events: [], nextSeq: options.sinceSeq ?? 0, total: 0 };
	try {
		filePath = safeExistingAgentFile(manifest, taskId, "events.jsonl");
	} catch {
		return { path: "", events: [], nextSeq: options.sinceSeq ?? 0, total: 0 };
	}
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
	ensureAgentStateDir(manifest, taskId);
	fs.appendFileSync(agentStateFile(manifest, taskId, "output.log"), `${redactSecretString(text)}\n`, "utf-8");
}

export function emptyCrewAgentProgress(): CrewAgentProgress {
	return { recentTools: [], recentOutput: [], toolCount: 0 };
}

function modelFromTask(task: TeamTaskState): string | undefined {
	const attempts = task.modelAttempts;
	if (!attempts?.length) return undefined;
	return attempts.find((attempt) => attempt.success)?.model ?? attempts.at(-1)?.model;
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
		model: modelFromTask(task),
		routing: task.modelRouting,
		usage: task.usage,
		progress: task.agentProgress,
		error: task.error,
	};
}
