/**
 * L2 pin (real-test 2026-10-07, report
 * docs/real-test/reports/real-test-2026-10-07-ui-instability-review.md):
 * the renderTick health gates (GATE 1 / FIX #1 / GATE 2 / GATE 3) must
 * REFRESH the run-snapshot entry IN PLACE — never `invalidate(runId)`
 * (entries.delete).
 *
 * `list(20)` keeps recently-finished runs in the preloaded frame, so the
 * gates re-fire on EVERY renderTick (~160ms while work is active) for a
 * terminal/divergent run. A hard delete there left
 * `snapshotCache.get(runId)` undefined for 1-n frames and the widget/powerbar
 * fell back to their disk-read branch around every run completion — exactly
 * the flicker the FLICKER FIX invariant (run-snapshot-cache.ts scheduleRefresh
 * docs + the onRunChange wiring in render-loop.ts) forbids.
 *
 * These tests drive the REAL pipeline (installSessionLifecycleHandlers →
 * setupRenderLoop → real preload loop + real RenderScheduler, same harness
 * shape as preload-idle-render.test.ts), then force a synchronous renderTick
 * via `ctx.renderScheduler.flush()` and assert the snapshot entry SURVIVES.
 * Reverting any gate to `invalidate()` fails the tests.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildRegistrationContext } from "../../../../src/extension/registration/context-builder.ts";
import { importCrashRecovery, purgeStaleActiveRunIndexSyncIfLoaded } from "../../../../src/extension/registration/crash-recovery-cache.ts";
import { installLazyConfigurers } from "../../../../src/extension/registration/lazy-configurers.ts";
import { installSessionLifecycleHandlers } from "../../../../src/extension/registration/lifecycle-handlers.ts";
import { installRuntimeCleanup } from "../../../../src/extension/registration/runtime-cleanup.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

// --- Harness primitives (mirrored from preload-idle-render.test.ts) ---

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

async function waitFor(predicate: () => boolean, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(25);
	}
	return predicate();
}

// --- Run fixtures ---

function writeRunFixture(cwd: string, run: { runId: string; status: string; tasks?: Array<Record<string, unknown>> }): string {
	const stateRoot = path.join(cwd, ".crew", "state", "runs", run.runId);
	fs.mkdirSync(stateRoot, { recursive: true });
	fs.mkdirSync(path.join(cwd, ".crew", "artifacts", run.runId), { recursive: true });
	const now = new Date().toISOString();
	fs.writeFileSync(
		path.join(stateRoot, "manifest.json"),
		JSON.stringify({
			schemaVersion: 2,
			runId: run.runId,
			team: "default",
			goal: "L2 rebuild-in-place pin",
			status: run.status,
			workspaceMode: "single",
			createdAt: now,
			updatedAt: now,
			cwd,
			stateRoot,
			artifactsRoot: path.join(cwd, ".crew", "artifacts", run.runId),
			tasksPath: path.join(stateRoot, "tasks.json"),
			eventsPath: path.join(stateRoot, "events.jsonl"),
			artifacts: [],
		}),
		"utf-8",
	);
	fs.writeFileSync(path.join(stateRoot, "events.jsonl"), "", "utf-8");
	if (run.tasks) fs.writeFileSync(path.join(stateRoot, "tasks.json"), JSON.stringify(run.tasks), "utf-8");
	return stateRoot;
}

function makeTask(runId: string, status: string): Record<string, unknown> {
	return {
		id: "t1",
		runId,
		role: "executor",
		agent: "worker-1",
		title: "L2 pin task",
		status,
		dependsOn: [],
		cwd: "/tmp",
	};
}

interface LoopHarness {
	pi: ReturnType<typeof createFakePi>;
	ctx: ReturnType<typeof buildRegistrationContext>;
	sessionCtx: {
		cwd: string;
		hasUI: false;
		model: undefined;
		thinkingLevel: undefined;
		ui: { notify(): void; setWorkingMessage(): void };
		sessionManager: { getSessionId: () => string; getEntries: () => unknown[] };
	};
}

/** Install the real lifecycle stack (render loop included) for `cwd`. */
function makeLoopHarness(cwd: string, events: ReturnType<typeof createEventBus>): LoopHarness {
	const pi = createFakePi(events);
	const ctx = buildRegistrationContext(pi as never);
	ctx.importCrashRecovery = importCrashRecovery;
	ctx.purgeStaleActiveRunIndexSyncIfLoaded = purgeStaleActiveRunIndexSyncIfLoaded;
	ctx.subagentManager = {
		abortAll() {
			/* no-op stub for session-switch cleanup */
		},
	} as never;
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
			getSessionId: () => "sess-l2-pin",
			getEntries: () => [] as unknown[],
		},
	} as const;
	return { pi, ctx, sessionCtx };
}

