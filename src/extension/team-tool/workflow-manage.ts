/**
 * team-tool/workflow-manage.ts — Handlers for the 5 workflow-management actions (P3).
 *
 * Plan: 07-PLAN.md v3 P3 + §0c C3 (destructive-gate, NOT autonomous-policy) + C5 (paths).
 *
 * Actions:
 *   - workflow-create : write a .dwf.ts from params.config.script. SECURITY: gated by
 *                       destructive-gate.ts (confirm:true required) + path-allowlist
 *                       (resolveRealContainedPath) + content validation. NEVER auto-invoked
 *                       by the agent (the gate enforces this).
 *   - workflow-get    : return a workflow's source/metadata (read-only).
 *   - workflow-list   : list all workflows incl. runtime discriminator (extends existing list).
 *   - workflow-save   : persist an ephemeral script as a named reusable workflow.
 *   - workflow-delete : remove a dynamic workflow file (confirm-gated).
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { result, type TeamContext } from "./context.ts";
import { assertSafePathId, resolveRealContainedPath } from "../../utils/safe-paths.ts";
import { projectCrewRoot, userCrewRoot } from "../../utils/paths.ts";
import { allWorkflows, discoverWorkflows } from "../../workflows/discover-workflows.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";

/** The 3 allowed bases for dynamic-workflow scripts (§0c C5). */
function allowedWorkflowDirs(cwd: string): string[] {
	return [
		join(projectCrewRoot(cwd), "workflows"),
		join(userCrewRoot(), "workflows"),
		join(projectCrewRoot(cwd), "..", "workflows"), // <proj>/.pi/teams/workflows variant
	];
}

