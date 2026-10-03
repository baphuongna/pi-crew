/**
 * ui-request-policy.ts — W7 (P2-3) RPC transport: the two Round-2 design gates.
 *
 * Evidence base (read directly from the SDK's rpc-mode.js during W7 recon):
 *
 *  GATE 1 — extension_ui_request DRAIN (fire-and-forget methods):
 *    `notify` (rpc-mode.js:87-96), `setStatus` (:101-110), `setWidget`
 *    (:123+), `setTitle`, `set_editor_text` are emitted WITHOUT being
 *    registered in `pendingExtensionRequests` — the server never waits for
 *    a response. Round-2 live evidence: 15 of the first 16 records a worker
 *    emits are these. Drain policy = COUNT + DROP (a response would be
 *    harmlessly ignored by the server, but sending one is pure waste).
 *
 *  GATE 2 — DIALOG auto-answer (ask-over-RPC otherwise blocks forever):
 *    `select` / `confirm` / `input` (:84-86) and `editor` (:191) register a
 *    promise in `pendingExtensionRequests` (:70-76). If the client never
 *    answers and the request has no `timeout`, the server-side promise NEVER
 *    resolves — the worker deadlocks (R2.5 ask-tool deadlock caveat).
 *    Universal safe answer: `{type:"extension_ui_response", id, cancelled:true}`
 *    → server resolves select/input to undefined and confirm to false.
 *
 *  SECURITY GATE (deliberate, review-mandated): there is NO auto-approve /
 *  auto-confirm mode. An unattended transport must never answer "yes" on the
 *  user's behalf. If a confirm-approval mode is ever needed it must be an
 *  explicit opt-in with its own security review — do not add it here.
 */

import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";

/** Dialog answer policy. See module header GATE 2 + SECURITY GATE. */
export type DialogAnswerPolicy = "cancel" | "block";

/** UI-request methods the server emits fire-and-forget (never pending). */
export const FIRE_AND_FORGET_UI_METHODS: ReadonlySet<string> = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);

/** UI-request methods that register a pending server-side promise (block until answered). */
export const DIALOG_UI_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);

/** Counters surfaced for diagnostics + tests (packet §E instrumentation set). */
export interface UiRequestCounters {
	/** Fire-and-forget records drained (counted, then dropped). */
	uiRequestsDrained: number;
	/** Drain breakdown by method (e.g. setStatus / setWidget). */
	drainedByMethod: Record<string, number>;
	/** Dialogs answered with the universal safe answer (`cancelled:true`). */
	dialogsCancelled: number;
	/** Dialogs left unanswered on purpose (policy "block" — server promise stays pending). */
	dialogsBlocked: number;
}

export interface UiRequestPolicy {
	/** Apply the drain/answer policy to one incoming ui-request record. */
	handle(request: RpcExtensionUIRequest): void;
	/** Snapshot of the counters (fresh object each call). */
	counters(): UiRequestCounters;
}

export interface UiRequestPolicyOptions {
	/** GATE 2 policy. "cancel" (default): answer `cancelled:true`. "block": leave pending (debug). */
	dialogPolicy: DialogAnswerPolicy;
	/** Sink for ui-responses the policy decides to send (the client's stdin writer). */
	writeResponse: (response: RpcExtensionUIResponse) => void;
	/** Optional warn sink (policy decisions worth surfacing). */
	onWarn?: (message: string) => void;
}

/**
 * Build the drain/answer policy for one RPC frame client.
 *
 * Unknown methods (future SDK additions) are treated as fire-and-forget:
 * counted into `uiRequestsDrained` and dropped — never answered, because we
 * cannot know whether the server put them in the pending map. A stray answer
 * is harmless to the server, but staying silent is the conservative default
 * for anything we have not classified.
 */
export function createUiRequestPolicy(options: UiRequestPolicyOptions): UiRequestPolicy {
	const dialogPolicy = options.dialogPolicy === "block" ? "block" : "cancel";
	const drainedByMethod: Record<string, number> = {};
	let uiRequestsDrained = 0;
	let dialogsCancelled = 0;
	let dialogsBlocked = 0;

	return {
		handle(request: RpcExtensionUIRequest): void {
			const method: string = request.method;
			if (DIALOG_UI_METHODS.has(method)) {
				if (dialogPolicy === "block") {
					dialogsBlocked++;
					options.onWarn?.(
						`rpc dialog ${method} (${request.id}) left unanswered by policy "block" — server promise stays pending`,
					);
					return;
				}
				dialogsCancelled++;
				// Universal safe answer: select/input → undefined, confirm → false.
				options.writeResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
				return;
			}
			// GATE 1: fire-and-forget (or unknown) — count + drop.
			uiRequestsDrained++;
			drainedByMethod[method] = (drainedByMethod[method] ?? 0) + 1;
		},
		counters(): UiRequestCounters {
			return {
				uiRequestsDrained,
				drainedByMethod: { ...drainedByMethod },
				dialogsCancelled,
				dialogsBlocked,
			};
		},
	};
}
