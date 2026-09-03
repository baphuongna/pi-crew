import * as fs from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { withSessionId } from "../team-tool/context.ts";
// Lazy-loaded: team-tool.ts pulls in entire runtime chain.
import type { handleTeamTool as HandleTeamToolFn } from "../team-tool.ts";

async function handleTeamTool(
	params: Parameters<typeof HandleTeamToolFn>[0],
	ctx: Parameters<typeof HandleTeamToolFn>[1],
): Promise<Awaited<ReturnType<typeof HandleTeamToolFn>>> {
	// LAZY: team-tool.ts pulls in entire runtime chain.
	const mod = await import("../team-tool.ts");
	return mod.handleTeamTool(params, ctx);
}

import { Text } from "@earendil-works/pi-tui";
import { loadConfig } from "../../config/config.ts";
import { t } from "../../i18n.ts";
import { readCrewAgents } from "../../runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";
import { checkSubagentSpawnPermission, currentCrewRole } from "../../runtime/role-permission.ts";
import type { BatchBarrier } from "../../runtime/scheduling/batch-barrier.ts";
import {
	readPersistedSubagentRecord,
	type SubagentManager,
	type SubagentRecord,
	type SubagentSpawnOptions,
	savePersistedSubagentRecord,
} from "../../runtime/subagent-manager.ts";
import { TEAM_TERMINAL_TASK_STATUSES } from "../../state/contracts.ts";
import { resolveEntryBySubagentId, upsertOwnershipEntry } from "../../state/stores/ownership-map.ts";
import { loadRunManifestById } from "../../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import { formatCompactToolProgress } from "../../ui/tool-progress-formatter.ts";
import { agentToolRenderer, type ToolRenderContext } from "../../ui/tool-renderers/index.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { resolveRealContainedPath } from "../../utils/safe-paths.ts";
import {
	__test__subagentSpawnParams,
	formatSubagentRecord,
	readSubagentRunResult,
	refreshPersistedSubagentRecord,
	subagentToolResult,
} from "./subagent-helpers.ts";

const TOOL_PROGRESS_TICK_MS = 1000;

type OnUpdate = (chunk: { content: { type: "text"; text: string }[] }) => void;

export interface SubagentToolRegistrationOptions {
	ownerSessionGeneration?: () => number;
	startForegroundRun?: (ctx: unknown, runner: (signal?: AbortSignal) => Promise<void>, runId?: string) => void;
	/** Rule 1 batch barrier. When present, agents spawned with a batchId are
	 * registered here so their completion notifications are coalesced. */
	batchBarrier?: BatchBarrier;
}

