/**
 * request-parsers.ts — Protocol-level parameter parsers and type guards for
 * the crew-broker wire protocol.
 *
 * Moved from crew-broker.ts (M4 / WI-4.1) — pure move, no behavior change.
 * Every parser rejects malformed frames at the boundary so handlers see only
 * typed params. Method-name charset check (^[a-zA-Z][a-zA-Z0-9._-]{0,63}$)
 * guards against control chars / oversized names reaching the dispatcher.
 */

import type { MailboxDeliveryMode, MailboxMessageKind, MailboxMessagePriority } from "../../../state/coordination/mailbox.ts";

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
	/** U5 (2026-10-10): client-supplied idempotency key — a msg.send retried
	 *  with the SAME requestId is deduped per target mailbox (no duplicate
	 *  rows; the broker returns the existing message). Charset-bounded like
	 *  cross-extension-rpc's requestId to keep it a safe log/mailbox token. */
	requestId?: string;
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
	const rawRequestId = v.requestId;
	const requestId = typeof rawRequestId === "string" && /^[\w:.-]{1,256}$/.test(rawRequestId) ? rawRequestId : undefined;
	return { to: to as string | string[] | "all", body: v.body, kind, priority, replyTo, subject, requestId };
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
/** Default ask timeout when the caller omits timeoutSec (ADR item 1).
 * F2 (2026-09-12 live battery): MUST stay strictly below the worker response
 * watchdog (`DEFAULT_CHILD_PI.responseTimeoutMs` = 600s). A parked worker
 * emits NO output, so the watchdog counts the whole park; at 600==600 the
 * kill raced the wake and the worker died at its own deadline
 * (team_20260912014448: parked 01:46:01, response_timeout 01:56:01). 480s
 * leaves 120s grace for the worker to wake, answer its fallback, and finish
 * the turn. MAX stays 3600 (ADR P2-7) — a park longer than ~600s needs
 * PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS raised to survive the watchdog. */
export const WAIT_REQUEST_TIMEOUT_SEC_DEFAULT = 480;
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

// ============================================================================
// R7-H1 fix (deep-review round 8): delegate.request parameter parser.
// Mirrors parseWaitRequestParams discipline — the handler previously spread
// `typeof x === "number"` values straight into `requested`, so non-integer,
// non-finite, negative and over-ceiling maxTurns/budgetTokens reached
// admission (e.g. raw-wire -1e9 budget → durable negative tokensSpent;
// 1e999 → Infinity maxTurns → dead child-pi turn caps).
// ============================================================================

/** Server-side ceiling for grandchild turn caps (client tool schema: 1..200). */
export const DELEGATE_MAX_TURNS_CEILING = 200;
/** Server-side ceiling for grandchild token budgets (client schema: <=100M). */
export const DELEGATE_BUDGET_TOKENS_CEILING = 100_000_000;
/** Bounded delegate prompt (defense-in-depth under the frame cap). */
export const DELEGATE_PROMPT_MAX_CHARS = 100_000;

export interface DelegateRequestParams {
	prompt: string;
	description?: string;
	role?: string;
	model?: string;
	maxTurns?: number;
	budgetTokens?: number;
	timeoutSec?: number;
}

export function parseDelegateRequestParams(value: unknown): DelegateRequestParams | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	if (typeof v.prompt !== "string" || v.prompt.trim().length === 0 || v.prompt.length > DELEGATE_PROMPT_MAX_CHARS) {
		return undefined;
	}
	if (v.description !== undefined && typeof v.description !== "string") return undefined;
	if (v.role !== undefined && !(typeof v.role === "string" && ["explorer", "analyst", "executor"].includes(v.role))) {
		return undefined;
	}
	if (v.model !== undefined && typeof v.model !== "string") return undefined;
	if (v.maxTurns !== undefined) {
		if (typeof v.maxTurns !== "number" || !Number.isInteger(v.maxTurns) || v.maxTurns < 1 || v.maxTurns > DELEGATE_MAX_TURNS_CEILING) {
			return undefined;
		}
	}
	if (v.budgetTokens !== undefined) {
		if (
			typeof v.budgetTokens !== "number" ||
			!Number.isInteger(v.budgetTokens) || // R8 lane-B correction: client Type.Integer parity (0.5/3.5 pass isFinite)
			v.budgetTokens < 0 ||
			v.budgetTokens > DELEGATE_BUDGET_TOKENS_CEILING
		) {
			return undefined;
		}
	}
	// timeoutSec stays finite-only here; the 1..MAX range enforcement remains
	// in spawn-policy §7 (evaluateDelegateAdmission).
	if (v.timeoutSec !== undefined && (typeof v.timeoutSec !== "number" || !Number.isFinite(v.timeoutSec))) {
		return undefined;
	}
	return {
		prompt: v.prompt,
		...(typeof v.description === "string" ? { description: v.description } : {}),
		...(typeof v.role === "string" ? { role: v.role } : {}),
		...(typeof v.model === "string" ? { model: v.model } : {}),
		...(v.maxTurns !== undefined ? { maxTurns: v.maxTurns as number } : {}),
		...(v.budgetTokens !== undefined ? { budgetTokens: v.budgetTokens as number } : {}),
		...(v.timeoutSec !== undefined ? { timeoutSec: v.timeoutSec as number } : {}),
	};
}

