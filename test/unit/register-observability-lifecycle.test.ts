import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { registerPiTeams } from "../../src/extension/register.ts";

function createEventBus() {
	const handlers = new Map<string, Set<(payload: unknown) => void>>();
	return {
		on(event: string, handler: (payload: unknown) => void) {
			const set = handlers.get(event) ?? new Set<(payload: unknown) => void>();
			set.add(handler);
			handlers.set(event, set);
			return () => { set.delete(handler); };
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

function createFakePi(events: ReturnType<typeof createEventBus>) {
	const lifecycle = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
	return {
		events,
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			const handlers = lifecycle.get(event) ?? [];
			handlers.push(handler);
			lifecycle.set(event, handlers);
		},
		emitLifecycle(event: string, ctx: unknown) {
			for (const handler of lifecycle.get(event) ?? []) handler({}, ctx);
		},
		registerCommand() {},
		registerTool() {},
		appendEntry() {},
		getSessionName() { return undefined; },
		setSessionName() {},
	};
}

test("registerPiTeams leaves no observability event subscriptions after repeated session shutdown", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-lifecycle-test-"));
	try {
		fs.writeFileSync(path.join(cwd, "package.json"), "{}\n", "utf-8");
		const events = createEventBus();
		const pi = createFakePi(events);
		registerPiTeams(pi as never);
		const ctx = { cwd, hasUI: false, ui: { notify() {}, setWorkingMessage() {} } };
		for (let index = 0; index < 3; index += 1) {
			pi.emitLifecycle("session_start", ctx);
			assert.ok(events.totalSubscriptions() > 0, "session_start should register event subscriptions");
			pi.emitLifecycle("session_shutdown", ctx);
			assert.equal(events.totalSubscriptions(), 0, `cycle ${index + 1} leaked event subscriptions`);
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
