/**
 * stale-ctx-publish.test.ts — WI-1 (SDD-4): crew-vibes must never publish
 * with an extension ctx that has been invalidated by a session replacement.
 *
 * Production evidence (team_20261001143008 / team_20261001162336 worker
 * stderr): after the session is replaced/disposed, an in-flight provider
 * fetch continuation still called the publish path with the pre-replacement
 * ctx, whose `ctx.hasUI` getter throws:
 *   "This extension ctx is stale after session replacement or reload. ..."
 *
 * The fakes below mirror pi's runner semantics (createContext in
 * @earendil-works/pi-coding-agent): every ctx property access on a disposed
 * runner throws the stale message. The tests simulate the exact replacement
 * teardown sequence (agent-session-runtime.teardownCurrent):
 *   session_shutdown(ctx) → ctx invalidated → pending continuations run.
 *
 * Red-first contract:
 *   1. A provider fetch that settles AFTER the session was shut down and the
 *      ctx invalidated must NOT touch the stale ctx (no stale read, no throw,
 *      no swallowed stderr noise) — RED on the captured-ctx implementation.
 *   2. A fetch REJECTION after replacement must equally not touch the ctx.
 *   3. Pin: publish reaches the live UI (output not swallowed) and a timer
 *      tick after replacement publishes with the NEW session ctx.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { configPath, PROVIDER_STATUS_ID } from "../../../../src/extension/crew-vibes/config.ts";
import { registerCrewVibes } from "../../../../src/extension/crew-vibes/index.ts";

const STALE_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

interface FakeCtxState {
	setStatusCalls: Array<{ id: string; text: string | undefined }>;
	staleReads: number;
}

/** Fake ExtensionContext matching pi's createContext staleness semantics:
 * property getters throw the stale message once the owning runner is
 * invalidated (dispose). Reads are counted so tests can assert the publish
 * path never touched a stale ctx. */
function makeFakeCtx(provider: string | undefined): { ctx: unknown; state: FakeCtxState; markStale: () => void } {
	const state: FakeCtxState = { setStatusCalls: [], staleReads: 0 };
	let stale = false;
	function assertNotStale(): void {
		if (stale) {
			state.staleReads += 1;
			throw new Error(STALE_MESSAGE);
		}
	}
	const ui = {
		setStatus: (id: string, text: string | undefined) => {
			state.setStatusCalls.push({ id, text });
		},
		notify: () => undefined,
		theme: undefined,
	};
	const ctx = {
		get cwd() {
			assertNotStale();
			return "/tmp/pi-crew-stale-ctx-test";
		},
		get hasUI() {
			assertNotStale();
			return true;
		},
		get ui() {
			assertNotStale();
			return ui;
		},
		get model() {
			assertNotStale();
			return provider ? { provider } : undefined;
		},
	};
	return { ctx, state, markStale: () => (stale = true) };
}

/** Register crew-vibes against a fake pi that captures event handlers. */
function capturePi(): { fire: (event: string, ctx: unknown) => void } {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	registerCrewVibes({
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
			handlers.set(event, handler);
		},
		registerCommand: () => undefined,
	} as never);
	return {
		fire: (event: string, ctx: unknown) => {
			const handler = handlers.get(event);
			assert.ok(handler, `handler for '${event}' was not registered`);
			handler({ type: event }, ctx);
		},
	};
}

/** Flush pending promise continuations (microtasks + immediate ticks). */
async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

const previousHome = process.env.PI_CREW_HOME;
let tempHome = "";

before(() => {
	tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-stale-ctx-test-"));
	process.env.PI_CREW_HOME = tempHome;
	fs.mkdirSync(path.dirname(configPath()), { recursive: true });
	fs.writeFileSync(
		configPath(),
		JSON.stringify({ enabled: true, capacity: { enabled: true, providerUsage: true, providerRefreshMs: 10000 } }),
	);
});

after(() => {
	if (previousHome === undefined) delete process.env.PI_CREW_HOME;
	else process.env.PI_CREW_HOME = previousHome;
	if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
});

