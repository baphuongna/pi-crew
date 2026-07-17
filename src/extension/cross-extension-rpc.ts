import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TeamToolParamsValue } from "../schema/team-tool-schema.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import { withHmacVerification } from "./rpc-hmac.ts";
// Lazy-loaded to avoid pulling team-tool.ts (and its entire runtime chain) into module load.
import type { handleTeamTool as HandleTeamToolFn } from "./team-tool.ts";

let _cachedHandleTeamTool: typeof HandleTeamToolFn | undefined;
async function handleTeamTool(
	params: Parameters<typeof HandleTeamToolFn>[0],
	ctx: Parameters<typeof HandleTeamToolFn>[1],
): Promise<Awaited<ReturnType<typeof HandleTeamToolFn>>> {
	if (!_cachedHandleTeamTool) {
		// LAZY: avoid pulling team-tool.ts (and its entire runtime chain) into module load.
		const mod = await import("./team-tool.ts");
		_cachedHandleTeamTool = mod.handleTeamTool;
	}
	return _cachedHandleTeamTool(params, ctx);
}

import { parseLiveControlRealtimeMessage, publishLiveControlRealtime } from "../runtime/live-control-realtime.ts";

export interface EventBusLike {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

export type RpcReply<T = unknown> = { success: true; data?: T } | { success: false; error: string };
export const PI_CREW_RPC_VERSION = 1;

export interface PiCrewRpcHandle {
	unsubscribe(): void;
}

function requestId(raw: unknown): string | undefined {
	return raw && typeof raw === "object" && !Array.isArray(raw) && typeof (raw as { requestId?: unknown }).requestId === "string"
		? (raw as { requestId: string }).requestId
		: undefined;
}

function reply(events: EventBusLike, channel: string, id: string | undefined, payload: RpcReply): void {
	if (!id) return;
	// SECURITY: Validate requestId format to prevent channel injection.
	if (!/^[a-zA-Z0-9_-]+$/.test(id)) return;
	events.emit(`${channel}:reply:${id}`, payload);
}

function textOf(result: Awaited<ReturnType<typeof handleTeamTool>>): string {
	return result.content?.map((item) => (item.type === "text" ? item.text : "")).join("\n") ?? "";
}

// SECURITY: Strictly enumerate allowed operations per RPC channel.
// Only read-only operations are permitted via RPC to prevent malicious extensions
// from mutating run state without user consent.
const RPC_ALLOWED_OPERATIONS = new Set([
	// Read-only manifest/plan ops
	"metrics-snapshot",
	"inventory",
	"read-manifest",
	"list-tasks",
	"read-task",
	"read-events",
	// Read-only agent ops
	"list-agents",
	"read-agent-status",
	"read-agent-events",
	"read-agent-transcript",
	"read-agent-output",
	"agent-dashboard",
	// Mailbox read ops
	"read-mailbox",
	"read-delivery",
	"read-heartbeat",
	// No mutating ops (approve-plan, cancel-plan, steer-agent, stop-agent, etc.)
	// — these require explicit intent confirmation and are NOT allowed via RPC.
]);

function isAllowedRpcOperation(operation: string): boolean {
	return RPC_ALLOWED_OPERATIONS.has(operation);
}

// SECURITY (HIGH #4 fix): In-memory rate limiter for RPC run requests.
// Prevents any extension from spawning unlimited child processes.
const RPC_RATE_LIMIT_MAX = 5; // Max 5 RPC run requests...
const RPC_RATE_LIMIT_WINDOW_MS = 60_000; // ...per 60 seconds
const rpcRunTimestamps: number[] = [];

function checkRpcRateLimit(): { allowed: boolean; retryAfterMs?: number } {
	const now = Date.now();
	// Evict entries older than the window
	const cutoff = now - RPC_RATE_LIMIT_WINDOW_MS;
	while (rpcRunTimestamps.length > 0 && rpcRunTimestamps[0] < cutoff) {
		rpcRunTimestamps.shift();
	}
	if (rpcRunTimestamps.length >= RPC_RATE_LIMIT_MAX) {
		const oldestInWindow = rpcRunTimestamps[0];
		const retryAfterMs = oldestInWindow + RPC_RATE_LIMIT_WINDOW_MS - now;
		return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) };
	}
	return { allowed: true };
}

