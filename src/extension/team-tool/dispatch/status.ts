/**
 * API-5 facade dispatch — Status domain router.
 *
 * Actions: status, list, get, events, artifacts, summary, graph, search,
 * health, worktrees, checkpoint, cache, explain, onboard, recommend, help.
 *
 * Inline cases (graph, search, onboard, explain, cache, checkpoint, recommend,
 * help) are moved verbatim from the former handleTeamTool switch.
 */
import * as path from "node:path";
import { allAgents, discoverAgents } from "../../../agents/discover-agents.ts";
import { loadConfig } from "../../../config/config.ts";
import { FileCheckpointStore } from "../../../runtime/recovery/checkpoint.ts";
import { getSkillCacheStats } from "../../../runtime/skill-instructions.ts";
import type { TeamToolParamsValue } from "../../../schema/team-tool-schema.ts";
import { computeRunCacheKey, getCachedRun, getCacheStats } from "../../../state/stores/run-cache.ts";
import { listRunGraphs, loadRunGraph } from "../../../state/stores/run-graph.ts";
import { allTeams, discoverTeams } from "../../../teams/discover-teams.ts";
import { searchAgents, searchTeams } from "../../../utils/bm25-search.ts";
import { projectCrewRoot } from "../../../utils/paths.ts";
import { assertSafePathId } from "../../../utils/safe-paths.ts";
import { formatActionSuggestion } from "../../action-suggestions.ts";
import { piTeamsHelp } from "../../help.ts";
import { buildTeamOnboarding } from "../../team-onboard.ts";
import { formatRecommendation, recommendTeam } from "../../team-recommendation.ts";
import { handleGet, handleList } from "../../team-tool.ts";
import type { PiTeamsToolResult } from "../../tool-result.ts";
import { result, type TeamContext } from "../context.ts";
import { handleExplain } from "../explain.ts";
import { handleHealthMonitor } from "../health-monitor.ts";
import { handleArtifacts, handleEvents, handleSummary } from "../inspect.ts";
import { handleWorktrees } from "../lifecycle-actions.ts";
import { handleStatus } from "../status.ts";

/**
 * Actions owned by the Status domain. Single source of truth for the switch
 * below AND for the runtime exhaustiveness test
 * (test/unit/dispatch-exhaustive.test.ts). The compile-time `never` sentinel in
 * the `default` branch errors if a StatusDomainAction is added here without a
 * matching `case`.
 */
export const STATUS_DOMAIN_ACTIONS = [
	"status",
	"list",
	"get",
	"events",
	"artifacts",
	"summary",
	"graph",
	"search",
	"health",
	"worktrees",
	"checkpoint",
	"cache",
	"explain",
	"onboard",
	"recommend",
	"help",
] as const;
type StatusDomainAction = (typeof STATUS_DOMAIN_ACTIONS)[number];

