/**
 * Issue #62 — foreground run completion path must survive spread-copy contexts.
 *
 * Tool-dispatched foreground runs capture `withSessionId({ ...ctx })` — a NEW
 * object — as their owner ExtensionContext. The completion block in
 * startForegroundRunImpl's `.finally()` used `isContextCurrent` (object
 * identity), which was false from the very first moment for every tool-started
 * run: stale `pi-crew foreground run <runId>...` working message forever, zero
 * `crew:run-completed` session entries, empty crew.run.* metrics (reporter:
 * 0 occurrences across 782 session files).
 *
 * Contract pinned here:
 *   - spread-copy owner (same session id): full completion side effects —
 *     working-message CLEAR, notify, crew:run-completed appendEntry,
 *     crew.run.completed event;
 *   - stale session (different current session id): reporting SKIPPED, but
 *     the working-message clear still runs (unconditional UI cleanup);
 *   - cleanedUp: same as stale-session;
 *   - failed runner: error notify reaches a spread-copy owner too.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { installForegroundRunController } from "../../../../src/extension/registration/foreground-run-controller.ts";
import type { RegistrationContext } from "../../../../src/extension/registration/registration-types.ts";
import { createRunManifest, updateRunStatus } from "../../../../src/state/stores/state-store.ts";

function makeTmpDir(prefix: string): { dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

type UiRecorder = {
	calls: { method: string; args: unknown[] }[];
	setWorkingMessage: (msg?: string) => void;
	notify: (msg: string, level: string) => void;
};

function makeUiRecorder(): UiRecorder {
	const calls: { method: string; args: unknown[] }[] = [];
	return {
		calls,
		setWorkingMessage: (msg?: string) => calls.push({ method: "setWorkingMessage", args: [msg] }),
		notify: (msg: string, level: string) => calls.push({ method: "notify", args: [msg, level] }),
	};
}

/** A session context base: hasUI=false keeps updateCrewWidget a no-op when
 * this object serves as ctx.currentCtx (the widget path early-returns). */
function makeSessionBase(cwd: string, sessionId: string): Record<string, unknown> {
	return {
		cwd,
		hasUI: false,
		ui: {},
		sessionManager: { getSessionId: () => sessionId },
	};
}

