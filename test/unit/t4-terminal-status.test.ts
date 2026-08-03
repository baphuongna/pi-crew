/**
 * T4 (v0.8.3) — terminal tab title + Ghostty OSC 9;4 native progress bar.
 *
 * Distilled from pi-status (Thinkscape). Tests pin the OSC sequences, the
 * title-segment builder, and the controller lifecycle (active/complete/idle),
 * without touching a real /dev/tty (the writer is injected via the test seam).
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { clearLiveAgentsForTest } from "../../src/runtime/live-session/live-agent-manager.ts";
import {
	buildCrewTitleSegment,
	buildIdleTitle,
	createTerminalStatusController,
	GHOSTTY_PROGRESS,
	ghosttyClear,
	ghosttyComplete,
	ghosttyWorking,
	setGhosttyProgress,
	setGhosttyWriterForTest,
	setTerminalTitle,
} from "../../src/ui/terminal-status.ts";

function capturingWriter(): { write: (s: string) => void; seqs: string[] } {
	const seqs: string[] = [];
	return {
		write: (s: string) => seqs.push(s),
		get seqs() {
			return seqs;
		},
	};
}

function mockCtx(hasUI = true): {
	hasUI: boolean;
	ui: { setTitle(title: string): void; titles: string[] };
} {
	const titles: string[] = [];
	return {
		hasUI,
		ui: {
			setTitle(title: string) {
				titles.push(title);
			},
			get titles() {
				return titles;
			},
		},
	};
}

afterEach(() => {
	setGhosttyWriterForTest(undefined);
	clearLiveAgentsForTest();
});

describe("T4: OSC 9;4 sequence shape", () => {
	test("setGhosttyProgress emits the OSC 9;4 sequence with state only", () => {
		const cap = capturingWriter();
		setGhosttyWriterForTest(cap.write);
		setGhosttyProgress(GHOSTTY_PROGRESS.CLEAR);
		assert.deepEqual(cap.seqs, ["\x1b]9;4;0\x07"]);
	});

	test("setGhosttyProgress emits state + value when value given", () => {
		const cap = capturingWriter();
		setGhosttyWriterForTest(cap.write);
		setGhosttyProgress(GHOSTTY_PROGRESS.SET, 100);
		assert.deepEqual(cap.seqs, ["\x1b]9;4;1;100\x07"]);
	});

	test("ghosttyWorking = state 3 (indeterminate)", () => {
		const cap = capturingWriter();
		setGhosttyWriterForTest(cap.write);
		ghosttyWorking();
		assert.deepEqual(cap.seqs, ["\x1b]9;4;3\x07"]);
	});

	test("ghosttyComplete = state 1 value 100 (green flash)", () => {
		const cap = capturingWriter();
		setGhosttyWriterForTest(cap.write);
		ghosttyComplete();
		assert.deepEqual(cap.seqs, ["\x1b]9;4;1;100\x07"]);
	});

	test("ghosttyClear = state 0", () => {
		const cap = capturingWriter();
		setGhosttyWriterForTest(cap.write);
		ghosttyClear();
		assert.deepEqual(cap.seqs, ["\x1b]9;4;0\x07"]);
	});

	test("default writer does not throw when /dev/tty is absent (best-effort)", () => {
		// No injected writer → uses default (/dev/tty). In the test env /dev/tty
		// may be absent; the call must NOT throw. If /dev/tty exists, the write
		// is harmless (a few control bytes).
		assert.doesNotThrow(() => setGhosttyProgress(GHOSTTY_PROGRESS.CLEAR));
	});
});

describe("T4: title-segment builder", () => {
	test("buildCrewTitleSegment is empty when no live agents", () => {
		clearLiveAgentsForTest();
		assert.equal(buildCrewTitleSegment(), "");
	});

	test("buildIdleTitle is the π-crew prefix", () => {
		assert.equal(buildIdleTitle(), "π-crew");
	});
});

describe("T4: setTerminalTitle", () => {
	test("setTitle called on the ctx when hasUI", () => {
		const ctx = mockCtx(true);
		setTerminalTitle(ctx, "hello");
		assert.deepEqual(ctx.ui.titles, ["hello"]);
	});

	test("setTitle is a no-op when hasUI is false", () => {
		const ctx = mockCtx(false);
		setTerminalTitle(ctx, "hello");
		assert.deepEqual(ctx.ui.titles, []);
	});

	test("setTitle swallows errors (cosmetic, never surfaces)", () => {
		const ctx = {
			hasUI: true,
			ui: {
				setTitle() {
					throw new Error("boom");
				},
			},
		};
		assert.doesNotThrow(() => setTerminalTitle(ctx, "hello"));
	});
});

describe("T4: controller lifecycle", () => {
	test("onRunsActive sets indeterminate Ghostty progress (no throw, no live agents)", () => {
		const cap = capturingWriter();
		setGhosttyWriterForTest(cap.write);
		const ctx = mockCtx(true);
		const ctrl = createTerminalStatusController(ctx);
		// No live agents → title segment empty, but Ghostty indeterminate still fires.
		assert.doesNotThrow(() => ctrl.onRunsActive());
		assert.ok(cap.seqs.includes("\x1b]9;4;3\x07"), "should emit indeterminate progress");
		ctrl.dispose();
	});

	test("onRunCompleted emits the green completion flash (state 1/100)", () => {
		const cap = capturingWriter();
		setGhosttyWriterForTest(cap.write);
		const ctx = mockCtx(true);
		const ctrl = createTerminalStatusController(ctx);
		ctrl.onRunCompleted();
		assert.ok(cap.seqs.includes("\x1b]9;4;1;100\x07"), "should emit completion flash");
		ctrl.dispose();
	});

	test("onIdle clears progress and restores the idle title", () => {
		const cap = capturingWriter();
		setGhosttyWriterForTest(cap.write);
		const ctx = mockCtx(true);
		const ctrl = createTerminalStatusController(ctx);
		ctrl.onIdle();
		assert.ok(cap.seqs.includes("\x1b]9;4;0\x07"), "should clear progress");
		assert.ok(ctx.ui.titles.includes("π-crew"), "should restore idle title");
		ctrl.dispose();
	});

	test("dispose clears progress and stops further writes", () => {
		const cap = capturingWriter();
		setGhosttyWriterForTest(cap.write);
		const ctx = mockCtx(true);
		const ctrl = createTerminalStatusController(ctx);
		ctrl.dispose();
		const before = cap.seqs.length;
		ctrl.onRunsActive();
		ctrl.onRunCompleted();
		assert.equal(cap.seqs.length, before, "no writes after dispose");
	});

	test("dispose itself is idempotent (no throw on double-dispose)", () => {
		const ctx = mockCtx(true);
		const ctrl = createTerminalStatusController(ctx);
		assert.doesNotThrow(() => ctrl.dispose());
		assert.doesNotThrow(() => ctrl.dispose());
	});
});
