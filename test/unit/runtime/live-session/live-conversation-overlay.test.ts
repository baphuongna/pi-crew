/**
 * UI-13: Basic coverage for src/ui/live-conversation-overlay.ts.
 *
 * E1 / M4 (2026-09-16): the overlay moved to the RAIL design language
 * (docs/UI-DESIGN-SYSTEM.md §2.E) — the rounded `╭─╮│╰─╯` frame and its two
 * `│ ──── │` rules are retired in favour of `┏ LIVE ▸ <agent>` / `┃` body /
 * `┗ <hint> ···· <state>`. Chrome therefore drops from 6 rows to 3
 * (canopy + meta + close cap), so the viewport is `rows - 3` instead of
 * `rows - 6`; the frame/hint assertions below were adapted, while EVERY scroll
 * / clamp / autoScroll behaviour assertion is unchanged (the migration is a
 * visual-language change, not a behaviour change).
 *
 * LiveConversationOverlay shows streaming output from a live-session agent.
 * Constructor takes a LiveAgentHandle + CrewTheme (+ optional columns/rows).
 * On construct it subscribes to handle.session.subscribe (if present) and
 * starts a poll timer (unref'd) that refreshes a summary line. Public surface:
 * `cachedLines`, static `MAX_CACHED_LINES`, `render(width?)`, `close()`,
 * `dispose()`.
 *
 * Only the LiveAgentHandle *type* is imported (erased at runtime) so the test
 * avoids pulling heavy runtime modules; handles are built inline.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { LiveAgentHandle } from "../../../../src/runtime/live-session/live-agent-manager.ts";
import { LiveConversationOverlay } from "../../../../src/ui/live-conversation-overlay.ts";
import type { CrewTheme } from "../../../../src/ui/theme-adapter.ts";

// No-op theme keeps render output plain and deterministic.
const theme: CrewTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
	inverse: (text) => text,
};

/** Build a minimal, valid LiveAgentHandle for tests. */
function makeHandle(overrides: { session?: Record<string, unknown>; status?: string } = {}): LiveAgentHandle {
	return {
		agentId: "agent-1",
		taskId: "task-1",
		runId: "run-1",
		workspaceId: "ws-1",
		role: "executor",
		agent: "worker",
		description: "building feature",
		modelName: "sonnet",
		session: (overrides.session ?? {}) as LiveAgentHandle["session"],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		status: (overrides.status ?? "running") as LiveAgentHandle["status"],
		pendingSteers: [],
		pendingFollowUps: [],
		pendingMessages: [],
		activity: {
			activeTools: new Map(),
			toolUses: 3,
			turnCount: 2,
			maxTurns: 10,
			responseText: "",
			compactionCount: 0,
			startedAtMs: Date.now() - 5000,
			completedAtMs: 0,
			modelName: undefined,
		},
	} as unknown as LiveAgentHandle;
}

test("renders a framed overlay with the agent name, summary, and close hint", () => {
	const overlay = new LiveConversationOverlay(makeHandle(), theme, 80, 24);
	try {
		const lines = overlay.render();
		assert.ok(lines.length > 0);
		assert.ok(lines[0].startsWith("┏ LIVE ▸ "), "canopy opens the surface");
		assert.ok(lines[lines.length - 1].startsWith("┗ "), "close cap ends the surface");
		assert.equal(
			lines.some((line) => /[╭╮╰╯├┤]/.test(line)),
			false,
			"the retired rounded-box glyphs must not be rendered",
		);
		const out = lines.join("\n");
		assert.ok(out.includes("worker"), "agent name in header");
		assert.ok(out.includes("Esc/Q close"), "footer hint spells the canonical Esc (never ESC/esc)");
		assert.ok(out.includes("turn"), "turn counter in header");
		// refreshSummary() seeds one summary line at construction time
		assert.ok(overlay.cachedLines.length >= 1);
	} finally {
		overlay.close();
	}
});

test("render returns an empty array for a very narrow width", () => {
	const overlay = new LiveConversationOverlay(makeHandle(), theme, 80, 24);
	try {
		assert.deepEqual(overlay.render(5), []);
	} finally {
		overlay.close();
	}
});

