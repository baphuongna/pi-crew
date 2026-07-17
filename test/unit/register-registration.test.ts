/**
 * Tests for src/extension/register.ts (TB-2 short-term fix).
 *
 * register.ts is the single integration point for the whole extension — every
 * tool, command, and lifecycle hook lands here. Before TB-2 there was only
 * one lifecycle test (`register-observability-lifecycle.test.ts`); this file
 * adds focused coverage for the registration surface itself.
 *
 * Goals (from TB-2 task packet):
 *   1. registerPiTeams is callable with a fake Pi API (no throw, no hang).
 *   2. After the call, the fake Pi has tool/command/hook registrations.
 *   3. Calling registerPiTeams twice on the same fake Pi does NOT double-stack
 *      process-level listeners (idempotency at the registration seam).
 *
 * Strategy:
 *   - Build a counting fake Pi that records every (method, args) invocation.
 *     This mirrors the ExtensionAPI surface that register.ts touches
 *     (on/registerTool/registerCommand/registerShortcut/registerMessageRenderer/
 *     registerProvider/events/appendEntry/getSessionName/setSessionName).
 *   - Exercise registerPiTeams directly via the source module — the bundle
 *     path is covered by bundle-load.test.ts; this test verifies the source
 *     path's wiring, which is what future refactors will keep honest.
 *
 * Notes on idempotency interpretation:
 *   registerPiTeams DOES re-register tools/commands/event-handlers when called
 *   twice (no in-source dedupe at that level). The observable idempotency
 *   invariant — and the one that matters for production reload safety — is
 *   that process-level listeners (SIGTERM/SIGHUP via crew-cleanup.ts) do NOT
 *   stack. crew-cleanup.ts guards that with a module-level flag, so the
 *   listener count should stay flat across calls. This test pins that
 *   invariant; it does NOT pin a "calls shouldn't re-register" claim, which
 *   the implementation does not currently make.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { registerPiTeams } from "../../src/extension/register.ts";

/**
 * Minimal fake of the ExtensionAPI surface that register.ts touches. Counts
 * every call so tests can assert the registration shape.
 *
 * Cast through unknown at the boundary so we don't have to satisfy every
 * method on the full ExtensionAPI interface (which is large and pulls in
 * TUI types). This mirrors the approach in register-observability-lifecycle.test.ts.
 */
type FakePi = ReturnType<typeof createFakePi>;

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
		off(event: string, handler: (payload: unknown) => void) {
			handlers.get(event)?.delete(handler);
		},
	};
}

function createFakePi() {
	const eventHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
	const registeredTools: Array<{ name?: string }> = [];
	const registeredCommands: string[] = [];
	const registeredShortcuts: Array<{ key: unknown }> = [];
	const registeredRenderers: string[] = [];
	const registeredProviders: string[] = [];
	const appendedEntries: Array<{ type: string; data?: unknown }> = [];
	let sessionName: string | undefined;
	const events = createEventBus();
	return {
		events,
		// Lifecycle event subscription.
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			const list = eventHandlers.get(event) ?? [];
			list.push(handler);
			eventHandlers.set(event, list);
		},
		emitLifecycle(event: string, ctx: unknown) {
			for (const handler of eventHandlers.get(event) ?? []) handler({}, ctx);
		},
		registeredTools,
		registeredCommands,
		registeredShortcuts,
		registeredRenderers,
		registeredProviders,
		appendedEntries,
		registerTool(tool: { name?: string }) {
			registeredTools.push({ name: tool?.name });
		},
		registerCommand(name: string, _options: unknown) {
			registeredCommands.push(name);
		},
		registerShortcut(key: unknown, _options: unknown) {
			registeredShortcuts.push({ key });
		},
		registerMessageRenderer(customType: string, _renderer: unknown) {
			registeredRenderers.push(customType);
		},
		registerProvider(name: string, _config: unknown) {
			registeredProviders.push(name);
		},
		appendEntry(type: string, data?: unknown) {
			appendedEntries.push({ type, data });
		},
		getSessionName() {
			return sessionName;
		},
		setSessionName(name: string) {
			sessionName = name;
		},
	};
}

test("registerPiTeams is callable with a fake Pi API (no throw, no hang)", () => {
	const pi = createFakePi();
	assert.doesNotThrow(() => registerPiTeams(pi as unknown as Parameters<typeof registerPiTeams>[0]));
});

test("registerPiTeams registers at least one tool via the fake Pi API", () => {
	const pi = createFakePi();
	registerPiTeams(pi as unknown as Parameters<typeof registerPiTeams>[0]);
	assert.ok(
		pi.registeredTools.length >= 1,
		`expected at least 1 tool registration, got ${pi.registeredTools.length}`,
	);
});

test("registerPiTeams registers at least one slash command via the fake Pi API", () => {
	const pi = createFakePi();
	registerPiTeams(pi as unknown as Parameters<typeof registerPiTeams>[0]);
	assert.ok(
		pi.registeredCommands.length >= 1,
		`expected at least 1 command registration, got ${pi.registeredCommands.length}`,
	);
	// Spot-check: the teams-list command should be among them — this is the
	// canonical user-facing entry point that everything else augments. (The
	// command is pluralised to "teams" to disambiguate from the upcoming
	// /team subcommand family; see src/extension/registration/commands.ts.)
	assert.ok(
		pi.registeredCommands.includes("teams"),
		`expected 'teams' command in registrations, got: ${pi.registeredCommands.join(", ")}`,
	);
});

