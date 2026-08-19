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
 */

import * as fs from "node:fs";
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
	onSpawn?: (pid: number | null) => void;
}

export interface GrandchildSpawnResult {
	ok: boolean;
	/** Fenced-ish result text (caller fences before mailbox delivery). */
	resultText: string;
	/** Usage in tokens for roll-up; undefined = unattributed. */
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

/** Namespaced artifacts root: artifacts/<runId>/<parentTaskId>/nested/<subId>/ */
export function grandchildArtifactsRoot(cwd: string, runId: string, parentTaskId: string, subId: string): string {
	return path.join(cwd, ".crew", "artifacts", runId, parentTaskId, "nested", subId);
}

export async function spawnDelegateGrandchild(input: GrandchildSpawnInput): Promise<GrandchildSpawnResult> {
	const artifactsRoot = grandchildArtifactsRoot(input.cwd, input.runId, input.parentTaskId, input.subId);
	fs.mkdirSync(artifactsRoot, { recursive: true });

	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), input.timeoutSec * 1000);
	timer.unref?.();

	try {
		const result: ChildPiRunResult = await runChildPi({
			cwd: input.cwd,
			task: input.prompt,
			agent: agentForRole(input.role),
			...(input.model !== undefined ? { model: input.model } : {}),
			...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
			depthOverride: input.depthOverride,
			runId: input.runId,
			agentId: input.parentTaskId,
			signal: abort.signal,
			env: {
				...process.env,
				PI_CREW_ARTIFACTS_ROOT: artifactsRoot,
			},
			onSpawn: input.onSpawn,
		});
		const ok = result.exitCode === 0;
		const text = (result.rawFinalText ?? result.stdout ?? "").trim() || (ok ? "" : result.stderr.trim());
		return { ok, resultText: text, usageTokens: undefined };
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