test("renders a completion glyph for a completed agent", () => {
	const overlay = new LiveConversationOverlay(makeHandle({ status: "completed" }), theme, 80, 24);
	try {
		assert.ok(overlay.render().join("\n").includes("✓"));
	} finally {
		overlay.close();
	}
});

test("renders context-usage percent when getSessionStats provides it", () => {
	const session = { getSessionStats: () => ({ contextUsage: { percent: 90 } }) };
	const overlay = new LiveConversationOverlay(makeHandle({ session }), theme, 80, 24);
	try {
		assert.ok(overlay.render().join("\n").includes("90% ctx"));
	} finally {
		overlay.close();
	}
});

test("session.subscribe events append text/content lines and ignore empty/non-text", () => {
	let cb: ((event: unknown) => void) | undefined;
	const session = {
		subscribe(fn: (event: unknown) => void): () => void {
			cb = fn;
			return () => undefined;
		},
	};
	const overlay = new LiveConversationOverlay(makeHandle({ session }), theme, 80, 24);
	try {
		assert.ok(typeof cb === "function", "subscribe callback captured");
		const before = overlay.cachedLines.length;
		cb({ text: "hello world" });
		cb({ content: "via content field" }); // fallback field
		cb({ text: "   " }); // whitespace-only ignored
		cb({ nothing: 42 }); // no text/content ignored
		assert.ok(overlay.cachedLines.some((l) => l.includes("hello world")));
		assert.ok(overlay.cachedLines.some((l) => l.includes("via content field")));
		assert.equal(overlay.cachedLines.length, before + 2);
	} finally {
		overlay.close();
	}
});

test("close() unsubscribes, clears the poll timer, and is idempotent", () => {
	let unsubscribed = 0;
	let cb: ((event: unknown) => void) | undefined;
	const session = {
		subscribe(fn: (event: unknown) => void): () => void {
			cb = fn;
			return () => {
				unsubscribed++;
			};
		},
	};
	const overlay = new LiveConversationOverlay(makeHandle({ session }), theme, 80, 24);
	const before = overlay.cachedLines.length;
	overlay.close();
	overlay.close(); // idempotent: unsubscribe must fire exactly once
	assert.equal(unsubscribed, 1);
	// After close, subscribe events are ignored (closed guard)
	assert.ok(typeof cb === "function");
	cb({ text: "should be ignored" });
	assert.equal(overlay.cachedLines.length, before);
});

test("dispose() delegates to close() (triggers unsubscribe)", () => {
	let unsubscribed = 0;
	const session = {
		subscribe: (_fn: (event: unknown) => void) => (): void => {
			unsubscribed++;
		},
	};
	const overlay = new LiveConversationOverlay(makeHandle({ session }), theme, 80, 24);
	overlay.dispose();
	assert.equal(unsubscribed, 1);
});

test("cached lines are capped at MAX_CACHED_LINES (oldest dropped first)", () => {
	let cb: ((event: unknown) => void) | undefined;
	const session = {
		subscribe(fn: (event: unknown) => void): () => void {
			cb = fn;
			return () => undefined;
		},
	};
	const overlay = new LiveConversationOverlay(makeHandle({ session }), theme, 80, 24);
	try {
		const cap = LiveConversationOverlay.MAX_CACHED_LINES;
		for (let i = 0; i < cap + 10; i++) cb?.({ text: `line ${i}` });
		assert.equal(overlay.cachedLines.length, cap);
		// Most recent line is retained at the tail
		assert.ok(overlay.cachedLines[cap - 1].includes(`line ${cap + 9}`));
	} finally {
		overlay.close();
	}
});

// ── M1-6 / P1-3: scrolling + capability-matching footer ─────────────────────
//
// The overlay used to have NO handleInput and a footer that advertised
// `↑/k ↓/j G/g` inside an `autoScroll === false` branch nothing could reach.
// These tests drive the real handleInput with the keys the footer advertises
// and assert both the scroll offset and the rendered window.

