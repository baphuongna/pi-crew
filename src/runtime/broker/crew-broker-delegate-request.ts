/**
 * crew-broker-delegate-request.ts — `delegate.request` broker handler
 *                                (governed-nesting grandchild spawn).
 *
 * Moved from crew-broker.ts:1459-1748 (wc-gate ITEM C, pure move, no
 * behavior change, 2026-10-27). Top-level free function so the class
 * method stays a 1-line delegation (same deps-object pattern as
 * protocol/wait-resolve.ts / protocol/msg-inbox.ts).
 *
 * Behavior contract (unchanged — ADR-5 §1-§12):
 *  - Auth: task-scoped token MANDATORY (worker role + compound auth
 *    match; ADR-5 pin iii) — plain run tokens are rejected `forbidden`.
 *  - Params parsed through the protocol parser (R7-H1: bad maxTurns /
 *    budgetTokens never reach admission or the slot reservation).
 *  - Capability gate `nestingEnabled` fail-closed (never silent —
 *    delegate.rejected recorded + typed `policy-disabled` frame).
 *  - Admission matrix (spawn-policy) evaluated under a bounded
 *    run-lock busy-retry (RR-023 F4) off a FRESH disk read; lock-busy
 *    degrades to a typed `busy` frame + delegate.rejected event, the
 *    connection SURVIVES. Nested slot is acquired INSIDE the lock
 *    (S1#1: no reserve-then-race refund window) and the grandchild
 *    token scopes to a subId minted BEFORE admission.
 *  - Budget reservation is pessimistic and seeds the parent allocation
 *    (M3-3/R43-N1); the reservation IS the spend (M3-4/R44-N4).
 *  - Grandchild SHADOW TASK registered in the same locked RMW (S1#1).
 *  - Responds IMMEDIATELY with `grandchildTaskRef` (principle 7: the
 *    tool self-polls the mailbox); the grandchild lifecycle runs in a
 *    background IIFE: abort-controller registered BEFORE the spawn
 *    (M3-5/R43-N3), parent-model inheritance (RR-023 F3), shadow
 *    queued→running promotion on live pid (RR-012 F16), end-fence
 *    neutralization before durable mailbox delivery + budget charge +
 *    shadow terminal flip (finalizeDelegateResult), abort + nested
 *    slot released in a `finally`, terminal delegate event recorded.
 *
 * Leaf-module imports ONLY — never import crew-broker.ts (no cycle).
 * Broker-owned collaborators (token registry, socket path, nested-slot
 * budget singleton, abort registry, send helpers, options slice) are
 * threaded through the explicit {@link DelegateRequestDeps} object.
 */

import { randomUUID } from "node:crypto";
import { loadRunManifestById, saveRunTasks } from "../../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import { type GrandchildSpawnResult, spawnDelegateGrandchild } from "../delegate-spawn.ts";
import { resolveCrewMaxDepth } from "../model/pi-args.ts";
import type { NestedSlotBudget } from "../scheduling/nested-slots.ts";
import { evaluateDelegateAdmission } from "../spawn-policy.ts";
import type { DelegateAbortRegistry } from "./delegate/delegate-abort.ts";
import type { DelegateEventTarget, DelegateEventType } from "./delegate/delegate-event.ts";
import { delegateTerminalEvent, finalizeDelegateResult } from "./delegate/delegate-finalize.ts";
import { promoteShadowToRunning } from "./delegate/shadow-lifecycle.ts";
import type { CrewBrokerOptions, ServerConnection } from "./protocol/connection-state.ts";
import type { LockBusyOutcome } from "./protocol/lock-busy.ts";
import { parseDelegateRequestParams } from "./protocol/request-parsers.ts";

/** Options slice the delegate handler reads off the broker's RESOLVED
 *  options (single source of truth: CrewBrokerOptions in
 *  protocol/connection-state.ts — field docs live there). */
export type DelegateRequestOptions = Pick<
	CrewBrokerOptions,
	| "cwd"
	| "nestingEnabled"
	| "nestingMaxDepth"
	| "nestingTrustedEscalation"
	| "serializeOnPathOverlap"
	| "lockBusyRetryDelaysMs"
	| "grandchildSpawner"
	| "modelCatalog"
