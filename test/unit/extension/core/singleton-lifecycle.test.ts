/**
 * EXT-9: singleton lifecycle tests.
 *
 * Asserts the pi-crew singletons (CrewRegistry + CrewScheduler) are
 * module-scoped (NOT on `globalThis[Symbol.for(...)]`), register/unregister
 * cleanly, and that a second "load" (dynamic re-import) of the same module
 * shares the single module-scoped instance within a session.
 *
 * @see src/extension/team-tool.ts (CrewRegistry)
 * @see src/extension/team-tool/handle-schedule.ts (CrewScheduler)
 */

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { getCrewScheduler, registerCrewScheduler, unregisterCrewScheduler } from "../../../../src/extension/team-tool/handle-schedule.ts";
import {
	getCrewGlobalRegistry,
	installCrewGlobalRegistry,
	registerCrewGlobalRegistry,
	uninstallCrewGlobalRegistry,
} from "../../../../src/extension/team-tool.ts";

const REGISTRY_KEY = Symbol.for("pi-crew:registry");
const SCHEDULER_KEY = Symbol.for("pi-crew:scheduler");

/** Read globalThis defensively for the (now-removed) singleton keys. */
function globalForKey(key: symbol): unknown {
	return (globalThis as Record<symbol | string, unknown>)[key];
}

// Snapshot module-scoped state so we can restore it after the suite (other
// suites in the same process — e.g. team-tool-schedule.test.ts — also touch the
// scheduler singleton). Restore in `after` to avoid cross-test bleed.
const savedRegistry = getCrewGlobalRegistry();
const savedScheduler = getCrewScheduler();

afterEach(() => {
	// Defensive: leave the singletons in a clean state between cases.
	uninstallCrewGlobalRegistry();
	unregisterCrewScheduler();
});

after(() => {
	// Restore whatever was registered before this suite ran.
	if (savedRegistry) registerCrewGlobalRegistry(savedRegistry);
	if (savedScheduler) registerCrewScheduler(savedScheduler);
});

describe("EXT-9 CrewRegistry singleton (team-tool.ts)", () => {
	it("is module-scoped: register does NOT write to globalThis[Symbol.for]", () => {
		assert.strictEqual(globalForKey(REGISTRY_KEY), undefined, "globalThis must be clean before register");

		const sentinel = { version: 2 } as never;
		registerCrewGlobalRegistry(sentinel);

		// The fix: the singleton lives in module scope, NOT on globalThis.
		assert.strictEqual(globalForKey(REGISTRY_KEY), undefined, "register must not pollute globalThis");
		assert.strictEqual(getCrewGlobalRegistry(), sentinel, "module-scoped getter returns the registered instance");
	});

	it("registers and unregisters cleanly", () => {
		assert.strictEqual(getCrewGlobalRegistry(), undefined, "starts empty");

		const sentinel = { version: 2 } as never;
		registerCrewGlobalRegistry(sentinel);
		assert.strictEqual(getCrewGlobalRegistry(), sentinel);

		uninstallCrewGlobalRegistry();
		assert.strictEqual(getCrewGlobalRegistry(), undefined, "uninstall clears the singleton");
		assert.strictEqual(globalForKey(REGISTRY_KEY), undefined, "globalThis never touched");
	});

	it("installCrewGlobalRegistry builds and installs a real registry (no globalThis stub)", () => {
		assert.strictEqual(globalForKey(REGISTRY_KEY), undefined);

		installCrewGlobalRegistry({
			manifestCache: { get: () => undefined, list: () => [] },
			cwdProvider: () => "/tmp",
		});

		const reg = getCrewGlobalRegistry();
		assert.ok(reg, "install produced a registry");
		assert.strictEqual(reg?.version, 2);
		// install must not leak onto globalThis.
		assert.strictEqual(globalForKey(REGISTRY_KEY), undefined);

		uninstallCrewGlobalRegistry();
		assert.strictEqual(getCrewGlobalRegistry(), undefined);
	});

	it("a second 'load' (dynamic re-import) shares the same module-scoped instance", async () => {
		const sentinel = { version: 2 } as never;
		registerCrewGlobalRegistry(sentinel);

		// Dynamic re-import resolves to the SAME ES module namespace, so the
		// module-scoped `let` is shared — a second "load" sees the registered
		// instance. (The old globalThis pattern had no such guarantee against
		// peer-extension tampering.)
		const mod2 = await import("../../../../src/extension/team-tool.ts");
		assert.strictEqual(mod2.getCrewGlobalRegistry(), sentinel, "second load sees the same singleton instance");
		assert.strictEqual(globalForKey(REGISTRY_KEY), undefined);
	});
});

describe("EXT-9 CrewScheduler singleton (handle-schedule.ts)", () => {
	function makeSchedulerRef(): {
		add(): void;
		list(): never[];
		remove(): boolean;
		update(): undefined;
	} {
		return {
			add() {
				/* no-op */
			},
			list() {
				return [];
			},
			remove() {
				return false;
			},
			update() {
				return undefined;
			},
		};
	}

	it("is module-scoped: register does NOT write to globalThis[Symbol.for]", () => {
		assert.strictEqual(globalForKey(SCHEDULER_KEY), undefined, "globalThis must be clean before register");

		const ref = makeSchedulerRef() as never;
		registerCrewScheduler(ref);

		assert.strictEqual(globalForKey(SCHEDULER_KEY), undefined, "register must not pollute globalThis");
		assert.strictEqual(getCrewScheduler(), ref, "module-scoped getter returns the registered instance");
	});

	it("registers and unregisters cleanly", () => {
		assert.strictEqual(getCrewScheduler(), undefined, "starts empty");

		const ref = makeSchedulerRef() as never;
		registerCrewScheduler(ref);
		assert.strictEqual(getCrewScheduler(), ref);

		unregisterCrewScheduler();
		assert.strictEqual(getCrewScheduler(), undefined, "unregister clears the singleton");
		assert.strictEqual(globalForKey(SCHEDULER_KEY), undefined, "globalThis never touched");
	});

	it("a second 'load' (dynamic re-import) shares the same module-scoped instance", async () => {
		const ref = makeSchedulerRef() as never;
		registerCrewScheduler(ref);

		const mod2 = await import("../../../../src/extension/team-tool/handle-schedule.ts");
		assert.strictEqual(mod2.getCrewScheduler(), ref, "second load sees the same singleton instance");
		assert.strictEqual(globalForKey(SCHEDULER_KEY), undefined);
	});
});