export function registerSubagentTools(
	pi: ExtensionAPI,
	subagentManager: SubagentManager,
	options: SubagentToolRegistrationOptions = {},
): void {
	const agentTool: ToolDefinition = {
		name: "Agent",
		label: "Agent",
		description:
			"Launch a real pi-crew subagent. Uses pi-crew's durable child-process runtime by default; set run_in_background=true for parallel/background work, then use get_subagent_result.",
		promptSnippet:
			"Use Agent to delegate focused work to a real pi-crew subagent. Use run_in_background=true for parallel work and get_subagent_result to join results.",
		promptGuidelines: [
			"Use Agent for independent exploration, review, verification, or implementation subtasks instead of doing all work in the parent turn.",
			"For parallel work, launch multiple Agent calls with run_in_background=true, then call get_subagent_result for each result.",
			"Available pi-crew subagent types include explorer, planner, analyst, executor, reviewer, verifier, writer, security-reviewer, and test-engineer.",
		],
		parameters: Type.Object({
			prompt: Type.String({
				description: "The task for the subagent to perform.",
			}),
			description: Type.String({
				description: "Short 3-5 word task description.",
			}),
			subagent_type: Type.String({
				description:
					"pi-crew agent name, e.g. explorer, planner, executor, reviewer, verifier, writer, security-reviewer, test-engineer.",
			}),
			model: Type.Optional(
				Type.String({
					description: "Optional model override. If omitted, pi-crew uses Pi-configured model fallback.",
				}),
			),
			skill: Type.Optional(
				Type.Union([Type.String(), Type.Array(Type.String()), Type.Boolean()], {
					description: "Skill name(s) to inject for this subagent, or false to disable selected/default skills.",
				}),
			),
			max_turns: Type.Optional(
				Type.Number({
					description: "Reserved for live-session subagents; child-process runtime may ignore this.",
				}),
			),
			run_in_background: Type.Optional(
				Type.Boolean({
					description: "Run in background and return an agent ID immediately.",
				}),
			),
			batch_id: Type.Optional(
				Type.String({
					description:
						"Optional batch grouping id. Background agents sharing the same batch_id receive ONE consolidated completion notification when ALL members finish (instead of N individual notifications). Use this when launching several background agents in one turn and you do not join them immediately. Omit for the default individual-notification behavior.",
				}),
			),
		}) as never,
		async execute(_id, params, signal, onUpdate, ctx) {
			// Diagnostic: detect pre-aborted signal before spawn
			if (signal?.aborted) {
				logInternalError(
					"subagent-tools.pre-aborted-signal",
					undefined,
					`aborted=true paramsKeys=${Object.keys(params as object).join(",")}`,
				);
				return subagentToolResult(
					"Agent tool signal was already aborted before execution started. This usually means Pi cancelled the tool call before it ran.",
					{ action: "agent", status: "error" },
					true,
				);
			}
			const currentRole = currentCrewRole();
			const permission = checkSubagentSpawnPermission(currentRole);
			if (!permission.allowed)
				return subagentToolResult(
					permission.reason ?? "Current role cannot spawn subagents.",
					{ role: currentRole, mode: permission.mode },
					true,
				);
			const spawnOptions = __test__subagentSpawnParams(params as Record<string, unknown>, ctx);
			spawnOptions.ownerSessionGeneration = options.ownerSessionGeneration?.();
			if (!spawnOptions.prompt.trim()) return subagentToolResult(t("agent.requiresPrompt"), {}, true);
			// Extract sessionId from sessionManager.getSessionId() so team runs created
			// by the Agent tool have proper session ownership for isolation.
			const ctxWithSession = withSessionId(ctx);
			spawnOptions.ownerSessionId = ctxWithSession.sessionId;
			// WP-1/R1 (H6): the one-shot identity link. taskId is NOT knowable at
			// spawn() time — handleTeamTool(action:"run") resolves only after the
			// run is dispatched (scaffold/mock returns immediately; real runs at
			// completion), and runId comes from the result details. So the link is
			// written in the runner wrapper once the manifest resolves: the record
			// gains taskId/depth, the persisted copy is refreshed, and the
			// ownership-map entry (task ⇄ subagentId ⇄ artifactsDir) is upserted
			// under the run lock. Best-effort: a failure logs but never throws
			// into the spawn path. `spawnedRecord` is assigned right after spawn()
			// returns; the runner's continuation runs on a later microtask, so the
			// assignment is always visible when the identity-link block executes.
			let spawnedRecord: SubagentRecord | undefined;
			const runner = async (currentOptions: SubagentSpawnOptions, childSignal?: AbortSignal) => {
				// WP-1/R1 (H6 fix, review round): mid-run steer requires the identity
				// link AT DISPATCH TIME, not after completion. `handleTeamTool` awaits
				// the full run; the only mid-run signal we have is `onRunStarted`
				// (fired in run.ts with updatedManifest.runId as the run starts). Hook
				// it so the subagentId leg of the ownership map lands while the worker
				// is live — steer_subagent can then resolve taskId mid-run instead of
				// saying "not linked". The completion-time block below remains as a
				// fallback for runs that complete between dispatch and this hook.
				const linkAtDispatch = (runId?: string): void => {
					if (typeof runId !== "string" || !spawnedRecord || spawnedRecord.taskId) return;
					try {
						const loaded = loadRunManifestById(currentOptions.cwd, runId);
						const taskId = loaded?.tasks[0]?.id;
						if (taskId && loaded) {
							spawnedRecord.taskId = taskId;
							// runId too: the manager only back-fills record.runId from the
							// awaited result (waitForRun — i.e. at COMPLETION for background
							// runs). Linking it here keeps taskId+runId landing together at
							// dispatch so mid-run consumers (steer) resolve both immediately.
							spawnedRecord.runId = runId;
							spawnedRecord.depth = currentOptions.depth ?? 0;
							savePersistedSubagentRecord(currentOptions.cwd, spawnedRecord);
							upsertOwnershipEntry(loaded.manifest, {
								taskId,
								runId,
								subagentId: spawnedRecord.id,
								artifactsDir: loaded.manifest.artifactsRoot,
								depth: spawnedRecord.depth,
								updatedAt: new Date().toISOString(),
							});
						}
					} catch (err) {
						logInternalError("subagent-tools.identity-dispatch", err, `runId=${runId ?? "(unknown)"}`);
					}
				};
				const result = await handleTeamTool(
					{
						action: "run",
						agent: currentOptions.type,
						goal: currentOptions.prompt,
						model: currentOptions.model,
						skill: currentOptions.skill,
						async: currentOptions.background,
						config: currentOptions.maxTurns ? { runtime: { maxTurns: currentOptions.maxTurns } } : undefined,
					} as TeamToolParamsValue,
					{
						...ctxWithSession,
						onRunStarted: (runId: string) => linkAtDispatch(runId), // mid-run capture (FIX)
						signal: childSignal,
						...(options.startForegroundRun
							? {
									startForegroundRun: (runRunner: (sig?: AbortSignal) => Promise<void>, runId?: string) =>
										options.startForegroundRun!(ctxWithSession, runRunner, runId),
								}
							: {}),
					},
				);
				// WP-1/R1 (H6): identity link — record taskId/depth + ownership entry
				// once the run manifest resolves. Direct-agent one-shot runs have
				// exactly one task (direct-agent workflow); resolve from the manifest
				// rather than hardcoding the id. The ownership upsert is verified and
				// retried: a concurrently-completing run holds the run lock during its
				// terminal writes, so a single upsert can lose the lock race
				// (acquireLockWithRetry throws on a fresh foreign lock) and the
				// store swallows that best-effort. taskId is already on the record at
				// that point, so steer still resolves — but the map's subagentId leg
				// would be missing for widget/status attribution. Ride out the
				// contention window, then verify; still never throw.
				let runId: string | undefined;
				try {
					const detailsRunId = (result.details as { runId?: unknown } | undefined)?.runId;
					runId = typeof detailsRunId === "string" ? detailsRunId : undefined;
					if (typeof runId === "string" && spawnedRecord) {
						const loaded = loadRunManifestById(currentOptions.cwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
						const taskId = loaded?.tasks[0]?.id;
						// P3 hardening (T1 review round 1): base the completion-time retry on
						// the MAP LEG, not on record.taskId. A dispatch-time upsert
						// (linkAtDispatch) that lost the lock race would leave the map's
						// subagentId leg missing; the old `!spawnedRecord.taskId` guard then
						// skipped the verify+retry entirely. Now: write record fields once
						// (idempotent), then verify+retry the MAP until the subagentId leg
						// is present or budget exhausted. Upsert is merge-idempotent, so
						// double-writing is safe.
						if (taskId && loaded) {
							if (!spawnedRecord.taskId) {
								spawnedRecord.taskId = taskId;
								spawnedRecord.depth = currentOptions.depth ?? 0;
								savePersistedSubagentRecord(currentOptions.cwd, spawnedRecord);
							}
							const entry = {
								taskId,
								runId,
								subagentId: spawnedRecord.id,
								artifactsDir: loaded.manifest.artifactsRoot,
								depth: spawnedRecord.depth,
								updatedAt: new Date().toISOString(),
							};
							for (let attempt = 0; attempt < 5; attempt++) {
								try {
									upsertOwnershipEntry(loaded.manifest, entry);
								} catch (err) {
									logInternalError("subagent-tools.identity-link", err, `taskId=${taskId}, attempt=${attempt}`);
								}
								if (resolveEntryBySubagentId(loaded.manifest, spawnedRecord.id)?.taskId === taskId) break;
								if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
							}
						}
					}
				} catch (err) {
					logInternalError("subagent-tools.identity-link", err, `runId=${runId ?? "(unknown)"}`);
				}
				return result;
			};
			const record = subagentManager.spawn(spawnOptions, runner, spawnOptions.background ? undefined : signal);
			spawnedRecord = record;
			// Rule 1: register batch membership so completions can be coalesced.
			if (spawnOptions.batchId && spawnOptions.background) {
				options.batchBarrier?.register(spawnOptions.batchId, record.id, { description: record.description, type: record.type });
			}
			if (spawnOptions.background || record.status === "queued") {
				// Phase 1.1a: Terminate turn for background queued — no LLM follow-up needed.
				// Phase 1.6: Record was terminated for telemetry.
				record.terminated = true;
				savePersistedSubagentRecord(ctx.cwd, record);
				return {
					...subagentToolResult(
						[
							t("agent.started", {
								state: record.status === "queued" ? "queued" : "started",
							}),
							t("agent.id", { id: record.id }),
							t("agent.type", { type: record.type }),
							t("agent.description", {
								description: record.description,
							}),
							t("agent.retrieveHint"),
						].join("\n"),
						{ agentId: record.id, status: record.status },
					),
					terminate: true,
				};
			}
			const stopProgress = startAgentToolProgress(ctx.cwd, record.id, onUpdate as OnUpdate | undefined, subagentManager);
			try {
				await record.promise;
			} finally {
				stopProgress();
			}
			// Diagnostic: log when foreground subagent ends in "stopped" to surface the abort reason
			if (record.status === "stopped") {
				logInternalError(
					"subagent-tools.foreground-stopped",
					undefined,
					`agentId=${record.id} runId=${record.runId ?? ""} error=${record.error ?? "(none)"} result=${(record.result ?? "").slice(0, 200)}`,
				);
			}
			const output = readSubagentRunResult(ctx, record) ?? record.result ?? record.error ?? t("agent.noOutput");
			const foregroundResult = subagentToolResult(
				[
					t("agent.foregroundStatus", {
						id: record.id,
						status: record.status,
					}),
					"",
					output,
				].join("\n"),
				{
					agentId: record.id,
					runId: record.runId,
					status: record.status,
				},
				record.status === "failed" || record.status === "error" || record.status === "stopped",
			);
			if (loadConfig(ctx.cwd).config.tools?.terminateOnForeground === true) {
				record.terminated = true;
				savePersistedSubagentRecord(ctx.cwd, record);
				return { ...foregroundResult, terminate: true };
			}
			return foregroundResult;
		},
		renderCall(args, theme, context) {
			return agentToolRenderer.renderCall(args as Record<string, unknown>, theme, context as ToolRenderContext);
		},
		renderResult(result, options, theme, context) {
			try {
				return agentToolRenderer.renderResult(
					result as unknown as Record<string, unknown>,
					options,
					theme,
					context as ToolRenderContext,
				);
			} catch (e) {
				return new Text("agent-err: " + (e instanceof Error ? e.message : "unknown"), 0, 0);
			}
		},
	};

	const getSubagentResultTool: ToolDefinition = {
		name: "get_subagent_result",
		label: "Get Agent Result",
		description: "Check status and retrieve results from a pi-crew background subagent.",
		parameters: Type.Object({
			agent_id: Type.String({
				description: "Agent ID returned by Agent.",
			}),
			wait: Type.Optional(
				Type.Boolean({
					description: "Wait for completion before returning.",
				}),
			),
			verbose: Type.Optional(
				Type.Boolean({
					description: "Include status metadata before output.",
				}),
			),
		}) as never,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const p = params as {
				agent_id?: string;
				wait?: boolean;
				verbose?: boolean;
			};
			if (!p.agent_id) return subagentToolResult(t("result.requiresAgentId"), {}, true);
			const inMemory = subagentManager.getRecord(p.agent_id);
			const record = inMemory ?? readPersistedSubagentRecord(ctx.cwd, p.agent_id);
			if (!record) return subagentToolResult(t("result.notFound", { id: p.agent_id }), {}, true);
			// P2.3: Cross-session ownership check — refuse to serve a record owned by
			// a different session. Legacy records (no ownerSessionId) still pass.
			const currentSessionId = withSessionId(ctx).sessionId;
			if (record.ownerSessionId && record.ownerSessionId !== currentSessionId) {
				return subagentToolResult("Agent belongs to another session.", {}, true);
			}
			let current = refreshPersistedSubagentRecord(ctx, record);
			if (inMemory && current !== inMemory) Object.assign(inMemory, current);
			if (!inMemory && !current.runId && (current.status === "running" || current.status === "queued")) {
				current = {
					...current,
					status: "error",
					error: t("result.unrecoverable"),
					completedAt: current.completedAt ?? Date.now(),
				};
				savePersistedSubagentRecord(ctx.cwd, current);
			}
			if (p.wait && (current.status === "running" || current.status === "queued")) {
				const waited = await subagentManager.waitForRecord(current.id);
				if (waited) current = waited;
				if (current.status === "blocked") {
					current.resultConsumed = false;
					if (inMemory) inMemory.resultConsumed = false;
					savePersistedSubagentRecord(ctx.cwd, current);
				} else {
					const waitStartMs = Date.now();
					const maxWaitMs = 300_000; // 5 minutes
					while (current.status === "running" || current.status === "queued") {
						if (signal?.aborted) {
							current = {
								...current,
								status: "error",
								error: t("result.waitAborted"),
								completedAt: Date.now(),
							};
							savePersistedSubagentRecord(ctx.cwd, current);
							break;
						}
						if (Date.now() - waitStartMs > maxWaitMs) {
							current = {
								...current,
								status: "error",
								error: t("result.waitTimeout"),
								completedAt: Date.now(),
							};
							savePersistedSubagentRecord(ctx.cwd, current);
							break;
						}
						await new Promise((resolve) => setTimeout(resolve, 1000));
						current = refreshPersistedSubagentRecord(ctx, current);
						if (!current.runId) break;
					}
				}
			}
			const output = readSubagentRunResult(ctx, current);
			if (current.status !== "running" && current.status !== "queued" && current.status !== "blocked") {
				// P2.4: Only consume the result when this session owns the record (or
				// it's legacy without ownerSessionId). Don't clobber another session's
				// completion notification.
				if (!current.ownerSessionId || current.ownerSessionId === currentSessionId) {
					current.resultConsumed = true;
					if (inMemory) inMemory.resultConsumed = true;
					savePersistedSubagentRecord(ctx.cwd, current);
				}
			}
			const text = [
				p.verbose ? formatSubagentRecord(current) : undefined,
				output
					? `${p.verbose ? "\n" : ""}${output}`
					: current.status === "running" || current.status === "queued"
						? t("result.stillRunning")
						: (current.error ?? t("agent.noOutput")),
			]
				.filter((line): line is string => Boolean(line))
				.join("\n");
			return subagentToolResult(
				text,
				{
					agentId: current.id,
					runId: current.runId,
					status: current.status,
				},
				current.status === "failed" || current.status === "error",
			);
		},
	};

	const steerSubagentTool: ToolDefinition = {
		name: "steer_subagent",
		label: "Steer Agent",
		description:
			"Send a steering note to a running pi-crew subagent. Resolves the subagent record → ownership map → appends artifacts/steering/<taskId>.jsonl, which the child worker polls at its next turn boundary. Use team action=steer (runId+taskId+message) for run-level steering, or team cancel for interruption.",
		parameters: Type.Object({
			agent_id: Type.String(),
			message: Type.String(),
		}) as never,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { agent_id?: string; message?: string };
			if (!p.message?.trim()) return subagentToolResult(t("agent.requiresPrompt"), {}, true);
			const record = p.agent_id
				? (subagentManager.getRecord(p.agent_id) ?? readPersistedSubagentRecord(ctx.cwd, p.agent_id))
				: undefined;
			if (!record) return subagentToolResult(t("result.notFound", { id: p.agent_id ?? "" }), {}, true);
			// P2.3: Cross-session ownership check — refuse to steer a record owned by
			// a different session. Legacy records (no ownerSessionId) still pass.
			const currentSessionId = withSessionId(ctx).sessionId;
			if (record.ownerSessionId && record.ownerSessionId !== currentSessionId) {
				return subagentToolResult("Agent belongs to another session.", {}, true);
			}
			// Resolve the live run's taskId + artifactsRoot: prefer the record's
			// taskId link (set by the Agent-tool spawn route), falling back to the
			// per-run ownership map (resolve by subagentId) when the record predates
			// the link.
			let taskId = record.taskId;
			let artifactsRoot: string | undefined;
			let loaded: ReturnType<typeof loadRunManifestById> | undefined;
			if (record.runId) {
				loaded = loadRunManifestById(ctx.cwd, record.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
				if (loaded) {
					artifactsRoot = loaded.manifest.artifactsRoot;
					taskId ??= resolveEntryBySubagentId(loaded.manifest, record.id)?.taskId;
				}
			}
			// Back-compat: no taskId/link (legacy record or run never dispatched) →
			// the existing "not linked" structured message, NO throw, NO file write.
			if (!taskId || !artifactsRoot) {
				return subagentToolResult(
					[t("steer.unavailable"), record.runId ? t("steer.cancelHint", { runId: record.runId }) : undefined]
						.filter((line): line is string => Boolean(line))
						.join("\n"),
					{
						agentId: record.id,
						runId: record.runId,
						status: record.status,
					},
				);
			}
			// Real steer — append to artifacts/steering/<taskId>.jsonl, same writer util
			// + JSONL schema as `team steer` (handleSteer, team-tool.ts):
			// {type:"steer", message, ts}. The child worker polls this file every
			// 500ms and picks the message up at its next turn boundary.
			// Security review (T1/WP-1 round 1, security 1-3): mirror handleSteer's
			// hardening — (a) T-S1 terminal-task refusal + taskId-belongs-to-manifest
			// validation; (b) cap steering-file growth (unbounded files force a
			// Buffer.alloc(fileSize) on the next worker's first poll and re-deliver
			// every line to each incarnation — see P2 replay finding); (c) no throw.
			if (!loaded) return subagentToolResult("Run manifest unavailable for steer.", {}, true);
			const manifestTask = loaded.tasks.find((t) => t.id === taskId);
			if (!manifestTask) {
				return subagentToolResult(
					`Task '${taskId}' not found in the owning run; cannot steer.`,
					{ agentId: record.id, runId: record.runId, taskId, status: record.status },
					true,
				);
			}
			if (TEAM_TERMINAL_TASK_STATUSES.has(manifestTask.status)) {
				return subagentToolResult(
					`Task '${taskId}' is ${manifestTask.status}; cannot steer.`,
					{ agentId: record.id, runId: record.runId, taskId, status: record.status },
					true,
				);
			}
			try {
				const steeringDir = `${artifactsRoot}/steering`;
				fs.mkdirSync(steeringDir, { recursive: true });
				const safeSteeringPath = resolveRealContainedPath(steeringDir, `${taskId}.jsonl`);
				// Security 3: cap file growth — refuse when the file exceeds a byte
				// threshold (drop-oldest semantics are not feasible for a plain JSONL
				// append; refuse loudly instead of poisoning the next incarnation).
				const MAX_STEERING_BYTES = 256 * 1024;
				let existingBytes = 0;
				try {
					existingBytes = fs.statSync(safeSteeringPath).size;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				const line = JSON.stringify({ type: "steer", message: p.message, ts: new Date().toISOString() }) + "\n";
				if (existingBytes + Buffer.byteLength(line) > MAX_STEERING_BYTES) {
					return subagentToolResult(
						`Steering file for task '${taskId}' has reached its size cap (${(MAX_STEERING_BYTES / 1024).toFixed(0)}KiB); steer refused.`,
						{ agentId: record.id, runId: record.runId, taskId, status: record.status },
						true,
					);
				}
				fs.appendFileSync(safeSteeringPath, line);
			} catch (err) {
				// B1 battery 2026-08-18 (F7): this catch previously logged at DEBUG
				// level (invisible unless PI_TEAMS_DEBUG) and then STILL returned the
				// success message — a live probe showed "Steer delivered to task …"
				// while the steering file stayed 0 bytes, undiagnosable from the
				// outside. Fail LOUD: error-level log + isError result.
				logInternalError(
					"subagent-tools.steer-write-failed",
					err instanceof Error ? err : new Error(String(err)),
					`taskId=${taskId} runId=${record.runId} artifactsRoot=${artifactsRoot}`,
					"error",
				);
				return subagentToolResult(
					`Steer write failed for task '${taskId}': ${err instanceof Error ? err.message : String(err)} (see pi-crew error log)`,
					{ agentId: record.id, runId: record.runId, taskId, status: record.status },
					true,
				);
			}
			return subagentToolResult(
				[
					t("steer.noted", { id: record.id }),
					`Steer delivered to task '${taskId}'; it will be picked up at the next turn boundary.`,
				].join("\n"),
				{
					agentId: record.id,
					runId: record.runId,
					taskId,
					status: record.status,
				},
			);
		},
	};

	const crewAgentTool: ToolDefinition = {
		...agentTool,
		name: "crew_agent",
		label: "Crew Agent",
		description: "Launch a real pi-crew subagent using a conflict-safe pi-crew-specific tool name.",
		promptSnippet: "Use crew_agent when you need pi-crew subagents and another extension may own the generic Agent tool.",
	};
	const crewAgentResultTool: ToolDefinition = {
		...getSubagentResultTool,
		name: "crew_agent_result",
		label: "Get Crew Agent Result",
		description: "Check status and retrieve results from a pi-crew subagent using the conflict-safe tool name.",
	};
	const crewAgentSteerTool: ToolDefinition = {
		...steerSubagentTool,
		name: "crew_agent_steer",
		label: "Steer Crew Agent",
		description: "Send a steering note to a pi-crew subagent using the conflict-safe tool name (same behavior as steer_subagent).",
	};
	const toolConfig = loadConfig(process.cwd()).config.tools;
	const enableSteer = toolConfig?.enableSteer !== false;
	const enableClaudeStyleAliases = toolConfig?.enableClaudeStyleAliases !== false;

	for (const extraTool of enableSteer ? [crewAgentTool, crewAgentResultTool, crewAgentSteerTool] : [crewAgentTool, crewAgentResultTool])
		pi.registerTool(extraTool);
	if (enableClaudeStyleAliases) {
		for (const extraTool of enableSteer ? [agentTool, getSubagentResultTool, steerSubagentTool] : [agentTool, getSubagentResultTool]) {
			try {
				pi.registerTool(extraTool);
			} catch (error) {
				logInternalError("register.duplicate-tool", error, `tool=${extraTool.name}`);
			}
		}
	}
}

function startAgentToolProgress(cwd: string, agentRecordId: string, onUpdate: OnUpdate | undefined, manager: SubagentManager): () => void {
	if (!onUpdate) return () => undefined;
	const startedAt = Date.now();
	const tick = (): void => {
		try {
			const record = manager.getRecord(agentRecordId);
			if (!record) return;
			let manifest: TeamRunManifest | undefined;
			let tasks: TeamTaskState[] | undefined;
			let agents: CrewAgentRecord[] | undefined;
			if (record.runId) {
				const loaded = loadRunManifestById(cwd, record.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
				if (loaded) {
					manifest = loaded.manifest;
					tasks = loaded.tasks;
					try {
						agents = readCrewAgents(loaded.manifest);
					} catch {
						/* ignore */
					}
				}
			}
			const text = formatCompactToolProgress({
				agentId: record.id,
				status: record.status,
				runId: record.runId,
				startedAt: record.startedAt ?? startedAt,
				manifest,
				tasks,
				agents,
				error: record.error,
			});
			onUpdate({ content: [{ type: "text", text }] });
		} catch (error) {
			logInternalError("subagent-tools.progress", error, `agentId=${agentRecordId}`);
		}
	};
	tick();
	const timer = setInterval(tick, TOOL_PROGRESS_TICK_MS);
	if (typeof timer.unref === "function") timer.unref();
	return () => clearInterval(timer);
}
