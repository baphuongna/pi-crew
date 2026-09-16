/**
 * M1-6 / P1-3 — host wiring for the live conversation overlay.
 *
 * Before this fix `openLiveConversation`'s custom component only handled
 * `escape`/`q`: every scroll keypress was swallowed, so the live transcript
 * could never be scrolled. This file covers ONLY the host component returned
 * to `ctx.ui.custom`:
 *   - non-close keys are forwarded to `LiveConversationOverlay.handleInput`
 *     (observable through the rendered window, which is all the host owns);
 *   - `escape`/`q` keep the pre-existing semantics exactly: `overlay.close()`
 *     followed by `done(undefined)`, exactly once;
 *   - the overlay options passed to `ctx.ui.custom` are unchanged.
 *
 * Scrolling semantics themselves are covered by
 * test/unit/runtime/live-session/live-conversation-overlay.test.ts.
 *
 * No HOME/repo writes: the live-agent registry is in-memory and the fake ctx
 * exposes nothing that touches disk (cwd is a throw-away tmpdir).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openLiveConversation } from "../../../../src/extension/registration/viewers.ts";
import { clearLiveAgentsForTest, registerLiveAgent } from "../../../../src/runtime/live-session/live-agent-manager.ts";

type HostComponent = {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
};

type HostOptions = {
	overlay?: boolean;
	overlayOptions?: { width?: string; maxHeight?: string; anchor?: string };
};

const tmpDirs: string[] = [];

afterEach(() => {
	clearLiveAgentsForTest();
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Fake host: registers one live agent, captures the component factory given to
 * `ctx.ui.custom` (plus its options) and exposes the session event emitter so a
 * test can stream lines exactly like a real live agent would.
 */
function makeHost(): {
	ctx: unknown;
	component(): HostComponent;
	options(): HostOptions | undefined;
	doneCalls(): number;
	emit(event: unknown): void;
} {
	const cwd = mkdtempSync(join(tmpdir(), "viewers-live-"));
	tmpDirs.push(cwd);
	let component: HostComponent | undefined;
	let options: HostOptions | undefined;
	let doneCalls = 0;
	let emit: (event: unknown) => void = () => {
		/* replaced once the overlay subscribes */
	};
	const session = {
		subscribe(cb: (event: unknown) => void): () => void {
			emit = cb;
			return () => undefined;
		},
	};
	registerLiveAgent({
		agentId: "agent-1",
		taskId: "task-1",
		runId: "run-1",
		workspaceId: "ws-1",
		role: "executor",
		agent: "worker",
		description: "building feature",
		status: "running",
		session,
	} as unknown as Parameters<typeof registerLiveAgent>[0]);
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			select: async () => undefined,
			custom: async (
				factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: undefined) => void) => HostComponent,
				opts?: HostOptions,
			) => {
				options = opts;
				component = factory({ terminal: { columns: 80, rows: 12 } }, {}, {}, () => {
					doneCalls++;
				});
			},
		},
	};
	return {
		ctx,
		component: () => {
			assert.ok(component, "ctx.ui.custom must build the overlay component");
			return component;
		},
		options: () => options,
		doneCalls: () => doneCalls,
		emit: (event) => emit(event),
	};
}

test("M1-6 host: scroll keys reach the overlay without closing it (g / G)", async () => {
	const host = makeHost();
	assert.equal(await openLiveConversation(host.ctx as never, "run-1", "task-1"), true, "overlay opened");
	const comp = host.component();

	// Overlay options must stay exactly as they were before this fix.
	assert.deepEqual(host.options(), {
		overlay: true,
		overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" },
	});

	try {
		for (let i = 0; i < 30; i++) host.emit({ text: `line ${i}` });
		const tail = comp.render(80).join("\n");
		assert.ok(tail.includes("line 29"), "streamed tail line is rendered");
		assert.ok(tail.includes("auto-scroll"), "footer announces auto-scroll while tailing");

		// `g` must travel host -> overlay and move the viewport.
		comp.handleInput("g");
		assert.equal(host.doneCalls(), 0, "scroll keys must not close the overlay");
		const top = comp.render(80).join("\n");
		assert.ok(top.includes("line 0"), "host renders the top window after g");
		assert.ok(!top.includes("line 29"), "newest line left the window after g");
		assert.ok(top.includes("manual"), "footer flips to manual after g");

		// k/↑ scroll back one line, G returns to the live tail.
		comp.handleInput("k");
		assert.equal(host.doneCalls(), 0);
		comp.handleInput("\x1b[B"); // down arrow
		comp.handleInput("G");
		const back = comp.render(80).join("\n");
		assert.ok(back.includes("line 29"), "G returns to the newest line");
		assert.ok(back.includes("auto-scroll"), "footer flips back to auto-scroll after G");

		// The `a` toggle is forwarded too.
		comp.handleInput("a");
		assert.ok(comp.render(80).join("\n").includes("manual"), "a pauses auto-scroll");
		assert.equal(host.doneCalls(), 0, "a must not close the overlay");
	} finally {
		comp.dispose();
	}
});

test("M1-6 host: esc and q keep the pre-existing close semantics (close + done once)", async () => {
	const escHost = makeHost();
	assert.equal(await openLiveConversation(escHost.ctx as never, "run-1", "task-1"), true);
	const escComp = escHost.component();
	escComp.handleInput("\x1b");
	assert.equal(escHost.doneCalls(), 1, "escape closes exactly once");
	escComp.dispose();

	const qHost = makeHost();
	assert.equal(await openLiveConversation(qHost.ctx as never, "run-1", "task-1"), true);
	const qComp = qHost.component();
	qComp.handleInput("q");
	assert.equal(qHost.doneCalls(), 1, "q closes exactly once");
	qComp.dispose();
});

test("M1-6 host: unknown keys are ignored (no scroll, no close)", async () => {
	const host = makeHost();
	assert.equal(await openLiveConversation(host.ctx as never, "run-1", "task-1"), true);
	const comp = host.component();
	try {
		for (let i = 0; i < 30; i++) host.emit({ text: `line ${i}` });
		comp.handleInput("g");
		const top = comp.render(80).join("\n");
		comp.handleInput("z");
		assert.equal(comp.render(80).join("\n"), top, "unknown key does not move the viewport");
		assert.equal(host.doneCalls(), 0, "unknown key does not close the overlay");
	} finally {
		comp.dispose();
	}
});
