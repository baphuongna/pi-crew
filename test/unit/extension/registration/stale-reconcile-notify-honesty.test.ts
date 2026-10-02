/**
 * NEW-2 (SDD-4 follow-up, P3 review MAJOR 1) — session-start stale-reconcile
 * notify HONESTY.
 *
 * The session_start deferred cleanup notified on ANY non-empty reconcile
 * result list — including verdicts that repaired NOTHING
 * (blocked_awaiting_approval / waiting_answer / result_exists) — with the
 * fixed text "Found and repaired ghost runs from previous sessions".
 * Observed live 2026-09-29: 77 dishonest notifies/day, ~3x per runId,
 * repeating on every session start because non-repaired runs stay
 * reconcileable forever (their disk state never changes).
 *
 * Pins (RED-first at 6cdd4ac8):
 *   (b) a reconcile that repaired NOTHING must produce ZERO stale-notify
 *   (a) a mixed reconcile (1 non-repaired + 1 repaired) must notify ONLY the
 *       repaired run, with a title that says "Repaired" — never claim a
 *       repair that did not happen
 *
 * Drives the REAL session_start handler (same harness as
 * preload-idle-render.test.ts) with the REAL reconcileAllStaleRuns over
 * on-disk fixtures in a throwaway PI_CREW_HOME + project cwd:
 *   run-blocked-apprv — status "blocked" + planApproval pending → verdict
 *                       blocked_awaiting_approval, repaired:false
 *   run-dead-async    — status "running", async.pid points at a pid beyond
 *                       pid_max (guaranteed dead) → verdict pid_dead,
 *                       repaired:true
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildRegistrationContext } from "../../../../src/extension/registration/context-builder.ts";
import { importCrashRecovery, purgeStaleActiveRunIndexSyncIfLoaded } from "../../../../src/extension/registration/crash-recovery-cache.ts";
import { installLazyConfigurers } from "../../../../src/extension/registration/lazy-configurers.ts";
import { installSessionLifecycleHandlers } from "../../../../src/extension/registration/lifecycle-handlers.ts";
import { installRuntimeCleanup } from "../../../../src/extension/registration/runtime-cleanup.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function createEventBus() {
	const handlers = new Map<string, Set<(payload: unknown) => void>>();
	return {
		on(event: string, handler: (payload: unknown) => void) {
			const set = handlers.get(event) ?? new Set<(payload: unknown) => void>();
			set.add(handler);
			handlers.set(event, set);
			return () => {
				set.delete(handler);
			};
		},
		emit(event: string, payload: unknown) {
			for (const handler of handlers.get(event) ?? []) handler(payload);
		},
	};
}

function createFakePi(events: ReturnType<typeof createEventBus>) {
	const lifecycle = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
	return {
		events,
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			const handlers = lifecycle.get(event) ?? [];
			handlers.push(handler);
			lifecycle.set(event, handlers);
		},
		emitLifecycle(event: string, ctx: unknown, payload: unknown = {}) {
			for (const handler of [...(lifecycle.get(event) ?? [])]) handler(payload, ctx);
		},
		sendMessage() {
			/* no-op */
		},
		registerCommand() {
			/* no-op */
		},
		registerTool() {
			/* no-op */
		},
		appendEntry() {
			/* no-op */
		},
		getSessionName() {
			return undefined;
		},
		setSessionName() {
			/* no-op */
		},
	};
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForQuiet(sample: () => unknown, stableMs: number, deadlineMs = stableMs + 500): Promise<boolean> {
	const start = Date.now();
	const deadline = start + deadlineMs;
	let last = sample();
	let lastChange = start;
	while (Date.now() < deadline) {
		await sleep(25);
		const current = sample();
		if (!Object.is(current, last)) {
			last = current;
			lastChange = Date.now();
		}
		if (Date.now() - lastChange >= stableMs) return true;
	}
	return Date.now() - lastChange >= stableMs;
}

/** A pid beyond /proc/sys/kernel/pid_max can never exist — guaranteed-dead. */
function guaranteedDeadPid(): number {
	try {
		const pidMax = Number.parseInt(fs.readFileSync("/proc/sys/kernel/pid_max", "utf-8").trim(), 10);
		if (Number.isFinite(pidMax) && pidMax > 0) return pidMax + 7;
	} catch {
		/* non-Linux fallback below */
	}
	return 4_194_311;
}

interface FixtureRun {
	runId: string;
	status: "running" | "blocked";
	planApprovalPending?: boolean;
	asyncPid?: number;
}

