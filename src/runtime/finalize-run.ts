/**
 * Run finalization for the team-run scheduler loop.
 *
 * Extracted from team-runner.ts (2026-08, Phase 2.6 maintainability split —
 * CORE-4 extraction 8 + the writeProgress cluster + applyPolicy it depends
 * on). Pure code motion: formatTaskProgress / runEffectivenessLines /
 * scratchpadSummaryLines / lastProgressContentHash / writeProgress /
 * applyPolicy / finalizeRun moved verbatim, including the R15-1 / S02 / F1
 * / P6 / RT-7 / RT-7a / I5 / BUG A comments.
 *
 * Import direction: this module imports isRunTerminalPreserved from
 * ./merge-loop.ts (never the reverse) and never imports from team-runner.ts —
 * `writeProgress` / `lastProgressContentHash` / `finalizeRun` are exported so
 * team-runner.ts (core loop + finally) can import them here.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { CrewLimitsConfig, CrewRuntimeConfig } from "../config/config.ts";
import { flushPendingAtomicWrites } from "../state/atomic-write.ts";
import { TEAM_TERMINAL_TASK_STATUSES } from "../state/contracts.ts";
import { withRunLock } from "../state/coordination/locks.ts";
import { appendEvent, appendEventAsync, appendEventFireAndForget, readEvents } from "../state/event-log/event-log.ts";
import { hashArtifactContent as hashContent, writeArtifact } from "../state/stores/artifact-store.ts";
import { HealthStore } from "../state/stores/health-store.ts";
import { loadRunManifestById, saveRunManifestAsync, saveRunTasksAsync, updateRunStatus } from "../state/stores/state-store.ts";
import type { ArtifactDescriptor, PolicyDecision, TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { aggregateUsage, formatUsage } from "../state/usage.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { checkBranchFreshness } from "../worktree/branch-freshness.ts";
import { effectivenessPolicyDecision, evaluateRunEffectiveness, formatRunEffectivenessLines } from "./effectiveness.ts";
import { isRunTerminalPreserved } from "./merge-loop.ts";
import { evaluateCrewPolicy, summarizePolicyDecisions } from "./policy-engine.ts";
import { buildRecoveryLedger } from "./recovery/recovery-recipes.ts";
import type { SchedulerContext } from "./scheduler-context.ts";
import { taskGraphSnapshot } from "./scheduling/task-graph-scheduler.ts";

function formatTaskProgress(task: TeamTaskState): string {
	return `- ${task.id}: ${task.status} (${task.role} -> ${task.agent})${task.taskPacket ? ` scope=${task.taskPacket.scope}` : ""}${task.verification ? ` green=${task.verification.observedGreenLevel}/${task.verification.requiredGreenLevel}` : ""}${task.error ? ` - ${task.error}` : ""}`;
}

function runEffectivenessLines(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
	executeWorkers: boolean,
	runtimeConfig?: CrewRuntimeConfig,
): string[] {
	return formatRunEffectivenessLines(
		evaluateRunEffectiveness({
			manifest,
			tasks,
			executeWorkers,
			runtimeConfig,
		}),
	);
}

// I5 (plan): surface scratchpad adoption in the run summary — but ONLY when
// non-zero, so the 3 armed roles that never call it add no noise. Counts the
// metric events the workers appended to the run events log (fire-and-forget
// scratchpad.cell / scratchpad.restored). Silent when the feature is unused or
// the events path is missing (no throw).
function scratchpadSummaryLines(manifest: TeamRunManifest): string[] {
	if (!manifest.eventsPath) return [];
	const events = readEvents(manifest.eventsPath);
	const cells = events.filter((e) => e.type === "scratchpad.cell");
	const restores = events.filter((e) => e.type === "scratchpad.restored");
	if (cells.length === 0 && restores.length === 0) return [];
	return [
		`## Scratchpad (RLM adoption) — I5 metric`,
		`- cells executed: ${cells.length}`,
		`- snapshot restores: ${restores.length}`,
		...(cells.length > 0
			? [`- total cell time: ${Math.round(cells.reduce((s, e) => s + ((e.data?.durationMs as number) ?? 0), 0))} ms`]
			: []),
	];
}

// P6 (perf): Cache the last-rendered progress content so we can skip the
// artifact write + redaction + atomic write + size/hash read when nothing
// material changed (rare between batches, but happens between idle heartbeats).
// The dedup filter also moved from O(N²) findIndex inside .filter(...)
// (the previous implementation ran 2 redundant passes on every batch) to
// a single-pass Map-based replacement: remove the existing entry by path, then
// append the new one. Net complexity: O(N) build + O(1) replace per write.
// RT-7: key on manifest.runId (stable string) instead of object identity
// (WeakMap). Every writeProgress mutator returns a NEW manifest object via
// spread, so object-identity keying meant the cache NEVER hit. Using runId
// makes back-to-back calls (same millisecond) actually dedup.
export const lastProgressContentHash = new Map<string, string>();

export function writeProgress(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
	producer: string,
	executeWorkers = true,
	runtimeConfig?: CrewRuntimeConfig,
): TeamRunManifest {
	const counts = new Map<string, number>();
	for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
	const queue = taskGraphSnapshot(tasks);
	const updatedAt = new Date().toISOString();
	const content = [
		`# pi-crew progress ${manifest.runId}`,
		"",
		`Status: ${manifest.status}`,
		`Team: ${manifest.team}`,
		`Workflow: ${manifest.workflow ?? "(none)"}`,
		`Updated: ${updatedAt}`,
		`Task counts: ${[...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`,
		`Queue: ready=${queue.ready.length}, blocked=${queue.blocked.length}, running=${queue.running.length}, done=${queue.done.length}, failed=${queue.failed.length}, cancelled=${queue.cancelled.length}`,
		"",
		"## Tasks",
		...tasks.map(formatTaskProgress),
		"",
		"## Effectiveness",
		...runEffectivenessLines(manifest, tasks, executeWorkers, runtimeConfig),
		"",
	].join("\n");

	// P6 content-cache: even with identical status / counts / queue, the
	// `Updated:` timestamp ticks on every call so the content rarely matches
	// byte-for-byte. We DO compare against the previous rendered byte-stream
	// (which used the previous timestamp) — so this only hits on the
	// back-to-back writeProgress calls during the applyPolicy phase, where
	// both calls happen within the same millisecond. It's a minor win but
	// matches the audit recommendation (skip artifact write when nothing
	// material changed).
	// RT-7: compute the content hash ONCE (was hashed twice per call: once
	// for the canSkip comparison and again for the cache .set). Key the cache
	// on manifest.runId (stable) instead of object identity (never hit).
	const contentHash = hashContent(content);
	const prevHash = lastProgressContentHash.get(manifest.runId);
	// Cheap pre-check: avoid the redaction + atomicWrite + readback roundtrip
	// when both the timestamp and the input args are identical to last time.
	const canSkip = prevHash === contentHash;

	const progress = canSkip
		? (() => {
				// Reuse the previous artifact rather than rebuilding one via
				// writeArtifact. This skips mkdirSync, resolveRealContainedPath,
				// redactSecrets, atomicWriteFile, and the post-write readFileSync +
				// statSync.
				const existing = manifest.artifacts.find((a) => a.kind === "progress");
				if (existing) {
					// RT-7a: return a FRESH descriptor with a refreshed createdAt
					// instead of reusing the stale existing reference. The existing
					// descriptor's createdAt reflects the FIRST write time, not this
					// skip-write; refreshing it matches the non-skip path (writeArtifact
					// stamps createdAt with the actual write time) so the manifest
					// always carries a descriptor whose createdAt reflects the current
					// write. Content is identical (that's why we skipped), so path /
					// sizeBytes / contentHash / retention are unchanged.
					return { ...existing, createdAt: new Date().toISOString() };
				}
				// No prior progress artifact (rare; first call from a stale manifest
				// view). Fall through to the normal write.
				return writeArtifact(manifest.artifactsRoot, {
					kind: "progress",
					relativePath: "progress.md",
					producer,
					content,
				});
			})()
		: writeArtifact(manifest.artifactsRoot, {
				kind: "progress",
				relativePath: "progress.md",
				producer,
				content,
			});
	lastProgressContentHash.set(manifest.runId, contentHash);

	// P6 dedup: replace by path in a single Map pass instead of
	//   .filter(...)  // O(N) to remove the old entry
	//   .filter((_, i, self) => self.findIndex(...) === i)  // O(N²) for dedup
	// For an artifact list of size 30+ across a long run, this was the
	// dominant cost of writeProgress between batches.
	const byPath = new Map<string, ArtifactDescriptor>();
	for (const artifact of manifest.artifacts) {
		if (artifact.kind === "progress" && artifact.path === progress.path) continue;
		byPath.set(artifact.path, artifact);
	}
	byPath.set(progress.path, progress);
	const deduped = [...byPath.values()];

	return {
		...manifest,
		updatedAt,
		artifacts: deduped,
	};
}

function applyPolicy(manifest: TeamRunManifest, tasks: TeamTaskState[], limits?: CrewLimitsConfig): TeamRunManifest {
	const branchFreshness = checkBranchFreshness(manifest.cwd);
	const branchArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: "metadata/branch-freshness.json",
		producer: "branch-freshness",
		content: `${JSON.stringify(branchFreshness, null, 2)}\n`,
	});
	let decisions: PolicyDecision[] = evaluateCrewPolicy({
		manifest,
		tasks,
		limits,
	});
	if (branchFreshness.status === "stale" || branchFreshness.status === "diverged") {
		const branchDecision: PolicyDecision = {
			action: "notify",
			reason: "branch_stale",
			message: branchFreshness.message,
			createdAt: new Date().toISOString(),
		};
		decisions = [...decisions, branchDecision];
		appendEvent(manifest.eventsPath, {
			type: "branch.stale",
			runId: manifest.runId,
			message: branchFreshness.message,
			data: { branchFreshness },
		});
	}
	const policyArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: "policy-decisions.json",
		producer: "policy-engine",
		content: `${JSON.stringify(decisions, null, 2)}\n`,
	});
	const recoveryLedger = buildRecoveryLedger(decisions);
	const recoveryArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: "recovery-ledger.json",
		producer: "recovery-engine",
		content: `${JSON.stringify(recoveryLedger, null, 2)}\n`,
	});
	for (const item of decisions)
		appendEvent(manifest.eventsPath, {
			type: item.action === "escalate" ? "policy.escalated" : "policy.action",
			runId: manifest.runId,
			taskId: item.taskId,
			message: item.message,
			data: { action: item.action, reason: item.reason },
		});
	for (const item of recoveryLedger.entries)
		appendEvent(manifest.eventsPath, {
			type: item.state === "escalation_required" ? "recovery.escalated" : "recovery.attempted",
			runId: manifest.runId,
			taskId: item.taskId,
			message: item.message,
			data: {
				scenario: item.scenario,
				steps: item.steps,
				attempt: item.attempt,
				state: item.state,
			},
		});
	return {
		...manifest,
		updatedAt: new Date().toISOString(),
		policyDecisions: decisions,
		artifacts: [
			...manifest.artifacts.filter(
				(artifact) =>
					!(
						artifact.kind === "metadata" &&
						(artifact.path.endsWith("policy-decisions.json") ||
							artifact.path.endsWith("recovery-ledger.json") ||
							artifact.path.endsWith("branch-freshness.json"))
					),
			),
			branchArtifact,
			policyArtifact,
			recoveryArtifact,
		],
	};
}

/**
 * CORE-4 extraction 8: finalize the run after the scheduler loop exits.
 *
 * Computes the final run status (failed/blocked/completed) from task states,
 * policy decisions, and effectiveness evaluation; writes the workflow output
 * deliverable warning, the `summary.md` artifact, the joint atomic manifest+tasks
 * save, and a health snapshot; then returns the terminal `{ manifest, tasks }`.
 *
 * Reads `ctx.input` (limits/workflow/executeWorkers/runtimeConfig). Mutates
 * `ctx.manifest` / `ctx.tasks` and writes them back before returning so the
 * caller stays in sync. This function is the terminal step of
 * `executeTeamRunCore` — its return value is the run result.
 *
 * @param ctx  The scheduler context.
 * @returns    The final `{ manifest, tasks }` result for the run.
 */
