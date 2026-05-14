import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest } from "./types.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import { redactSecrets } from "../utils/redaction.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { atomicWriteFile } from "./atomic-write.ts";

export type MailboxDirection = "inbox" | "outbox";
export type MailboxMessageStatus = "queued" | "delivered" | "acknowledged";
export type MailboxMessageKind = "message" | "steer" | "follow-up" | "response" | "group_join";
export type MailboxMessagePriority = "urgent" | "normal" | "low";
export type MailboxDeliveryMode = "interrupt" | "next_turn";

export interface MailboxMessage {
	id: string;
	runId: string;
	direction: MailboxDirection;
	from: string;
	to: string;
	body: string;
	createdAt: string;
	status: MailboxMessageStatus;
	kind?: MailboxMessageKind;
	priority?: MailboxMessagePriority;
	deliveryMode?: MailboxDeliveryMode;
	taskId?: string;
	acknowledgedAt?: string;
	data?: Record<string, unknown>;
	/** ID of the original message this is a reply to. */
	replyTo?: string;
	/** Task ID sending the reply. */
	replyFrom?: string;
	/** Ms epoch deadline for a reply. */
	replyDeadline?: number;
	/** ISO timestamp when a reply was received for this message. */
	repliedAt?: string;
	/** Content of the reply received for this message. */
	replyContent?: string;
}

export interface MailboxDeliveryState {
	messages: Record<string, MailboxMessageStatus>;
	updatedAt: string;
}

export interface MailboxValidationIssue {
	level: "error" | "warning";
	path: string;
	message: string;
}

export interface MailboxValidationReport {
	issues: MailboxValidationIssue[];
	repaired: string[];
}

export interface MailboxReplayResult {
	messages: MailboxMessage[];
	updatedAt: string;
}

function mailboxDir(manifest: TeamRunManifest): string {
	return path.join(manifest.stateRoot, "mailbox");
}

function safeMailboxDir(manifest: TeamRunManifest, create = false): string {
	const dir = mailboxDir(manifest);
	if (create) fs.mkdirSync(dir, { recursive: true });
	if (!fs.existsSync(dir)) return dir;
	if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Invalid mailbox directory: ${dir}`);
	return resolveRealContainedPath(manifest.stateRoot, "mailbox");
}

function safeTaskId(taskId: string): string {
	if (!/^[\w.-]+$/.test(taskId) || taskId.includes("..") || path.isAbsolute(taskId)) throw new Error(`Invalid mailbox task id: ${taskId}`);
	return taskId;
}

function safeMailboxTasksRoot(manifest: TeamRunManifest, create = false): string {
	const root = path.join(safeMailboxDir(manifest, create), "tasks");
	if (create) fs.mkdirSync(root, { recursive: true });
	if (!fs.existsSync(root)) return root;
	if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`Invalid mailbox tasks directory: ${root}`);
	return resolveRealContainedPath(safeMailboxDir(manifest), "tasks");
}

function taskMailboxDir(manifest: TeamRunManifest, taskId: string, create = false): string {
	const tasksRoot = safeMailboxTasksRoot(manifest, create);
	const normalizedTaskId = safeTaskId(taskId);
	const resolved = path.resolve(tasksRoot, normalizedTaskId);
	const relative = path.relative(tasksRoot, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Invalid mailbox task id: ${taskId}`);
	if (create) fs.mkdirSync(resolved, { recursive: true });
	if (!fs.existsSync(resolved)) return resolved;
	if (fs.lstatSync(resolved).isSymbolicLink()) throw new Error(`Invalid mailbox task directory: ${resolved}`);
	return resolveRealContainedPath(tasksRoot, normalizedTaskId);
}

function mailboxPath(manifest: TeamRunManifest, direction: MailboxDirection, taskId?: string, create = false): string {
	return taskId ? path.join(taskMailboxDir(manifest, taskId, create), `${direction}.jsonl`) : path.join(safeMailboxDir(manifest, create), `${direction}.jsonl`);
}

function deliveryPath(manifest: TeamRunManifest, create = false): string {
	return path.join(safeMailboxDir(manifest, create), "delivery.json");
}

