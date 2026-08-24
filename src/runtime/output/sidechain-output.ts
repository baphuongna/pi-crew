import * as fs from "node:fs";
import * as path from "node:path";
import { logInternalError } from "../../utils/internal-error.ts";
import { redactSecrets } from "../../utils/redaction.ts";
import { isSafePathId } from "../../utils/safe-paths.ts";

export interface SidechainEntry {
	isSidechain: true;
	agentId: string;
	type: string;
	message: unknown;
	timestamp: string;
	cwd: string;
}

// ── Batched JSONL writer (Task 26, 2026-08-24) ──────────────────────────
// PERF (2026-08-24): the old writeSidechainEntry did one mkdirSync +
// appendFileSync + full redaction clone PER STREAMING EVENT (message_update
// fires per chunk). Batch per path on a 50ms unref'd timer like
// child-pi-transcript; redaction + serialization still run per event at
// queue time, and the flush does ONE mkdir + append per path per window.
interface PendingJsonlBatch {
	lines: string[];
	timer: NodeJS.Timeout;
}
const pendingJsonlBatches = new Map<string, PendingJsonlBatch>();
const JSONL_FLUSH_MS = 50;

function queueJsonlLine(filePath: string, line: string): void {
	const pending = pendingJsonlBatches.get(filePath);
	if (pending) {
		pending.lines.push(line);
		return;
	}
	const timer = setTimeout(() => flushJsonlBatch(filePath), JSONL_FLUSH_MS);
	timer.unref();
	pendingJsonlBatches.set(filePath, { lines: [line], timer });
}

function flushJsonlBatch(filePath: string): void {
	const pending = pendingJsonlBatches.get(filePath);
	if (!pending) return;
	pendingJsonlBatches.delete(filePath);
	clearTimeout(pending.timer);
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.appendFileSync(filePath, pending.lines.join(""), "utf-8");
	} catch (error) {
		logInternalError("sidechain-output.flush", error as Error, `path=${filePath}`);
	}
}

export function writeSidechainEntry(filePath: string, entry: Omit<SidechainEntry, "isSidechain" | "timestamp">): void {
	queueJsonlLine(filePath, `${JSON.stringify(redactSecrets({ isSidechain: true, timestamp: new Date().toISOString(), ...entry }))}\n`);
}

/**
 * Append one pre-serialized JSONL line through the shared batched writer.
 * Task 26: the live-session transcript append routes through the same
 * per-path 50ms batching as sidechain output. child-pi-transcript's batched
 * writer was NOT reused — it takes a ChildPiRunInput and enforces
 * artifactsRoot containment + a second redaction pass (redactJsonLine over
 * the already-redacted line), so it is not generic over plain paths.
 */
export function appendBatchedJsonlLine(filePath: string, line: string): void {
	queueJsonlLine(filePath, line);
}

/** @internal — flush on session teardown / process exit so files are complete. */
export function flushPendingSidechainWrites(): void {
	for (const filePath of [...pendingJsonlBatches.keys()]) flushJsonlBatch(filePath);
}

// The batch timers are unref'd, so a naturally-draining event loop can exit
// with unflushed telemetry. Same exit-hook pattern as atomic-write.ts and
// crew-agent-records.ts (sync-only work, safe inside "exit").
process.on("exit", () => flushPendingSidechainWrites());

export function sidechainOutputPath(stateRoot: string, taskId: string): string {
	if (!isSafePathId(taskId)) throw new Error(`Invalid taskId: ${taskId}`);
	return path.join(stateRoot, "agents", taskId, "sidechain.output.jsonl");
}

export function eventToSidechainType(event: unknown): string | undefined {
	if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
	const type = (event as { type?: unknown }).type;
	if (type === "message_start" || type === "message_update" || type === "message_end") return "message";
	if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") return "tool";
	return typeof type === "string" ? type : undefined;
}