>;

/** Broker-owned collaborators the moved handler needs. The broker binds
 *  these once per dispatch (see CrewBroker.handleDelegateRequest). */
export interface DelegateRequestDeps {
	sendError(conn: ServerConnection, id: string, code: string, message: string): void;
	sendResult(conn: ServerConnection, id: string, result: unknown): void;
	/** Resolved broker options (cwd + nesting gates + spawner/catalog seams). */
	options: DelegateRequestOptions;
	/** ADR-5 §5: lazy nested-slot budget singleton (broker owns sizing). */
	nestedSlotBudget(): NestedSlotBudget;
	/** Delegate event recorder (delegate-event.ts passthrough — never silent). */
	recordDelegateEvent(manifest: DelegateEventTarget, type: DelegateEventType, taskId: string, data: Record<string, unknown>): void;
	/** RR-023 F4: bounded busy-retry around a run-locked RMW (protocol/lock-busy.ts). */
	runLockBusyRetry<T>(manifest: TeamRunManifest, fn: () => T): Promise<LockBusyOutcome<T>>;
	/** M3-5/R43-N3: broker-owned grandchild abort registry (run-terminal + stop). */
	delegateAborts: DelegateAbortRegistry;
	/** Resolved socket path (broker getter) — threaded into grandchild creds. */
	socketPath: string;
	/** Mint a fresh grandchild-scoped run token (S1#1 pre-mint; heap-only). */
	issueRunToken(runId: string, taskId: string): string;
}

