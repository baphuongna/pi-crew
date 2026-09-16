/**
 * M3-1 (UI-AUDIT P0-2/P1-1): the terminal-status controller must actually be
 * WIRED. Before this fix `createTerminalStatusController` was only ever
 * constructed by its own unit tests (test/unit/t4-terminal-status.test.ts);
 * `ctx.terminalStatus` was never assigned, so neither the tab title nor the
 * Ghostty OSC 9;4 progress bar ever ran in production.
 *
 * These tests drive the REAL wiring module: events go through the real
 * `runEventBus`, evaluation runs on (mocked) timers, Ghostty sequences are
 * captured through the module's `setGhosttyWriterForTest` seam, and the
 * live-agent count comes from the wiring module's probe seam.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
	__test__resetTerminalStatusWiring,
	__test__setLiveAgentProbe,
	installTerminalStatus,
	type TerminalStatusWiringDeps,
} from "../../../../src/extension/registration/terminal-status-wiring.ts";
import { runEventBus } from "../../../../src/ui/run-event-bus.ts";
import { setGhosttyWriterForTest } from "../../../../src/ui/terminal-status.ts";

/** Ghostty OSC 9;4 sequences the controller emits (mirrors terminal-status.ts). */
const SEQ_INDETERMINATE = "\u001b]9;4;3\u0007";
const SEQ_COMPLETE_100 = "\u001b]9;4;1;100\u0007";
const SEQ_CLEAR = "\u001b]9;4;0\u0007";
const IDLE_TITLE = "π-crew";

interface Harness {
	writes: string[];
	titles: string[];
	deps: TerminalStatusWiringDeps;
	dispose: () => void;
}

function makeHarness(): Harness {
	const writes: string[] = [];
	const titles: string[] = [];
	setGhosttyWriterForTest((seq: string) => writes.push(seq));
	const deps: TerminalStatusWiringDeps = {
		currentCtx: { hasUI: true, ui: { setTitle: (t: string) => titles.push(t) } },
		terminalStatus: undefined,
		terminalStatusActive: false,
	};
	// Minimal pi: registerCleanupHandler only needs pi.on(...) bookkeeping.
	const handlers = new Map<string, Array<() => void>>();
	const pi = {
		on: (event: string, handler: () => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const current = handlers.get(event) ?? [];
				const idx = current.indexOf(handler);
				if (idx >= 0) current.splice(idx, 1);
			};
		},
	} as never;
	__test__resetTerminalStatusWiring();
	installTerminalStatus(pi, deps);
	return {
		writes,
		titles,
		deps,
		// Runs the REAL dispose closure (unsubscribe + timers + controller), the
		// same fn the signal handler would call — NOT the session_shutdown path
		// (crew-cleanup.ts only wires terminalStatusDispose to SIGTERM/SIGHUP).
		dispose: () => __test__resetTerminalStatusWiring(),
	};
}

/** Advance mocked timers then flush the real microtask/macrotask queues. */
async function advance(ms: number): Promise<void> {
	// 1) Let runEventBus's microtask fan-out run and arm the (mocked) timer.
	await new Promise((resolve) => setImmediate(resolve));
	// 2) Fire the mocked timers.
	mock.timers.tick(ms);
	// 3) Let timer-callback microtasks settle before returning.
	await new Promise((resolve) => setImmediate(resolve));
}