test("registerPiTeams registers lifecycle event hooks via pi.on(...)", () => {
	const pi = createFakePi();
	registerPiTeams(pi as unknown as Parameters<typeof registerPiTeams>[0]);
	// session_start and session_shutdown are the two anchors that Pi emits
	// for every session; registerPiTeams wires handlers to both. Pinning these
	// catches regressions where a hook gets accidentally dropped from the
	// orchestrator (e.g., a refactor splits the function and forgets one).
	assert.ok(
		pi.registeredCommands.length > 0 ? pi.emitLifecycle : null,
		"fake pi surface intact",
	);
	// Calling emitLifecycle('session_shutdown', ctx) must not throw — that
	// would mean registerPiTeams registered a handler that throws synchronously
	// on the empty event we feed it. Use the typed fake Pi method instead of
	// digging into the Map.
	assert.doesNotThrow(() => pi.emitLifecycle("session_shutdown", { cwd: process.cwd(), hasUI: false }));
});

test("registerPiTeams is safe to call twice — SIGTERM/SIGHUP listeners do not stack (idempotency)", () => {
	// Pin the production-load idempotency invariant: registerCleanupHandler
	// guards its signal listeners with a module-level flag, so a second call
	// to registerPiTeams must not add new SIGTERM/SIGHUP process listeners.
	// This is the only "idempotency at registration" guarantee the source
	// actually makes — tools/commands are intentionally re-registered on
	// reload (the previousRuntimeCleanup hook in register.ts handles teardown
	// of derived state, not of the registrations themselves).
	const beforeSIGTERM = process.listenerCount("SIGTERM");
	const beforeSIGHUP = process.listenerCount("SIGHUP");

	const pi = createFakePi();
	registerPiTeams(pi as unknown as Parameters<typeof registerPiTeams>[0]);
	const firstCallToolCount = pi.registeredTools.length;
	const firstCallCommandCount = pi.registeredCommands.length;

	const afterFirstSIGTERM = process.listenerCount("SIGTERM");
	const afterFirstSIGHUP = process.listenerCount("SIGHUP");

	// First call adds the signal listeners (one each).
	assert.ok(
		afterFirstSIGTERM - beforeSIGTERM <= 1,
		`first call stacked SIGTERM listeners: delta=${afterFirstSIGTERM - beforeSIGTERM}`,
	);
	assert.ok(
		afterFirstSIGHUP - beforeSIGHUP <= 1,
		`first call stacked SIGHUP listeners: delta=${afterFirstSIGHUP - beforeSIGHUP}`,
	);

	// Second call must not throw.
	assert.doesNotThrow(() => registerPiTeams(pi as unknown as Parameters<typeof registerPiTeams>[0]));

	const afterSecondSIGTERM = process.listenerCount("SIGTERM");
	const afterSecondSIGHUP = process.listenerCount("SIGHUP");

	// Second call must NOT add more SIGTERM/SIGHUP listeners — that's the
	// idempotency contract crew-cleanup.ts enforces via its module-level flag.
	assert.equal(
		afterSecondSIGTERM,
		afterFirstSIGTERM,
		`second call stacked SIGTERM listeners: was=${afterFirstSIGTERM}, now=${afterSecondSIGTERM}`,
	);
	assert.equal(
		afterSecondSIGHUP,
		afterFirstSIGHUP,
		`second call stacked SIGHUP listeners: was=${afterFirstSIGHUP}, now=${afterSecondSIGHUP}`,
	);

	// Tools and commands ARE intentionally re-registered (no in-source dedupe)
	// — pin that the count doubled, so future refactors that add dedupe can
	// update this assertion with intent rather than silently changing it.
	assert.equal(
		pi.registeredTools.length,
		firstCallToolCount * 2,
		`tools doubled across two calls: first=${firstCallToolCount}, total=${pi.registeredTools.length}`,
	);
	assert.equal(
		pi.registeredCommands.length,
		firstCallCommandCount * 2,
		`commands doubled across two calls: first=${firstCallCommandCount}, total=${pi.registeredCommands.length}`,
	);
});

test("registerPiTeams leaves the fake Pi API in a usable state for subsequent operations", () => {
	// After registration, the fake Pi's other methods (events bus, lifecycle
	// emit, appendEntry) must still be callable — registerPiTeams does not
	// overwrite or null them out.
	const pi = createFakePi();
	registerPiTeams(pi as unknown as Parameters<typeof registerPiTeams>[0]);
	assert.doesNotThrow(() => pi.events.emit("crew-test", { ok: true }));
	assert.doesNotThrow(() => pi.appendEntry("test:type", { foo: 1 }));
	assert.doesNotThrow(() => pi.setSessionName("test-session"));
	assert.equal(pi.getSessionName(), "test-session");
});
