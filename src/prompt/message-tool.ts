/**
 * message-tool.ts — D9 / §15.2 worker-side `message` tool.
 *
 * The worker's NON-BLOCKING outbound channel (unlike `ask`, this never parks
 * the task). Three targets:
 *   - `to: "parent"`  → notify the orchestrator (run-level inbox read by the
 *     main session; wake-pattern inject happens host-side, see §15.2).
 *   - `to: <taskId>`  → DM a sibling task.
 *   - `to: "group"`   → broadcast every worker that did group_join.
 *
 * Delivery is the broker `msg.send` method (already server-side role-gated
 * since Step 0 — workers may send with `from` always overridden to their
 * authenticated taskId, `to` restricted to parent/sibling/group, kind
 * notify|message). A broker outage falls back to the same "unavailable"
 * notice the ask/delegate tools return — never a hang.
 *
 * Dormant-until-env (ask/delegate precedent): registered ONLY when
 * `PI_CREW_MSG_ENABLED === "1"` (child-pi-spawn sets it unconditionally); a
 * layer-2 dormant check re-verifies inside execute. Tests inject a mock
 * broker client directly, which bypasses the env gate.
 *
 * Local rate-limit: 10 messages/minute per tool instance (sliding window) —
 * the 11th within the window returns a `rate-limited` warning instead of
 * sending, so two workers cannot loop message each other to death.
 */

import { type Static, Type } from "@sinclair/typebox";
import { getCrewEnv } from "../config/env-vars.ts";
import { CrewBrokerClient } from "../runtime/broker/crew-broker-client.ts";

export const PI_CREW_MSG_ENABLED_ENV = "PI_CREW_MSG_ENABLED";

/** D9 §15.3: body length cap mirrors the ask/delegate bounded-payload bounds;
 *  the broker additionally enforces the 256 KiB frame cap server-side. */
const MSG_BODY_MAX_CHARS = 8192;
const MSG_SUBJECT_MAX_CHARS = 256;
const MSG_TO_MAX_CHARS = 256;
/** §15.2 rate-limit: 10 messages/min/task, sliding window. */
const MSG_RATE_LIMIT_MAX = 10;
const MSG_RATE_LIMIT_WINDOW_MS = 60_000;

export const MessageToolParamsSchema = Type.Object({
	to: Type.Union([Type.Literal("parent"), Type.Literal("group"), Type.String({ minLength: 1, maxLength: MSG_TO_MAX_CHARS })]),
	kind: Type.Union([Type.Literal("notify"), Type.Literal("message")]),
	subject: Type.Optional(Type.String({ minLength: 1, maxLength: MSG_SUBJECT_MAX_CHARS })),
	body: Type.String({ minLength: 1, maxLength: MSG_BODY_MAX_CHARS }),
	priority: Type.Optional(Type.Union([Type.Literal("urgent"), Type.Literal("normal"), Type.Literal("low")])),
});
export type MessageToolParams = Static<typeof MessageToolParamsSchema>;

/** Minimal broker-client surface the message tool needs (structural subset of
 *  CrewBrokerClient — tests substitute a recorder). */
export interface MessageBrokerClientSurface {
	request(method: string, params: unknown): Promise<{ ok: true; value: unknown } | { ok: false; fallback?: boolean; errorCode?: string }>;
	close?(): Promise<void>;
}

export interface MessageToolDeps {
	/** Env source override (tests). Production reads via getCrewEnv. */
	env?: NodeJS.ProcessEnv;
	/** Test seam / injectable clock for the 10/min sliding window. */
	now?: () => number;
	/** Test seam: replace the per-call broker client. */
	makeBrokerClient?: (o: { runId: string; taskId: string; socketPath: string; token: string }) => MessageBrokerClientSurface;
}

export interface MessageTool {
	name: "message";
	description: string;
	inputSchema: object;
	execute: (params: MessageToolParams) => Promise<{ status: string; text: string }>;
}