export interface WaitResolveParams {
	to: string;
	questionId: string;
	/** G5 (deep-review 2026-10-01): the parked worker's terminal outcome —
	 *  "answered" = it PICKED UP the leader's mailbox response for this
	 *  questionId (the only outcome that triggers the broker's
	 *  task.respond_delivered ack event); "timed-out"/"aborted" resolve the
	 *  park WITHOUT a delivery claim. Optional + fail-closed: legacy workers
	 *  that omit it never claim a delivery (no event is emitted). */
	outcome?: "answered" | "timed-out" | "aborted";
}

export function parseWaitResolveParams(value: unknown): WaitResolveParams | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	if (typeof v.to !== "string" || v.to.length === 0 || v.to.length > 256) return undefined;
	if (typeof v.questionId !== "string" || v.questionId.length === 0 || v.questionId.length > 128) return undefined;
	if (v.outcome !== undefined && v.outcome !== "answered" && v.outcome !== "timed-out" && v.outcome !== "aborted") return undefined;
	return { to: v.to, questionId: v.questionId, ...(v.outcome !== undefined ? { outcome: v.outcome } : {}) };
}

// ============================================================================
// HƯỚNG A (ADR Option 3, 2026-11-01) — broker respond.* parameter parsers +
// the challenge-response canonical payload CONTRACT.
//
// `respond.challenge` / `respond.append` / `respond.force` are deliberately
// reachable PRE-hello (see CrewBroker.dispatchFrame): the whole point is that
// the responder may hold NO broker token at all — a dispatcher proving key
// possession (challenge-response) or a foreign session (force, gated by a
// live park). Because a pre-hello connection carries no runId, every params
// shape carries `runId` explicitly.
// ============================================================================

/** Bounded respond body (defense-in-depth under the 256 KiB frame cap). */
export const RESPOND_BODY_MAX_CHARS = 65_536;
/** Nonce shape: the broker issues 32 random bytes base64url (43 chars); the
 *  parser accepts a bounded envelope so future issuers stay compatible. */
export const RESPOND_NONCE_MIN_CHARS = 16;
export const RESPOND_NONCE_MAX_CHARS = 128;
/** Ed25519 signature, base64 (64-byte sig = 88 chars); bounded envelope. */
export const RESPOND_SIG_MAX_CHARS = 256;

/** Fields shared by respond.append and respond.force params. */
export interface RespondCommonParams {
	runId: string;
	taskId: string;
	questionId: string;
	body: string;
	replyTo?: string;
	priority?: MailboxMessagePriority;
	deliveryMode?: MailboxDeliveryMode;
	/** Optional client idempotency key; the broker defaults it to the
	 *  questionId (exactly-one response row per question on the broker paths). */
	requestId?: string;
}

export interface RespondChallengeParams {
	runId: string;
}

export interface RespondAppendParams extends RespondCommonParams {
	nonce: string;
	sig: string;
}

export type RespondForceParams = RespondCommonParams;

