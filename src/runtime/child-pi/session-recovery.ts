/**
 * W2 (Pi 1.0.0 adoption — session-file recovery).
 *
 * Workers run with a DETERMINISTIC pi session identity: `--session-id` +
 * `--session-dir` pointing under the run's artifacts root
 * (`<artifactsRoot>/sessions/<safeTaskId>/`), so session JSONL lives and dies
 * with run artifacts (auto-prune) instead of `~/.pi`. When a worker dies
 * WITHOUT a final assistant event (exitCode null / killed — SIGKILL between
 * turns), the session file still contains every COMPLETED turn (the SDK
 * persists records at message_end; a kill can only tear the line being
 * written). This module tail-replays that file and surfaces the last complete
 * assistant record as `recoveredFromSession` on the run result.
 *
 * Contract (per verified packet):
 * - Entry parsing is DELEGATED to the SDK (`parseSessionEntries` /
 *   `migrateSessionEntries`) — no hand-rolled parser. The only local IO
 *   defense is dropping a torn trailing fragment line (no final `\n`).
 * - A trailing user/toolResult record with no assistant after it means the
 *   worker died mid-turn → the last COMPLETE assistant BEFORE it is recovered.
 * - Recovery AUGMENTS the settle-time result; manifest polling is untouched.
 * - Default ON; `PI_CREW_SESSION_RECOVERY` env overrides; explicit
 *   `sessionRecovery: false` (runtime config) is the opt-out below env.
 *
 * SDK import is a LAZY dynamic import (first value-import of the SDK in
 * src/runtime): recovery only runs on crash paths, so module init must never
 * pay the SDK load cost.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getCrewEnvBool } from "../../config/env-vars.ts";
import { isSafePathId } from "../../utils/safe-paths.ts";

/** Recovered last-complete-assistant payload attached to the run result. */
export interface SessionRecoveryInfo {
	/** The session id the worker ran with (`--session-id`). */
	sessionId: string;
	/** Absolute path of the session JSONL the text was recovered from. */
	sessionFile: string;
	/** Text content of the last complete assistant message (text parts joined). */
	text: string;
	/** Timestamp of the recovered session entry (ISO). */
	timestamp: string;
	/** Stop reason of the recovered assistant message (e.g. "stop", "toolUse"). */
	stopReason?: string;
}

/** Per-worker session identity resolved from the run input. */
export interface WorkerSessionContext {
	sessionId: string;
	sessionDir: string;
}

/** Identity fields read off `ChildPiRunInput` (kept structural for tests). */
export interface SessionIdentityInput {
	sessionId?: string;
	sessionDir?: string;
	agentId?: string;
	artifactsRoot?: string;
}

/**
 * Sanitize a task/session id the same way the state store does
 * (crew-agent-records.ts safeAgentTaskId — module-private there, mirrored
 * here): delegate ids "parent:child" collapse to the last segment, then the
 * result must be path-safe. Returns null when unsafe — callers fail closed
 * (no session flags, no recovery) rather than spawning with a broken id.
 * [A-Za-z0-9_-]+ is a strict subset of the SDK's session-id charset.
 */
function sanitizeSessionIdentity(rawId: string): string | null {
	const leaf = rawId.includes(":") ? (rawId.split(":").pop() ?? "") : rawId;
	return isSafePathId(leaf) ? leaf : null;
}

/**
 * Derive the worker's deterministic session identity.
 *
 * Layout (packet §R2.2 + fact pack §3): session files land in a PER-WORKER
 * directory `<artifactsRoot>/sessions/<safeTaskId>/`; the session id rides
 * `--session-id` (explicit `sessionId` — e.g. manifest.sessionId already
 * threaded by child-executor — preferred, else the safe task id). Same id
 * across retries appends to one file = cross-attempt resume for free.
 *
 * Returns null (→ no session flags, recovery silently impossible) when the
 * artifacts root is unknown or no sanitizable identity exists.
 */
export function deriveSessionPaths(input: SessionIdentityInput): WorkerSessionContext | null {
	const safeAgent = input.agentId ? sanitizeSessionIdentity(input.agentId) : null;
	const safeSession = input.sessionId ? sanitizeSessionIdentity(input.sessionId) : null;
	// File id: explicit session id (manifest.sessionId) preferred, else task id.
	const sessionId = safeSession ?? safeAgent;
	// Dir leaf: PER-WORKER (safe task id) so same-run siblings never share a
	// session file; fall back to the session id for agent-id-less custom spawns.
	const dirLeaf = safeAgent ?? safeSession;
	if (!sessionId || !dirLeaf) return null;
	if (input.sessionDir) return { sessionId, sessionDir: input.sessionDir };
	if (!input.artifactsRoot) return null;
	return { sessionId, sessionDir: path.join(input.artifactsRoot, "sessions", dirLeaf) };
}