/** Layer-1 dormant-until-env gate (ask precedent: default-param env — reads
 *  the injected env object, never a raw process.env.PI_CREW_* member, so the
 *  check:env-vars gate stays green). */
export function shouldRegisterMessageTool(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[PI_CREW_MSG_ENABLED_ENV] === "1";
}

export function createMessageTool(deps: MessageToolDeps = {}): MessageTool {
	const now = deps.now ?? Date.now;
	const get = (name: string): string | undefined => (deps.env ? deps.env[name] : getCrewEnv(name));
	// Sliding window of send timestamps (ms). Pruned lazily on each send.
	const sentAt: number[] = [];

	/** Layer-2 dormant check: registered-only-when-env is the primary gate;
	 *  an injected mock client (tests) deliberately bypasses it so the core
	 *  send path is exercised without env plumbing. */
	const isActive = (): boolean => get(PI_CREW_MSG_ENABLED_ENV) === "1" || deps.makeBrokerClient !== undefined;

	/** True when the 10/min window is exhausted (the caller skips the send). */
	const isRateLimited = (): boolean => {
		const t = now();
		while (sentAt.length > 0 && t - sentAt[0]! >= MSG_RATE_LIMIT_WINDOW_MS) sentAt.shift();
		if (sentAt.length >= MSG_RATE_LIMIT_MAX) return true;
		sentAt.push(t);
		return false;
	};

	const brokerUnavailable = (): { status: string; text: string } => ({
		status: "unavailable",
		text: "[message] broker unavailable — include the note in your final result instead.",
	});

	return {
		name: "message",
		description:
			"Send a non-blocking message: notify the orchestrator of progress/risks (`to:'parent'`), DM another worker by task id, or broadcast the group. Unlike `ask`, this never waits.",
		inputSchema: MessageToolParamsSchema,
		async execute(params) {
			if (!isActive()) {
				return {
					status: "unavailable",
					text: "[message] is dormant in this worker (PI_CREW_MSG_ENABLED not set) — include the note in your final result instead.",
				};
			}
			if (isRateLimited()) {
				// §15.2: 10 messages/min/task; a warning instead of a silent drop
				// keeps the model informed the note was NOT delivered.
				return {
					status: "rate-limited",
					text: "[message] rate-limited (10 messages/minute) — this message was NOT sent; include the note in your final result instead.",
				};
			}
			const runId = get("PI_CREW_BROKER_RUN_ID") ?? "";
			const taskId = get("PI_CREW_TASK_ID") ?? get("PI_CREW_BROKER_TASK_ID") ?? "";
			const socketPath = get("PI_CREW_BROKER_SOCKET") ?? "";
			const token = get("PI_CREW_BROKER_TOKEN") ?? "";
			const client = deps.makeBrokerClient
				? deps.makeBrokerClient({ runId, taskId, socketPath, token })
				: (() => {
						// Production: the broker credentials are only present for
						// broker-eligible workers (child-pi-spawn). Scaffold/mock
						// workers fast-fail with a structured notice, never a hang.
						if (!runId || !taskId || !socketPath || !token) return null;
						return new CrewBrokerClient({ runId, taskId, socketPath, token });
					})();
			if (!client) return brokerUnavailable();
			const requestParams: Record<string, unknown> = { to: params.to, kind: params.kind, body: params.body };
			if (params.subject) requestParams.subject = params.subject;
			if (params.priority) requestParams.priority = params.priority;
			try {
				const sent = await client.request("msg.send", requestParams);
				if (!sent.ok) {
					// Broker rejection (role gate / policy / auth / fallback) — all
					// fast-fail, non-blocking.
					return brokerUnavailable();
				}
				return {
					status: "sent",
					text: `Message (${params.kind}) delivered to '${params.to}'.`,
				};
			} catch (error) {
				void error;
				return brokerUnavailable();
			} finally {
				// Only the production-created client needs closing; an injected
				// test recorder owns its own lifecycle.
				if (!deps.makeBrokerClient && client.close) {
					void client.close().catch(() => undefined);
				}
			}
		},
	};
}
