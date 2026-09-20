/**
 * RR-018 F13 (session-lifecycle ownership).
 *
 * RPC wiring (pi-crew:rpc:* subscriptions + crew global registry) is an
 * EXTENSION-lifetime resource installed once at registration. Session-switch
 * cleanup used to tear it down (`uninstallCrewGlobalRegistry()` +
 * `ctx.rpcHandle.unsubscribe()`) without any reinstall on session_start — RPC
 * was permanently dead after the first switch (4 subscriptions → 0 → never 4
 * again). Separately, caches were disposed but `cacheCwd`/refs were retained,
 * so same-cwd access returned the disposed instance.
 *
 * This test drives the REAL registerPiTeams + real session lifecycle events
 * and counts the pi-crew:rpc:* subscriptions across a switch, plus exercises
 * rpc:ping end-to-end after the switch.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { registerPiTeams } from "../../../../src/extension/register.ts";
import { buildRegistrationContext } from "../../../../src/extension/registration/context-builder.ts";
import { createRunSnapshotCache } from "../../../../src/ui/run-snapshot-cache.ts";

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
		countByPrefix(prefix: string) {
			let total = 0;
			for (const [event, set] of handlers) if (event.startsWith(prefix)) total += set.size;
			return total;
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

function makeSessionCtx(cwd: string, sessionId: string) {
	return {
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
			getSessionId: () => sessionId,
			getEntries: () => [],
		},
	};
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("F13: RPC subscriptions survive a session switch and rpc:ping keeps answering (registerPiTeams wiring)", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "f13-rpc-home-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "f13-rpc-cwd-"));
	fs.writeFileSync(path.join(cwd, "package.json"), "{}\n", "utf-8");
	const prevHome = process.env.PI_CREW_HOME;
	process.env.PI_CREW_HOME = home;
	delete process.env.PI_CREW_RPC_SECRET;
	try {
		const events = createEventBus();
		const pi = createFakePi(events);
		await registerPiTeams(pi as never);

		// S1
		pi.emitLifecycle("session_start", makeSessionCtx(cwd, "sess-1"));
		const rpcAfterS1 = events.countByPrefix("pi-crew:rpc:");
		assert.equal(rpcAfterS1, 4, `expected 4 pi-crew:rpc:* subscriptions after S1 start, got ${rpcAfterS1}`);

		// RPC ping answers while S1 is current.
		const ping1 = new Promise<{ success: boolean }>((resolve) => {
			const off = events.on("pi-crew:rpc:ping:reply:ping1", (payload) => {
				resolve(payload as { success: boolean });
				off();
			});
		});
		events.emit("pi-crew:rpc:ping", { requestId: "ping1" });
		assert.equal((await ping1).success, true, "rpc:ping should answer on session 1");

		// Session switch (resume/new/fork → resources-only cleanup).
		pi.emitLifecycle("session_shutdown", makeSessionCtx(cwd, "sess-1"), { reason: "resume" });
		const rpcAfterSwitch = events.countByPrefix("pi-crew:rpc:");
		assert.equal(rpcAfterSwitch, 4, `RPC must survive a session switch (got ${rpcAfterSwitch})`);

		// S2 in the same cwd — must not double the subscriptions either.
		pi.emitLifecycle("session_start", makeSessionCtx(cwd, "sess-2"));
		await sleep(250);
		const rpcAfterS2 = events.countByPrefix("pi-crew:rpc:");
		assert.equal(rpcAfterS2, 4, `S2 start must keep exactly 4 RPC subscriptions (got ${rpcAfterS2})`);

		const ping2 = new Promise<{ success: boolean }>((resolve) => {
			const off = events.on("pi-crew:rpc:ping:reply:ping2", (payload) => {
				resolve(payload as { success: boolean });
				off();
			});
		});
		events.emit("pi-crew:rpc:ping", { requestId: "ping2" });
		assert.equal((await ping2).success, true, "rpc:ping should answer on session 2 after a switch");

		// Full shutdown still tears RPC down (extension-lifetime end).
		pi.emitLifecycle("session_shutdown", makeSessionCtx(cwd, "sess-2"), { reason: "quit" });
		await sleep(50);
		assert.equal(events.countByPrefix("pi-crew:rpc:"), 0, "full shutdown should remove the RPC subscriptions");
	} finally {
		if (prevHome === undefined) delete process.env.PI_CREW_HOME;
		else process.env.PI_CREW_HOME = prevHome;
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F13: disposed caches are recreated even when the cwd is unchanged", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "f13-cache-home-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "f13-cache-cwd-"));
	const prevHome = process.env.PI_CREW_HOME;
	process.env.PI_CREW_HOME = home;
	try {
		const events = createEventBus();
		const ctx = buildRegistrationContext({ events } as never);

		const manifest1 = ctx.getManifestCache(cwd);
		const snapshot1 = ctx.getRunSnapshotCache(cwd);
		assert.equal(snapshot1.isDisposed(), false, "fresh snapshot cache must not be disposed");
		assert.equal(ctx.getManifestCache(cwd), manifest1, "same-cwd access reuses the live cache");
		assert.equal(ctx.getRunSnapshotCache(cwd), snapshot1, "same-cwd access reuses the live snapshot cache");

		// Session-switch cleanup disposes the caches but keeps cacheCwd/refs.
		ctx.manifestCache.dispose();
		ctx.runSnapshotCache.dispose?.();
		ctx.runSnapshotCache.dispose?.(); // dispose must be idempotent — never throw.
		assert.equal(snapshot1.isDisposed(), true, "dispose() must set the disposed flag");

		const manifest2 = ctx.getManifestCache(cwd);
		assert.notEqual(manifest2, manifest1, "same-cwd access after dispose must return a NEW manifest cache");
		assert.equal(ctx.runSnapshotCache.isDisposed(), false, "getManifestCache must recreate the snapshot cache too");
		const snapshot2 = ctx.getRunSnapshotCache(cwd);
		assert.notEqual(snapshot2, snapshot1, "same-cwd access after dispose must return a NEW snapshot cache");

		// A fresh standalone cache: isDisposed flag flips on dispose.
		const standalone = createRunSnapshotCache(cwd);
		assert.equal(standalone.isDisposed(), false);
		standalone.dispose?.();
		standalone.dispose?.(); // idempotent
		assert.equal(standalone.isDisposed(), true);

		ctx.manifestCache.dispose();
		ctx.runSnapshotCache.dispose?.();
	} finally {
		if (prevHome === undefined) delete process.env.PI_CREW_HOME;
		else process.env.PI_CREW_HOME = prevHome;
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