/** Best-effort content validation: reject obvious ACE/exfil patterns (§0c D3). Not a security boundary. */
const FORBIDDEN_PATTERNS = [
	/require\s*\(\s*['"]child_process['"]/,
	/\bprocess\.exit\s*\(/,
	/import\s+.*['"]net['"]/,
	/import\s+.*['"]http['"]/,
	/import\s+.*['"]https['"]/,
	/eval\s*\(\s*new\s+Function/,
];

function validateScriptContent(content: string): string | undefined {
	for (const pattern of FORBIDDEN_PATTERNS) {
		if (pattern.test(content)) {
			return `Script content matches a forbidden pattern (${pattern.source}). Dynamic workflows must not spawn processes, exit, or make network calls directly — use ctx.agent().`;
		}
	}
	return undefined;
}

/** Resolve a workflow name + scope to a safe write path inside an allowed dir. */
function resolveWorkflowWritePath(cwd: string, name: string, scope: "user" | "project" = "project"): string {
	assertSafePathId("workflowName", name);
	const base = scope === "user" ? join(userCrewRoot(), "workflows") : join(projectCrewRoot(cwd), "workflows");
	return resolveRealContainedPath(base, `${name}.dwf.ts`);
}

export function handleWorkflowCreate(params: TeamToolParamsValue, ctx: TeamContext): ReturnType<typeof result> {
	// SECURITY (§0c C3): the destructive-gate.ts set enforces confirm:true BEFORE this handler
	// runs (the run is blocked at the tool_call layer if confirm is missing). We re-check here
	// as defense-in-depth in case the gate is bypassed.
	if (params.confirm !== true) {
		return result("workflow-create is a new arbitrary-code-execution surface and requires confirm:true. Add the action to DESTRUCTIVE_TEAM_ACTIONS (destructive-gate.ts) so the runtime gate enforces this.", { action: "workflow-create", status: "error" }, true);
	}
	const name = params.config?.name as string | undefined;
	const script = params.config?.script as string | undefined;
	if (!name || typeof name !== "string") {
		return result("workflow-create requires config.name (the workflow name, path-safe).", { action: "workflow-create", status: "error" }, true);
	}
	if (!script || typeof script !== "string") {
		return result("workflow-create requires config.script (the .dwf.ts source).", { action: "workflow-create", status: "error" }, true);
	}
	const validationError = validateScriptContent(script);
	if (validationError) {
		return result(`workflow-create rejected: ${validationError}`, { action: "workflow-create", status: "error" }, true);
	}
	try {
		const scope = (params.scope === "user" ? "user" : "project") as "user" | "project";
		const filePath = resolveWorkflowWritePath(ctx.cwd, name, scope);
		writeFileSync(filePath, script, "utf-8");
		return result(`Dynamic workflow '${name}' created at ${filePath}.\n\nIt is now runnable via: team action='run' workflow='${name}' goal='...'\n/scripts are commit-reviewed (postinstall-equivalent trust — see docs/dynamic-workflows.md).`, { action: "workflow-create", status: "ok", data: { name, filePath, scope } }, false);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result(`workflow-create failed: ${message}`, { action: "workflow-create", status: "error" }, true);
	}
}

export function handleWorkflowGet(params: TeamToolParamsValue, ctx: TeamContext): ReturnType<typeof result> {
	const name = (params.config?.name as string | undefined) ?? params.workflow;
	if (!name) return result("workflow-get requires config.name or workflow.", { action: "workflow-get", status: "error" }, true);
	const wf = allWorkflows(discoverWorkflows(ctx.cwd)).find((w) => w.name === name);
	if (!wf) return result(`Workflow '${name}' not found.`, { action: "workflow-get", status: "error" }, true);
	const isDynamic = wf.runtime === "dynamic";
	let source = "(static workflow — no script source)";
	if (isDynamic && wf.filePath && existsSync(wf.filePath)) {
		try {
			source = readFileSync(wf.filePath, "utf-8").slice(0, 8000);
		} catch (error) {
			logInternalError("workflow-manage.get", error, `filePath=${wf.filePath}`);
		}
	}
	return result(
		[
			`Workflow: ${wf.name} [${isDynamic ? "dynamic" : "static"}]`,
			`  description: ${wf.description}`,
			`  source: ${wf.source}`,
			`  filePath: ${wf.filePath}`,
			isDynamic ? `  dynamicScript: ${wf.dynamicScript}` : `  steps: ${wf.steps.length}`,
			"",
			isDynamic ? "Script source:" : "",
			isDynamic ? "```" : "",
			isDynamic ? source : "",
			isDynamic ? "```" : "",
		].filter(Boolean).join("\n"),
		{ action: "workflow-get", status: "ok", data: { name: wf.name, runtime: wf.runtime ?? "static", filePath: wf.filePath } },
		false,
	);
}

export function handleWorkflowList(params: TeamToolParamsValue, ctx: TeamContext): ReturnType<typeof result> {
	const workflows = allWorkflows(discoverWorkflows(ctx.cwd));
	if (workflows.length === 0) return result("No workflows found.", { action: "workflow-list", status: "ok" }, false);
	const lines = workflows.map((w) => {
		const tag = w.runtime === "dynamic" ? "[dynamic]" : "[static] ";
		const detail = w.runtime === "dynamic" ? w.dynamicScript ?? w.filePath : `${w.steps.length} steps`;
		return `  ${tag} ${w.name.padEnd(20)} ${detail}`;
	});
	return result(`Workflows (${workflows.length}):\n${lines.join("\n")}`, { action: "workflow-list", status: "ok", data: { count: workflows.length, workflows: workflows.map((w) => ({ name: w.name, runtime: w.runtime ?? "static" })) } }, false);
}

export function handleWorkflowSave(params: TeamToolParamsValue, ctx: TeamContext): ReturnType<typeof result> {
	// workflow-save: persist an ephemeral run's script as a named reusable workflow.
	// Reads the source from config.script (the caller provides what to save).
	const name = params.config?.name as string | undefined;
	const script = params.config?.script as string | undefined;
	if (!name || !script) return result("workflow-save requires config.name + config.script.", { action: "workflow-save", status: "error" }, true);
	const validationError = validateScriptContent(script);
	if (validationError) return result(`workflow-save rejected: ${validationError}`, { action: "workflow-save", status: "error" }, true);
	try {
		const filePath = resolveWorkflowWritePath(ctx.cwd, name, "project");
		writeFileSync(filePath, script, "utf-8");
		return result(`Saved dynamic workflow '${name}' → ${filePath}.`, { action: "workflow-save", status: "ok", data: { name, filePath } }, false);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result(`workflow-save failed: ${message}`, { action: "workflow-save", status: "error" }, true);
	}
}

export function handleWorkflowDelete(params: TeamToolParamsValue, ctx: TeamContext): ReturnType<typeof result> {
	// workflow-delete is destructive (removes a file) — gated by destructive-gate.ts confirm:true.
	if (params.confirm !== true) {
		return result("workflow-delete requires confirm:true (gated by destructive-gate.ts).", { action: "workflow-delete", status: "error" }, true);
	}
	const name = (params.config?.name as string | undefined) ?? params.workflow;
	if (!name) return result("workflow-delete requires config.name.", { action: "workflow-delete", status: "error" }, true);
	const wf = allWorkflows(discoverWorkflows(ctx.cwd)).find((w) => w.name === name);
	if (!wf) return result(`Workflow '${name}' not found.`, { action: "workflow-delete", status: "error" }, true);
	if (wf.runtime !== "dynamic") return result(`Workflow '${name}' is not a dynamic workflow (only .dwf.ts files can be deleted via this action).`, { action: "workflow-delete", status: "error" }, true);
	try {
		assertSafePathId("workflowName", name);
		// Verify the file is inside an allowed dir before deleting.
		const allowed = allowedWorkflowDirs(ctx.cwd);
		const contained = allowed.some((base) => {
			try {
				return resolveRealContainedPath(base, wf.filePath) === wf.filePath;
			} catch {
				return false;
			}
		});
		if (!contained) return result(`Refusing to delete '${wf.filePath}': not inside an allowed workflows directory.`, { action: "workflow-delete", status: "error" }, true);
		rmSync(wf.filePath, { force: true });
		return result(`Deleted dynamic workflow '${name}' (${wf.filePath}).`, { action: "workflow-delete", status: "ok", data: { name, filePath: wf.filePath } }, false);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result(`workflow-delete failed: ${message}`, { action: "workflow-delete", status: "error" }, true);
	}
}

void dirname; // (import kept for future expansion; currently unused)
