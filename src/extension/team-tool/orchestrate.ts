/**
 * Handler for `team action='orchestrate' planPath='/path/to/plan.md'`
 *
 * Parses a plan document and outputs agent chain commands.
 */
import * as fs from "node:fs";
import { currentCrewRole, permissionForRole } from "../../runtime/role-permission.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { withRunLock } from "../../state/coordination/locks.ts";
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
export async function handleOrchestrate(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
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
		// Security (T2 review S1/S2): the persist branch is a run-mutating write.
		// (a) role gate — read-only workers must NOT plant plan records;
		// (b) ownership — foreign-session runs require explicit force;
		// (c) locked read-modify-write + fail-closed tool error (never a throw
		//     into the caller, never a lost update vs concurrent manifest writers).
		const role = currentCrewRole();
		if (role && permissionForRole(role) === "read_only") {
			return result(
				`Role '${role}' is read-only and cannot persist a plan record to a run.`,
				{ action: "orchestrate", status: "error" },
				true,
			);
		}
		const runCwd = locateRunCwd(runId, ctx.cwd);
		const loaded = runCwd ? loadRunManifestById(runCwd, runId) : undefined;
		if (!loaded) {
			return result(`runId not found: ${runId}`, { action: "orchestrate", status: "error" }, true);
		}
		const manifest = loaded.manifest;
		if (typeof manifest.ownerSessionId === "string" && manifest.ownerSessionId !== ctx.sessionId && params.force !== true) {
			return result(
				`Run '${runId}' belongs to another session (owner ${manifest.ownerSessionId.slice(0, 8)}…). Pass force=true to persist anyway.`,
				{ action: "orchestrate", status: "error", runId },
				true,
			);
		}
		try {
			const outcome = await withRunLock(manifest, async () => {
				const fresh = loadRunManifestById(runCwd as string, runId); // in-lock consistent read
				if (!fresh) return undefined;
				const record = stepsToPlanRecord(steps, runId, { title: `Orchestrated: ${planPath}` });
				appendPlanRevision(fresh.manifest, record);
				saveRunManifest({
					...fresh.manifest,
					updatedAt: new Date().toISOString(),
					plan: { id: record.id, version: record.version },
				});
				return record;
			});
			if (!outcome) return result(`runId not found: ${runId}`, { action: "orchestrate", status: "error" }, true);
			persisted = { id: outcome.id, version: outcome.version, items: outcome.items.length };
			planNote = `PlanRecord persisted to run ${runId}: v${outcome.version} (${outcome.items.length} item(s)) — team action='plans' runId='${runId}' to inspect.`;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return result(`PlanRecord persistence failed: ${message}`, { action: "orchestrate", status: "error", runId }, true);
		}
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