function recordRpcRun(): void {
	rpcRunTimestamps.push(Date.now());
}

/** Reset the RPC rate limiter. Used primarily for testing. */
export function resetRpcRateLimit(): void {
	rpcRunTimestamps.length = 0;
}

export function isAllowedRpcRunParams(
	params: TeamToolParamsValue,
	ctx: ExtensionContext,
): {
	ok: boolean;
	error?: string;
} {
	// SECURITY: Require explicit intent for any RPC-initiated run creation.
	// This prevents malicious extensions from spawning child Pi processes silently.
	const cfg = params.config as Record<string, unknown> | undefined;
	const intent = cfg?.intent as string | undefined;
	if (!intent || typeof intent !== "string" || intent.trim().length === 0) {
		return {
			ok: false,
			error: "RPC run requires config.intent (a non-empty intent string)",
		};
	}
	// SECURITY: Validate cwd, if provided, resolves WITHIN the project directory (ctx.cwd).
	// Arg order is (baseDir=ctx.cwd, targetPath=params.cwd): the project dir is the container,
	// the caller-supplied cwd is the contained target. (Previously the args were swapped —
	// resolveContainedPath(params.cwd, ".") — which validates that "." is inside params.cwd,
	// trivially true for ANY path, so the check never rejected anything.)
	// NOTE: defense-in-depth — handleTeamTool currently uses ctx.cwd and ignores params.cwd,
	// but a correct guard here prevents a future regression from silently enabling cwd escape.
	if (params.cwd && typeof params.cwd === "string") {
		try {
			resolveRealContainedPath(ctx.cwd, params.cwd);
		} catch {
			return {
				ok: false,
				error: "RPC run config.cwd must be within the project directory",
			};
		}
	}
	return { ok: true };
}

function on(events: EventBusLike, channel: string, handler: (raw: any) => unknown): () => void {
	const unsub = events.on(channel, handler);
	return typeof unsub === "function" ? unsub : () => {};
}

// SECURITY TRUST BOUNDARY: RPC channels (pi-crew:rpc:run, pi-crew:rpc:status,
// pi-crew:rpc:live-control) are accessible to any extension on the shared event
// bus. Mitigations: rate limiting, explicit intent, operation allowlist, cwd
// containment validation, and HMAC origin signing (see rpc-hmac.ts).

