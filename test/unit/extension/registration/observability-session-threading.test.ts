/**
 * M3 — Observability reconcile threading test (Vector #5, highest-freq leak path).
 *
 * `src/extension/registration/observability.ts` registers a `before_agent_start`
 * hook (fires every user turn) and a setInterval (every autoRepairIntervalMs)
 * that both call `deps.reconcileStaleRuns(cwd, cache, currentSessionId)`. The
 * `currentSessionId` is derived via `extractSessionId(ctx)` so reconcile skips
 * the current session's own live runs instead of cancelling them.
 *
 * This test drives `configureObservability` directly with a SPY
 * `reconcileStaleRuns`, captures the `before_agent_start` handler via a fake
 * `pi.on`, fires it with an ExtensionContext whose
 * `sessionManager.getSessionId()` returns "session-X", and asserts the spy
 * received `currentSessionId === "session-X"`.
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

test("configureObservability threads extractSessionId(ctx) into reconcileStaleRuns via before_agent_start (#5)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-obs-session-"));
	try {
		fs.writeFileSync(path.join(cwd, "package.json"), "{}\n", "utf-8");

		// Capture the before_agent_start handler so we can fire it manually and
		// observe what args reconcileStaleRuns receives.
		const lifecycleHandlers = new Map<string, Array<() => void>>();
		const fakePi = {
			// `events: undefined` skips wireEventToMetrics (no subscriptions to clean).
			events: undefined,
			on(event: string, handler: () => void) {
				const arr = lifecycleHandlers.get(event) ?? [];
				arr.push(handler);
				lifecycleHandlers.set(event, arr);
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

		// The before_agent_start hook must have been registered exactly once.
		const hooks = lifecycleHandlers.get("before_agent_start") ?? [];
		assert.equal(hooks.length, 1, "before_agent_start handler should be registered");

		// Fire the hook the way Pi would on each user turn.
		hooks[0]!();

		assert.equal(reconcileCalls.length, 1, "reconcileStaleRuns called once per before_agent_start");
		assert.equal(reconcileCalls[0]?.cwd, cwd);
		assert.equal(reconcileCalls[0]?.currentSessionId, "session-X", "currentSessionId must be threaded from ctx.sessionManager");

		await disposeObservability(state, false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