describe("M3-1: terminal-status wiring (P0-2/P1-1)", () => {
	beforeEach(() => {
		mock.timers.enable({ apis: ["setTimeout"] });
	});

	afterEach(() => {
		__test__setLiveAgentProbe(() => 0);
		__test__resetTerminalStatusWiring();
		setGhosttyWriterForTest(undefined);
		mock.timers.reset();
	});

	it("run events construct the controller and drive the ACTIVE phase", async () => {
		const h = makeHarness();
		__test__setLiveAgentProbe(() => 2); // 2 live agents → active
		assert.equal(h.deps.terminalStatus, undefined, "controller must be lazy (constructed on first event)");

		runEventBus.emit({ type: "run_started", runId: "team_w1" });
		await advance(300); // > EVAL_DEBOUNCE_MS (250)

		assert.ok(h.deps.terminalStatus, "controller must be constructed after the first run event");
		assert.equal(h.deps.terminalStatusActive, true, "ctx.terminalStatusActive must latch in the active phase");
		assert.ok(h.writes.includes(SEQ_INDETERMINATE), `Ghostty INDETERMINATE not emitted: ${JSON.stringify(h.writes)}`);
		h.dispose();
	});

	it("an event burst collapses into ONE evaluation (debounced)", async () => {
		const h = makeHarness();
		__test__setLiveAgentProbe(() => 1);
		runEventBus.emit({ type: "run_started", runId: "team_w2" });
		runEventBus.emit({ type: "task_started", runId: "team_w2", taskId: "t1" });
		runEventBus.emit({ type: "worker_status", runId: "team_w2", taskId: "t1" });
		runEventBus.emit({ type: "task_completed", runId: "team_w2", taskId: "t1" });
		await advance(400);

		// One INDETERMINATE write per transition, not one per event.
		assert.equal(
			h.writes.filter((s) => s === SEQ_INDETERMINATE).length,
			1,
			`burst must coalesce to a single INDETERMINATE write: ${JSON.stringify(h.writes)}`,
		);
		h.dispose();
	});

	it("completion drives the flash, then IDLE (title restore + clear) after COMPLETE_FLASH_MS", async () => {
		const h = makeHarness();
		__test__setLiveAgentProbe(() => 1);
		runEventBus.emit({ type: "run_started", runId: "team_w3" });
		await advance(300);
		assert.equal(h.deps.terminalStatusActive, true);

		__test__setLiveAgentProbe(() => 0); // agents gone → idle transition
		runEventBus.emit({ type: "run_completed", runId: "team_w3" });
		await advance(300);

		assert.equal(h.deps.terminalStatusActive, false, "active flag must drop on the idle transition");
		assert.ok(h.writes.includes(SEQ_COMPLETE_100), `green flash missing: ${JSON.stringify(h.writes)}`);
		assert.ok(!h.writes.includes(SEQ_CLEAR), "flash must NOT be cleared immediately");
		assert.ok(!h.titles.includes(IDLE_TITLE), "idle title must not be set before the flash window ends");

		await advance(1500); // COMPLETE_FLASH_MS
		assert.ok(h.writes.includes(SEQ_CLEAR), `Ghostty CLEAR missing after flash: ${JSON.stringify(h.writes)}`);
		assert.ok(h.titles.includes(IDLE_TITLE), `idle title restore missing: ${JSON.stringify(h.titles)}`);
		h.dispose();
	});

	it("a new run during the flash window cancels the idle transition", async () => {
		const h = makeHarness();
		__test__setLiveAgentProbe(() => 1);
		runEventBus.emit({ type: "run_started", runId: "team_w4" });
		await advance(300);

		__test__setLiveAgentProbe(() => 0);
		runEventBus.emit({ type: "run_completed", runId: "team_w4" });
		await advance(300); // flash armed, idle pending

		__test__setLiveAgentProbe(() => 3); // another run starts before the flash ends
		runEventBus.emit({ type: "run_started", runId: "team_w5" });
		await advance(300);
		await advance(2000); // flash window fully elapsed

		assert.equal(h.deps.terminalStatusActive, true, "must be active again");
		assert.ok(!h.writes.includes(SEQ_CLEAR), "idle CLEAR must be cancelled by the new run");
		assert.ok(!h.titles.includes(IDLE_TITLE), "idle title must not be restored mid-run");
		h.dispose();
	});

	it("headless (hasUI=false) evaluates to a no-op — nothing is written", async () => {
		const h = makeHarness();
		h.deps.currentCtx = { hasUI: false, ui: { setTitle: () => undefined } };
		__test__setLiveAgentProbe(() => 5);
		runEventBus.emit({ type: "run_started", runId: "team_w6" });
		await advance(400);

		assert.equal(h.deps.terminalStatus, undefined, "no controller may be constructed headless");
		assert.deepEqual(h.writes, [], "no Ghostty writes headless");
		assert.deepEqual(h.titles, [], "no title writes headless");
		h.dispose();
	});

	it("dispose unsubscribes: later events write nothing", async () => {
		const h = makeHarness();
		__test__setLiveAgentProbe(() => 1);
		runEventBus.emit({ type: "run_started", runId: "team_w7" });
		await advance(300);
		h.dispose();
		// controller.dispose() itself best-effort-clears the Ghostty bar — that
		// write is expected, so snapshot AFTER dispose.
		const writesAfterDispose = h.writes.length;

		__test__setLiveAgentProbe(() => 0);
		runEventBus.emit({ type: "run_completed", runId: "team_w7" });
		await advance(300);
		await advance(2000);

		assert.equal(h.writes.length, writesAfterDispose, "events after dispose must not write anything");
		assert.equal(h.deps.terminalStatus, undefined, "controller must be released on dispose");
		assert.equal(h.deps.terminalStatusActive, false, "active flag must be reset on dispose");
	});
});