export function registerPiCrewRpc(
	events: EventBusLike | undefined,
	getCtx: () => ExtensionContext | undefined,
): PiCrewRpcHandle | undefined {
	if (!events) return undefined;
	// Note: the prior loud startup warning has been replaced by a soft, opt-out
	// info note emitted lazily by withHmacVerification only when an actual RPC
	// request is processed (see rpc-hmac.ts). This avoids noisy output during
	// every pi load for users who never wire cross-extension RPC.
	const unsubs = [
		on(
			events,
			"pi-crew:rpc:ping",
			withHmacVerification(
				(raw) =>
					reply(events, "pi-crew:rpc:ping", requestId(raw), {
						success: true,
						data: { version: PI_CREW_RPC_VERSION },
					}),
				"pi-crew:rpc:ping",
			),
		),
		on(
			events,
			"pi-crew:rpc:run",
			withHmacVerification(async (raw) => {
				const id = requestId(raw);
				try {
					// SECURITY (HIGH #4 fix): Rate limit RPC run requests
					const rateLimit = checkRpcRateLimit();
					if (!rateLimit.allowed) {
						reply(events, "pi-crew:rpc:run", id, {
							success: false,
							error: `RPC run rate limit exceeded. Max ${RPC_RATE_LIMIT_MAX} requests per ${RPC_RATE_LIMIT_WINDOW_MS / 1000}s. Retry after ${Math.ceil((rateLimit.retryAfterMs ?? 60000) / 1000)}s.`,
						});
						return;
					}
					recordRpcRun();
					const ctx = getCtx();
					if (!ctx) throw new Error("No active pi-crew session context.");
					// Validate payload: only allow known fields from TeamToolParamsValue
					const ALLOWED_RPC_RUN_KEYS = new Set([
						"goal",
						"team",
						"workflow",
						"async",
						"cwd",
						"config",
						"skill",
						"model",
						"budgetTotal",
						"budgetWarning",
						"budgetAbort",
						"budgetUnlimited",
					]);
					let params: TeamToolParamsValue;
					if (raw && typeof raw === "object" && !Array.isArray(raw)) {
						const filtered: Record<string, unknown> = {
							...(raw as object),
						};
						// Strip any keys not in the allowlist to prevent injection of unexpected fields
						for (const key of Object.keys(filtered)) {
							if (!ALLOWED_RPC_RUN_KEYS.has(key)) delete filtered[key];
						}
						params = {
							...filtered,
							action: "run",
						} as TeamToolParamsValue;
					} else {
						params = { action: "run" };
					}
					const permission = isAllowedRpcRunParams(params, ctx);
					if (!permission.ok) {
						reply(events, "pi-crew:rpc:run", id, {
							success: false,
							error: permission.error ?? "permission denied",
						});
						return;
					}
					const result = await handleTeamTool(params, ctx);
					reply(
						events,
						"pi-crew:rpc:run",
						id,
						result.isError ? { success: false, error: textOf(result) } : { success: true, data: result.details },
					);
				} catch (error) {
					reply(events, "pi-crew:rpc:run", id, {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}, "pi-crew:rpc:run"),
		),
		on(
			events,
			"pi-crew:rpc:status",
			withHmacVerification(async (raw) => {
				const id = requestId(raw);
				try {
					const ctx = getCtx();
					if (!ctx) throw new Error("No active pi-crew session context.");
					const runId = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { runId?: string }).runId : undefined;
					const result = await handleTeamTool({ action: "status", runId }, ctx);
					reply(
						events,
						"pi-crew:rpc:status",
						id,
						result.isError
							? { success: false, error: textOf(result) }
							: {
									success: true,
									data: {
										text: textOf(result),
										details: result.details,
									},
								},
					);
				} catch (error) {
					reply(events, "pi-crew:rpc:status", id, {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}, "pi-crew:rpc:status"),
		),
		on(events, "pi-crew:live-control", (raw) => {
			const request = parseLiveControlRealtimeMessage(raw);
			if (request) publishLiveControlRealtime(request);
		}),
		on(
			events,
			"pi-crew:rpc:live-control",
			withHmacVerification(async (raw) => {
				const id = requestId(raw);
				try {
					const ctx = getCtx();
					if (!ctx) throw new Error("No active pi-crew session context.");
					const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
					const rawOp = typeof obj.operation === "string" ? obj.operation : "steer-agent";
					// SECURITY: Reject any operation not in the explicit allowlist.
					// Mutating ops (approve-plan, cancel-plan, steer-agent, stop-agent, etc.)
					// require user consent and are blocked here.
					if (!isAllowedRpcOperation(rawOp)) {
						reply(events, "pi-crew:rpc:live-control", id, {
							success: false,
							error: `RPC operation '${rawOp}' is not allowed. Allowed: ${[...RPC_ALLOWED_OPERATIONS].join(", ")}`,
						});
						return;
					}
					const result = await handleTeamTool(
						{
							action: "api",
							runId: typeof obj.runId === "string" ? obj.runId : undefined,
							config: {
								operation: rawOp,
								agentId: obj.agentId,
								message: obj.message,
								prompt: obj.prompt,
							},
						},
						ctx,
					);
					reply(
						events,
						"pi-crew:rpc:live-control",
						id,
						result.isError
							? { success: false, error: textOf(result) }
							: {
									success: true,
									data: {
										text: textOf(result),
										details: result.details,
									},
								},
					);
				} catch (error) {
					reply(events, "pi-crew:rpc:live-control", id, {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}, "pi-crew:rpc:live-control"),
		),
	];
	return { unsubscribe: () => unsubs.forEach((unsub) => unsub()) };
}
