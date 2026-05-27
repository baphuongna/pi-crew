import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { listRuns } from "./run-index.ts";
// Lazy-loaded: team-tool.ts pulls in entire runtime chain.
import type { handleTeamTool as HandleTeamToolFn } from "./team-tool.ts";
let _cachedHandleTeamTool: typeof HandleTeamToolFn | undefined;
async function handleTeamTool(params: Parameters<typeof HandleTeamToolFn>[0], ctx: Parameters<typeof HandleTeamToolFn>[1]): Promise<Awaited<ReturnType<typeof HandleTeamToolFn>>> {
	if (!_cachedHandleTeamTool) {
		// LAZY: team-tool.ts pulls in the entire runtime chain.
		const mod = await import("./team-tool.ts");
		_cachedHandleTeamTool = mod.handleTeamTool;
	}
	return _cachedHandleTeamTool(params, ctx);
}
import { isToolError, textFromToolResult } from "./tool-result.ts";

async function notifyResult(ctx: ExtensionCommandContext, result: Awaited<ReturnType<typeof handleTeamTool>>): Promise<void> {
	const text = textFromToolResult(result);
	ctx.ui.notify(text.length > 1000 ? `${text.slice(0, 997)}...` : text, isToolError(result) ? "error" : "info");
}

export async function handleTeamManagerCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const action = await ctx.ui.select("pi-crew", [
		"List teams/workflows/agents/runs",
		"Run team",
		"Show run status",
		"Cleanup run worktrees",
		"Create routed resource",
		"Update routed resource",
		"Doctor",
	]);
	if (!action) return;

	if (action.startsWith("List")) {
		await notifyResult(ctx, await handleTeamTool({ action: "list" }, ctx));
		return;
	}

	if (action === "Doctor") {
		await notifyResult(ctx, await handleTeamTool({ action: "doctor" }, ctx));
		return;
	}

	if (action === "Create routed resource" || action === "Update routed resource") {
		const isUpdate = action === "Update routed resource";
		const resource = await ctx.ui.select("Resource type", ["agent", "team"]);
		if (resource !== "agent" && resource !== "team") return;
		const name = await ctx.ui.input("Name", resource === "agent" ? "custom-agent" : "custom-team");
		if (!name) return;
		const description = await ctx.ui.input("Description", "When to use this resource");
		if (!description) return;
		const triggers = await ctx.ui.input("Triggers (comma-separated)", "");
		const useWhen = await ctx.ui.input("Use when (comma-separated)", "");
		const avoidWhen = await ctx.ui.input("Avoid when (comma-separated)", "");
		const cost = await ctx.ui.select("Cost", ["cheap", "free", "expensive"]);
		const category = await ctx.ui.input("Category", "custom");
		const baseConfig = { name, description, scope: "project", triggers, useWhen, avoidWhen, cost, category };
		if (resource === "agent") {
			const systemPrompt = isUpdate ? undefined : `You are ${name}.`;
			await notifyResult(ctx, await handleTeamTool({ action: isUpdate ? "update" : "create", resource, agent: name, config: { ...baseConfig, systemPrompt } }, ctx));
			return;
		}
		const agent = await ctx.ui.input("Role agent", "executor");
		await notifyResult(ctx, await handleTeamTool({ action: isUpdate ? "update" : "create", resource, team: name, config: { ...baseConfig, roles: [{ name: "executor", agent: agent || "executor" }] } }, ctx));
		return;
	}

	if (action === "Run team") {
		const team = await ctx.ui.input("Team name", "default");
		if (team === undefined) return;
		const goal = await ctx.ui.input("Goal", "Describe the team objective");
		if (!goal) return;
		const asyncRun = await ctx.ui.confirm("Async run?", "Run in detached background mode?");
		const worktree = await ctx.ui.confirm("Worktree mode?", "Use git worktrees for task workspaces? Requires a clean repo by default.");
		await notifyResult(ctx, await handleTeamTool({ action: "run", team: team || "default", goal, async: asyncRun, workspaceMode: worktree ? "worktree" : "single" }, ctx));
		return;
	}

	const runs = listRuns(ctx.cwd).slice(0, 20);
	if (runs.length === 0) {
		ctx.ui.notify("No pi-crew runs found.", "info");
		return;
	}
	const selected = await ctx.ui.select("Select run", runs.map((run) => `${run.runId} [${run.status}] ${run.team}/${run.workflow ?? "none"}`));
	if (!selected) return;
	const runId = selected.split(" ")[0];
	if (!runId) return;

	if (action === "Show run status") {
		await notifyResult(ctx, await handleTeamTool({ action: "status", runId }, ctx));
		return;
	}
	if (action === "Cleanup run worktrees") {
		const force = await ctx.ui.confirm("Force cleanup?", "Force may remove dirty worktrees. Choose false to preserve dirty worktrees and capture cleanup diffs.");
		await notifyResult(ctx, await handleTeamTool({ action: "cleanup", runId, force }, ctx));
	}
}