/**
 * Append the session flags to the two argv views produced by
 * `prepareSpawnContext`: `builtArgs` (raw worker argv — also consumed by the
 * surface branch) and the headless `spawnArgs` ([script, ...builtArgs]).
 * Flags are inserted right after the `--mode json -p` cluster so they never
 * trail the task-file positional. Idempotent: if the flags are already
 * present (builder forwarding, future wiring), this is a no-op.
 */
export function appendWorkerSessionArgs(spawnArgs: string[], builtArgs: string[], ctx: WorkerSessionContext): boolean {
	if (builtArgs.includes("--session-id") || builtArgs.includes("--session-dir")) return false;
	const flags = ["--session-id", ctx.sessionId, "--session-dir", ctx.sessionDir];
	insertAfterHeadlessCluster(builtArgs, flags);
	if (!spawnArgs.includes("--session-id")) insertAfterHeadlessCluster(spawnArgs, flags);
	return true;
}

function insertAfterHeadlessCluster(arr: string[], flags: string[]): void {
	const idx = arr.indexOf("--mode");
	if (idx !== -1 && arr[idx + 1] === "json" && arr[idx + 2] === "-p") {
		arr.splice(idx + 3, 0, ...flags);
	} else {
		arr.push(...flags);
	}
}

/**
 * Recovery gate: explicit flag (runtime.sessionRecovery → ChildPiRunInput)
 * with env override. Default ON (W2 scope). The env var is the operator
 * kill-switch and wins in EITHER direction.
 */
export function resolveSessionRecoveryEnabled(explicit?: boolean): boolean {
	const env = getCrewEnvBool("PI_CREW_SESSION_RECOVERY");
	if (env !== undefined) return env;
	return explicit ?? true;
}

/**
 * Crash-path predicate (packet: exitCode === null OR killed). Structural so
 * both the pre-resolve result and a materialized WorkerExitStatus feed it.
 */
export function shouldAttemptSessionRecovery(
	result: { exitCode: number | null; exitStatus?: { exitCode?: number | null; killed?: boolean } },
	killed: boolean,
): boolean {
	// NB: explicit `exitCode: null` in exitStatus IS the signal-death signal —
	// `??` would collapse it onto the outer exitCode, so branch on presence.
	const status = result.exitStatus;
	const exitCode = status && status.exitCode !== undefined ? status.exitCode : result.exitCode;
	const wasKilled = status && status.killed !== undefined ? status.killed : killed;
	return exitCode === null || wasKilled === true;
}

/** Bounded crash-path work: never let a pathological read hang task settle. */
const RECOVERY_DEADLINE_MS = 5_000;
/** Scan at most this many candidate files (id-matched first, then newest). */
const RECOVERY_MAX_FILES = 3;
/** Skip absurdly large session files rather than blocking settle for them. */
const RECOVERY_MAX_FILE_BYTES = 64 * 1024 * 1024;

interface SessionParserModule {
	parseSessionEntries(content: string): unknown[];
	migrateSessionEntries(entries: unknown[]): void;
}

let sessionParserCache: SessionParserModule | null | undefined;

async function loadSessionParser(): Promise<SessionParserModule | null> {
	if (sessionParserCache !== undefined) return sessionParserCache;
	try {
		// LAZY: first value-import of the SDK inside src/runtime — recovery is a
		// crash-path concern; child-pi module init must never pay SDK load cost.
		const mod = (await import("@earendil-works/pi-coding-agent")) as unknown as SessionParserModule;
		sessionParserCache = typeof mod.parseSessionEntries === "function" && typeof mod.migrateSessionEntries === "function" ? mod : null;
	} catch {
		sessionParserCache = null;
	}
	return sessionParserCache;
}

/**
 * Candidate session files, best-first: id-suffixed matches
 * (`<ISO-ts>_<sessionId>.jsonl`) newest-mtime first, then any other .jsonl
 * (fallback for id-less derivation). Missing/unreadable dir → [].
 */