type ScrollState = { scrollOffset: number };

/** TS `private` is compile-time only — read the runtime field for assertions. */
function scrollOffsetOf(overlay: LiveConversationOverlay): number {
	return (overlay as unknown as ScrollState).scrollOffset;
}

/** Build an overlay whose session emitted `count` lines (viewport = rows - 3: canopy + meta + cap). */
function makeScrolledOverlay(count: number, rows = 12): { overlay: LiveConversationOverlay; cb: (event: unknown) => void } {
	let cb: ((event: unknown) => void) | undefined;
	const session = {
		subscribe(fn: (event: unknown) => void): () => void {
			cb = fn;
			return () => undefined;
		},
	};
	const overlay = new LiveConversationOverlay(makeHandle({ session }), theme, 80, rows);
	assert.ok(typeof cb === "function", "subscribe callback captured");
	for (let i = 0; i < count; i++) cb?.({ text: `line ${i}` });
	return { overlay, cb: cb ?? (() => undefined) };
}

/** The overlay's CONTENT rows (layout: canopy, meta, vh content rows, close cap). */
function windowOf(overlay: LiveConversationOverlay): string[] {
	return overlay
		.render()
		.slice(2, -1)
		.map((l) => l.replace(/^┃ /, "").trim());
}

function footerOf(overlay: LiveConversationOverlay): string {
	const lines = overlay.render();
	// Footer is the close cap — the last line of the surface.
	return lines[lines.length - 1];
}

test("M1-6: viewport taller than the buffer fits — render window + auto footer", () => {
	const { overlay } = makeScrolledOverlay(3, 12); // viewport = 9, buffer = 4
	try {
		assert.equal(scrollOffsetOf(overlay), 0, "no scrolling possible -> offset pinned at 0");
		const out = overlay.render().join("\n");
		assert.ok(out.includes("line 0") && out.includes("line 2"), "all lines visible");
		assert.ok(out.includes("auto-scroll"), "auto footer when tailing");
	} finally {
		overlay.close();
	}
});

test("M1-6: j/k/↑/↓/PgDn/PgUp move scrollOffset within bounds and flip autoScroll", () => {
	const { overlay } = makeScrolledOverlay(30, 12); // viewport = 9, total = 31 lines
	try {
		const vh = 9;
		const total = overlay.cachedLines.length;
		const max = total - vh;
		assert.ok(total > vh, "buffer must exceed the viewport");
		assert.equal(scrollOffsetOf(overlay), max, "starts tailing the newest line");

		// ↑ / k scroll up one line and pause auto-scroll (offset leaves the tail).
		overlay.handleInput("k");
		assert.equal(scrollOffsetOf(overlay), max - 1, "k scrolls up one line");
		assert.ok(footerOf(overlay).includes("manual"), "manual footer after scrolling up");
		overlay.handleInput("\x1b[A"); // up arrow
		assert.equal(scrollOffsetOf(overlay), max - 2, "↑ scrolls up one line");

		// ↓ / j scroll down one line; reaching the tail restores autoScroll.
		overlay.handleInput("j");
		assert.equal(scrollOffsetOf(overlay), max - 1, "j scrolls down one line");
		overlay.handleInput("\x1b[B"); // down arrow
		assert.equal(scrollOffsetOf(overlay), max, "↓ scrolls down one line");
		assert.ok(footerOf(overlay).includes("auto-scroll"), "reaching the tail restores auto-scroll");

		// PgUp/PgDn move a page and clamp at both ends.
		overlay.handleInput("\x1b[5~"); // pageUp
		assert.equal(scrollOffsetOf(overlay), Math.max(0, max - 10), "PgUp scrolls one page");
		overlay.handleInput("\x1b[6~"); // pageDown
		assert.equal(scrollOffsetOf(overlay), max, "PgDn returns to the tail");

		// Clamping: scrolling up past the top stops at 0; down past the end at max.
		for (let i = 0; i < total + 5; i++) overlay.handleInput("k");
		assert.equal(scrollOffsetOf(overlay), 0, "clamped at the top");
		assert.ok(footerOf(overlay).includes("manual 1-"), "manual footer reports the first window");
		for (let i = 0; i < total + 5; i++) overlay.handleInput("j");
		assert.equal(scrollOffsetOf(overlay), max, "clamped at the bottom");
	} finally {
		overlay.close();
	}
});

