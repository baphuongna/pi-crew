import { renderAskAnswer } from "../../prompt/prompt-runtime.ts";
import { readCrewAgents, recordFromTask, saveCrewAgents } from "../../runtime/crew-agent-records.ts";
import { isWaitingWorkerAlive } from "../../runtime/dispatch-batch.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { withRunLockSync } from "../../state/coordination/locks.ts";
import { appendMailboxMessage, readMailbox, updateMailboxMessageReply } from "../../state/coordination/mailbox.ts";
import { appendEventAsync } from "../../state/event-log/event-log.ts";
import { loadRunManifestById, saveRunManifest, saveRunTasks, updateRunStatus } from "../../state/stores/state-store.ts";
import type { TeamTaskState } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { locateRunCwd } from "../team-tool.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { result, type TeamContext } from "./context.ts";
import { paramRequired } from "./param-error.ts";
import { RUN_NOT_FOUND_HINT } from "./run-not-found.ts";

/** WP-2/R2 (ADR-0 item 8/security P1-4): fence the injected ask answer as
 *  untrusted when it is replayed into the next dispatch prompt via the
 *  `pendingSteers` cross-attempt channel. The mailbox is a same-uid
 *  unauthenticated channel — raw answer text is never injected without the
 *  dependency-context fence. */
/** Re-queue a waiting task for durable scheduler resume. Optionally carries an
 *  injected note (the fenced ask answer / timeout note) on the pendingSteers
 *  cross-attempt channel — child-executor re-appends pendingSteers into the
 *  next worker incarnation's steering file, and registerLiveAgent drains them
 *  for the live-session runtime. The park marker (`waiting`) is cleared: a
 *  requeued task must not stay parked (mirrors applyRecoveryPlan discipline). */
function requeueWaitingTask(tasks: TeamTaskState[], taskId: string, message: string, injection?: string): TeamTaskState[] {
	return tasks.map((task) => {
		if (task.id !== taskId) return task;
		return {
			...task,
			status: "queued" as const,
			startedAt: undefined,
			finishedAt: undefined,
			error: undefined,
			waiting: undefined,
			adaptive: {
				...task.adaptive,
				phase: "resumed",
				task: message || task.adaptive?.task || "",
			},
			...(injection ? { pendingSteers: [...(task.pendingSteers ?? []), injection] } : {}),
		};
	});
}

/**
 * Handle `respond` action: answer a waiting (parked) task's question.
 *
 * WP-2/R2 (ADR-0 docs/decisions/2026-08-17-waiting-producer-ask.md item 8):
 * liveness discrimination replaces the old blanket re-queue of ALL waiting
 * tasks.
 * - ALIVE (heartbeat last-beat within the 60s gradient-stale window, or a
 *   live in-memory session handle) → append a mailbox `kind:"response"`
 *   entry carrying the task's `waiting.questionId` (from leader, to the task)
 *   and LEAVE `task.waiting` in place: the parked `ask` tool polls the task
 *   mailbox stream, picks the response up and flips waiting→running via its
 *   own terminal report.
 * - DEAD → re-queue the task AND inject the fenced answer into the next
 *   dispatch prompt (pendingSteers cross-attempt channel). No questionId-
 *   tagged mailbox response is written.
 * - EXACTLY-ONE-DISPATCH GUARD: a response for a given questionId dispatches
 *   via mailbox-write OR requeue+inject — never both — and is idempotent per
 *   questionId. The branch is atomic under the run lock (check + write inside
 *   one withRunLockSync + fresh-reload critical section); the requeue path
 *   clears `waiting` so a second respond finds no waiting task (no-op).
 * - Legacy waiting parks without `task.waiting` (pre-v2 records) keep the old
 *   mailbox + re-queue resume behavior — there is no parked tool to pick a
 *   questionId-tagged response up.
 * - `ask.answered` is emitted on both discrimination paths.
 */