export async function handleDelegateRequest(conn: ServerConnection, id: string, params: unknown, deps: DelegateRequestDeps): Promise<void> {
	// Auth: task-scoped token MANDATORY (ADR-5 pin iii) — same rule as wait.*.
	if (!conn.runId || !conn.taskId) {
		deps.sendError(conn, id, "auth", "not authed");
		return;
	}
	if (conn.role !== "worker" || conn.authMatchKind !== "compound") {
		deps.sendError(conn, id, "forbidden", "delegate requires a task-scoped token; re-dispatch with PI_CREW_BROKER_TASK_ID");
		return;
	}
	// R7-H1 fix: parse params through the protocol-level parser (mirrors
	// parseWaitRequestParams discipline) — non-integer/non-finite/negative/
	// over-ceiling maxTurns/budgetTokens never reach admission or the
	// budget reservation (durable-negative tokensSpent escape).
	const parsed = parseDelegateRequestParams(params);
	if (!parsed) {
		deps.sendError(conn, id, "bad-params", "delegate.request: invalid params");
		return;
	}
	const requested = parsed;
	const cwd = deps.options.cwd;
	if (!cwd) {
		deps.sendError(conn, id, "no-manifest", "broker has no cwd configured");
		return;
	}
	let loaded: NonNullable<ReturnType<typeof loadRunManifestById>>;
	try {
		const l = loadRunManifestById(cwd, conn.runId);
		if (!l) {
			deps.sendError(conn, id, "no-manifest", `run '${conn.runId}' not found`);
			return;
		}
		loaded = l;
	} catch (err) {
		deps.sendError(conn, id, "no-manifest", (err as Error).message);
		return;
	}
	// Capability gate (ADR-5 §10): fail-closed, NEVER silent. Since the D8
	// flip the DEFAULT is true, so reaching this branch means the user
	// closed the surface via config — the message points back at the knob.
	if (deps.options.nestingEnabled !== true) {
		deps.recordDelegateEvent(loaded.manifest, "delegate.rejected", conn.taskId, {
			reason: "nesting-disabled",
			policy: "nesting.enabled=false (user config; default is true since D8)",
		});
		deps.sendError(
			conn,
			id,
			"policy-disabled",
			"delegate is disabled: nesting.enabled=false (set nesting.enabled=true in user config; delegate.rejected recorded in events.jsonl)",
		);
		return;
	}
	const runId = conn.runId;
	const parentTaskId = conn.taskId;
	// S1#1 fix (security round 1): the subId is minted BEFORE admission so the
	// grandchild token scopes to the SUBID (never the parent task key) and the
	// nested slot is acquired INSIDE the same lock as the admission snapshot.
	const subId = `gc-${randomUUID()}`;
	deps.recordDelegateEvent(loaded.manifest, "delegate.requested", parentTaskId, { subId, role: requested.role ?? "explorer" });
	// Admission: full spawn-policy matrix (ADR-5 §2-§7), parent state from
	// the RECORD under the run lock — never the worker's env/self-report.
	// RR-023 F4: run-locked via bounded busy-retry (protocol/lock-busy.ts).
	const admissionAttempt = await deps.runLockBusyRetry(loaded.manifest, () => {
		const fresh = loadRunManifestById(loaded.manifest.cwd, runId);
		if (!fresh) return { code: "no-manifest" as const, message: `run '${runId}' not found` };
		const task = fresh.tasks.find((t) => t.id === parentTaskId);
		if (!task) {
			deps.recordDelegateEvent(fresh.manifest, "delegate.rejected", parentTaskId, { subId, reason: "no-task" });
			return { code: "no-task" as const, message: `task '${parentTaskId}' not found` };
		}
		if (task.status !== "running") {
			deps.recordDelegateEvent(fresh.manifest, "delegate.rejected", parentTaskId, {
				subId,
				reason: "parent-not-running",
				message: `task is ${task.status}`,
			});
			return { code: "bad-params" as const, message: `delegate: parent task '${parentTaskId}' is ${task.status}, not running` };
		}
		// RR-012 F03: authoritative execution cwd = the parent task's cwd from
		// this locked fresh read — ONE source for overlap check, shadow record
		// and spawner input; broker cwd stays for manifest lookup only.
		const executionCwd = task.cwd;
		const catalog = deps.options.modelCatalog?.();
		// S3 fail-closed: a DEFINED loader yielding undefined is a loader failure.
		const effectiveCatalog = deps.options.modelCatalog !== undefined ? (catalog ?? []) : undefined;
		// ADR-5 §9: count OTHER in-flight executor-class tasks sharing the
		// parent task's cwd (manifest record — single source of truth).
		const overlapping = fresh.tasks.filter(
			(t) =>
				t.id !== parentTaskId &&
				t.status === "running" &&
				(t.role === "executor" || t.role === "test-engineer") &&
				t.cwd === executionCwd,
		).length;
		const decision = evaluateDelegateAdmission({
			maxDepth: deps.options.nestingMaxDepth ?? resolveCrewMaxDepth(undefined), // config knob > env-clamped 1..10, default 4 (D8; ADR-5 §3)
			parentTask: {
				taskId: parentTaskId,
				role: task.role,
				...(task.depth !== undefined ? { depth: task.depth } : {}),
				...(task.allocation !== undefined ? { allocation: task.allocation } : {}),
			},
			slots: deps.nestedSlotBudget().snapshot(),
			requested,
			...(effectiveCatalog !== undefined ? { modelCatalog: effectiveCatalog } : {}),
			// ADR-5 §12: the delegate surface is an escalation — trusted only by the
			// explicit user opt-in threaded from config.nesting.enabled (sensitive).
			untrusted: deps.options.nestingTrustedEscalation !== true,
			// M3-3 / R43-N1 SEED: the run-level token budget is the grant every
			// task inherits when its own record carries no allocation (pre-fix
			// state of EVERY task — nothing produced `tokensGranted`, so every
			// budgeted delegate was denied and every unmetered one slipped by).
			// `budgetUnlimited` opts out of enforcement entirely ⇒ no seed.
			...(fresh.manifest.budgetTotal !== undefined && fresh.manifest.budgetUnlimited !== true
				? { parentBudgetGrantTokens: fresh.manifest.budgetTotal }
				: {}),
			// M3-3 / R43-N1: unmetered delegation stays available (documented
			// pre-fix behavior for nesting runs without a budgetTotal) but is now
			// an EXPLICIT, audited allow (`unmetered: true` on delegate.admitted).
			unmeteredDelegates: "allow",
			workspace: {
				serializeEnabled: deps.options.serializeOnPathOverlap === true,
				overlappingInFlightExecutors: overlapping,
			},
		});
		if (!decision.allowed) {
			deps.recordDelegateEvent(fresh.manifest, "delegate.rejected", parentTaskId, {
				subId,
				reason: decision.reason,
				message: (decision.message ?? "").slice(0, 120),
			});
			return { code: "policy-denied" as const, message: decision.message ?? decision.reason ?? "delegate denied" };
		}
		// Slot acquisition INSIDE the lock (no reserve-then-race refund window).
		if (!deps.nestedSlotBudget().tryAcquire(subId)) {
			deps.recordDelegateEvent(fresh.manifest, "delegate.rejected", parentTaskId, { subId, reason: "slots-exhausted" });
			return {
				code: "policy-denied" as const,
				message: `delegate rejected: nested spawn budget exhausted; ${deps.nestedSlotBudget().statusLine}`,
			};
		}
		// Reserve the requested budget pessimistically (ADR-5 §5): tokensSpent
		// += budgetTokens now. M3-3/R43-N1: the reservation ALSO seeds the parent
		// allocation when the record has none — the `decision.budget.grantedTokens`
		// the gate admitted against is the write-once `tokensGranted`
		// (state-helpers.ts merge keeps disk's value verbatim). Pre-fix the
		// `parentAllocation` guard silently skipped the reserve for every task
		// that had no allocation, i.e. for every task.
		// M3-4/R44-N4: this reservation IS the spend — no settle-time refund.
		let reserved = 0;
		const budgetDecision = decision.budget;
		let tasksAfterReserve = fresh.tasks;
		if (budgetDecision?.metered === true) {
			reserved = budgetDecision.requestedTokens ?? 0;
			const updatedTasks = fresh.tasks.map((t) =>
				t.id === parentTaskId
					? {
							...t,
							allocation: {
								tokensGranted: budgetDecision.grantedTokens,
								tokensSpent: budgetDecision.spentTokens + reserved,
							},
						}
					: t,
			);
			tasksAfterReserve = updatedTasks;
			saveRunTasks(fresh.manifest, updatedTasks);
		}
		// S1#1: register the grandchild SHADOW TASK — the subId identity gets a
		// real depth/role entry (unbounded-chain fix). Built on tasksAfterReserve
		// so the budget reservation above is never clobbered.
		saveRunTasks(fresh.manifest, [
			...tasksAfterReserve,
			{
				id: subId,
				runId,
				role: requested.role ?? "explorer",
				agent: "delegate",
				title: `delegate: ${(requested as { description?: string }).description ?? subId}`,
				status: "queued",
				cwd: executionCwd,
				dependsOn: [],
				depth: decision.childDepth ?? 2,
				startedAt: new Date().toISOString(),
			} satisfies TeamTaskState,
		]);
		// RR-023 F3: thread the parent's model out of the locked read (gc fallback).
		return { code: "ok" as const, decision, reserved, executionCwd, parentModel: task.model, parentRole: task.role };
	});
	// RR-023 F4 (finding #4): run.lock held by a live cross-process holder —
	// degrade to a typed busy frame AND a delegate.rejected event (never
	// silent); the connection survives (ping still answers).
	if (!admissionAttempt.ok) {
		deps.recordDelegateEvent(loaded.manifest, "delegate.rejected", parentTaskId, { subId, reason: "run-lock-busy" });
		deps.sendError(conn, id, "busy", admissionAttempt.message);
		return;
	}
	const admissionOutcome = admissionAttempt.value;
	if (admissionOutcome.code !== "ok") {
		deps.sendError(conn, id, admissionOutcome.code, admissionOutcome.message);
		return;
	}
	const { decision, reserved, executionCwd, parentModel, parentRole } = admissionOutcome;
	deps.recordDelegateEvent(loaded.manifest, "delegate.admitted", parentTaskId, {
		subId,
		childDepth: decision.childDepth,
		role: requested.role ?? "explorer",
		// M3-3/R43-N1: an unmetered allow is EXPLICIT in the audit trail.
		...(decision.budget?.metered === false ? { unmetered: true } : {}),
		...(reserved > 0 ? { reservedTokens: reserved } : {}),
	});
	// S1#1: pre-mint the grandchild-scoped token when (and only when) the
	// child may itself delegate (childDepth < resolved maxDepth — the same
	// gate as issueForChild). Depth-2 at default maxDepth gets NO creds.
	const grandchildCreds =
		(decision.childDepth ?? 2) < (deps.options.nestingMaxDepth ?? resolveCrewMaxDepth(undefined))
			? { socketPath: deps.socketPath, token: deps.issueRunToken(runId, subId) }
			: undefined;
	// Return IMMEDIATELY (principle 7): the tool self-polls the mailbox.
	deps.sendResult(conn, id, { ok: true, grandchildTaskRef: subId, childDepth: decision.childDepth, timeoutSec: decision.timeoutSec });
	// RR-023 F3 (finding #3, run team_20260929041427): model-less gc spawn fell
	// through to the pi GLOBAL default — inherit the parent task's model.
	const gcModel = requested.model ?? parentModel;
	// M3-5/R43-N3: register the grandchild's abort controller BEFORE the
	// spawn starts, so a run terminalise / budget abort / broker stop that
	// lands mid-spawn still cancels it (no orphan outliving the run).
	const delegateAbort = deps.delegateAborts.register(subId, runId);
	// Background grandchild lifecycle (ADR-5 §1/§6).
	const spawner = deps.options.grandchildSpawner ?? spawnDelegateGrandchild;
	void (async () => {
		let outcome: GrandchildSpawnResult;
		try {
			outcome = await spawner({
				cwd: executionCwd,
				runId,
				parentTaskId,
				// R43-S1: transitive tier containment — the spawner applies
				// min(parentRole, requestedRole) as the grandchild tool policy.
				parentRole,
				subId,
				prompt: requested.prompt,
				eventsPath: loaded.manifest.eventsPath,
				role: requested.role ?? "explorer",
				...(grandchildCreds ? { brokerSpawn: grandchildCreds } : {}),
				...(gcModel !== undefined ? { model: gcModel } : {}),
				...(requested.maxTurns !== undefined ? { maxTurns: requested.maxTurns } : {}),
				timeoutSec: decision.timeoutSec ?? 900,
				depthOverride: decision.childDepth ?? 2,
				// M3-5/R43-N3: owner cancellation (registry-driven).
				signal: delegateAbort.signal,
				// RR-012 F16: promote shadow queued→running once the process exists.
				onSpawn: (pid) => {
					if (pid !== null) promoteShadowToRunning(cwd, runId, subId);
				},
			});
		} catch (err) {
			outcome = { ok: false, resultText: `delegate spawn failed: ${(err as Error).message}` };
		}
		try {
			// S3 fence hardening: neutralize smuggled end-fence markers in the
			// grandchild's raw text, then wrap (the client re-fences too — the
			// mailbox is an unauthenticated same-uid channel by design).
			const sanitizedText = outcome.resultText.replace(/^--- (end )?delegate /gm, "-- ~delegate ").slice(0, 65_536);
			const statusTag = outcome.cancelled ? "(cancelled)" : outcome.timedOut ? "(timed out)" : outcome.ok ? "(ok)" : "(failed)";
			const fenced = `--- delegate ${subId} ${statusTag} ---\n${sanitizedText}\n--- end delegate ${subId} ---`;
			// Durable delivery + budget charge + shadow terminal flip — all
			// inside one run lock, off a fresh disk read (delegate-finalize.ts
			// owns the R43-N4 reroute and the R44-N4 broker-side charge).
			finalizeDelegateResult({
				brokerCwd: cwd,
				runId,
				parentTaskId,
				subId,
				fenced,
				ok: outcome.ok,
				...(outcome.timedOut !== undefined ? { timedOut: outcome.timedOut } : {}),
				reservedTokens: reserved,
				...(outcome.usageTokens !== undefined ? { selfReportedTokens: outcome.usageTokens } : {}),
			});
		} finally {
			deps.delegateAborts.release(subId);
			deps.nestedSlotBudget().release(subId);
		}
		deps.recordDelegateEvent(loaded.manifest, delegateTerminalEvent(outcome), parentTaskId, {
			subId,
			ok: outcome.ok,
		});
	})();
}
