/**
 * ARCH-1: Tool loop guard.
 *
 * Detects a session re-issuing the exact same tool call (same tool, same
 * arguments) consecutively with identical results — how model-side infinite
 * loops present (precedent: a pi-crew run where a worker re-verified the
 * same completed files 14+ times; OMO-slim issue #1071).
 *
 * Ported from oh-my-opencode-slim src/hooks/tool-loop-guard/hook.ts, adapted
 * to pi's extension hook surface:
 * - `tool_result` advances the counter: identical args AND byte-identical
 *   output continues the run; new output resets it (a legitimate re-read
 *   after a file changed can never accumulate toward a block).
 * - `tool_call` blocks when a hard-block tool's confirmed run count reached
 *   the block threshold. The before-hook never increments — overlapping
 *   parallel calls cannot inflate the count.
 * - Hard-block set is read-only file tools only (read/grep/glob/find/ls);
 *   everything else warns. bash and edit/write stay warn-only: their
 *   identical repeats may be legitimate side-effect retries.
 * - Wait-style tool (`ask` — its contract is "stop and wait"): per-turn
 *   counter keyed by tool name only, warn at 2, block the 3rd; any non-ask
 *   tool result resets the turn (OMO #1139 semantics).
 *
 * Scope is per-process: each child worker runs in its own process, and the
 * main session is one more, so module-level state needs no session keying.
 * Tracked fingerprints are FIFO-bounded to guard memory in long sessions.
 *
 * Toggle: runtime.reliability.loopGuard = false in config disables install
 * (mirrors perWriteValidation).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOOP_GUARD_WARN_AT = 3;
const LOOP_GUARD_BLOCK_AT = 5;

/** Tools exempt from the entire guard: identical repeated invocation is legitimate. */
const LOOP_GUARD_EXEMPT: Record<string, true> = {
	team: true,
	crew_agent: true,
	Agent: true,
	get_subagent_result: true,
};

/** Tools that may be hard-blocked: read-only file analysis only. */
const LOOP_GUARD_BLOCK_TOOLS: Record<string, true> = {
	read: true,
	grep: true,
	glob: true,
	find: true,
	ls: true,
};

/** Wait-style tools: repeating within a turn is always degenerate. */
const WAIT_TOOL = "ask";
const WAIT_GUARD_WARN_AT = 2;
/** Once this many ask calls have COMPLETED, the next ask call is refused (OMO #1139: warn at 2, refuse the 3rd). */
const WAIT_GUARD_BLOCK_AT = 2;

/** Max tracked fingerprints before evicting the oldest (FIFO bound). */
const MAX_TRACKED_FINGERPRINTS = 512;

export const LOOP_GUARD_MARKER = "[REPEATED TOOL CALLS - STOP]";
export const WAIT_GUARD_MARKER = "[REPEATED WAIT TOOL - END TURN]";

export const LOOP_GUARD_WARNING = `
${LOOP_GUARD_MARKER}

You have issued the exact same tool call with identical arguments ${LOOP_GUARD_WARN_AT} times in a row and received identical results. This is an infinite loop and you are making no progress.

STOP repeating this call. Instead:
1. Reconsider what you are looking for — the result above already contains what this call can tell you.
2. If you need different information, make a DIFFERENT call (different path, pattern, or tool).
3. If the task is actually done, produce your final answer now instead of calling more tools.
`;

export const WAIT_GUARD_WARNING = `
${WAIT_GUARD_MARKER}

You have called \`ask\` ${WAIT_GUARD_WARN_AT} times in this turn. Its contract is to stop and wait — do not call it again in the same turn.

STOP calling tools that wait. Continue with what you can do, or produce your final answer; the reply arrives as a separate message later.
`;

/** Deterministic JSON: object keys sorted recursively, insensitive to key order. */
export function stableStringify(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			out[key] = sortValue(record[key]);
		}
		return out;
	}
	return value;
}

/** Deterministic fingerprint of tool + args, insensitive to key order. */
export function fingerprint(tool: string, args: unknown): string {
	return `${tool.toLowerCase()}:${stableStringify(args ?? null)}`;
}

interface FingerprintState {
	/** Confirmed consecutive identical-args + identical-output count. */
	runCount: number;
	/** Last output fingerprint seen for this tool+args (null until first result). */
	lastOutput: string | null;
}