function listSessionCandidateFiles(sessionDir: string, sessionId?: string): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(sessionDir);
	} catch {
		return [];
	}
	const jsonl = names.filter((n) => n.endsWith(".jsonl"));
	const withMtime = (list: string[]): { name: string; mtimeMs: number }[] => {
		const out: { name: string; mtimeMs: number }[] = [];
		for (const name of list) {
			try {
				out.push({ name, mtimeMs: fs.statSync(path.join(sessionDir, name)).mtimeMs });
			} catch {
				/* raced away — ignore */
			}
		}
		return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	};
	const matched = sessionId ? withMtime(jsonl.filter((n) => n.endsWith(`_${sessionId}.jsonl`))) : [];
	const matchedSet = new Set(matched.map((x) => x.name));
	const rest = withMtime(jsonl.filter((n) => !matchedSet.has(n)));
	return [...matched, ...rest].map((x) => path.join(sessionDir, x.name));
}

interface AssistantMessageLike {
	role?: unknown;
	content?: unknown;
	stopReason?: unknown;
}

/** Join the text parts of an assistant message's content array. */
function extractAssistantText(content: unknown): string {
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string" && text.length > 0) parts.push(text);
		}
	}
	return parts.join("\n");
}

async function readLastCompleteAssistant(sessionFile: string, sessionId: string): Promise<SessionRecoveryInfo | null> {
	let size: number;
	try {
		size = fs.statSync(sessionFile).size;
	} catch {
		return null;
	}
	if (size <= 0 || size > RECOVERY_MAX_FILE_BYTES) return null;
	let content: string;
	try {
		content = fs.readFileSync(sessionFile, "utf8");
	} catch {
		return null;
	}
	// Defensive torn-tail: a SIGKILL can interrupt the final line mid-write
	// (no trailing newline). parseSessionEntries already skips malformed
	// lines, but drop the unterminated fragment explicitly so it can never be
	// resurrected as a partial record by migration.
	if (content.length > 0 && !content.endsWith("\n")) {
		content = content.slice(0, content.lastIndexOf("\n") + 1);
	}
	const parser = await loadSessionParser();
	if (!parser) return null;
	let entries: unknown[];
	try {
		entries = parser.parseSessionEntries(content);
		parser.migrateSessionEntries(entries);
	} catch {
		return null;
	}
	// Backward scan for the last COMPLETE assistant record: role assistant,
	// stopReason present and not "pending" (dangling), and it must carry
	// replayable text — tool-call-only turns recover nothing useful, keep
	// scanning for the last turn that actually spoke.
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") continue;
		const message = (entry as { message?: unknown }).message;
		if (!message || typeof message !== "object") continue;
		const assistant = message as AssistantMessageLike;
		if (assistant.role !== "assistant") continue;
		const stopReason = assistant.stopReason;
		if (typeof stopReason !== "string" || stopReason === "pending") continue;
		const text = extractAssistantText(assistant.content);
		if (!text) continue;
		return {
			sessionId,
			sessionFile,
			text,
			timestamp:
				typeof (entry as { timestamp?: unknown }).timestamp === "string"
					? ((entry as { timestamp?: unknown }).timestamp as string)
					: "",
			stopReason,
		};
	}
	return null;
}

async function doRecoverLastAssistant(sessionDir: string, sessionId?: string): Promise<SessionRecoveryInfo | null> {
	for (const file of listSessionCandidateFiles(sessionDir, sessionId).slice(0, RECOVERY_MAX_FILES)) {
		const info = await readLastCompleteAssistant(file, sessionId ?? path.basename(file).replace(/\.jsonl$/, ""));
		if (info) return info;
	}
	return null;
}

/**
 * Tail-replay a worker's session directory: recover the last COMPLETE
 * assistant record from the best candidate session JSONL. Returns null when
 * nothing recoverable exists (no dir, no files, no complete assistant turn,
 * SDK unresolvable). Best-effort by contract — never throws, never hangs
 * past RECOVERY_DEADLINE_MS.
 */
export async function recoverLastAssistantFromSession(sessionDir: string, sessionId?: string): Promise<SessionRecoveryInfo | null> {
	const attempt = doRecoverLastAssistant(sessionDir, sessionId);
	return await Promise.race([
		attempt,
		new Promise<SessionRecoveryInfo | null>((resolve) => {
			const timer = setTimeout(() => resolve(null), RECOVERY_DEADLINE_MS);
			timer.unref();
		}),
	]);
}