function writeFixtureRun(cwd: string, fixture: FixtureRun): void {
	const stateRoot = path.join(cwd, ".crew", "state", "runs", fixture.runId);
	const artifactsRoot = path.join(cwd, ".crew", "artifacts", fixture.runId);
	fs.mkdirSync(stateRoot, { recursive: true });
	fs.mkdirSync(artifactsRoot, { recursive: true });
	const now = new Date().toISOString();
	const manifest: Record<string, unknown> = {
		schemaVersion: 1,
		runId: fixture.runId,
		team: "fast-fix",
		goal: "NEW-2 notify honesty probe",
		status: fixture.status,
		workspaceMode: "single",
		createdAt: now,
		updatedAt: now,
		cwd,
		stateRoot,
		artifactsRoot,
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	};
	if (fixture.planApprovalPending) {
		manifest.planApproval = { required: true, status: "pending" };
	}
	if (fixture.asyncPid !== undefined) {
		manifest.async = { pid: fixture.asyncPid, startedAt: now };
	}
	fs.writeFileSync(path.join(stateRoot, "manifest.json"), JSON.stringify(manifest), "utf-8");
	fs.writeFileSync(
		path.join(stateRoot, "tasks.json"),
		JSON.stringify([
			{
				id: `${fixture.runId}-t1`,
				runId: fixture.runId,
				role: "executor",
				agent: "executor",
				title: "probe task",
				status: fixture.status === "running" ? "running" : "pending",
				dependsOn: [],
				cwd,
			},
		]),
		"utf-8",
	);
}

type CapturedNotification = { id?: string; title?: string; body?: string };

/**
 * Boot the real registration stack in a throwaway home + project cwd with the
 * given fixture runs on disk, fire ONE session_start, wait for the deferred
 * cleanup to settle, and return every stale-reconcile operator notification.
 */
async function probeSessionStartNotifications(fixtures: FixtureRun[]): Promise<CapturedNotification[]> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "new2-honesty-home-"));
	const cwd = createTrackedTempDir("new2-honesty-cwd-");
	const prevHome = process.env.PI_CREW_HOME;
	process.env.PI_CREW_HOME = home;
	fs.mkdirSync(path.join(cwd, ".crew", "state", "runs"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".crew", "config.json"), JSON.stringify({}), "utf-8");
	fs.writeFileSync(path.join(cwd, "package.json"), "{}\n", "utf-8");
	for (const fixture of fixtures) writeFixtureRun(cwd, fixture);
	try {
		const pi = createFakePi(createEventBus());
		const ctx = buildRegistrationContext(pi as never);
		ctx.importCrashRecovery = importCrashRecovery;
		ctx.purgeStaleActiveRunIndexSyncIfLoaded = purgeStaleActiveRunIndexSyncIfLoaded;
		ctx.subagentManager = {
			abortAll() {
				/* no-op stub for session-switch cleanup */
			},
		} as never;
		const staleNotifies: CapturedNotification[] = [];
		ctx.notifyOperator = (notification: CapturedNotification) => {
			if (notification.id === "stale_reconcile") {
				staleNotifies.push(notification);
			}
		};
		installRuntimeCleanup(pi as never, ctx);
		installLazyConfigurers(pi as never, ctx);
		installSessionLifecycleHandlers(pi as never, ctx);

		const sessionCtx = {
			cwd,
			hasUI: false,
			model: undefined,
			thinkingLevel: undefined,
			ui: {
				notify() {
					/* no-op */
				},
				setWorkingMessage() {
					/* no-op */
				},
			},
			sessionManager: {
				getSessionId: () => "sess-new2-honesty",
				getEntries: () => [] as unknown[],
			},
		};
		pi.emitLifecycle("session_start", sessionCtx);
		// Deferred cleanup is setTimeout(0) + async reconcile; a stable capture
		// window of 900ms (registration ticks measured <600ms in F14) proves the
		// reconcile batch settled either way (notify or no notify).
		const settled = await waitForQuiet(() => staleNotifies.length, 900, 3000);
		assert.ok(settled, "deferred session-start cleanup must settle within the window");
		// Repair persistence (terminateLiveAgentsForRun void-promise) tail.
		await sleep(150);
		pi.emitLifecycle("session_shutdown", sessionCtx, { reason: "quit" });
		await sleep(25);
		return staleNotifies;
	} finally {
		if (prevHome === undefined) delete process.env.PI_CREW_HOME;
		else process.env.PI_CREW_HOME = prevHome;
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

test("NEW-2 (b): reconcile that repaired NOTHING must not notify the operator", async () => {
	const staleNotifies = await probeSessionStartNotifications([
		{ runId: "run-blocked-apprv", status: "blocked", planApprovalPending: true },
	]);
	assert.equal(
		staleNotifies.length,
		0,
		`a blocked_awaiting_approval verdict (repaired:false) must NOT produce a stale-reconcile notify — got ${JSON.stringify(staleNotifies)}`,
	);
});

test("NEW-2 (a): mixed reconcile notifies ONLY the repaired run with an honest title", async () => {
	const staleNotifies = await probeSessionStartNotifications([
		{ runId: "run-blocked-apprv", status: "blocked", planApprovalPending: true },
		{ runId: "run-dead-async", status: "running", asyncPid: guaranteedDeadPid() },
	]);
	assert.equal(staleNotifies.length, 1, `expected exactly one stale-reconcile notify, got ${JSON.stringify(staleNotifies)}`);
	const notify = staleNotifies[0];
	assert.ok(
		(notify.title ?? "").startsWith("Repaired"),
		`title must state what actually happened (Repaired N stale run(s)), got: ${notify.title}`,
	);
	assert.ok((notify.body ?? "").includes("run-dead-async"), `body must name the repaired run, got: ${notify.body}`);
	assert.ok(
		!(notify.body ?? "").includes("run-blocked-apprv"),
		`body must NOT mention the non-repaired run (blocked_awaiting_approval, repaired:false), got: ${notify.body}`,
	);
});