function safeMailboxFile(filePath: string, parentDir: string): string {
	if (!fs.existsSync(filePath)) return filePath;
	if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`Invalid mailbox file: ${filePath}`);
	return resolveRealContainedPath(parentDir, path.basename(filePath));
}

function mailboxFile(manifest: TeamRunManifest, direction: MailboxDirection, taskId?: string, create = false): string {
	const parent = taskId ? taskMailboxDir(manifest, taskId, create) : safeMailboxDir(manifest, create);
	return safeMailboxFile(path.join(parent, `${direction}.jsonl`), parent);
}

function deliveryFile(manifest: TeamRunManifest, create = false): string {
	const parent = safeMailboxDir(manifest, create);
	return safeMailboxFile(path.join(parent, "delivery.json"), parent);
}

function ensureRunMailbox(manifest: TeamRunManifest): void {
	safeMailboxDir(manifest, true);
	for (const direction of ["inbox", "outbox"] as const) {
		const filePath = mailboxFile(manifest, direction, undefined, true);
		if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf-8");
	}
	const delivery = deliveryFile(manifest, true);
	if (!fs.existsSync(delivery)) fs.writeFileSync(delivery, `${JSON.stringify({ messages: {}, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf-8");
}

function ensureTaskMailbox(manifest: TeamRunManifest, taskId: string): void {
	ensureRunMailbox(manifest);
	taskMailboxDir(manifest, taskId, true);
	for (const direction of ["inbox", "outbox"] as const) {
		const filePath = mailboxFile(manifest, direction, taskId, true);
		if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf-8");
	}
}

function isDirection(value: unknown): value is MailboxDirection {
	return value === "inbox" || value === "outbox";
}

function isStatus(value: unknown): value is MailboxMessageStatus {
	return value === "queued" || value === "delivered" || value === "acknowledged";
}

function isKind(value: unknown): value is MailboxMessageKind {
	return value === "message" || value === "steer" || value === "follow-up" || value === "response" || value === "group_join";
}

function isPriority(value: unknown): value is MailboxMessagePriority {
	return value === "urgent" || value === "normal" || value === "low";
}

function isDeliveryMode(value: unknown): value is MailboxDeliveryMode {
	return value === "interrupt" || value === "next_turn";
}

function parseMailboxMessage(raw: unknown, expectedDirection: MailboxDirection): MailboxMessage | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.id !== "string" || typeof obj.runId !== "string" || !isDirection(obj.direction) || typeof obj.from !== "string" || typeof obj.to !== "string" || typeof obj.body !== "string" || typeof obj.createdAt !== "string" || !isStatus(obj.status)) return undefined;
	if (obj.direction !== expectedDirection) return undefined;
	const data = obj.data && typeof obj.data === "object" && !Array.isArray(obj.data) ? obj.data as Record<string, unknown> : undefined;
	const dataKind = data?.kind;
	return { id: obj.id, runId: obj.runId, direction: obj.direction, from: obj.from, to: obj.to, body: obj.body, createdAt: obj.createdAt, status: obj.status, kind: isKind(obj.kind) ? obj.kind : isKind(dataKind) ? dataKind : undefined, priority: isPriority(obj.priority) ? obj.priority : undefined, deliveryMode: isDeliveryMode(obj.deliveryMode) ? obj.deliveryMode : undefined, taskId: typeof obj.taskId === "string" ? obj.taskId : undefined, acknowledgedAt: typeof obj.acknowledgedAt === "string" ? obj.acknowledgedAt : undefined, data, replyTo: typeof obj.replyTo === "string" ? obj.replyTo : undefined, replyFrom: typeof obj.replyFrom === "string" ? obj.replyFrom : undefined, replyDeadline: typeof obj.replyDeadline === "number" ? obj.replyDeadline : undefined, repliedAt: typeof obj.repliedAt === "string" ? obj.repliedAt : undefined, replyContent: typeof obj.replyContent === "string" ? obj.replyContent : undefined };
}

function readMailboxFile(filePath: string, direction: MailboxDirection): MailboxMessage[] {
	if (!fs.existsSync(filePath)) return [];
	const messages: MailboxMessage[] = [];
	const raw = fs.readFileSync(filePath, "utf-8");
	for (const line of raw.split(/\r?\n/).filter(Boolean)) {
		try {
			const message = parseMailboxMessage(JSON.parse(line) as unknown, direction);
			if (message) messages.push(message);
		} catch {
			// Invalid mailbox lines are reported by validateMailbox().
		}
	}
	return messages;
}

function safeReadMailboxFile(filePath: string, direction: MailboxDirection): MailboxMessage[] {
	if (!fs.existsSync(filePath)) return [];
	const messages: MailboxMessage[] = readMailboxFile(filePath, direction);
	// 3.3 — also include any rotated archive files alongside the live file.
	// Archive naming: `<filename>.<isoTimestamp>.archive.jsonl`.
	try {
		const dir = path.dirname(filePath);
		const base = path.basename(filePath);
		for (const entry of fs.readdirSync(dir)) {
			if (!entry.startsWith(`${base}.`) || !entry.endsWith(".archive.jsonl")) continue;
			const archivePath = path.join(dir, entry);
			messages.push(...readMailboxFile(archivePath, direction));
		}
	} catch {
		// Directory missing — nothing to read.
	}
	return messages;
}

/**
 * 3.3 — rotate a mailbox JSONL file when it grows past `thresholdBytes`.
 * Renames it to `<file>.<timestamp>.archive.jsonl` and re-creates an empty
 * primary file. Readers continue to see all messages because
 * `safeReadMailboxFile` walks both the primary file and any archives.
 */
const MAILBOX_ARCHIVE_THRESHOLD_BYTES = 10 * 1024 * 1024;
function rotateMailboxFileIfNeeded(filePath: string, thresholdBytes = MAILBOX_ARCHIVE_THRESHOLD_BYTES): boolean {
	try {
		if (!fs.existsSync(filePath)) return false;
		const stat = fs.statSync(filePath);
		if (stat.size < thresholdBytes) return false;
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const archivePath = `${filePath}.${ts}.archive.jsonl`;
		fs.renameSync(filePath, archivePath);
		fs.writeFileSync(filePath, "", "utf-8");
		return true;
	} catch (error) {
		logInternalError("mailbox.rotate", error, filePath);
		return false;
	}
}

export function readMailbox(manifest: TeamRunManifest, direction?: MailboxDirection, taskId?: string, kind?: MailboxMessageKind): MailboxMessage[] {
	const directions = direction ? [direction] : ["inbox", "outbox"] as const;
	return directions.flatMap((item) => safeReadMailboxFile(mailboxFile(manifest, item, taskId), item)).filter((msg) => !kind || msg.kind === kind).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function readAllMailboxMessages(manifest: TeamRunManifest, direction?: MailboxDirection, signal?: AbortSignal): MailboxMessage[] {
	const directions = direction ? [direction] : ["inbox", "outbox"] as const;
	return directions.flatMap((item) => readAllMessages(manifest, item, signal)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function readAllMessages(manifest: TeamRunManifest, direction: MailboxDirection, signal?: AbortSignal): MailboxMessage[] {
	const messages = [...safeReadMailboxFile(mailboxFile(manifest, direction), direction)];
	const tasksDir = safeMailboxTasksRoot(manifest);
	if (fs.existsSync(tasksDir)) {
		for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
			if (signal?.aborted) break;
			if (!entry.isDirectory()) continue;
			messages.push(...safeReadMailboxFile(mailboxFile(manifest, direction, entry.name), direction));
		}
	}
	return messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function readAllInboxMessages(manifest: TeamRunManifest): MailboxMessage[] {
	return readAllMessages(manifest, "inbox");
}

export function readDeliveryState(manifest: TeamRunManifest): MailboxDeliveryState {
	try {
		const raw = JSON.parse(fs.readFileSync(deliveryFile(manifest), "utf-8")) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid delivery state.");
		const obj = raw as Record<string, unknown>;
		const messages: Record<string, MailboxMessageStatus> = {};
		if (obj.messages && typeof obj.messages === "object" && !Array.isArray(obj.messages)) {
			for (const [id, status] of Object.entries(obj.messages)) if (isStatus(status)) messages[id] = status;
		}
		return { messages, updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString() };
	} catch {
		return { messages: {}, updatedAt: new Date().toISOString() };
	}
}

function writeDeliveryState(manifest: TeamRunManifest, state: MailboxDeliveryState): void {
	ensureRunMailbox(manifest);
	atomicWriteFile(deliveryFile(manifest, true), `${JSON.stringify(redactSecrets(state), null, 2)}\n`);
}

export function appendMailboxMessage(manifest: TeamRunManifest, message: Omit<MailboxMessage, "id" | "runId" | "createdAt" | "status"> & { id?: string; status?: MailboxMessageStatus }): MailboxMessage {
	if (message.taskId) ensureTaskMailbox(manifest, message.taskId);
	else ensureRunMailbox(manifest);
	const createdAt = new Date().toISOString();
	const complete: MailboxMessage = {
		id: message.id ?? `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
		runId: manifest.runId,
		direction: message.direction,
		from: message.from,
		to: message.to,
		body: message.body,
		createdAt,
		status: message.status ?? "queued",
		kind: message.kind,
		priority: message.priority,
		deliveryMode: message.deliveryMode,
		taskId: message.taskId,
		data: message.data,
		replyTo: message.replyTo,
		replyFrom: message.replyFrom,
		replyDeadline: message.replyDeadline,
		repliedAt: message.repliedAt,
		replyContent: message.replyContent,
	};
	fs.appendFileSync(mailboxFile(manifest, complete.direction, complete.taskId), `${JSON.stringify(redactSecrets(complete))}\n`, "utf-8");
	// 3.3 — rotate mailbox file if it has grown past 10 MB. Cheap stat
	// check; rotates at most once per append.
	rotateMailboxFileIfNeeded(mailboxFile(manifest, complete.direction, complete.taskId));
	const delivery = readDeliveryState(manifest);
	delivery.messages[complete.id] = complete.status;
	delivery.updatedAt = createdAt;
	writeDeliveryState(manifest, delivery);
	return complete;
}

