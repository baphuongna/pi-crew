/**
 * M3 — Observability reconcile threading test (Vector #5, highest-freq leak path).
 *
 * F12 (RR-018) moved the `before_agent_start` reconcile hook to extension
 * registration (lazy-configurers.ts → installTurnReconcileHook — see
 * turn-hook-once.test.ts for the once-per-extension contract). What REMAINS
 * in `configureObservability` is the per-session auto-repair interval, which
 * still calls `deps.reconcileStaleRuns(cwd, cache, currentSessionId)` with
 * `currentSessionId` derived via `extractSessionId(ctx)` — so reconcile skips
 * the current session's own live runs instead of cancelling them.
 *
 * This test drives `configureObservability` directly with a SPY
 * `reconcileStaleRuns`, a fast autoRepairIntervalMs (via project config), and
 * asserts the spy receives `currentSessionId === "session-X"` from the
 * ExtensionContext's `sessionManager.getSessionId()`.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	configureObservability,
	disposeObservability,
	type ObservabilityDeps,
	type ObservabilityState,
} from "../../../../src/extension/registration/observability.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("configureObservability threads extractSessionId(ctx) into reconcileStaleRuns via the auto-repair interval (#5)", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-obs-thread-home-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-obs-session-"));
	const prevHome = process.env.PI_CREW_HOME;
	process.env.PI_CREW_HOME = home;
	try {
		fs.writeFileSync(path.join(cwd, "package.json"), "{}\n", "utf-8");
		// Fast auto-repair interval so the timer path fires within the test.
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".crew", "config.json"), JSON.stringify({ reliability: { autoRepairIntervalMs: 40 } }), "utf-8");

		// `events: undefined` skips wireEventToMetrics (no subscriptions to clean).
		const fakePi = {
			events: undefined,
			on() {
				/* hook registration moved to lazy-configurers (F12) */
			},
		};

		// Inert manifest cache — list() returns nothing so heartbeat/reconcile do
		// no real work; we only care that reconcileStaleRuns receives the sid.
		const manifestCache = { list: () => [] };

		// SPY: record every reconcileStaleRuns invocation's currentSessionId.
		const reconcileCalls: Array<{ cwd: string; currentSessionId?: string }> = [];

		const deps = {
			pi: fakePi,
			getManifestCache: () => manifestCache,
			notifyOperator: () => undefined,
			isCleanedUp: () => false,
			getSessionGeneration: () => 1,
			reconcileStaleRuns: (cwdArg: string, _cache: unknown, currentSessionId?: string) => {
				reconcileCalls.push({ cwd: cwdArg, currentSessionId });
				return [];
			},
			reconcileOrphanedTempWorkspaces: () => undefined,
			cleanupOrphanTempDirs: () => ({ cleaned: 0, scanned: 0, failed: 0 }),
			cleanupLegacyOrphanTempDirs: () => ({ cleaned: 0, scanned: 0, failed: 0 }),
			appendDeadletter: () => undefined,
			importCrashRecovery: async () => ({ detectInterruptedRuns: () => [] }),
		} as unknown as ObservabilityDeps;

		const state: ObservabilityState = {
			metricRegistry: undefined,
			eventMetricSub: undefined,
			metricSink: undefined,
			heartbeatWatcher: undefined,
			autoRepairTimer: undefined,
			tempReconcileTimer: undefined,
			otlpExporter: undefined,
			initPromise: undefined,
		};

		// ExtensionContext whose sessionManager reports "session-X". This is the
		// value extractSessionId(ctx) must thread into reconcileStaleRuns.
		const ctx = {
			cwd,
			sessionManager: { getSessionId: () => "session-X" },
		};

		await configureObservability(ctx as never, state, deps);

		// No reconcile should have fired at configure time.
		assert.equal(reconcileCalls.length, 0, "no reconcile at configure time");

		// The auto-repair interval (40ms) must fire with the session id threaded.
		await sleep(250);
		assert.ok(reconcileCalls.length >= 1, `auto-repair interval should have fired (got ${reconcileCalls.length} calls)`);
		for (const call of reconcileCalls) {
			assert.equal(call.cwd, cwd);
			assert.equal(call.currentSessionId, "session-X", "currentSessionId must be threaded from ctx.sessionManager");
		}

		await disposeObservability(state, false);
	} finally {
		if (prevHome === undefined) delete process.env.PI_CREW_HOME;
		else process.env.PI_CREW_HOME = prevHome;
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
