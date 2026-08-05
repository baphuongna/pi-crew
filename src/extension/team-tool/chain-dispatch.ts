/**
 * Team-tool entry point for the `chain` feature.
 *
 * Dispatched from `handleRun` (run.ts) via an early-return guard:
 *   if (params.chain) → handleChainRun(params, ctx, handleRun)
 *
 * `handleRun` is passed by reference (NOT imported) to break the
 * run.ts ↔ chain-dispatch.ts import cycle. This file imports only
 * chain-runner, handoff-manager, chain-executor, and the shared
 * tool-result helpers — none of which import run.ts.
 *
 * @see src/extension/team-tool/chain-executor.ts (ChainTeamRunExecutor)
 * @see src/runtime/chain-runner.ts (ChainRunner.runChain, parseChainString)
 */

import { ChainRunner, parseChainString } from "../../runtime/chain-runner.ts";
import { HandoffManager } from "../../runtime/handoff-manager.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { ChainTeamRunExecutor, type HandleRunFn } from "./chain-executor.ts";
import { result, type TeamContext } from "./context.ts";

/**
 * Execute a chain expression (`"a -> b -> c"`). Each step runs a real team run
 * via the injected `handleRun`, with handoff context passed forward through the
 * goal text. Returns a multi-line summary plus structured `data` for the TUI.
 *
 * @param params  - Must contain `chain`. `team`/`workflow`/`model` are forwarded
 *                  as per-step overrides when a step does not declare its own.
 * @param ctx     - The team tool context (cwd is used to load run manifests).
 * @param handleRun - The run.ts `handleRun` function reference (injected).
 */
export async function handleChainRun(params: TeamToolParamsValue, ctx: TeamContext, handleRun: HandleRunFn): Promise<PiTeamsToolResult> {
	const chainString = params.chain;
	if (!chainString || chainString.trim().length === 0) {
		return result("Chain expression is empty.", { action: "run", status: "error" }, true);
	}

	// BUG-44 (github #44): reject an explicit `workflow: "chain"` on a chain run with a
	// clear message. `chain` is a dispatcher-only workflow; forwarding it to steps made
	// every step fail fast (~58 ms) with a confusing empty error. Chain runs have no
	// per-step workflow — omit `workflow` (or rely on the step's @team ref) instead.
	if (params.workflow === "chain") {
		return result(
			"Workflow 'chain' cannot be combined with a chain run: the chain runner owns step execution and has no per-step workflow. Omit `workflow` (steps use the team's defaultWorkflow) or use @team references in the chain expression.",
			{ action: "run", status: "error" },
			true,
		);
	}

	const spec = parseChainString(chainString);
	if (spec.steps.length === 0) {
		return result(
			'Chain must contain at least one step. Use the form: "step1 -> step2 -> step3".',
			{ action: "run", status: "error" },
			true,
		);
	}

	// Construct the concrete executor with per-step overrides forwarded from the
	// chain invocation (overridden by any step that parsed to a @team reference).
	//
	// BUG-44 (github #44): `workflow` is INTENTIONALLY NOT forwarded. The chain
	// runner owns step execution — a chain has no per-step workflow. Forwarding
	// params.workflow (e.g. "chain") made every step execute the `chain` workflow
	// via the normal executeTeamRun path, which fails fast (~58 ms) with a
	// confusing empty error. Steps use the team's defaultWorkflow instead.
	const executor = new ChainTeamRunExecutor({
		handleRun,
		ctx,
		overrides: {
			team: params.team,
			// workflow intentionally omitted — chain runner owns step execution (bug-44)
			...(params.model ? { model: params.model } : {}),
		},
	});

	// Surface the global continueOnError from the parsed spec (e.g. --continue-on-error=true).
	const runner = new ChainRunner(executor, new HandoffManager());
	const chainResult = await runner.runChain(spec, {}, undefined);

	// Build a readable multi-line summary.
	const lines: string[] = [
		`Chain ${chainResult.success ? "completed" : "ended"}: ${spec.steps.length} step(s), ${chainResult.totalHandoffs.length} handoff(s).`,
		"",
	];
	for (const s of chainResult.steps) {
		const runId = executor.stepRunIds[s.step - 1];
		const tag = s.outcome === "success" ? "✓" : s.outcome === "failure" ? "✗" : s.outcome === "partial" ? "≈" : "⊘";
		lines.push(
			`${tag} Step ${s.step} [${s.name}]: ${s.outcome} (${s.duration}ms)${runId ? ` runId=${runId}` : ""}${s.error ? ` | ${s.error}` : ""}`,
		);
	}
	lines.push("");
	lines.push(
		`Total: ${chainResult.totalDuration}ms${chainResult.totalTokens !== undefined ? `, ${chainResult.totalTokens} tokens` : ""}`,
	);

	return result(
		lines.join("\n"),
		{
			action: "run",
			status: chainResult.success ? "ok" : "error",
			data: {
				chain: true,
				steps: chainResult.steps.length,
				totalTokens: chainResult.totalTokens,
				runIds: executor.stepRunIds,
			},
		},
		!chainResult.success,
	);
}