export function appendSteeringMessage(manifest: TeamRunManifest, input: { taskId: string; body: string; from?: string; to?: string; priority?: MailboxMessagePriority; status?: MailboxMessageStatus; data?: Record<string, unknown> }): MailboxMessage {
	return appendMailboxMessage(manifest, { direction: "inbox", from: input.from ?? "leader", to: input.to ?? input.taskId, taskId: input.taskId, body: input.body, kind: "steer", priority: input.priority ?? "urgent", deliveryMode: "interrupt", status: input.status, data: { ...(input.data ?? {}), kind: "steer" } });
}

export function appendFollowUpMessage(manifest: TeamRunManifest, input: { taskId: string; body: string; from?: string; to?: string; priority?: MailboxMessagePriority; status?: MailboxMessageStatus; data?: Record<string, unknown> }): MailboxMessage {
	return appendMailboxMessage(manifest, { direction: "inbox", from: input.from ?? "leader", to: input.to ?? input.taskId, taskId: input.taskId, body: input.body, kind: "follow-up", priority: input.priority ?? "normal", deliveryMode: "next_turn", status: input.status, data: { ...(input.data ?? {}), kind: "follow-up" } });
}

export function listMailboxByKind(manifest: TeamRunManifest, kind: MailboxMessageKind, direction?: MailboxDirection): MailboxMessage[] {
	const messages = direction ? readAllMessages(manifest, direction) : [...readAllMessages(manifest, "inbox"), ...readAllMessages(manifest, "outbox")].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	return messages.filter((message) => message.kind === kind || message.data?.kind === kind);
}

