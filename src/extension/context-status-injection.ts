/**
 * context-status-injection.ts — Ambient crew-status injection (GAP-2).
 *
 * Registers a `context` event handler that keeps the parent agent continuously
 * aware of in-flight crew runs. Without this, the agent "forgets" about active
 * runs between turns unless it explicitly calls the `team` tool.
 *
 * ## How it works
 *
 * Pi's `context` event fires before EVERY LLM call (see Pi source
 * `extensions/runner.ts:emitContext`). The handler receives the full messages
 * array and may return a modified copy. Critically, the returned messages are
 * used ONLY for that single LLM call (`agent-loop.ts:283-289` feeds the result
 * straight into `convertToLlm` for the request) — they do NOT mutate the
 * agent's persistent `state.messages`. So injection is transient per-call:
 *   - No accumulation across turns (the note never enters history).
 *   - No need to dedup against prior injections.
 *   - No risk of corrupting the conversation transcript.
 *
 * The injected note is a compact 1–4 line ambient status, inserted BEFORE the
 * last message so the last message remains the active turn driver (preserves
 * the user/assistant/tool alternation the LLMs expect).
 *
 * ## Safety
 *
 * - No-op when zero runs are in-flight (returns undefined → Pi uses original
 *   messages unchanged). Normal single-agent operation is completely unaffected.
 * - `emitContext` already wraps handlers in try/catch and emits errors instead
 *   of crashing the loop (Pi `runner.ts:933`), so a throw here can't break the
 *   agent — but we also guard defensively.
 * - Opt-out: `runtime.reliability.ambientStatusInjection: false` in config.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ContextEvent } from "@earendil-works/pi-coding-agent";
import { collectInFlightRuns } from "./registration/compaction-guard.ts";
import { extractSessionId } from "../utils/session-utils.ts";
import type { TeamRunManifest } from "../state/types.ts";

/** Sentinel that marks an injected ambient-status user message. */
export const AMBIENT_STATUS_SENTINEL = "[pi-crew ambient status";

/** Cap the number of runs listed inline to keep the note compact. */
const MAX_INLINE_RUNS = 3;
/** Truncate long goals so one run can't dominate the context window. */
const MAX_GOAL_LEN = 80;

/**
 * Cheap human-readable run age from manifest timestamps (no extra I/O).
 * Returns "running 12m" / "updated 3m ago" style, or "" if timestamps are
 * missing/invalid. Keeps the ambient note informative without reading
 * tasks.json on every LLM call.
 */
function runAge(createdAt?: string, updatedAt?: string): string {
	try {
		const updated = updatedAt ? Date.parse(updatedAt) : NaN;
		const created = createdAt ? Date.parse(createdAt) : NaN;
		if (Number.isFinite(updated)) {
			const sinceUpdate = Date.now() - updated;
			if (sinceUpdate < 60_000) return `, updated just now`;
			return `, updated ${humanizeMs(sinceUpdate)} ago`;
		}
		if (Number.isFinite(created)) {
			return `, running ${humanizeMs(Date.now() - created)}`;
		}
	} catch { /* ignore malformed timestamps */ }
	return "";
}

function humanizeMs(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const m = Math.floor(ms / 60_000);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return h < 24 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d`;
}

/**
 * Build a compact, human+LLM-readable ambient status string for the given
 * in-flight runs. Returns "" for an empty list (caller treats as no-op).
 *
 * Exported for unit testing.
 */
export function formatAmbientStatus(runs: TeamRunManifest[]): string {
	if (runs.length === 0) return "";
	const truncate = (s: string, n: number): string =>
		s.length > n ? `${s.slice(0, n - 1)}…` : s;
	const lines: string[] = [
		`${AMBIENT_STATUS_SENTINEL} — environmental context, not a user request]`,
		`${runs.length} pi-crew run${runs.length === 1 ? "" : "s"} in flight:`,
	];
	const shown = runs.slice(0, MAX_INLINE_RUNS);
	for (const run of shown) {
		const wf = run.workflow ? `, ${run.workflow}` : "";
		const age = runAge(run.createdAt, run.updatedAt);
		lines.push(`• ${run.runId} (${run.status}, ${run.team}${wf})${age}: ${truncate(run.goal ?? "(no goal)", MAX_GOAL_LEN)}`);
	}
	if (runs.length > MAX_INLINE_RUNS) {
		lines.push(`• …and ${runs.length - MAX_INLINE_RUNS} more`);
	}
	lines.push("Inspect/join via the `team` tool: action=\"status\" (list), action=\"wait\" (join running), action=\"summary\"/action=\"get\" (results).");
	return lines.join("\n");
}

/**
 * Construct a user-role AgentMessage carrying the ambient status. Uses the
 * `user` role (the Message union has no `system` role — the system prompt is a
 * separate field). The sentinel prefix signals to the model that this is
 * environmental information, not a typed user instruction.
 *
 * Exported for unit testing.
 */
export function buildStatusMessage(runs: TeamRunManifest[]): Message {
	return {
		role: "user",
		content: [{ type: "text", text: formatAmbientStatus(runs) }],
		timestamp: Date.now(),
	};
}

/** Result type for the `context` event handler (mirrors Pi's ContextEventResult,
 * which isn't re-exported from the coding-agent package entry). */
export interface AmbientContextResult {
	messages?: AgentMessage[];
}

/**
 * Core handler logic, separated from the Pi registration so it is trivially
 * unit-testable without a live ExtensionAPI.
 *
 * Returns `{messages}` with the ambient status inserted before the last
 * message, or `undefined` to leave the context untouched (no in-flight runs).
 *
 * Exported for unit testing.
 */
export function handleContextEvent(event: ContextEvent, cwd: string, sessionId?: string): AmbientContextResult | undefined {
	let runs: TeamRunManifest[] = [];
	try {
		runs = collectInFlightRuns(cwd, sessionId);
	} catch {
		// State read failure → don't inject, don't crash. Pi catches handler
		// errors anyway, but we avoid noisy error emission for a best-effort
		// awareness feature.
		return undefined;
	}
	if (runs.length === 0) return undefined;

	const messages = [...event.messages];
	const statusMsg = buildStatusMessage(runs);
	// Insert BEFORE the last message so the genuine last message (the current
	// turn driver — user prompt or tool result) stays last. When there are 0–1
	// messages, appending is the only sensible option.
	const insertAt = messages.length > 1 ? messages.length - 1 : messages.length;
	messages.splice(insertAt, 0, statusMsg as unknown as AgentMessage);
	return { messages };
}

/**
 * Register the ambient-status `context` event handler. Reads the project cwd
 * from the session context on each call (crew state is per-project).
 *
 * Pass `enabled: false` (from `runtime.reliability.ambientStatusInjection`) to
 * disable the feature without unwiring the handler.
 */
export function registerContextStatusInjection(
	pi: ExtensionAPI,
	opts: { enabled?: boolean } = {},
): void {
	if (opts.enabled === false) return;
	pi.on("context", (event: ContextEvent, ctx: unknown): AmbientContextResult | undefined => {
		// crew state is per-project; use the session ctx cwd when available,
		// falling back to process.cwd(). Thread the session id so ambient
		// status only reflects runs owned by THIS session (the state store is
		// per-project, shared across sessions).
		const cwd =
			typeof ctx === "object" && ctx !== null && typeof (ctx as { cwd?: unknown }).cwd === "string"
				? (ctx as { cwd: string }).cwd
				: typeof process.cwd === "function" ? process.cwd() : ".";
		const sessionId = extractSessionId(ctx);
		return handleContextEvent(event, cwd, sessionId);
	});
}
