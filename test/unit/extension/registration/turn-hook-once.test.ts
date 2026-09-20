/**
 * RR-018 F12 (session-lifecycle ownership).
 *
 * The before_agent_start reconcile hook used to be registered inside
 * configureObservability — i.e. once per session_start — and never removed
 * (there is no pi.off). Across switches the hooks accumulated: 1 → dispose →
 * 1 → session B → 2, and one turn fired a reconcile for the OLD session's cwd
 * (flipping the shared manifest cache back and disposing the current
 * session's cache).
 *
 * The hook is now registered exactly ONCE for the extension lifetime
 * (installLazyConfigurers → installTurnReconcileHook) and resolves the
 * CURRENT session context at fire time. This test drives the real
 * registerPiTeams + session lifecycle events for ≥3 cycles and asserts the
 * hook count never grows.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { registerPiTeams } from "../../../../src/extension/register.ts";

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
	const hookCounts = new Map<string, number>();
	return {
		events,
		hookCounts,
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			hookCounts.set(event, (hookCounts.get(event) ?? 0) + 1);
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

test("F12: before_agent_start hook count stays at 1 across repeated session cycles", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "f12-hook-home-"));
	const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "f12-hook-a-"));
	const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "f12-hook-b-"));
	fs.writeFileSync(path.join(cwdA, "package.json"), "{}\n", "utf-8");
	fs.writeFileSync(path.join(cwdB, "package.json"), "{}\n", "utf-8");
	const prevHome = process.env.PI_CREW_HOME;
	process.env.PI_CREW_HOME = home;
	try {
		const events = createEventBus();
		const pi = createFakePi(events);
		await registerPiTeams(pi as never);

		const counts: number[] = [];
		const cwds = [cwdA, cwdB, cwdA, cwdB];
		for (let cycle = 0; cycle < cwds.length; cycle += 1) {
			pi.emitLifecycle("session_start", makeSessionCtx(cwds[cycle], `sess-${cycle + 1}`));
			// configureObservability is fire-and-forget: give the lazy imports
			// (and, on the pre-fix code, the per-session hook registration)
			// time to land before counting.
			await sleep(250);
			counts.push(pi.hookCounts.get("before_agent_start") ?? 0);
			pi.emitLifecycle("session_shutdown", makeSessionCtx(cwds[cycle], `sess-${cycle + 1}`), { reason: "resume" });
		}

		// Baseline observed one EXTRA hook per session_start (never removed:
		// 1 → 2 → 3 → 4 accumulated). The fix registers the reconcile hook
		// exactly once at extension registration, so the count must be STABLE
		// across cycles (other registration-time hooks may exist — they are
		// one-time too, so the baseline count just stays put).
		const baselineCount = counts[0];
		assert.ok(baselineCount >= 1, "expected at least one before_agent_start hook after registration");
		for (let index = 0; index < counts.length; index += 1) {
			assert.equal(
				counts[index],
				baselineCount,
				`cycle ${index + 1}: before_agent_start hook count must not grow (got ${counts[index]}, expected ${baselineCount})`,
			);
		}
	} finally {
		if (prevHome === undefined) delete process.env.PI_CREW_HOME;
		else process.env.PI_CREW_HOME = prevHome;
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(cwdA, { recursive: true, force: true });
		fs.rmSync(cwdB, { recursive: true, force: true });
	}
});