test("M1-6: g jumps to the oldest line, G to the newest, and the window follows", () => {
	const { overlay } = makeScrolledOverlay(30, 12); // viewport = 9, total = 31
	try {
		overlay.handleInput("g");
		assert.equal(scrollOffsetOf(overlay), 0, "g jumps to the top");
		const top = windowOf(overlay);
		assert.ok(
			top.some((l) => l === "line 0"),
			"top window shows the first streamed line",
		);
		assert.ok(!top.some((l) => l.includes("line 29")), "top window must not show the newest line");
		assert.ok(footerOf(overlay).includes("manual"), "g leaves auto-scroll off");

		overlay.handleInput("G");
		assert.equal(scrollOffsetOf(overlay), overlay.cachedLines.length - 9, "G jumps to the tail");
		const tail = windowOf(overlay);
		assert.ok(
			tail.some((l) => l.includes("line 29")),
			"tail window shows the newest line",
		);
		assert.ok(!tail.some((l) => l === "line 0"), "tail window must not show the oldest line");
		assert.ok(footerOf(overlay).includes("auto-scroll"), "G restores auto-scroll");

		// Arrow-key aliases for the same jumps (home/end).
		overlay.handleInput("\x1b[H");
		assert.equal(scrollOffsetOf(overlay), 0, "home jumps to the top");
		overlay.handleInput("\x1b[F");
		assert.equal(scrollOffsetOf(overlay), overlay.cachedLines.length - 9, "end jumps to the tail");
	} finally {
		overlay.close();
	}
});

test("M1-6: `a` toggles autoScroll (on => tail, off => stays put) in both directions", () => {
	const { overlay, cb } = makeScrolledOverlay(30, 12);
	try {
		const max = overlay.cachedLines.length - 9;
		overlay.handleInput("g"); // manual mode
		assert.ok(footerOf(overlay).includes("manual"), "footer announces manual mode");
		overlay.handleInput("a");
		assert.equal(scrollOffsetOf(overlay), max, "a (on) jumps to the newest line");
		assert.ok(footerOf(overlay).includes("auto-scroll"), "footer announces auto-scroll");

		overlay.handleInput("a");
		assert.equal(scrollOffsetOf(overlay), max, "a (off) leaves the viewport where it is");
		assert.ok(footerOf(overlay).includes("manual"), "footer announces manual mode");

		// Paused: new lines must NOT yank the viewport to the tail.
		const paused = scrollOffsetOf(overlay);
		cb({ text: "brand new line" });
		assert.equal(scrollOffsetOf(overlay), paused, "paused viewport stays put while lines stream in");
		assert.ok(!windowOf(overlay).some((l) => l.includes("brand new line")), "new line is off-window while paused");

		// Tailing (default) does follow the stream.
		overlay.handleInput("a");
		cb({ text: "another new line" });
		assert.ok(
			windowOf(overlay).some((l) => l.includes("another new line")),
			"auto-scroll follows new lines",
		);
	} finally {
		overlay.close();
	}
});

