/**
 * delegate-spawn.ts — root-side grandchild spawner for governed nesting
 * (ADR-5 §1/§2/§6, WP-5 step 5).
 *
 * The broker's `delegate.request` handler calls this on an admitted request:
 * a DIRECT `runChildPi` call-site that never touches the global worker
 * semaphore (the MAJ#3 anti-deadlock precedent generalized — the nested-slot
 * budget is managed by the broker handler, not here), with `depthOverride`
 * from the parent task record, namespaced artifacts, and a timeout-driven
 * soft cancel (`delegate-timeout`).
 *
 * Security review round 1 (T3):
 * - S1#2: the grandchild's ROLE is threaded so role-based tool restrictions
 *   apply (`--tools`/`--exclude-tools` from role-tools config) — a
 *   "read-only" explorer/analyst grandchild must actually be read-only
 *   (ADR-5 §9's serialization exemption depends on it).
 * - S1#1: the grandchild authenticates under its OWN subId identity
 *   (grandchild-scoped broker token pre-minted by the handler) — never the
 *   parent's task token. Identity fields (`agentId: subId`) match.
 * - S2#1: namespaced artifacts via the `artifactsRoot` input field (the env
 *   spread never survived the spawn allowlist).
 * - S2#3: usage roll-up — message_end usage events are accumulated from the
 *   child's JSON event stream and reported for the parent-task reconciliation.
 */

import * as path from "node:path";
import type { AgentConfig } from "../agents/agent-config.ts";
import { type ChildPiRunResult, runChildPi } from "./child-pi/child-pi.ts";

export interface GrandchildSpawnInput {
	cwd: string;
	runId: string;
	parentTaskId: string;
	/** Nested-slot holder id (minted by the broker handler). */
	subId: string;
	prompt: string;
	role: string;
	model?: string;
	maxTurns?: number;
	/** Mandatory default 900 (spawn-policy normalized). */
	timeoutSec: number;
	/** Parent-task-record depth + 1 (ADR-5 §3). */
	depthOverride: number;
	/** Grandchild-scoped broker credentials (S1#1 — NEVER the parent token). */
	brokerSpawn?: { socketPath: string; token: string };
	onSpawn?: (pid: number | null) => void;
}

export interface GrandchildSpawnResult {
	ok: boolean;
	/** Fenced-ish result text (caller fences before mailbox delivery). */
	resultText: string;
	/** Usage in tokens for roll-up (input+output+cache summed over
	 *  message_end events); undefined = unattributed. */
	usageTokens?: number;
	timedOut?: boolean;
}

/** Minimal in-memory agent config for a delegate grandchild role. */
function agentForRole(role: string): AgentConfig {
	return {
		name: role,
		description: `delegate grandchild (${role})`,
		source: "builtin",
		filePath: "",
		systemPrompt: "",
	};
}

/** Sum usage tokens from a message_end JSON event record (S2#3 roll-up). */
export function usageTokensFromEvent(event: unknown): number | undefined {
	if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
	const record = event as { type?: unknown; usage?: unknown; message?: { usage?: unknown } };
	if (record.type !== "message_end") return undefined;
	const usage = (record.usage ?? record.message?.usage) as Record<string, unknown> | undefined;
	if (!usage || typeof usage !== "object") return undefined;
	let total = 0;
	let seen = false;
	for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
		const value = usage[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			total += value;
			seen = true;
		}
	}
	return seen ? total : undefined;
}

/** Namespaced artifacts root: artifacts/<runId>/<parentTaskId>/nested/<subId>/ */
export function grandchildArtifactsRoot(cwd: string, runId: string, parentTaskId: string, subId: string): string {
	return path.join(cwd, ".crew", "artifacts", runId, parentTaskId, "nested", subId);
}

export async function spawnDelegateGrandchild(input: GrandchildSpawnInput): Promise<GrandchildSpawnResult> {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const artifactsRoot = path.join(input.cwd, ".crew", "artifacts", input.runId, input.parentTaskId, "nested", input.subId);
	fs.mkdirSync(artifactsRoot, { recursive: true });

	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), input.timeoutSec * 1000);
	timer.unref?.();

	// S2#3: accumulate grandchild usage from message_end events.
	let usageTokens: number | undefined;
	const onJsonEvent = (event: unknown): void => {
		const tokens = usageTokensFromEvent(event);
		if (tokens !== undefined) usageTokens = (usageTokens ?? 0) + tokens;
	};

	try {
		const result: ChildPiRunResult = await runChildPi({
			cwd: input.cwd,
			task: input.prompt,
			agent: agentForRole(input.role),
			// S1#2: thread the role so role-based tool restrictions apply.
			role: input.role,
			...(input.model !== undefined ? { model: input.model } : {}),
			...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
			depthOverride: input.depthOverride,
			runId: input.runId,
			// S1#1: the grandchild carries its OWN identity + credentials —
			// never the parent's task token.
			agentId: input.subId,
			...(input.brokerSpawn ? { brokerSpawn: input.brokerSpawn } : {}),
			// S2#1: namespaced artifacts via the typed field.
			artifactsRoot,
			signal: abort.signal,
			onJsonEvent,
			onSpawn: input.onSpawn,
		});
		const ok = result.exitCode === 0;
		const text = (result.rawFinalText ?? result.stdout ?? "").trim() || (ok ? "" : result.stderr.trim());
		return { ok, resultText: text, ...(usageTokens !== undefined ? { usageTokens } : {}) };
	} catch (error) {
		const timedOut = abort.signal.aborted;
		return {
			ok: false,
			timedOut,
			resultText: timedOut ? "[delegate timed out]" : `delegate spawn failed: ${(error as Error).message}`,
		};
	} finally {
		clearTimeout(timer);
	}
}
