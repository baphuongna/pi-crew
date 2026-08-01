/**
 * UI-13: Basic coverage for src/ui/live-conversation-overlay.ts.
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
import { LiveConversationOverlay } from "../../src/ui/live-conversation-overlay.ts";
import type { CrewTheme } from "../../src/ui/theme-adapter.ts";
import type { LiveAgentHandle } from "../../src/runtime/live-agent-manager.ts";

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
		assert.ok(lines[0].includes("╭"), "top border present");
		assert.ok(lines[lines.length - 1].includes("╯"), "bottom border present");
		const out = lines.join("\n");
		assert.ok(out.includes("worker"), "agent name in header");
		assert.ok(out.includes("esc/q close"), "footer hint");
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
			return () => {};
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
			return () => {};
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