/** Common per-test sandbox: isolated PI_CREW_HOME + tracked temp cwd + config. */
function makeSandbox(): { home: string; cwd: string; restore: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "l2-pin-home-"));
	const cwd = createTrackedTempDir("l2-pin-cwd-");
	const prevHome = process.env.PI_CREW_HOME;
	process.env.PI_CREW_HOME = home;
	fs.mkdirSync(path.join(cwd, ".crew", "state", "runs"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".crew", "config.json"), JSON.stringify({ ui: { dashboardLiveRefreshMs: 250 } }), "utf-8");
	fs.writeFileSync(path.join(cwd, "package.json"), "{}\n", "utf-8");
	return {
		home,
		cwd,
		restore: () => {
			if (prevHome === undefined) delete process.env.PI_CREW_HOME;
			else process.env.PI_CREW_HOME = prevHome;
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(cwd, { recursive: true, force: true });
		},
	};
}

test("L2 pin: a TERMINAL run keeps its snapshot entry defined across forced renderTicks (GATE 1)", async () => {
	const sandbox = makeSandbox();
	try {
		const runId = "run-l2-terminal";
		writeRunFixture(sandbox.cwd, { runId, status: "completed" });
		const harness = makeLoopHarness(sandbox.cwd, createEventBus());
		harness.pi.emitLifecycle("session_start", harness.sessionCtx);
		const installed = await waitFor(() => harness.ctx.renderScheduler !== undefined, 600);
		assert.ok(installed && harness.ctx.renderScheduler, "session_start must install a render scheduler");

		const snapshotCache = () => harness.ctx.getRunSnapshotCache(sandbox.cwd);
		// buildFrame's preloadAllStale covers ALL listed runs (terminal included),
		// so the entry must exist before the gates ever fire.
		const preloaded = await waitFor(() => snapshotCache().get(runId) !== undefined, 1500);
		assert.ok(preloaded, "preload must build the terminal run's snapshot entry");

		// The pin: force a synchronous renderTick. GATE 1 sees the terminal
		// manifest; the old code hard-deleted the entry right here, so the
		// widget/powerbar read `get(runId) === undefined` on the next paint.
		harness.ctx.renderScheduler.flush();
		assert.ok(
			snapshotCache().get(runId) !== undefined,
			"GATE 1 must rebuild the snapshot in place — invalidate() leaves get(runId) undefined (report L2 flicker)",
		);
		// The gate re-fires on EVERY tick while the terminal run sits in the
		// recent-20 list — the entry must survive repeated ticks too.
		harness.ctx.renderScheduler.flush();
		assert.ok(snapshotCache().get(runId) !== undefined, "snapshot entry must stay defined across repeated renderTicks");

		harness.pi.emitLifecycle("session_shutdown", harness.sessionCtx, { reason: "quit" });
		await sleep(25);
	} finally {
		sandbox.restore();
	}
});

test("L2 pin: a task-status DIVERGENT run keeps its snapshot entry defined across a forced renderTick (GATE 3)", async () => {
	const sandbox = makeSandbox();
	try {
		const runId = "run-l2-divergent";
		const stateRoot = writeRunFixture(sandbox.cwd, { runId, status: "running", tasks: [makeTask(runId, "running")] });
		const harness = makeLoopHarness(sandbox.cwd, createEventBus());
		harness.pi.emitLifecycle("session_start", harness.sessionCtx);
		const installed = await waitFor(() => harness.ctx.renderScheduler !== undefined, 600);
		assert.ok(installed && harness.ctx.renderScheduler, "session_start must install a render scheduler");

		const snapshotCache = () => harness.ctx.getRunSnapshotCache(sandbox.cwd);
		const preloaded = await waitFor(() => snapshotCache().get(runId) !== undefined, 1500);
		assert.ok(preloaded, "preload must build the running run's snapshot entry");
		assert.equal(snapshotCache().get(runId)?.tasks[0]?.status, "running", "precondition: cached task is running");

		// Flip the on-disk task status WITHOUT yielding to the event loop first
		// (no awaits between the write and the flush): the cached snapshot says
		// running, disk says waiting → overlayFreshTaskStatuses diverges →
		// GATE 3. The old code hard-deleted the entry here.
		fs.writeFileSync(path.join(stateRoot, "tasks.json"), JSON.stringify([makeTask(runId, "waiting")]), "utf-8");
		harness.ctx.renderScheduler.flush();
		assert.ok(
			snapshotCache().get(runId) !== undefined,
			"GATE 3 must rebuild the snapshot in place — invalidate() leaves get(runId) undefined (report L2 flicker)",
		);
		// The rebuild is coalesced/async (80ms) — synchronously after the tick the
		// entry still holds the PRE-divergence snapshot (stale-while-revalidate),
		// which is exactly what keeps the widget populated instead of flickering.
		assert.equal(
			snapshotCache().get(runId)?.tasks[0]?.status,
			"running",
			"entry keeps the stale-but-populated snapshot until the async rebuild lands",
		);

		harness.pi.emitLifecycle("session_shutdown", harness.sessionCtx, { reason: "quit" });
		await sleep(25);
	} finally {
		sandbox.restore();
	}
});