export function findMailboxMessageByRequestId(manifest: TeamRunManifest, requestId: string): MailboxMessage | undefined {
	return readMailbox(manifest).find((message) => message.data?.requestId === requestId);
}

export function readMailboxMessage(manifest: TeamRunManifest, messageId: string): MailboxMessage | undefined {
	return readMailbox(manifest).find((message) => message.id === messageId);
}

export function acknowledgeMailboxMessage(manifest: TeamRunManifest, messageId: string): MailboxDeliveryState {
	const delivery = readDeliveryState(manifest);
	if (!delivery.messages[messageId]) throw new Error(`Mailbox message '${messageId}' not found.`);
	delivery.messages[messageId] = "acknowledged";
	delivery.updatedAt = new Date().toISOString();
	writeDeliveryState(manifest, delivery);
	return delivery;
}

/**
 * Update an original mailbox message with reply metadata.
 * Rewrites the mailbox file line containing the original message
 * to include `repliedAt` and `replyContent`.
 */
export function updateMailboxMessageReply(manifest: TeamRunManifest, originalMessageId: string, replyContent: string): void {
	const directions: MailboxDirection[] = ["inbox", "outbox"];

	// Collect all mailbox file paths (global + task-specific)
	const filesToSearch: Array<{ filePath: string; direction: MailboxDirection }> = [];
	for (const direction of directions) {
		filesToSearch.push({ filePath: mailboxFile(manifest, direction), direction });
	}
	const tasksDir = safeMailboxTasksRoot(manifest);
	if (fs.existsSync(tasksDir)) {
		for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			for (const direction of directions) {
				filesToSearch.push({ filePath: mailboxFile(manifest, direction, entry.name), direction });
			}
		}
	}

	for (const { filePath, direction } of filesToSearch) {
		if (!fs.existsSync(filePath)) continue;
		const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
		let found = false;
		const updatedLines: string[] = [];
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as unknown;
				const msg = parseMailboxMessage(parsed, direction);
				if (msg && msg.id === originalMessageId) {
					msg.repliedAt = new Date().toISOString();
					msg.replyContent = replyContent;
					updatedLines.push(JSON.stringify(redactSecrets(msg)));
					found = true;
				} else {
					updatedLines.push(line);
				}
			} catch {
				updatedLines.push(line);
			}
		}
		if (found) {
			atomicWriteFile(filePath, `${updatedLines.join("\n")}\n`);
			return;
		}
	}
	// Not finding the original is non-fatal; the reply is still delivered.
}

