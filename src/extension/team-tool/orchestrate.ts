/**
 * Handler for `team action='orchestrate' planPath='/path/to/plan.md'`
 *
 * Parses a plan document and outputs agent chain commands.
 */
import * as fs from "node:fs";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { appendPlanRevision } from "../../state/stores/plan-store.ts";
import { loadRunManifestById, saveRunManifest } from "../../state/stores/state-store.ts";
import { resolveRealContainedPath } from "../../utils/safe-paths.ts";
import {
	buildAgentChain,
	formatPlanOverview,
	type OrchestratedStep,
	parsePlanDocument,
	parsePlanDocumentSimple,
	stepsToPlanRecord,
} from "../plan-orchestrate.ts";
import { locateRunCwd } from "../team-tool.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { result, type TeamContext } from "./context.ts";

/**
 * Handle the orchestrate action.
 *
 * Parses a plan document (markdown with `<!-- tag: <tag> -->` comments)
 * and outputs the decomposed agent chain commands.
 *
 * Usage: `team action='orchestrate' planPath='/path/to/plan.md'`
 */
export function handleOrchestrate(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const planPath = params.planPath as string | undefined;

	if (!planPath) {
		return result(
			"orchestrate requires planPath parameter pointing to a markdown plan document.",
			{ action: "orchestrate", status: "error" },
			true,
		);
	}

	// Resolve and validate path stays within ctx.cwd (path-traversal protection)
	let resolvedPath: string;
	try {
		resolvedPath = resolveRealContainedPath(ctx.cwd, planPath);
	} catch {
		return result(`planPath must be within project directory: ${planPath}`, { action: "orchestrate", status: "error" }, true);
	}

	if (!fs.existsSync(resolvedPath)) {
		return result(`Plan document not found: ${resolvedPath}`, { action: "orchestrate", status: "error" }, true);
	}

	// Try primary parser
	let steps: OrchestratedStep[] = parsePlanDocument(resolvedPath);

	// Fallback to simple parser
	if (steps.length === 0) {
		steps = parsePlanDocumentSimple(resolvedPath);
	}

	if (steps.length === 0) {
		return result(
			`No tagged sections found in plan document: ${resolvedPath}\n\nExpected format: <!-- tag: <tag> --> in markdown sections`,
			{ action: "orchestrate", status: "error" },
			true,
		);
	}

	// Build overview and commands
	const overview = formatPlanOverview(resolvedPath);
	const commands = buildAgentChain(steps);

	// T2/R4 (ADR-4 §6 producer 1): persist a PlanRecord when the caller binds
	// an explicit run. Opt-in: orchestrate emits one `team action='run'` per
	// step (each creating its OWN run), so silently attaching the record to
	// "some" run would misattribute linkage. Without runId the action stays
	// read-only and says so.
	let planNote = "PlanRecord not persisted (no runId given — pass runId=<runId> to attach a versioned record to that run).";
	let persisted: { id: string; version: number; items: number } | undefined;
	const runId = typeof params.runId === "string" && params.runId.trim() ? params.runId.trim() : undefined;
	if (runId) {
		const runCwd = locateRunCwd(runId, ctx.cwd);
		const manifest = runCwd ? loadRunManifestById(runCwd, runId)?.manifest : undefined;
		if (!manifest) {
			return result(`runId not found: ${runId}`, { action: "orchestrate", status: "error" }, true);
		}
		const record = stepsToPlanRecord(steps, runId, { title: `Orchestrated: ${planPath}` });
		appendPlanRevision(manifest, record);
		saveRunManifest({ ...manifest, updatedAt: new Date().toISOString(), plan: { id: record.id, version: record.version } });
		persisted = { id: record.id, version: record.version, items: record.items.length };
		planNote = `PlanRecord persisted to run ${runId}: v${record.version} (${record.items.length} item(s)) — team action='plans' runId='${runId}' to inspect.`;
	}

	const outputLines: string[] = [
		`Plan: ${resolvedPath}`,
		`Steps: ${steps.length}`,
		planNote,
		"",
		"# Agent Chain Commands",
		"",
		...commands.map((cmd, i) => `${i + 1}. ${cmd}`),
		"",
		"# Full Overview",
		overview,
	];

	return result(outputLines.join("\n"), {
		action: "orchestrate",
		status: "ok",
		data: {
			planPath: resolvedPath,
			stepCount: steps.length,
			commands,
			persisted,
			steps: steps.map((sqs) => ({
				stepId: sqs.stepId,
				tag: sqs.tag,
				chain: sqs.chain,
				prompt: sqs.prompt,
				heading: sqs.heading,
			})),
		},
	});
}