test("M1-6: footer matches capability in BOTH states and advertises onClose", () => {
	const { overlay } = makeScrolledOverlay(30, 12);
	try {
		const autoFooter = footerOf(overlay);
		assert.ok(autoFooter.includes("auto-scroll"), `auto footer must announce auto-scroll: ${autoFooter}`);
		assert.ok(autoFooter.includes("Esc/Q close"), "auto footer keeps the close hint");
		// Both states are reachable — the old code's manual branch was dead.
		overlay.handleInput("k");
		const manualFooter = footerOf(overlay);
		assert.ok(manualFooter.includes("manual"), `manual footer must announce manual mode: ${manualFooter}`);
		assert.ok(manualFooter.includes("Esc/Q close"), "manual footer keeps the close hint");
		assert.notEqual(manualFooter, autoFooter, "the two footers differ");
		// Mode markers are mutually exclusive — a footer can never claim both.
		assert.ok(!autoFooter.includes("manual"), "auto footer must not claim manual mode");
		assert.ok(!manualFooter.includes("auto-scroll"), "manual footer must not claim auto-scroll");

		// Every advertised scroll key must actually move the viewport (from a
		// position where that key is not already clamped).
		const advertised: Array<[label: string, key: string, setup: string]> = [
			["↑", "k", "G"],
			["↓", "j", "g"],
			["PgUp", "\x1b[5~", "G"],
			["PgDn", "\x1b[6~", "g"],
			["g", "g", "G"],
			["G", "G", "g"],
		];
		for (const [label] of advertised) {
			assert.ok(manualFooter.includes(label), `footer must advertise ${label}`);
		}
		// `a` and the close hint are advertised too.
		assert.ok(manualFooter.includes("A resume"), "manual footer advertises the a toggle");
		assert.ok(autoFooter.includes("A pause"), "auto footer advertises the a toggle");

		for (const [label, key, setup] of advertised) {
			overlay.handleInput(setup);
			const start = scrollOffsetOf(overlay);
			overlay.handleInput(key);
			assert.notEqual(scrollOffsetOf(overlay), start, `advertised key ${label} must move the viewport`);
		}

		// Advertised `a` really toggles.
		overlay.handleInput("a");
		assert.ok(footerOf(overlay).includes("manual"), "a pauses auto-scroll");
		overlay.handleInput("a");
		assert.ok(footerOf(overlay).includes("auto-scroll"), "a resumes auto-scroll");
	} finally {
		overlay.close();
	}
});

test("M1-6: esc/q close the overlay from handleInput, and a closed overlay ignores keys", () => {
	let unsubscribed = 0;
	let cb: ((event: unknown) => void) | undefined;
	const session = {
		subscribe(fn: (event: unknown) => void): () => void {
			cb = fn;
			return () => {
				unsubscribed++;
			};
		},
	};
	const overlay = new LiveConversationOverlay(makeHandle({ session }), theme, 80, 12);
	for (let i = 0; i < 30; i++) cb?.({ text: `line ${i}` });
	overlay.handleInput("q");
	assert.equal(unsubscribed, 1, "q closes the overlay (unsubscribes)");
	const frozen = scrollOffsetOf(overlay);
	cb?.({ text: "after close" });
	overlay.handleInput("k");
	assert.equal(scrollOffsetOf(overlay), frozen, "closed overlay ignores scroll keys");
	assert.ok(overlay.render().length > 0, "closed overlay still renders its frozen buffer");

	let unsubscribed2 = 0;
	let cb2: ((event: unknown) => void) | undefined;
	const session2 = {
		subscribe(fn: (event: unknown) => void): () => void {
			cb2 = fn;
			return () => {
				unsubscribed2++;
			};
		},
	};
	const overlay2 = new LiveConversationOverlay(makeHandle({ session: session2 }), theme, 80, 12);
	for (let i = 0; i < 30; i++) cb2?.({ text: `line ${i}` });
	overlay2.handleInput("\x1b");
	assert.equal(unsubscribed2, 1, "escape closes the overlay (unsubscribes)");
});

test("M1-6: unrecognised keys are ignored (no scroll, footer unchanged)", () => {
	const { overlay } = makeScrolledOverlay(30, 12);
	try {
		overlay.handleInput("g");
		assert.ok(footerOf(overlay).includes("manual"), "g actually reached handleInput");
		const before = scrollOffsetOf(overlay);
		const footer = footerOf(overlay);
		overlay.handleInput("x");
		overlay.handleInput("\x1b[200~pasted text\x1b[201~");
		assert.equal(scrollOffsetOf(overlay), before, "unknown keys do not scroll");
		assert.equal(footerOf(overlay), footer, "unknown keys do not change the footer");
	} finally {
		overlay.close();
	}
});