export function handleRespond(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId)
		return result(
			paramRequired("respond", "runId", "{ action: 'respond', runId: 'team_...', message: '...' }"),
			{ action: "respond", status: "error" },
			true,
		);
	if (!params.message && !params.taskId)
		return result(
			paramRequired(
				"respond",
				"taskId and/or message",
				"{ action: 'respond', runId: 'team_...', taskId: '01_agent', message: '...' }",
			),
			{ action: "respond", status: "error" },
			true,
		);

	const runCwd = locateRunCwd(params.runId, ctx.cwd);
	if (!runCwd) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "respond", status: "error" }, true);
	const loaded = loadRunManifestById(runCwd, params.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "respond", status: "error" }, true);

	return withRunLockSync(loaded.manifest, () => {
		const fresh = loadRunManifestById(loaded.manifest.cwd, params.runId!); // NOTE: inside withRunLockSync - consistent read
		if (!fresh) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "respond", status: "error" }, true);
		const foreignRun = typeof fresh.manifest.ownerSessionId === "string" && fresh.manifest.ownerSessionId !== ctx.sessionId;
		if (foreignRun && !params.force)
			return result(
				`Run ${fresh.manifest.runId} belongs to another session. Use force: true to override.`,
				{
					action: "respond",
					status: "error",
					runId: fresh.manifest.runId,
				},
				true,
			);

		const taskId = params.taskId;
		const message = params.message ?? "";

		const targetTasks = taskId
			? fresh.tasks.filter((t) => t.id === taskId && t.status === "waiting")
			: fresh.tasks.filter((t) => t.status === "waiting");

		if (targetTasks.length === 0) {
			const existing = taskId ? fresh.tasks.find((t) => t.id === taskId) : undefined;
			const hint =
				" Use api operation=follow-up-agent for continuation prompts or api operation=steer-agent to interrupt active work.";
			return result(
				(taskId
					? existing
						? `Task '${taskId}' is ${existing.status}, not waiting.`
						: `Task '${taskId}' not found.`
					: `No waiting tasks in run ${fresh.manifest.runId}.`) + hint,
				{
					action: "respond",
					status: "error",
					runId: fresh.manifest.runId,
				},
				true,
			);
		}

		const mailboxIds: string[] = [];
		/** ALIVE parks: response delivered via the mailbox stream the parked ask tool polls. */
		const answeredIds: string[] = [];
		/** DEAD parks (and legacy no-question parks): re-queued for durable scheduler resume. */
		const requeuedIds: string[] = [];
		/** Exactly-once no-ops: a mailbox response already exists for the questionId. */
		const noopIds: string[] = [];
		const answeredEvents: Array<{ taskId: string; questionId: string; delivery: "mailbox" | "requeue" }> = [];
		let updatedTasks = fresh.tasks;

		for (const task of targetTasks) {
			const questionId = task.waiting?.questionId;
			if (!questionId) {
				// Legacy pre-v2 waiting park (no ask question): keep the old
				// mailbox + re-queue resume behavior verbatim.
				const mailbox = appendMailboxMessage(fresh.manifest, {
					direction: "inbox",
					from: "leader",
					to: task.id,
					taskId: task.id,
					body: message || "(resume)",
					kind: "response",
					priority: "normal",
					deliveryMode: "next_turn",
					data: { action: "respond", kind: "response" },
					replyTo: params.replyTo,
					replyFrom: params.replyFrom,
					replyDeadline: params.replyDeadline,
				});
				mailboxIds.push(mailbox.id);
				updatedTasks = requeueWaitingTask(updatedTasks, task.id, message);
				requeuedIds.push(task.id);
				continue;
			}
			// EXACTLY-ONE-DISPATCH GUARD (idempotent per questionId): if a
			// mailbox response for this questionId already exists, do nothing —
			// never write a second response and never requeue on top of it.
			// Atomic: the scan and the write below share this run-lock section.
			if (readMailbox(fresh.manifest, "inbox", task.id, "response").some((m) => m.questionId === questionId)) {
				noopIds.push(task.id);
				continue;
			}
			if (isWaitingWorkerAlive(task)) {
				// ALIVE: deliver via the task mailbox stream the parked ask tool
				// polls (≤500ms). The park stays — the tool's terminal report
				// flips waiting→running; root-side status must NOT change here.
				const mailbox = appendMailboxMessage(fresh.manifest, {
					direction: "inbox",
					from: "leader",
					to: task.id,
					taskId: task.id,
					body: message || "(resume)",
					kind: "response",
					priority: "normal",
					deliveryMode: "next_turn",
					questionId,
					data: { action: "respond", kind: "response", questionId },
					replyTo: params.replyTo,
					replyFrom: params.replyFrom,
					replyDeadline: params.replyDeadline,
				});
				mailboxIds.push(mailbox.id);
				answeredIds.push(task.id);
				answeredEvents.push({ taskId: task.id, questionId, delivery: "mailbox" });
				continue;
			}
			// DEAD: re-queue AND inject the fenced answer into the next dispatch
			// prompt. No questionId-tagged mailbox response is written — the
			// parked poller is gone; delivery rides the requeue instead.
			updatedTasks = requeueWaitingTask(updatedTasks, task.id, message, renderAskAnswer(questionId, message));
			requeuedIds.push(task.id);
			answeredEvents.push({ taskId: task.id, questionId, delivery: "requeue" });
		}

		// If this respond includes a replyTo, update the original message with reply metadata.
		if (params.replyTo) {
			updateMailboxMessageReply(fresh.manifest, params.replyTo, message || "(resume)");
		}

		let manifest = fresh.manifest;
		if (requeuedIds.length > 0) {
			saveRunTasks(fresh.manifest, updatedTasks);
			// WP-2 review round 1 (P3): clear manifest.waitState when its park was
			// requeued — mirror the broker's clearWaitState guard (taskId match),
			// else the stale pointer shields the run from staleness repair for
			// the full 24h TTL and leaves a stale marker in the manifest/UI.
			if (manifest.waitState && requeuedIds.includes(manifest.waitState.taskId)) {
				manifest = { ...manifest, waitState: undefined, updatedAt: new Date().toISOString() };
				saveRunManifest(manifest);
			}
			if (
				manifest.status === "blocked" ||
				manifest.status === "completed" ||
				manifest.status === "failed" ||
				manifest.status === "cancelled"
			) {
				manifest = updateRunStatus(manifest, "running", `Resumed ${requeuedIds.length} waiting task(s).`);
			}
		}
		// ask.answered on BOTH discrimination paths (ADR-0 item 8).
		for (const answered of answeredEvents) {
			// H1 (2026-08-10): handleRespond is a SYNC function inside a sync
			// run-lock callback — cannot await; fire-and-forget async.
			void appendEventAsync(manifest.eventsPath, {
				type: "ask.answered",
				runId: manifest.runId,
				taskId: answered.taskId,
				message: `Question ${answered.questionId} answered (${
					answered.delivery === "mailbox"
						? "worker alive — parked ask tool picks up the mailbox response"
						: "worker dead — task requeued with the answer injected"
				}).`,
				data: { questionId: answered.questionId, delivery: answered.delivery },
			}).catch((error) =>
				logInternalError(
					"respond.ask-answered-event",
					error instanceof Error ? error : new Error(String(error)),
					`runId=${manifest.runId}`,
				),
			);
		}
		for (const requeuedId of requeuedIds) {
			void appendEventAsync(manifest.eventsPath, {
				type: "task.resumed",
				runId: manifest.runId,
				taskId: requeuedId,
				message: message || "Task re-queued after respond.",
				data: { mailboxIds },
			}).catch((error) =>
				logInternalError(
					"respond.resumed-event",
					error instanceof Error ? error : new Error(String(error)),
					`runId=${manifest.runId}`,
				),
			);
		}
		if (requeuedIds.length > 0) {
			try {
				const existingRuntimes = new Map(readCrewAgents(fresh.manifest).map((a) => [a.taskId, a.runtime]));
				saveCrewAgents(
					fresh.manifest,
					updatedTasks
						.filter((task) => requeuedIds.includes(task.id))
						.map((task) => recordFromTask(fresh.manifest, task, existingRuntimes.get(task.id) ?? "child-process")),
				);
			} catch (error) {
				logInternalError("team-tool.handleRespond.crewAgents", error, `runId=${fresh.manifest.runId}`);
			}
		}

		const summaryParts: string[] = [];
		if (answeredIds.length > 0) summaryParts.push(`answered via mailbox (worker alive): ${answeredIds.join(", ")}`);
		if (requeuedIds.length > 0) summaryParts.push(`requeued with injected answer (worker dead): ${requeuedIds.join(", ")}`);
		if (noopIds.length > 0) summaryParts.push(`already answered, no-op: ${noopIds.join(", ")}`);
		return result(
			`Responded to ${targetTasks.length} waiting task(s). ${summaryParts.join("; ")}. Message: ${message || "(no message)"}`,
			{
				action: "respond",
				status: "ok",
				runId: fresh.manifest.runId,
				resumedIds: requeuedIds,
				mailboxIds,
				intent: `responding to ${targetTasks.map((t) => t.id).join(", ")} in ${fresh.manifest.runId}`,
				data: { answeredIds, noopIds },
			},
		);
	});
}