function makeRegContext(currentCtx: Record<string, unknown> | undefined): RegistrationContext {
	const ctx = {
		cleanedUp: false,
		currentCtx,
		sessionGeneration: 7,
		foregroundTeamRunControllers: new Map(),
		captureSessionGeneration: () => ctx.sessionGeneration,
		isOwnerSessionCurrent: (gen: number | undefined, oid: string | undefined) => {
			const currentSid = (ctx.currentCtx?.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.();
			return !ctx.cleanedUp && (oid === undefined || oid === currentSid) && (gen === undefined || gen === ctx.sessionGeneration);
		},
		isContextCurrent: (c: unknown, gen: number | undefined) => !ctx.cleanedUp && ctx.currentCtx === c && ctx.sessionGeneration === gen,
		widgetState: { frame: 0 },
		getManifestCache: () => new Map(),
		getRunSnapshotCache: () => new Map(),
	};
	return ctx as unknown as RegistrationContext;
}

function makePi() {
	const entries: { type: string; payload: unknown }[] = [];
	const events: { type: string; payload: unknown }[] = [];
	return {
		entries,
		events,
		pi: {
			appendEntry: (type: string, payload: unknown) => entries.push({ type, payload }),
			events: { emit: (type: string, payload: unknown) => events.push({ type, payload }) },
		},
	};
}

function completedRunIn(dir: string): string {
	const created = createRunManifest({ cwd: dir, team: { name: "fast-fix" } as never, goal: "#62 repro" });
	const running = updateRunStatus(created.manifest, "running");
	updateRunStatus(running, "completed");
	return created.manifest.runId;
}

/** Give the .finally chain a few macrotasks: setImmediate(runner) → await
 * runner → .catch/.finally → lazy watchdog stop import. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 120));

test("#62 spread-copy owner (tool path): completion side effects all fire", async () => {
	const { dir, cleanup } = makeTmpDir("pi-crew-fg62-spread-");
	try {
		const runId = completedRunIn(dir);
		const base = makeSessionBase(dir, "sess-1");
		const ctx = makeRegContext(base);
		const { pi, entries, events } = makePi();
		installForegroundRunController(pi as never, ctx);

		// THE repro shape: spread copy (≠ ctx.currentCtx) sharing sessionManager.
		const ui = makeUiRecorder();
		const extCtx = { ...base, hasUI: true, ui };
		// Sanity: the OLD guard would have been false from birth.
		assert.equal(ctx.isContextCurrent(extCtx as never, ctx.captureSessionGeneration()), false);

		ctx.startForegroundRun(extCtx as never, async () => undefined, runId);
		await settle();

		const cleared = ui.calls.filter((c) => c.method === "setWorkingMessage" && c.args[0] === undefined);
		assert.equal(cleared.length >= 1, true, `working message must be cleared, got ${JSON.stringify(ui.calls)}`);
		assert.equal(
			ui.calls.some((c) => c.method === "notify" && String(c.args[0]).includes(runId)),
			true,
			"completion notify must fire for a spread-copy owner",
		);
		assert.equal(
			entries.some((e) => e.type === "crew:run-completed"),
			true,
			"crew:run-completed session entry must be appended",
		);
		assert.equal(
			events.some((e) => e.type === "crew.run.completed"),
			true,
			"crew.run.completed event must emit",
		);
	} finally {
		cleanup();
	}
});

test("#62 stale session owner: reporting skipped, working-message clear still runs", async () => {
	const { dir, cleanup } = makeTmpDir("pi-crew-fg62-stale-");
	try {
		const runId = completedRunIn(dir);
		const ownerBase = makeSessionBase(dir, "sess-owner");
		const currentNow = makeSessionBase(dir, "sess-other"); // user switched sessions
		const ctx = makeRegContext(currentNow);
		const { pi, entries, events } = makePi();
		installForegroundRunController(pi as never, ctx);

		const ui = makeUiRecorder();
		const extCtx = { ...ownerBase, hasUI: true, ui };
		ctx.startForegroundRun(extCtx as never, async () => undefined, runId);
		await settle();

		assert.equal(
			ui.calls.some((c) => c.method === "setWorkingMessage" && c.args[0] === undefined),
			true,
			"UI clear is unconditional — a finished run must never keep spinning",
		);
		assert.equal(
			entries.some((e) => e.type === "crew:run-completed"),
			false,
			"no reporting into a foreign session",
		);
		assert.equal(
			events.some((e) => e.type === "crew.run.completed"),
			false,
		);
	} finally {
		cleanup();
	}
});

test("#62 cleanedUp registration: clear attempted, reporting skipped", async () => {
	const { dir, cleanup } = makeTmpDir("pi-crew-fg62-dead-");
	try {
		const runId = completedRunIn(dir);
		const base = makeSessionBase(dir, "sess-1");
		const ctx = makeRegContext(base);
		const { pi, entries, events } = makePi();
		installForegroundRunController(pi as never, ctx);
		(ctx as unknown as { cleanedUp: boolean }).cleanedUp = true;

		const ui = makeUiRecorder();
		const extCtx = { ...base, hasUI: true, ui };
		ctx.startForegroundRun(extCtx as never, async () => undefined, runId);
		await settle();

		assert.equal(
			entries.some((e) => e.type === "crew:run-completed"),
			false,
			"no reporting after cleanup",
		);
		// hasUI on a "disposed" fake still returns true here, so the clear
		// attempt is observable; the try/catch covers the throwing case.
		assert.equal(
			ui.calls.some((c) => c.method === "setWorkingMessage" && c.args[0] === undefined),
			true,
			"clear attempt happens even on a cleanedUp registration",
		);
	} finally {
		cleanup();
	}
});

test("#62 failed runner: error notify reaches a spread-copy owner", async () => {
	const { dir, cleanup } = makeTmpDir("pi-crew-fg62-fail-");
	try {
		const base = makeSessionBase(dir, "sess-1");
		const ctx = makeRegContext(base);
		const { pi, entries, events } = makePi();
		installForegroundRunController(pi as never, ctx);

		const ui = makeUiRecorder();
		const extCtx = { ...base, hasUI: true, ui };
		ctx.startForegroundRun(
			extCtx as never,
			async () => {
				throw new Error("boom-62");
			},
			undefined,
		);
		await settle();

		assert.equal(
			ui.calls.some((c) => c.method === "notify" && String(c.args[0]).includes("boom-62")),
			true,
			"failure notify must fire for a spread-copy owner (catch branch used the same broken identity guard)",
		);
	} finally {
		cleanup();
	}
});
