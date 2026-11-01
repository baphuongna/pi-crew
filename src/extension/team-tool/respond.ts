import { renderAskAnswer } from "../../prompt/prompt-runtime.ts";
import { repointWaitState } from "../../runtime/broker/protocol/wait-resolve.ts";
import { readCrewAgents, recordFromTask, saveCrewAgents } from "../../runtime/crew-agent-records.ts";
import { isWaitingWorkerAlive } from "../../runtime/dispatch-batch.ts";
import { checkProcessLiveness } from "../../runtime/process-status.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { withRunLockSync } from "../../state/coordination/locks.ts";
import { appendMailboxMessage, readMailbox, updateMailboxMessageReply } from "../../state/coordination/mailbox.ts";
import { appendEventAsync } from "../../state/event-log/event-log.ts";
import { loadRunManifestById, saveRunManifest, saveRunTasks, updateRunStatus } from "../../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { locateRunCwd } from "../team-tool.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { result, type TeamContext } from "./context.ts";
import { paramRequired } from "./param-error.ts";
import { deliverResponseRow, type RespondDeliveryRow } from "./respond-delivery.ts";
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

/** Lock-section product for handleRespond: either an early error result, or
 *  the full post-lock context. HƯỚNG A (2026-11-01): ALIVE-park response rows
 *  are STAGED inside the run lock (atomically with the exactly-one-dispatch
 *  scan) but DELIVERED after it releases — deliverResponseRow's broker RPC
 *  window must never sit under withRunLockSync (the broker handler takes its
 *  own run lock via withRunLockBusyRetry; an in-lock RPC window would
 *  livelock cross-process). */
type LockedRespondOutcome =
	| { ok: false; early: PiTeamsToolResult }
	| {
			ok: true;
			manifest: TeamRunManifest;
			targetTaskIds: string[];
			answeredIds: string[];
			requeuedIds: string[];
			noopIds: string[];
			mailboxIds: string[];
			pendingDeliveries: RespondDeliveryRow[];
			message: string;
	  };

/**
 * Handle `respond` action: answer a waiting (parked) task's question.
 *
 * WP-2/R2 (ADR-0 docs/decisions/2026-08-17-waiting-producer-ask.md item 8):
 * liveness discrimination replaces the old blanket re-queue of ALL waiting
 * tasks.
 * - ALIVE (heartbeat last-beat within the 60s gradient-stale window, or a
 *   live in-memory session handle) → stage a mailbox `kind:"response"`
 *   entry carrying the task's `waiting.questionId` (from leader, to the task)
 *   and LEAVE `task.waiting` in place: the parked `ask` tool polls the task
 *   mailbox stream, picks the response up and flips waiting→running via its
 *   own terminal report. HƯỚNG A: the staged row is delivered AFTER the run
 *   lock releases via deliverResponseRow (broker-first CR path → a
 *   BROKER-SIGNED row that verifies in the worker even when this responder
 *   is not the dispatch process; local signed append fallback = hướng C).
 * - DEAD → re-queue the task AND inject the fenced answer into the next
 *   dispatch prompt (pendingSteers cross-attempt channel). No questionId-
 *   tagged mailbox response is written.
 * - EXACTLY-ONE-DISPATCH GUARD: a response for a given questionId dispatches
 *   via mailbox-write OR requeue+inject — never both — and is idempotent per
 *   questionId. The branch decision is atomic under the run lock (check +
 *   staging inside one withRunLockSync + fresh-reload critical section); the
 *   requeue path clears `waiting` so a second respond finds no waiting task
 *   (no-op), and the out-of-lock row write is exactly-once via the durable
 *   requestId = questionId idempotency key (broker append AND local fallback
 *   both dedupe on it — a concurrent second respond that missed the in-lock
 *   scan reuses the first row instead of duplicating it).
 * - Legacy waiting parks without `task.waiting` (pre-v2 records) keep the old
 *   mailbox + re-queue resume behavior — there is no parked tool to pick a
 *   questionId-tagged response up (no questionId → no broker contract row;
 *   the legacy append stays inline/local, verbatim).
 * - `ask.answered` is emitted on both discrimination paths.
 */