export interface LoopGuardResultAppend {
	type: "text";
	text: string;
}

export interface LoopGuardCallVerdict {
	block?: boolean;
	reason?: string;
}

/**
 * Pure state machine — exported for tests and reused by the hook wiring.
 * One instance per process.
 */
export function createLoopGuardState() {
	const runs = new Map<string, FingerprintState>();
	let lastFingerprint: string | null = null;
	let waitRunCount = 0;

	function evictIfNeeded(): void {
		while (runs.size > MAX_TRACKED_FINGERPRINTS) {
			const oldest = runs.keys().next().value;
			if (oldest === undefined) break;
			runs.delete(oldest);
		}
	}

	/** tool_result side: returns warning content to append, if any. */
	function onToolResult(tool: string, args: unknown, output: unknown): LoopGuardResultAppend[] {
		const toolLower = tool.toLowerCase();
		if (toolLower === WAIT_TOOL) {
			waitRunCount += 1;
			if (waitRunCount === WAIT_GUARD_WARN_AT) return [{ type: "text", text: WAIT_GUARD_WARNING }];
			return [];
		}
		// Any completed non-ask tool call ends the "turn" for the wait guard.
		waitRunCount = 0;

		if (LOOP_GUARD_EXEMPT[tool]) return [];

		const fp = fingerprint(tool, args);
		const outputKey = stableStringify(output);
		const state = runs.get(fp) ?? { runCount: 0, lastOutput: null };

		if (fp !== lastFingerprint) {
			// A different call intervened: this starts a fresh run for this fp.
			state.runCount = 0;
		}
		if (state.lastOutput === outputKey) {
			state.runCount += 1;
		} else {
			// New information: never accumulates toward a block.
			state.runCount = 1;
			state.lastOutput = outputKey;
		}
		runs.set(fp, state);
		evictIfNeeded();
		lastFingerprint = fp;

		if (state.runCount === LOOP_GUARD_WARN_AT) {
			return [{ type: "text", text: LOOP_GUARD_WARNING }];
		}
		return [];
	}

	/** tool_call side: returns a block verdict for degenerate repeats. */
	function onToolCall(tool: string, args: unknown): LoopGuardCallVerdict {
		const toolLower = tool.toLowerCase();
		if (toolLower === WAIT_TOOL) {
			if (waitRunCount >= WAIT_GUARD_BLOCK_AT) {
				return {
					block: true,
					reason: `pi-crew loop guard: \`ask\` called ${waitRunCount} times this turn — its contract is to wait. End your turn; the reply arrives as a separate message.`,
				};
			}
			return {};
		}
		if (LOOP_GUARD_EXEMPT[tool]) return {};
		if (!LOOP_GUARD_BLOCK_TOOLS[toolLower]) return {};

		const fp = fingerprint(tool, args);
		const state = runs.get(fp);
		if (state && state.runCount >= LOOP_GUARD_BLOCK_AT) {
			return {
				block: true,
				reason: `pi-crew loop guard: this exact ${tool} call (identical arguments) has returned identical results ${state.runCount} times in a row. Make a DIFFERENT call (different path, pattern, or tool), or produce your final answer.`,
			};
		}
		return {};
	}

	function reset(): void {
		runs.clear();
		lastFingerprint = null;
		waitRunCount = 0;
	}

	return { onToolResult, onToolCall, reset };
}

/**
 * Install the loop guard on a Pi instance. Both hooks are best-effort:
 * older Pi versions without these events are tolerated (same pattern as
 * installResourcesDiscoverHook).
 */
export function installToolLoopGuard(pi: ExtensionAPI): void {
	const state = createLoopGuardState();
	try {
		pi.on("tool_call", async (event: { toolName: string; input?: unknown }) => {
			const verdict = state.onToolCall(event.toolName, event.input);
			if (verdict.block) {
				return { block: true as const, reason: verdict.reason };
			}
			return undefined;
		});
	} catch {
		/* older Pi without tool_call events */
	}
	try {
		pi.on("tool_result", (event: { toolName: string; input?: unknown; content?: unknown }) => {
			const appends = state.onToolResult(event.toolName, event.input, event.content);
			if (appends.length === 0) return undefined;
			const existing = Array.isArray(event.content) ? event.content : [];
			return { content: [...existing, ...appends] };
		});
	} catch {
		/* older Pi without tool_result events */
	}
}