function parseRespondCommonFields(v: Record<string, unknown>): RespondCommonParams | undefined {
	if (typeof v.runId !== "string" || v.runId.length === 0 || v.runId.length > 256) return undefined;
	if (typeof v.taskId !== "string" || v.taskId.length === 0 || v.taskId.length > 256) return undefined;
	if (typeof v.questionId !== "string" || v.questionId.length === 0 || v.questionId.length > 128) return undefined;
	if (typeof v.body !== "string" || v.body.length === 0 || v.body.length > RESPOND_BODY_MAX_CHARS) return undefined;
	const replyTo = v.replyTo;
	if (replyTo !== undefined && (typeof replyTo !== "string" || replyTo.length === 0 || replyTo.length > 256)) return undefined;
	const priority = v.priority as MailboxMessagePriority | undefined;
	if (priority !== undefined && !["urgent", "normal", "low"].includes(priority)) return undefined;
	const deliveryMode = v.deliveryMode as MailboxDeliveryMode | undefined;
	if (deliveryMode !== undefined && deliveryMode !== "interrupt" && deliveryMode !== "next_turn") return undefined;
	const rawRequestId = v.requestId;
	if (rawRequestId !== undefined && (typeof rawRequestId !== "string" || !/^[\w:.-]{1,256}$/.test(rawRequestId))) return undefined;
	return {
		runId: v.runId,
		taskId: v.taskId,
		questionId: v.questionId,
		body: v.body,
		...(replyTo !== undefined ? { replyTo } : {}),
		...(priority !== undefined ? { priority } : {}),
		...(deliveryMode !== undefined ? { deliveryMode } : {}),
		...(rawRequestId !== undefined ? { requestId: rawRequestId } : {}),
	};
}

export function parseRespondChallengeParams(value: unknown): RespondChallengeParams | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	if (typeof v.runId !== "string" || v.runId.length === 0 || v.runId.length > 256) return undefined;
	return { runId: v.runId };
}

export function parseRespondAppendParams(value: unknown): RespondAppendParams | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	const common = parseRespondCommonFields(v);
	if (!common) return undefined;
	if (typeof v.nonce !== "string" || v.nonce.length < RESPOND_NONCE_MIN_CHARS || v.nonce.length > RESPOND_NONCE_MAX_CHARS) {
		return undefined;
	}
	if (typeof v.sig !== "string" || v.sig.length === 0 || v.sig.length > RESPOND_SIG_MAX_CHARS) return undefined;
	return { ...common, nonce: v.nonce, sig: v.sig };
}

export function parseRespondForceParams(value: unknown): RespondForceParams | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return parseRespondCommonFields(value as Record<string, unknown>);
}

/** HƯỚNG A CR CONTRACT — canonical payload string over the client-supplied
 *  respond fields, in the STYLE of mailbox.ts's canonicalMailboxPayload
 *  (fixed field order, undefined → null; that helper is module-private, so
 *  the respond surface mirrors its discipline here rather than importing
 *  it). The dispatcher signs THIS string (prefixed by the nonce — see
 *  respondAppendSignInput) and the broker verifies the exact same bytes, so
 *  writer and verifier can never drift.
 *
 *  Field order: taskId, questionId, body, replyTo, priority, deliveryMode,
 *  requestId. CONVERGED (2026-11-01, cross-slice alignment): NO `runId` and
 *  NO separator — the client implementation (respond-delivery.ts) follows
 *  the ADR's literal `sign(nonce ∥ canonical payload)`; run binding is
 *  enforced by the runId-bound single-use nonce record (respond.challenge
 *  binds runId; respond.append requires record.runId === params.runId), and
 *  the appended row's runId comes from the server-side manifest load, never
 *  from the client. Client signers SHOULD build this via the exported
 *  respondAppendSignInput rather than re-implementing it. */
export function canonicalRespondAppendPayload(params: RespondCommonParams): string {
	const pick = (value: unknown): unknown => (value === undefined ? null : value);
	return JSON.stringify([
		params.taskId,
		params.questionId,
		params.body,
		pick(params.replyTo),
		pick(params.priority),
		pick(params.deliveryMode),
		pick(params.requestId),
	]);
}

/** HƯỚNG A CR CONTRACT — the exact bytes the dispatcher's Ed25519 private key
 *  signs: `${nonce}${canonicalRespondAppendPayload(params)}` (UTF-8, plain
 *  concatenation — the ADR's `nonce ∥ canonical payload`; unambiguous since
 *  the nonce is base64url and never contains the canonical's leading `[`).
 *  The broker's respond.append handler verifies against the bound public
 *  key over this same string. Signers on the client side MUST build it via
 *  this export (never re-implement) so the two ends cannot drift. */
export function respondAppendSignInput(nonce: string, params: RespondCommonParams): string {
	return `${nonce}${canonicalRespondAppendPayload(params)}`;
}