test("in-flight fetch settling after session_shutdown + dispose must not touch the stale ctx", async () => {
	const pi = capturePi();
	const ctx1 = makeFakeCtx("anthropic");

	const realFetch = globalThis.fetch;
	type FakeResponse = { ok: boolean; json: () => Promise<unknown> };
	let settleFetch: ((value: FakeResponse) => void) | undefined;
	globalThis.fetch = (() =>
		new Promise<FakeResponse>((resolve) => {
			settleFetch = resolve;
		})) as unknown as typeof fetch;
	const previousToken = process.env.ANTHROPIC_OAUTH_TOKEN;
	process.env.ANTHROPIC_OAUTH_TOKEN = "wi1-test-token";

	try {
		// session_start arms the timer and starts an immediate provider fetch
		// (pending — our stubbed fetch never settles until we say so).
		pi.fire("session_start", ctx1.ctx);

		// Replacement teardown sequence (agent-session-runtime.teardownCurrent):
		// session_shutdown fires while ctx is still valid, then dispose().
		pi.fire("session_shutdown", ctx1.ctx);
		ctx1.markStale();

		// The fetch settles only now — after the ctx was invalidated.
		assert.ok(settleFetch, "stubbed fetch was not called");
		settleFetch({
			ok: true,
			json: async () => ({ five_hour: { utilization: 41, resets_at: null }, seven_day: { utilization: 5 } }),
		});
		await flush();

		assert.equal(
			ctx1.state.staleReads,
			0,
			"publish must never read a post-replacement ctx — this is the production stderr signature that killed workers",
		);
		const providerCalls = ctx1.state.setStatusCalls.filter((call) => call.id === PROVIDER_STATUS_ID);
		assert.equal(providerCalls.length, 1, "only the pre-dispose session_shutdown clear may touch ctx1 (no post-replacement publish)");
	} finally {
		globalThis.fetch = realFetch;
		if (previousToken === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
		else process.env.ANTHROPIC_OAUTH_TOKEN = previousToken;
	}
});

test("fetch REJECTION after session_shutdown + dispose must not touch the stale ctx", async () => {
	const pi = capturePi();
	const ctx1 = makeFakeCtx("anthropic");

	const realFetch = globalThis.fetch;
	globalThis.fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;
	const previousToken = process.env.ANTHROPIC_OAUTH_TOKEN;
	process.env.ANTHROPIC_OAUTH_TOKEN = "wi1-test-token";

	try {
		pi.fire("session_start", ctx1.ctx);
		// The fetch promise rejects on a microtask; it settles only after the
		// flush below — i.e. strictly after the replacement teardown.
		pi.fire("session_shutdown", ctx1.ctx);
		ctx1.markStale();
		await flush();

		assert.equal(ctx1.state.staleReads, 0, "rejected-fetch continuation must not read the stale ctx");
		const providerCalls = ctx1.state.setStatusCalls.filter((call) => call.id === PROVIDER_STATUS_ID);
		assert.equal(providerCalls.length, 1, "only the pre-dispose session_shutdown clear may touch ctx1");
	} finally {
		globalThis.fetch = realFetch;
		if (previousToken === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
		else process.env.ANTHROPIC_OAUTH_TOKEN = previousToken;
	}
});

test("pin: live publish reaches the UI (output not swallowed) on a healthy session", async () => {
	const pi = capturePi();
	const ctx1 = makeFakeCtx("not-a-quota-provider"); // fetch short-circuits to null, no network

	pi.fire("session_start", ctx1.ctx);
	await flush();

	const providerCalls = ctx1.state.setStatusCalls.filter((call) => call.id === PROVIDER_STATUS_ID);
	assert.ok(providerCalls.length >= 1, "immediate publish must reach the live session UI");
	pi.fire("session_shutdown", ctx1.ctx);
	ctx1.markStale();
	await flush();
	assert.equal(ctx1.state.staleReads, 0);
});

test("pin: timer tick after replacement publishes with the NEW session ctx", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const pi = capturePi();
	const ctx1 = makeFakeCtx("not-a-quota-provider");
	const ctx2 = makeFakeCtx("not-a-quota-provider");

	pi.fire("session_start", ctx1.ctx);
	await flush();
	assert.equal(
		ctx1.state.setStatusCalls.filter((call) => call.id === PROVIDER_STATUS_ID).length,
		1,
		"immediate publish hit ctx1 while live",
	);

	// Full replacement: shutdown (ctx still valid) → dispose → new session_start.
	pi.fire("session_shutdown", ctx1.ctx);
	ctx1.markStale();
	pi.fire("session_start", ctx2.ctx);
	await flush();

	// Timer tick on the re-armed interval must resolve the CURRENT session ctx.
	t.mock.timers.tick(10001);
	await flush();

	assert.equal(
		ctx2.state.setStatusCalls.filter((call) => call.id === PROVIDER_STATUS_ID).length,
		2,
		"post-replacement tick published with the new session ctx (immediate + tick)",
	);
	assert.equal(ctx1.state.staleReads, 0, "the old ctx must never be read after replacement");
	pi.fire("session_shutdown", ctx2.ctx);
	await flush();
});
