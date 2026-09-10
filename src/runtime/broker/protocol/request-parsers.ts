/**
 * request-parsers.ts — Protocol-level parameter parsers and type guards for
 * the crew-broker wire protocol.
 *
 * Moved from crew-broker.ts (M4 / WI-4.1) — pure move, no behavior change.
 * Every parser rejects malformed frames at the boundary so handlers see only
 * typed params. Method-name charset check (^[a-zA-Z][a-zA-Z0-9._-]{0,63}$)
 * guards against control chars / oversized names reaching the dispatcher.
 */

import type { MailboxMessageKind, MailboxMessagePriority } from "../../../state/coordination/mailbox.ts";

/** Protocol version negotiated at `hello` time. Bump on breaking change. */
export const BROKER_PROTOCOL = 1;

// ============================================================================
// Type guards (no `any`)
// ============================================================================

export function isRequestObject(value: unknown): value is { id: string; method: string; params: unknown } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || v.id.length === 0 || v.id.length > 256) return false;
	if (typeof v.method !== "string" || v.method.length === 0 || v.method.length > 64) return false;
	// Method names are restricted to a small safe charset. This guards against
	// odd inputs (control chars, very long names) reaching the dispatcher.
	if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(v.method)) return false;
	// params may be anything (validated per-method), but not undefined-shaped.
	return "params" in v;
}

export function isHelloParams(value: unknown): value is {
	protocol: number;
	runId: string;
	taskId: string;
	token: string;
	role?: string;
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	if (v.protocol !== BROKER_PROTOCOL) {
		// Force exact-type comparison (must be the number 1, not "1").
		if (typeof v.protocol !== "number" || !Number.isInteger(v.protocol)) return false;
	}
	if (typeof v.runId !== "string" || v.runId.length === 0 || v.runId.length > 256) return false;
	if (typeof v.taskId !== "string" || v.taskId.length === 0 || v.taskId.length > 256) return false;
	if (typeof v.token !== "string" || v.token.length === 0 || v.token.length > 256) return false;
	return true;
}

// ============================================================================
// Phase 1 parameter parsers (module-level; no `any`)
// ============================================================================

export interface MsgSendParams {
	to: string | string[] | "all";
	body: unknown;
	kind?: MailboxMessageKind;
	priority?: MailboxMessagePriority;
	replyTo?: string;
	/** Task 5b (§15.2): short subject echoed into the worker.message wake
	 * event (bounded like the tool-side MSG_SUBJECT_MAX_CHARS). */
	subject?: string;
}

export function parseMsgSendParams(value: unknown): MsgSendParams | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	const to = v.to;
	if (typeof to !== "string" && !Array.isArray(to)) return undefined;
	if (Array.isArray(to) && !to.every((s) => typeof s === "string" && s.length > 0)) return undefined;
	if (typeof to === "string" && to.length === 0) return undefined;
	if (v.body === undefined) return undefined;
	const kind = v.kind as MailboxMessageKind | undefined;
	if (kind !== undefined && !["message", "notify", "steer", "follow-up", "response", "group_join"].includes(kind)) {
		return undefined;
	}
	const priority = v.priority as MailboxMessagePriority | undefined;
	if (priority !== undefined && !["urgent", "normal", "low"].includes(priority)) {
		return undefined;
	}
	const replyTo = typeof v.replyTo === "string" ? v.replyTo : undefined;
	const subject = typeof v.subject === "string" && v.subject.length > 0 && v.subject.length <= 256 ? v.subject : undefined;
	return { to: to as string | string[] | "all", body: v.body, kind, priority, replyTo, subject };
}

export interface MsgInboxParams {
	limit?: number;
	cursor?: string;
}

export function parseMsgInboxParams(value: unknown): MsgInboxParams | undefined {
	if (value === undefined || value === null) return { limit: 100, cursor: undefined };
	if (typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	const limit = v.limit;
	if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1)) {
		return undefined;
	}
	const cursor = v.cursor;
	if (cursor !== undefined && typeof cursor !== "string") return undefined;
	return { limit: limit as number | undefined, cursor: cursor as string | undefined };
}

export function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "{}";
	} catch {
		return "{}";
	}
}

// ============================================================================
// WP-2/R2 wait.* parameter parsers (ADR-0 2026-08-17-waiting-producer-ask)
// ============================================================================

/** Server-side ceiling for the ask deadline (ADR P2-7): worker-controlled
 *  timeoutSec may NEVER exceed 1h — an unbounded timeout would pin slots and
 *  amplify I/O. Applied as deadline = now + min(timeoutSec, 3600). */
export const WAIT_REQUEST_TIMEOUT_SEC_MAX = 3600;
/** Default ask timeout when the caller omits timeoutSec (ADR item 1). */
export const WAIT_REQUEST_TIMEOUT_SEC_DEFAULT = 600;
/** Bounded question payload (defense-in-depth under the 256 KiB frame cap). */
export const WAIT_QUESTION_MAX_CHARS = 8192;
/** Bounded answer-choice list: at most 16 options, 256 chars each. */
export const WAIT_OPTIONS_MAX = 16;
export const WAIT_OPTION_MAX_CHARS = 256;

export interface WaitRequestParams {
	to: string;
	question: string;
	options?: string[];
	timeoutSec?: number;
}

export function parseWaitRequestParams(value: unknown): WaitRequestParams | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	if (typeof v.to !== "string" || v.to.length === 0 || v.to.length > 256) return undefined;
	if (typeof v.question !== "string" || v.question.length === 0 || v.question.length > WAIT_QUESTION_MAX_CHARS) {
		return undefined;
	}
	let options: string[] | undefined;
	if (v.options !== undefined) {
		if (!Array.isArray(v.options) || v.options.length === 0 || v.options.length > WAIT_OPTIONS_MAX) return undefined;
		for (const o of v.options) {
			if (typeof o !== "string" || o.length === 0 || o.length > WAIT_OPTION_MAX_CHARS) return undefined;
		}
		options = v.options as string[];
	}
	// timeoutSec is clamped server-side in the handler (max 3600); the parser
	// only rejects non-finite values. Non-positive values clamp to 1s.
	if (v.timeoutSec !== undefined && (typeof v.timeoutSec !== "number" || !Number.isFinite(v.timeoutSec))) {
		return undefined;
	}
	return {
		to: v.to,
		question: v.question,
		options,
		timeoutSec: v.timeoutSec as number | undefined,
	};
}

export interface WaitResolveParams {
	to: string;
	questionId: string;
}

export function parseWaitResolveParams(value: unknown): WaitResolveParams | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	if (typeof v.to !== "string" || v.to.length === 0 || v.to.length > 256) return undefined;
	if (typeof v.questionId !== "string" || v.questionId.length === 0 || v.questionId.length > 128) return undefined;
	return { to: v.to, questionId: v.questionId };
}