export async function finalizeRun(ctx: SchedulerContext): Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }> {
	const input = ctx.input;
	let tasks = ctx.tasks;
	let manifest = ctx.manifest;
	// Bug-027 (PR #46 ubuntu CI, 3 consecutive runs): under heavy contention a
	// settled unit's merged result can carry a STALE non-terminal snapshot while
	// the worker's durable completion has already landed in tasks.json — the
	// status-derivation chain below would then flip a phantom 'running' into a
	// false 'blocked: still running' (events: reviewer task.completed 18.184 →
	// batch merge 18.190 → run.blocked 18.223, with the "running" task completed
	// on disk the whole time). Disk is the authority at finalize — the same
	// principle as the R15-1 locked save. Reconcile in-memory non-terminal tasks
	// against a fresh tasks.json read, but ONLY when nothing is in-flight
	// (pendingUnits empty) so a genuinely running worker is never clobbered.
	if (ctx.pendingUnits.size === 0 && tasks.some((task) => task.status === "running" || task.status === "waiting")) {
		try {
			flushPendingAtomicWrites();
			const diskTasks = JSON.parse(fs.readFileSync(manifest.tasksPath, "utf8")) as TeamTaskState[];
			const diskById = new Map(diskTasks.map((task) => [task.id, task] as const));
			const healed: string[] = [];
			tasks = tasks.map((task) => {
				if (task.status !== "running" && task.status !== "waiting") return task;
				const disk = diskById.get(task.id);
				if (disk && TEAM_TERMINAL_TASK_STATUSES.has(disk.status)) {
					healed.push(`${task.id}:${task.status}->${disk.status}`);
					return disk;
				}
				return task;
			});
			if (healed.length > 0) {
				ctx.tasks = tasks;
				appendEventFireAndForget(manifest.eventsPath, {
					type: "task.reconciled_from_disk",
					runId: manifest.runId,
					message: `Finalize healed stale non-terminal snapshot(s) from durable tasks.json: ${healed.join(", ")}`,
					data: { healed },
				});
			}
		} catch (error) {
			// Unreadable/missing tasks.json — keep the in-memory view; the chain
			// below decides as before.
			logInternalError("finalize-run.disk-reconcile", error, manifest.runId, "debug");
		}
	}
	const failed = tasks.find((task) => task.status === "failed");
	const waiting = tasks.find((task) => task.status === "waiting");
	const running = tasks.find((task) => task.status === "running");
	manifest = applyPolicy(manifest, tasks, input.limits);

	// S02: Verify workflow-declared output files exist before marking completed
	if (input.workflow?.steps) {
		const missingOutputs: string[] = [];
		for (const step of input.workflow.steps) {
			if (step.output && typeof step.output === "string") {
				const outputPath = path.join(manifest.artifactsRoot, step.output);
				if (!fs.existsSync(outputPath)) {
					missingOutputs.push(step.output);
				}
			}
		}
		if (missingOutputs.length > 0) {
			// Emit warning event — run still completes normally to avoid hanging
			appendEventFireAndForget(manifest.eventsPath, {
				type: "run.deliverable_warning",
				runId: manifest.runId,
				message: `Missing workflow output files: ${missingOutputs.join(", ")}`,
				data: { missingFiles: missingOutputs },
			});
		}
	}

	const effectiveness = evaluateRunEffectiveness({
		manifest,
		tasks,
		executeWorkers: input.executeWorkers,
		runtimeConfig: input.runtimeConfig,
	});
	const effectivenessDecision = effectivenessPolicyDecision(effectiveness);
	if (effectivenessDecision) {
		manifest = {
			...manifest,
			policyDecisions: [...(manifest.policyDecisions ?? []), effectivenessDecision],
			updatedAt: new Date().toISOString(),
		};
		await appendEventAsync(manifest.eventsPath, {
			type: "run.effectiveness",
			runId: manifest.runId,
			message: effectivenessDecision.message,
			data: { effectiveness, policyDecision: effectivenessDecision },
		});
	}
	const blockingDecision = manifest.policyDecisions?.find((item) => item.action === "block" || item.action === "escalate");
	// R15-1: capture the entry status BEFORE the in-memory status-derivation
	// chain. The chain below computes the final status in-memory ONLY — its
	// updateRunStatus persistence calls are replaced with a pure in-memory
	// status application so ALL persistence happens in the single locked save
	// further below, which re-reads disk first and preserves a disk-terminal
	// status (cancel → "cancelled", reconciler → "failed") instead of
	// overwriting it with the derived status (typically "completed"). The
	// DECISION LOGIC of the chain (branches, conditions, statuses, messages)
	// is unchanged; only the persistence mechanism moved.
	const entryStatus = manifest.status;
	// R15-1: true when the chain applied a derived status via a status branch
	// (mirrors the old chain's updateRunStatus call sites, INCLUDING the
	// from===to cases like `if (failed)` on an already-failed manifest that
	// re-emit run.<status>). The preserve branch below leaves it false so the
	// locked save does NOT emit a status event (matching old behavior).
	let chainAppliedStatus = false;
	const applyStatusInMemory = (status: TeamRunManifest["status"], summary: string): TeamRunManifest => {
		chainAppliedStatus = true;
		return { ...manifest, status, summary, updatedAt: new Date().toISOString() };
	};
	if (failed) {
		manifest = applyStatusInMemory("failed", `Failed at task '${failed.id}'.`);
	} else if (waiting) {
		manifest = applyStatusInMemory("blocked", `Waiting for response to task '${waiting.id}'.`);
	} else if (running) {
		manifest = applyStatusInMemory("blocked", `Task '${running.id}' is still running.`);
	} else if (effectiveness.severity === "failed") {
		manifest = applyStatusInMemory("failed", effectivenessDecision?.message ?? "Run effectiveness guard failed.");
	} else if (effectiveness.severity === "blocked") {
		manifest = applyStatusInMemory("blocked", effectivenessDecision?.message ?? "Run effectiveness guard blocked completion.");
	} else if (blockingDecision) {
		manifest = applyStatusInMemory("blocked", blockingDecision.message);
	} else if (tasks.some((task) => task.status === "queued")) {
		// F1 defense-in-depth: the loop exited with queued tasks still pending
		// (e.g. a hook skipped all ready tasks and downstream tasks never became
		// runnable). This is NOT a completed run — mark it blocked rather than
		// false-green "completed".
		manifest = applyStatusInMemory("blocked", "Run exited with queued tasks still pending.");
	} else if (manifest.status === "failed" || manifest.status === "cancelled") {
		// The run was already marked failed/cancelled mid-run (e.g. handleFailedTask
		// on a coalesced-group race where the failing task's status was later
		// mutated by the group-drain, or a cancel). Preserve that terminal status —
		// do NOT force "completed" here: failed -> completed is not in
		// TEAM_RUN_STATUS_TRANSITIONS and would throw an invalid-transition error.
		// (No updateRunStatus call: from===to is a no-op, but the intent here is
		// explicitly "leave the earlier decision intact".)
	} else {
		manifest = applyStatusInMemory(
			"completed",
			input.executeWorkers ? "Team workflow completed." : "Team workflow scaffold completed without launching child workers.",
		);
	}
	manifest = writeProgress(manifest, tasks, "team-runner", input.executeWorkers, input.runtimeConfig);
	const usage = aggregateUsage(tasks);

	// R15-1: ALL persistence inside ONE withRunLock that FIRST re-reads disk.
	// The former unlocked `saveRunManifestAsync(manifest)` (pre-lock) is gone —
	// the single locked write below (manifest + tasks via finalManifest) is now
	// the ONLY persistence point, preserving crash-window atomicity. Disk is
	// authoritative for terminal states: if a cancel/reconciler write landed
	// between loop-exit and this save, its terminal status is preserved and the
	// derived in-memory status (typically "completed") is NOT applied.
	const finalManifest = await withRunLock(manifest, async () => {
		flushPendingAtomicWrites();
		const disk = loadRunManifestById(manifest.cwd, manifest.runId);
		const diskManifest = disk?.manifest;
		const diskTerminal = diskManifest && isRunTerminalPreserved(diskManifest.status);
		const signalAborted = ctx.input.signal?.aborted === true;

		let resolvedManifest: TeamRunManifest;
		let resolvedTasks = tasks;
		if (diskTerminal || signalAborted) {
			// R15-1: preserve the disk terminal status — do NOT overwrite it with
			// the in-memory derived status, do NOT run the completion branch.
			// Signal-aborted also preserves (the run must not complete). Mirror
			// CANCEL-1: disk is authoritative for terminal states — the final
			// tasks write also uses the freshest disk tasks so a cancel that
			// landed between the last merge and this save is not resurrected.
			const preservedStatus = diskTerminal ? diskManifest!.status : "cancelled";
			resolvedManifest = {
				...manifest,
				status: preservedStatus,
				summary: diskTerminal ? (diskManifest!.summary ?? manifest.summary) : "Run cancelled during finalization.",
				updatedAt: new Date().toISOString(),
			};
			resolvedTasks = disk?.tasks ?? tasks;
			await appendEventAsync(manifest.eventsPath, {
				type: "run.terminal_preserved",
				runId: manifest.runId,
				message: `Run terminal status '${preservedStatus}' preserved from disk; finalize did not overwrite it.`,
				data: { preservedStatus, derivedStatus: manifest.status, signalAborted },
			});
		} else if (chainAppliedStatus) {
			// Apply the derived in-memory status via updateRunStatus (validates
			// the entryStatus→derived transition exactly as the pre-R15-1 chain
			// did — from===to included — emits the run.<status> event, unregisters
			// active-run, persists).
			resolvedManifest = updateRunStatus({ ...manifest, status: entryStatus }, manifest.status, manifest.summary);
		} else {
			// preserve branch from the chain — leave the earlier decision intact
			// (no status event, matching pre-R15-1 behavior).
			resolvedManifest = { ...manifest, updatedAt: new Date().toISOString() };
		}

		// summaryArtifact + healthSnapshot run in ALL paths (preserved-terminal
		// included) — the summary is written with the FINAL (possibly preserved)
		// status so the run record is complete.
		const summaryArtifact = writeArtifact(resolvedManifest.artifactsRoot, {
			kind: "summary",
			relativePath: "summary.md",
			producer: "team-runner",
			content: [
				`# pi-crew run ${resolvedManifest.runId}`,
				"",
				`Status: ${resolvedManifest.status}`,
				`Team: ${resolvedManifest.team}`,
				`Workflow: ${resolvedManifest.workflow ?? "(none)"}`,
				`Goal: ${resolvedManifest.goal}`,
				`Usage: ${formatUsage(usage)}`,
				"",
				"## Tasks",
				...resolvedTasks.map(formatTaskProgress),
				"",
				"## Effectiveness",
				...runEffectivenessLines(resolvedManifest, tasks, input.executeWorkers, input.runtimeConfig),
				"",
				"## Policy decisions",
				...(resolvedManifest.policyDecisions?.length ? summarizePolicyDecisions(resolvedManifest.policyDecisions) : ["- (none)"]),
				"",
				...scratchpadSummaryLines(resolvedManifest),
			].join("\n"),
		});
		// Joint atomic save: wrap manifest + tasks in a single run lock so they are
		// written together or not at all. Crash between separate saveRunManifestAsync
		// and saveRunTasksAsync calls could leave manifest/tasks.json out of sync.
		// R15-1: this is now the ONLY manifest+tasks write (the unlocked pre-lock
		// saveRunManifestAsync was removed).
		const final = {
			...resolvedManifest,
			updatedAt: new Date().toISOString(),
			artifacts: [...resolvedManifest.artifacts, summaryArtifact],
		};
		await saveRunManifestAsync(final);
		await saveRunTasksAsync(final, resolvedTasks);
		return { manifest: final, tasks: resolvedTasks };
	});
	manifest = finalManifest.manifest;
	const finalTasks = finalManifest.tasks;
	// Save health snapshot on run completion.
	// BUG A (pts/2 hang investigation 2026-06-16): stateRoot = `<crewRoot>/state/runs/<runId>`,
	// so the crew root is THREE dirnames up, not two. Two dirnames gave `<crewRoot>/state`
	// (the state dir), and HealthStore then joined HEALTH_DIR (`.crew/state/health`)
	// onto it → `<crewRoot>/state/.crew/state/health` — a double-joined BOGUS path.
	// That wrote health snapshots to a nonexistent subtree (silently breaking the
	// health feature) AND created junk dirs that the recursive state watcher then
	// attached extra inotify watches to. Fix: compute the real crew root (3 up)
	// and make HEALTH_DIR relative to it.
	const crewRoot = path.dirname(path.dirname(path.dirname(finalManifest.manifest.stateRoot)));
	const healthStore = new HealthStore(crewRoot);
	healthStore.saveSnapshot({
		runId: finalManifest.manifest.runId,
		tasks: finalTasks.map((t) => ({ id: t.id, status: t.status })),
		createdAt: finalManifest.manifest.createdAt,
	});
	ctx.manifest = manifest;
	ctx.tasks = finalTasks;
	return { manifest, tasks: finalTasks };
}

/** @internal RT-7 test export — verify cache is keyed on runId (stable string). */
export const __test__lastProgressContentHash = lastProgressContentHash;
/** @internal RT-7 test export — exercise writeProgress directly. */
export const __test__writeProgress = writeProgress;
/** @internal R15-1 test export — exercise finalizeRun directly (disk-terminal preservation). */
export const __test__finalizeRun = finalizeRun;