export async function handleStatusDomain(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	// `domainForAction` routes only Status-domain actions here, so narrowing is sound.
	const action = params.action as StatusDomainAction;
	switch (action) {
		case "list":
			return handleList(params, ctx);
		case "get":
			return handleGet(params, ctx);
		case "status":
			return handleStatus(params, ctx);
		case "events":
			return handleEvents(params, ctx);
		case "artifacts":
			return handleArtifacts(params, ctx);
		case "worktrees":
			return handleWorktrees(params, ctx);
		case "summary":
			return handleSummary(params, ctx);
		case "health":
			return handleHealthMonitor(ctx, params);
		case "help":
			return result(piTeamsHelp(), { action: "help", status: "ok" });
		case "recommend": {
			const goal = params.goal ?? params.task;
			if (!goal) return result("Recommend requires goal or task.", { action: "recommend", status: "error" }, true);
			const loaded = loadConfig(ctx.cwd);
			const recommendation = recommendTeam(goal, loaded.config.autonomous, {
				teams: allTeams(discoverTeams(ctx.cwd)),
				agents: allAgents(discoverAgents(ctx.cwd)),
			});
			return result(formatRecommendation(goal, recommendation), {
				action: "recommend",
				status: "ok",
			});
		}
		case "graph": {
			if (params.runId) {
				assertSafePathId("runId", params.runId);
				const graph = loadRunGraph(ctx.cwd, params.runId);
				return result(
					graph ? JSON.stringify(graph, null, 2) : "No graph found for this run.",
					{ action: "graph", status: graph ? "ok" : "error" },
					!graph,
				);
			}
			const graphs = listRunGraphs(ctx.cwd);
			return result(graphs.length ? `Available graphs:\n${graphs.join("\n")}` : "No graphs available.", {
				action: "graph",
				status: "ok",
			});
		}
		case "search": {
			const query = params.goal ?? params.task ?? "";
			if (!query) {
				return result("Search requires goal or task query.", { action: "search", status: "error" }, true);
			}
			try {
				const [agentResults, teamResults] = await Promise.all([
					searchAgents(query, { limit: 5 }),
					searchTeams(query, { limit: 3 }),
				]);
				const lines: string[] = [];
				if (teamResults.length) {
					lines.push("## Teams");
					for (const r of teamResults) {
						lines.push(`- [${r.team.name}] score=${r.score.toFixed(2)}: ${r.team.description ?? "(no description)"}`);
					}
				}
				if (agentResults.length) {
					lines.push("## Agents");
					for (const r of agentResults) {
						lines.push(`- [${r.agent.name}] score=${r.score.toFixed(2)}: ${r.agent.description ?? "(no description)"}`);
					}
				}
				return result(lines.length ? lines.join("\n") : "No results found.", { action: "search", status: "ok" });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return result(`Search failed: ${msg}`, { action: "search", status: "error" }, true);
			}
		}
		case "onboard": {
			const team = params.team ?? "default";
			const onboarding = buildTeamOnboarding(team, ctx.cwd);
			return result(onboarding, { action: "onboard", status: "ok" });
		}
		case "explain": {
			const explainResult = handleExplain(params, ctx.cwd);
			return result(
				explainResult.text,
				{
					action: "explain",
					status: explainResult.isError ? "error" : "ok",
				},
				explainResult.isError,
			);
		}
		case "cache": {
			if (params.goal) {
				const key = computeRunCacheKey(params.goal, params.team ?? "default", params.workflow ?? "default", ctx.cwd);
				const cached = getCachedRun(ctx.cwd, key);
				if (cached) {
					return result(
						`Cached run found (${new Date(cached.cachedAt).toISOString()}): runId=${cached.runId}, status=${cached.status}, ${cached.tasks.length} tasks`,
						{
							action: "cache",
							status: "ok",
							data: {
								cacheKey: key,
								cacheHit: true,
								runId: cached.runId,
								status: cached.status,
								taskCount: cached.tasks.length,
							},
						},
					);
				}
				return result(`No cached result for key: ${key}`, {
					action: "cache",
					status: "ok",
					data: { cacheKey: key, cacheHit: false },
				});
			}
			const stats = getCacheStats(ctx.cwd);
			const skillStats = getSkillCacheStats();
			return result(
				`Run cache: ${stats.entries} entries, ${stats.sizeBytes} bytes\n` +
					`Skill cache: ${skillStats.hits} hits, ${skillStats.misses} misses (${(skillStats.hitRate * 100).toFixed(1)}% hit rate), ${skillStats.currentSize}/${skillStats.maxEntries} entries, ${skillStats.evictions} evictions`,
				{ action: "cache", status: "ok" },
			);
		}
		case "checkpoint": {
			if (!params.runId || !params.taskId) {
				return result("Checkpoint requires runId and taskId.", { action: "checkpoint", status: "error" }, true);
			}
			assertSafePathId("runId", params.runId);
			assertSafePathId("taskId", params.taskId);
			const stateRoot = path.join(projectCrewRoot(ctx.cwd), "state", "runs", params.runId);
			const store = new FileCheckpointStore(stateRoot);
			const checkpoint = store.load(params.runId, params.taskId);
			if (!checkpoint) {
				return result("No checkpoint found.", { action: "checkpoint", status: "error" }, true);
			}
			return result(
				`Checkpoint: step=${checkpoint.step}, progress=${checkpoint.progress}, savedAt=${new Date(checkpoint.savedAt).toISOString()}`,
				{ action: "checkpoint", status: "ok", data: { checkpoint } },
			);
		}
		default: {
			// Compile-time exhaustiveness: errors if a StatusDomainAction lacks a case above.
			const _exhaustive: never = action;
			return result(
				`Unhandled status-domain action: ${params.action}${formatActionSuggestion(String(params.action ?? ""))}`,
				{ action: "unknown", status: "error" },
				true,
			);
		}
	}
}
