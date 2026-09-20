/**
 * RR-019 F14 (idle render stop).
 *
 * The preload loop used to call `renderScheduler.schedule()` after EVERY
 * successful buildFrame() — and buildFrame() returned true whenever a session
 * context existed, with no data comparison. schedule() resets `lastEventAt`
 * and `idleFallbackRenders` and re-arms the fallback timer, so the R1 idle
 * stop never engaged while a preload tick was running (probe: 12s window,
 * defaults maxIdleFallbackRenders=8 / fallbackMs=1000 → scheduler alone
 * rendered 8x then stopped; with the real preload wiring it was still
 * rendering at 11 and counting).
 *
 * This test drives the REAL session_start handler (setupRenderLoop → real
 * preload loop + real RenderScheduler) with dashboardLiveRefreshMs=250
 * (config minimum) and counts flush() calls — every render goes through
 * flush(), so flush-count == render-count.
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

test("F14: unchanged preload data stops rendering after the idle allowance; a changed frame re-triggers", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "f14-idle-home-"));
	const cwd = createTrackedTempDir("f14-idle-cwd-");
	const prevHome = process.env.PI_CREW_HOME;
	process.env.PI_CREW_HOME = home;
	fs.mkdirSync(path.join(cwd, ".crew", "state", "runs"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".crew", "config.json"), JSON.stringify({ ui: { dashboardLiveRefreshMs: 250 } }), "utf-8");
	fs.writeFileSync(path.join(cwd, "package.json"), "{}\n", "utf-8");
	try {
		const events = createEventBus();
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
				getSessionId: () => "sess-f14",
				getEntries: () => [] as unknown[],
			},
		};
		pi.emitLifecycle("session_start", sessionCtx);
		await sleep(300);
		assert.ok(ctx.renderScheduler, "session_start must install a render scheduler");

		// Count renders: every render goes through flush() (debounce drain +
		// fallback loop both call it). Shadow the instance method.
		const scheduler = ctx.renderScheduler;
		const originalFlush = scheduler.flush.bind(scheduler);
		let flushes = 0;
		scheduler.flush = (): void => {
			flushes += 1;
			originalFlush();
		};

		// Idle window 1: maxIdleFallbackRenders=8 renders at fallbackMs=250 →
		// the fallback loop stops re-arming around t≈2.3s. Sample well past it.
		await sleep(2900);
		const afterIdle = flushes;
		assert.ok(afterIdle >= 1, `expected at least the initial render, got ${afterIdle}`);
		assert.ok(
			afterIdle <= 13,
			`unchanged data must stop rendering near the idle allowance (maxIdleFallbackRenders=8 + first render); got ${afterIdle}`,
		);
		await sleep(1500);
		assert.equal(flushes, afterIdle, `render loop must be STOPPED while idle (grew from ${afterIdle} to ${flushes})`);

		// A genuinely changed frame (new run appears on disk) must re-trigger.
		const runId = "run-f14-changed";
		const stateRoot = path.join(cwd, ".crew", "state", "runs", runId);
		fs.mkdirSync(stateRoot, { recursive: true });
		fs.mkdirSync(path.join(cwd, ".crew", "artifacts", runId), { recursive: true });
		fs.writeFileSync(
			path.join(stateRoot, "manifest.json"),
			JSON.stringify({
				schemaVersion: 2,
				runId,
				team: "default",
				goal: "F14 change probe",
				status: "completed",
				workspaceMode: "single",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				cwd,
				stateRoot,
				artifactsRoot: path.join(cwd, ".crew", "artifacts", runId),
				tasksPath: path.join(stateRoot, "tasks.json"),
				eventsPath: path.join(stateRoot, "events.jsonl"),
				artifacts: [],
			}),
			"utf-8",
		);
		await sleep(2000);
		assert.ok(flushes > afterIdle, `a changed frame must re-trigger rendering (still ${flushes} after change)`);

		pi.emitLifecycle("session_shutdown", sessionCtx, { reason: "quit" });
		await sleep(100);
	} finally {
		if (prevHome === undefined) delete process.env.PI_CREW_HOME;
		else process.env.PI_CREW_HOME = prevHome;
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
