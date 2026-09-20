/**
 * RR-018 F11 + F12 (session-lifecycle ownership).
 *
 * F11: `configureObservability` is fire-and-forget from session_start
 * (lazy-configurers.ts voids it). The continuation used to publish
 * metricRegistry / eventMetricSub / metricSink / heartbeatWatcher into shared
 * state after await boundaries with NO ownership check — so an init that was
 * suspended across a cleanup (or across a whole session A→B switch) still
 * published, orphaning/overwriting resources. These tests reproduce that
 * interleaving against the REAL configureObservability + real lazy imports.
 *
 * F12: the `before_agent_start` reconcile hook used to be registered by
 * configureObservability on EVERY session — accumulating one dead hook per
 * switch. It now lives once at extension registration (lazy-configurers.ts),
 * so configureObservability must register NO hook at all.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	configureObservability,
	disposeObservability,
	type ObservabilityState,
} from "../../../../src/extension/registration/observability.ts";
import { createManifestCache } from "../../../../src/runtime/manifest-cache.ts";

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
		totalSubscriptions() {
			let total = 0;
			for (const set of handlers.values()) total += set.size;
			return total;
		},
	};
}

interface FakePi {
	events: ReturnType<typeof createEventBus>;
	hooks: Map<string, number>;
	on(event: string, handler: (event: unknown, ctx: unknown) => void): void;
}

function createFakePi(): FakePi {
	const events = createEventBus();
	const hooks = new Map<string, number>();
	return {
		events,
		hooks,
		on(event: string, _handler: (event: unknown, ctx: unknown) => void) {
			hooks.set(event, (hooks.get(event) ?? 0) + 1);
		},
	};
}

function freshState(): ObservabilityState {
	return {
		metricRegistry: undefined,
		eventMetricSub: undefined,
		metricSink: undefined,
		heartbeatWatcher: undefined,
		autoRepairTimer: undefined,
		tempReconcileTimer: undefined,
		otlpExporter: undefined,
		initPromise: undefined,
	};
}

interface Harness {
	cwd: string;
	homeRestore: () => void;
	cleanup: () => void;
}

function makeHarness(prefix: string): Harness {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-home-`));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-cwd-`));
	fs.writeFileSync(path.join(cwd, "package.json"), "{}\n", "utf-8");
	const prevHome = process.env.PI_CREW_HOME;
	process.env.PI_CREW_HOME = home;
	return {
		cwd,
		homeRestore: () => {
			if (prevHome === undefined) delete process.env.PI_CREW_HOME;
			else process.env.PI_CREW_HOME = prevHome;
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(cwd, { recursive: true, force: true });
		},
		cleanup: () => {
			fs.rmSync(cwd, { recursive: true, force: true });
		},
	};
}

interface OwnershipVars {
	generation: number;
	cleanedUp: boolean;
}

function makeDeps(pi: FakePi, cwd: string, vars: OwnershipVars) {
	const manifestCache = createManifestCache(cwd);
	return {
		pi,
		getManifestCache: () => manifestCache,
		notifyOperator: () => undefined,
		isCleanedUp: () => vars.cleanedUp,
		getSessionGeneration: () => vars.generation,
		reconcileStaleRuns: () => [],
		reconcileOrphanedTempWorkspaces: () => undefined,
		cleanupOrphanTempDirs: () => ({ cleaned: 0, scanned: 0, failed: 0 }),
		cleanupLegacyOrphanTempDirs: () => ({ cleaned: 0, scanned: 0, failed: 0 }),
		appendDeadletter: () => undefined,
		importCrashRecovery: async () => ({ detectInterruptedRuns: () => [] }),
	};
}

test("F11: init suspended across cleanup publishes nothing and subscribes nothing", async () => {
	const h = makeHarness("f11-own");
	try {
		const pi = createFakePi();
		const state = freshState();
		const vars: OwnershipVars = { generation: 7, cleanedUp: false };
		const deps = makeDeps(pi, h.cwd, vars);
		const extCtx = { cwd: h.cwd } as never;

		// Fire-and-forget, exactly like session_start does (lazy-configurers).
		const init = configureObservability(extCtx, state, deps as never);
		// ...cleanup runs while the init continuation is still suspended.
		vars.cleanedUp = true;
		vars.generation += 1;
		await init;

		assert.equal(state.metricRegistry, undefined, "metricRegistry must not be published after cleanup");
		assert.equal(state.eventMetricSub, undefined, "eventMetricSub must not be published after cleanup");
		assert.equal(state.metricSink, undefined, "metricSink must not be published after cleanup");
		assert.equal(state.heartbeatWatcher, undefined, "heartbeatWatcher must not be published after cleanup");
		assert.equal(pi.events.totalSubscriptions(), 0, "event→metric subscriptions leaked onto the bus");
		await disposeObservability(state, true);
	} finally {
		h.homeRestore();
	}
});

test("F11: a newer session resetting cleanedUp=false still cannot resurrect the old init (generation)", async () => {
	const h = makeHarness("f11-gen");
	try {
		const pi = createFakePi();
		const state = freshState();
		const vars: OwnershipVars = { generation: 1, cleanedUp: false };
		const deps = makeDeps(pi, h.cwd, vars);
		const extCtx = { cwd: h.cwd } as never;

		const init = configureObservability(extCtx, state, deps as never);
		// Real ordering: cleanup sets cleanedUp=true and bumps the generation,
		// then session B's session_start resets cleanedUp=false and bumps again.
		vars.cleanedUp = true;
		vars.generation += 1;
		vars.cleanedUp = false;
		vars.generation += 1;
		await init;

		assert.equal(state.metricRegistry, undefined, "stale-session init published into the new session's state");
		assert.equal(state.eventMetricSub, undefined, "stale-session init subscribed to the bus");
		assert.equal(state.heartbeatWatcher, undefined, "stale-session init started a watcher");
		assert.equal(pi.events.totalSubscriptions(), 0);
		await disposeObservability(state, true);
	} finally {
		h.homeRestore();
	}
});

test("F11: A-init → cleanup → B-init leaves B's resources intact (no orphaned A resources)", async () => {
	const h = makeHarness("f11-orphan");
	try {
		const pi = createFakePi();
		const state = freshState();
		const vars: OwnershipVars = { generation: 1, cleanedUp: false };
		const deps = makeDeps(pi, h.cwd, vars);
		const extCtx = { cwd: h.cwd } as never;

		// Session A's init starts (suspended at its first await boundary).
		const initA = configureObservability(extCtx, state, deps as never);
		// Session switch: cleanup runs to completion.
		vars.cleanedUp = true;
		vars.generation += 1;
		// Session B starts and fully initializes.
		vars.cleanedUp = false;
		vars.generation += 1;
		const initB = configureObservability(extCtx, state, deps as never);
		await initB;
		const bRegistry = state.metricRegistry;
		const bEventSub = state.eventMetricSub;
		const bSubs = pi.events.totalSubscriptions();
		assert.ok(bRegistry, "session B should own a published metricRegistry");
		assert.ok(bSubs > 0, "session B should own the event→metric subscriptions");

		// Now A's suspended continuation finally resumes — it must self-dispose
		// and leave B's published state + bus untouched.
		await initA;
		assert.equal(state.metricRegistry, bRegistry, "stale init A overwrote session B's registry");
		assert.equal(state.eventMetricSub, bEventSub, "stale init A overwrote session B's event subscription");
		assert.equal(pi.events.totalSubscriptions(), bSubs, "stale init A added orphaned bus subscriptions");
		await disposeObservability(state, true);
		assert.equal(pi.events.totalSubscriptions(), 0, "disposeObservability must clear B's subscriptions");
	} finally {
		h.homeRestore();
	}
});

test("F12: configureObservability registers no before_agent_start hook (hook moved to extension registration)", async () => {
	const h = makeHarness("f12-hook");
	try {
		const pi = createFakePi();
		const state = freshState();
		const vars: OwnershipVars = { generation: 1, cleanedUp: false };
		const deps = makeDeps(pi, h.cwd, vars);
		const extCtx = { cwd: h.cwd } as never;

		await configureObservability(extCtx, state, deps as never);
		await configureObservability(extCtx, state, deps as never);
		await configureObservability(extCtx, state, deps as never);

		assert.equal(pi.hooks.get("before_agent_start") ?? 0, 0, "configureObservability must not register turn hooks");
		await disposeObservability(state, true);
	} finally {
		h.homeRestore();
	}
});
