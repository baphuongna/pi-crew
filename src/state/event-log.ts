import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_EVENT_LOG } from "../config/defaults.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { redactSecrets } from "../utils/redaction.ts";

export type TeamEventProvenance = "live_worker" | "test" | "healthcheck" | "replay" | "api" | "background" | "team_runner";
export type TeamWatcherAction = "act" | "observe" | "ignore";

export interface TeamEventSessionIdentity {
	title: string;
	workspace: string;
	purpose: string;
	placeholderReason?: string;
}

export interface TeamEventOwnership {
	owner: string;
	workflowScope: string;
	watcherAction: TeamWatcherAction;
}

export interface TeamEventMetadata {
	seq: number;
	provenance: TeamEventProvenance;
	sessionIdentity?: TeamEventSessionIdentity;
	ownership?: TeamEventOwnership;
	nudgeId?: string;
	fingerprint?: string;
	confidence?: "low" | "medium" | "high";
}

export interface TeamEvent {
	time: string;
	type: string;
	runId: string;
	taskId?: string;
	message?: string;
	data?: Record<string, unknown>;
	metadata?: TeamEventMetadata;
}

export type AppendTeamEvent = Omit<TeamEvent, "time" | "metadata"> & { metadata?: Partial<TeamEventMetadata> };

const TERMINAL_EVENT_TYPES = new Set<string>(DEFAULT_EVENT_LOG.terminalEventTypes);
const MAX_EVENTS_BYTES = 50 * 1024 * 1024;

const sequenceCache = new Map<string, { size: number; mtimeMs: number; seq: number }>();

export function sequencePath(eventsPath: string): string {
	return `${eventsPath}.seq`;
}

function parseSequence(raw: string): number | undefined {
	const value = Number.parseInt(raw.trim(), 10);
	return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function scanSequence(eventsPath: string): number {
	if (!fs.existsSync(eventsPath)) return 0;
	let max = 0;
	for (const line of fs.readFileSync(eventsPath, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as TeamEvent;
			max = Math.max(max, event.metadata?.seq ?? 0);
		} catch {
			max += 1;
		}
	}
	return max;
}

function readStoredSequence(eventsPath: string): number | undefined {
	try {
		return parseSequence(fs.readFileSync(sequencePath(eventsPath), "utf-8"));
	} catch {
		return undefined;
	}
}

function nextSequence(eventsPath: string): number {
	if (!fs.existsSync(eventsPath)) return 1;
	const stat = fs.statSync(eventsPath);
	const cached = sequenceCache.get(eventsPath);
	if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
		return cached.seq + 1;
	}
	let current = readStoredSequence(eventsPath);
	if (current === undefined || (cached && stat.size < cached.size)) {
		current = scanSequence(eventsPath);
	}
	sequenceCache.set(eventsPath, { size: stat.size, mtimeMs: stat.mtimeMs, seq: current });
	return current + 1;
}

function persistSequence(eventsPath: string, seq: number): void {
	try {
		atomicWriteFile(sequencePath(eventsPath), String(seq));
	} catch (error) {
		logInternalError("event-log.persist-sequence-file", error, `eventsPath=${eventsPath}`);
	}
}

export function computeEventFingerprint(event: Pick<TeamEvent, "type" | "runId" | "taskId" | "data">): string {
	return createHash("sha256").update(JSON.stringify({ type: event.type, runId: event.runId, taskId: event.taskId, data: event.data ?? null })).digest("hex").slice(0, 16);
}

export function appendEvent(eventsPath: string, event: AppendTeamEvent): TeamEvent {
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
	const baseMetadata = event.metadata;
	let metadata: TeamEventMetadata = {
		seq: baseMetadata?.seq ?? nextSequence(eventsPath),
		provenance: baseMetadata?.provenance ?? "team_runner",
		...(baseMetadata?.sessionIdentity ? { sessionIdentity: baseMetadata.sessionIdentity } : {}),
		...(baseMetadata?.ownership ? { ownership: baseMetadata.ownership } : {}),
		...(baseMetadata?.nudgeId ? { nudgeId: baseMetadata.nudgeId } : {}),
		...(baseMetadata?.confidence ? { confidence: baseMetadata.confidence } : {}),
	};
	const fullEvent: TeamEvent = {
		time: new Date().toISOString(),
		...event,
		metadata,
	};
	if (baseMetadata?.fingerprint || TERMINAL_EVENT_TYPES.has(fullEvent.type)) {
		metadata = { ...metadata, fingerprint: baseMetadata?.fingerprint ?? computeEventFingerprint(fullEvent) };
		fullEvent.metadata = metadata;
	}
	try {
		if (fs.existsSync(eventsPath) && fs.statSync(eventsPath).size > MAX_EVENTS_BYTES) {
			logInternalError("event-log.size-limit", new Error(`events file ${eventsPath} exceeds ${MAX_EVENTS_BYTES} bytes`), `eventsPath=${eventsPath}`);
			return fullEvent;
		}
	} catch (error) {
		logInternalError("event-log.size-check", error, `eventsPath=${eventsPath}`);
	}
	fs.appendFileSync(eventsPath, `${JSON.stringify(redactSecrets(fullEvent))}\n`, "utf-8");
	const seq = fullEvent.metadata?.seq ?? 0;
	try {
		const stat = fs.statSync(eventsPath);
		sequenceCache.set(eventsPath, { size: stat.size, mtimeMs: stat.mtimeMs, seq });
		persistSequence(eventsPath, seq);
	} catch (error) {
		logInternalError("event-log.persist-sequence", error, `eventsPath=${eventsPath}`);
	}
	return fullEvent;
}

export function readEvents(eventsPath: string): TeamEvent[] {
	if (!fs.existsSync(eventsPath)) return [];
	return fs.readFileSync(eventsPath, "utf-8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TeamEvent);
}

export interface EventCursorOptions {
	sinceSeq?: number;
	limit?: number;
}

function positiveInteger(value: number | undefined): number | undefined {
	return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function readEventsCursor(eventsPath: string, options: EventCursorOptions = {}): { events: TeamEvent[]; nextSeq: number; total: number } {
	const sinceSeq = positiveInteger(options.sinceSeq) ?? 0;
	const limit = positiveInteger(options.limit);
	const all = readEvents(eventsPath);
	const filtered = all.filter((event) => (event.metadata?.seq ?? 0) > sinceSeq);
	const events = limit !== undefined ? filtered.slice(0, limit) : filtered;
	const returnedMaxSeq = events.reduce((max, event) => Math.max(max, event.metadata?.seq ?? 0), sinceSeq);
	return { events, nextSeq: returnedMaxSeq, total: filtered.length };
}

export function dedupeTerminalEvents(events: TeamEvent[]): TeamEvent[] {
	const seen = new Set<string>();
	const output: TeamEvent[] = [];
	for (const event of events) {
		const fingerprint = event.metadata?.fingerprint;
		if (fingerprint && TERMINAL_EVENT_TYPES.has(event.type)) {
			if (seen.has(fingerprint)) continue;
			seen.add(fingerprint);
		}
		output.push(event);
	}
	return output;
}