export async function handleRespond(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
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

	const locked = withRunLockSync(loaded.manifest, (): LockedRespondOutcome => {
		const fresh = loadRunManifestById(loaded.manifest.cwd, params.runId!); // NOTE: inside withRunLockSync - consistent read
		if (!fresh)
			return {
				ok: false,
				early: result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "respond", status: "error" }, true),
			};
		const foreignRun = typeof fresh.manifest.ownerSessionId === "string" && fresh.manifest.ownerSessionId !== ctx.sessionId;
		if (foreignRun && !params.force)
			return {
				ok: false,
				early: result(
					`Run ${fresh.manifest.runId} belongs to another session. Use force: true to override.`,
					{
						action: "respond",
						status: "error",
						runId: fresh.manifest.runId,
					},
					true,
				),
			};

		const taskId = params.taskId;
		const message = params.message ?? "";

		let tasks = fresh.tasks;
		let targetTasks = taskId
			? fresh.tasks.filter((t) => t.id === taskId && t.status === "waiting")
			: fresh.tasks.filter((t) => t.status === "waiting");

		if (targetTasks.length === 0) {
			// ASK-PARK CLOBBER SELF-HEAL (2026-10-31, live incidents team_20261031084714
			// + team_20261031045633): the HOST process's coalesced tasks.json flush can
			// race the BROKER process's run-locked sync waiting-park (the coalesce
			// buffer is per-process, so the broker's write cannot cancel it) and blind-
			// flush a pre-park `running` snapshot over `waiting` — losing BOTH the
			// status and the questionId marker. Every subsequent respond then hit the
			// reject below ("is running, not waiting") and every ask timed out.
			// The broker's manifest.waitState pointer survives the clobber (manifest.json
			// is not coalesced), so it is the authoritative repair source: when it is
			// still live while tasks.json lost the park, restore `waiting` + marker
			// from it inside the SAME run-lock section, then let the normal answer
			// machinery below run verbatim. Fix 1 (atomic-write flush-time CAS) closes
			// the root cause; this is the defense-in-depth backstop.
			const waitState = fresh.manifest.waitState;
			if (waitState && typeof waitState.deadline === "number" && waitState.deadline > Date.now()) {
				// Narrowed const - the typeof guard on the property does not survive
				// into the map callback below.
				const waitDeadline = waitState.deadline;
				const parked = fresh.tasks.find((t) => t.id === waitState.taskId);
				if (
					parked &&
					parked.status === "running" &&
					(parked.waiting === undefined || parked.waiting.questionId !== waitState.questionId)
				) {
					tasks = fresh.tasks.map((t) =>
						t.id === waitState.taskId
							? {
									...t,
									status: "waiting" as const,
									waiting: {
										questionId: waitState.questionId,
										askedAt: waitState.askedAt,
										deadline: waitDeadline,
									},
								}
							: t,
					);
					// Sync save inside the SAME run-lock critical section — also cancels
					// any same-process pending coalesced tasks.json write (stale
					// snapshot) before it can clobber the repair.
					saveRunTasks(fresh.manifest, tasks);
					void appendEventAsync(fresh.manifest.eventsPath, {
						type: "task.waiting_repaired",
						runId: fresh.manifest.runId,
						taskId: waitState.taskId,
						message: `Repaired clobbered ask park for question ${waitState.questionId}: tasks.json showed the parked task running with no waiting marker (host coalesced-flush raced the broker park); waiting restored from manifest.waitState so the answer path could run.`,
						data: { taskId: waitState.taskId, questionId: waitState.questionId, reason: "coalesce-clobber" },
					}).catch((error) =>
						logInternalError(
							"respond.waiting-repaired-event",
							error instanceof Error ? error : new Error(String(error)),
							`runId=${fresh.manifest.runId}`,
						),
					);
					targetTasks = taskId
						? tasks.filter((t) => t.id === taskId && t.status === "waiting")
						: tasks.filter((t) => t.status === "waiting");
				}
			}
		}

		if (targetTasks.length === 0) {
			const existing = taskId ? fresh.tasks.find((t) => t.id === taskId) : undefined;
			const hint =
				" Use api operation=follow-up-agent for continuation prompts or api operation=steer-agent to interrupt active work.";
			return {
				ok: false,
				early: result(
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
				),
			};
		}

		const mailboxIds: string[] = [];
		/** ALIVE parks: response delivered via the mailbox stream the parked ask tool polls. */
		const answeredIds: string[] = [];
		/** DEAD parks (and legacy no-question parks): re-queued for durable scheduler resume. */
		const requeuedIds: string[] = [];
		/** Exactly-once no-ops: a mailbox response already exists for the questionId. */
		const noopIds: string[] = [];
		/** HƯỚNG A (2026-11-01): ALIVE-park response rows staged IN-LOCK (atomic
		 *  with the exactly-one-dispatch scan above) for post-lock delivery via
		 *  deliverResponseRow — broker-first CR path / local signed fallback. The
		 *  durable requestId = questionId key keeps the out-of-lock write
		 *  exactly-once. */
		const pendingDeliveries: RespondDeliveryRow[] = [];
		const answeredEvents: Array<{ taskId: string; questionId: string; delivery: "mailbox" | "requeue" }> = [];
		/** G5 (deep-review 2026-10-01): DEAD parks — the questionId-tagged response
		 *  can never be picked up (the parked poller is gone); recorded with the
		 *  liveness pid evidence so the leader sees the respond fell into the void.
		 *  Twin of the broker-side task.respond_delivered ack. */
		const missedEvents: Array<{
			taskId: string;
			questionId: string;
			workerPid: number | undefined;
			pidAlive: boolean;
			pidDetail: string;
		}> = [];
		let updatedTasks = tasks;

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
				// HƯỚNG A (2026-11-01): the row is no longer appended inline. It is
				// staged here — inside the run lock, atomically with the
				// exactly-one-dispatch scan — and delivered AFTER the lock releases
				// via deliverResponseRow (broker-first CR path → a BROKER-SIGNED row
				// that verifies in the worker even when this responder is not the
				// dispatch process; local signed append fallback = hướng C behavior).
				// Holding withRunLockSync across the RPC window would livelock
				// against the broker handler's own run lock (withRunLockBusyRetry);
				// exactly-once moves to the durable requestId = questionId key.
				pendingDeliveries.push({
					direction: "inbox",
					from: "leader",
					to: task.id,
					taskId: task.id,
					body: message || "(resume)",
					kind: "response",
					priority: "normal",
					deliveryMode: "next_turn",
					questionId,
					requestId: questionId,
					data: { action: "respond", kind: "response", questionId },
					replyTo: params.replyTo,
					replyFrom: params.replyFrom,
					replyDeadline: params.replyDeadline,
				});
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
			// G5: liveness evidence for respond_missed — the same pid source + probe
			// the stale-reconciler / heartbeat-watcher use (heartbeat pid, fallback
			// checkpoint childPid, then process.kill(pid,0) via checkProcessLiveness).
			// A live pid here (stale heartbeat but process alive) is still recorded
			// verbatim — the discriminator already ruled DEAD for delivery; the event
			// reports what the pid probe saw, it does not re-decide the branch.
			const missedPid = task.heartbeat?.pid ?? task.checkpoint?.childPid;
			const liveness = checkProcessLiveness(missedPid);
			missedEvents.push({
				taskId: task.id,
				questionId,
				workerPid: missedPid,
				pidAlive: liveness.alive,
				pidDetail: liveness.detail,
			});
		}

		// If this respond includes a replyTo, update the original message with reply metadata.
		if (params.replyTo) {
			updateMailboxMessageReply(fresh.manifest, params.replyTo, message || "(resume)");
		}

		let manifest = fresh.manifest;
		if (requeuedIds.length > 0) {
			saveRunTasks(fresh.manifest, updatedTasks);
			// WP-2 review round 1 (P3) + M4-R1(b) (fix-wave 6 residual): when the slot
			// pointed at a REQUEUED park, scoped-forget it — but never by blind
			// clearing. Another task may still be parked and this single slot is the
			// only thing shielding it (isWaitAnswerPending reads just this field), so
			// re-point it at the surviving park (latest deadline wins, mirroring
			// wait.resolve's repointedWaitState); it is cleared only when this was
			// the last live park. The clear remains the correct outcome there — the
			// pre-fix guard left the stale pointer shielding the run for the full
			// 24h TTL with a stale marker in the manifest/UI.
			if (manifest.waitState && requeuedIds.includes(manifest.waitState.taskId)) {
				const waitState = repointWaitState(updatedTasks, manifest.waitState, (candidateId) => requeuedIds.includes(candidateId));
				manifest = { ...manifest, waitState, updatedAt: new Date().toISOString() };
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
		// G5 (deep-review 2026-10-01): respond_missed — the DEAD-branch twin of
		// the broker's respond_delivered ack. Same H1 fire-and-forget discipline
		// (sync run-lock callback, never await/block); carries the questionId and
		// the pid/liveness evidence the discrimination was based on.
		for (const missed of missedEvents) {
			void appendEventAsync(manifest.eventsPath, {
				type: "task.respond_missed",
				runId: manifest.runId,
				taskId: missed.taskId,
				message: `Leader respond missed: worker for question ${missed.questionId} is not alive to receive the mailbox response (pid ${
					missed.workerPid ?? "none recorded"
				}: ${missed.pidDetail}); delivery rides the requeue+inject path.`,
				data: {
					questionId: missed.questionId,
					...(missed.workerPid !== undefined ? { workerPid: missed.workerPid } : {}),
					pidAlive: missed.pidAlive,
					pidDetail: missed.pidDetail,
					delivery: "requeue",
				},
			}).catch((error) =>
				logInternalError(
					"respond.respond-missed-event",
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
				// R4-A1 (fix): merge requeued records into the existing index — the
				// subset-only save wiped sibling agent records (team-runner.ts:525 pattern).
				const mergedById = new Map(readCrewAgents(fresh.manifest).map((record) => [record.id, record] as const));
				for (const task of updatedTasks.filter((task) => requeuedIds.includes(task.id))) {
					const record = recordFromTask(fresh.manifest, task, existingRuntimes.get(task.id) ?? "child-process");
					mergedById.set(record.id, record);
				}
				saveCrewAgents(fresh.manifest, [...mergedById.values()]);
			} catch (error) {
				logInternalError("team-tool.handleRespond.crewAgents", error, `runId=${fresh.manifest.runId}`);
			}
		}

		// HƯỚNG A (2026-11-01): ALIVE rows are staged, not appended — the lock
		// section returns the context and delivery happens after the release
		// (see deliverResponseRow). task.resumed events above snapshot
		// `mailboxIds` at fire time (in-lock), so their data lists the legacy
		// inline ids only — informational field, the ALIVE ids land in the tool
		// result below.
		return {
			ok: true,
			manifest,
			targetTaskIds: targetTasks.map((t) => t.id),
			answeredIds,
			requeuedIds,
			noopIds,
			mailboxIds,
			pendingDeliveries,
			message,
		};
	});
	if (!locked.ok) return locked.early;
	// Deliver the staged ALIVE rows OUTSIDE the run lock — broker-first CR
	// path (broker-SIGNED row, verifies in the worker regardless of who the
	// responder process is) with the local signed idempotent append as
	// fallback (hướng C). deliverResponseRow never throws on broker failure;
	// a local append failure propagates exactly like the pre-hướng-A inline
	// append did.
	for (const row of locked.pendingDeliveries) {
		const delivered = await deliverResponseRow(locked.manifest, row);
		locked.mailboxIds.push(delivered.messageId);
	}
	const summaryParts: string[] = [];
	if (locked.answeredIds.length > 0) summaryParts.push(`answered via mailbox (worker alive): ${locked.answeredIds.join(", ")}`);
	if (locked.requeuedIds.length > 0) summaryParts.push(`requeued with injected answer (worker dead): ${locked.requeuedIds.join(", ")}`);
	if (locked.noopIds.length > 0) summaryParts.push(`already answered, no-op: ${locked.noopIds.join(", ")}`);
	return result(
		`Responded to ${locked.targetTaskIds.length} waiting task(s). ${summaryParts.join("; ")}. Message: ${
			locked.message || "(no message)"
		}`,
		{
			action: "respond",
			status: "ok",
			runId: locked.manifest.runId,
			resumedIds: locked.requeuedIds,
			mailboxIds: locked.mailboxIds,
			intent: `responding to ${locked.targetTaskIds.join(", ")} in ${locked.manifest.runId}`,
			data: { answeredIds: locked.answeredIds, noopIds: locked.noopIds },
		},
	);
}