export function replayPendingMailboxMessages(manifest: TeamRunManifest): MailboxReplayResult {
	const delivery = readDeliveryState(manifest);
	const pending = readAllInboxMessages(manifest).filter((message) => message.status !== "acknowledged" && delivery.messages[message.id] !== "acknowledged");
	if (!pending.length) return { messages: [], updatedAt: delivery.updatedAt };
	const updatedAt = new Date().toISOString();
	for (const message of pending) delivery.messages[message.id] = "delivered";
	delivery.updatedAt = updatedAt;
	writeDeliveryState(manifest, delivery);
	return { messages: pending, updatedAt };
}

export function validateMailbox(manifest: TeamRunManifest, options: { repair?: boolean; signal?: AbortSignal } = {}): MailboxValidationReport {
	ensureRunMailbox(manifest);
	const issues: MailboxValidationIssue[] = [];
	const repaired: string[] = [];
	for (const direction of ["inbox", "outbox"] as const) {
		if (options.signal?.aborted) break;
		const filePath = mailboxFile(manifest, direction);
		const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
		const validLines: string[] = [];
		for (let i = 0; i < lines.length; i += 1) {
			if (options.signal?.aborted) break;
			const line = lines[i];
			if (!line) continue;
			try {
				const parsed = JSON.parse(line) as unknown;
				const message = parseMailboxMessage(parsed, direction);
				if (!message) throw new Error("invalid message schema");
				validLines.push(JSON.stringify(redactSecrets(message)));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				issues.push({ level: "error", path: filePath, message });
			}
		}
		if (options.repair && validLines.length !== lines.length) {
			atomicWriteFile(filePath, `${validLines.join("\n")}${validLines.length ? "\n" : ""}`);
			repaired.push(filePath);
		}
	}
	const delivery = readDeliveryState(manifest);
	const allMessages = readMailbox(manifest);
	for (const message of allMessages) {
		if (options.signal?.aborted) break;
		if (!delivery.messages[message.id]) issues.push({ level: "warning", path: deliveryFile(manifest), message: `Missing delivery entry for ${message.id}.` });
	}
	if (options.repair) {
		for (const message of allMessages) delivery.messages[message.id] ??= message.status;
		delivery.updatedAt = new Date().toISOString();
		writeDeliveryState(manifest, delivery);
		repaired.push(deliveryFile(manifest));
	}
	return { issues, repaired };
}
