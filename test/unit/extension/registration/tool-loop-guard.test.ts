import assert from "node:assert/strict";
import test from "node:test";
import {
	createLoopGuardState,
	fingerprint,
	installToolLoopGuard,
	LOOP_GUARD_MARKER,
	stableStringify,
	WAIT_GUARD_MARKER,
} from "../../../../src/extension/registration/tool-loop-guard.ts";

// ── stableStringify / fingerprint ──────────────────────────────────────

test("stableStringify is insensitive to key order (recursively)", () => {
	const a = { z: 1, a: { y: [2, { b: 1, a: 2 }], x: 3 } };
	const b = { a: { x: 3, y: [2, { a: 2, b: 1 }] }, z: 1 };
	assert.equal(stableStringify(a), stableStringify(b));
	assert.notEqual(stableStringify({ a: 1, b: 2 }), stableStringify({ a: 2, b: 1 }));
});

test("fingerprint is tool+args deterministic and case-insensitive on tool", () => {
	assert.equal(fingerprint("Read", { path: "a" }), fingerprint("read", { path: "a" }));
	assert.notEqual(fingerprint("read", { path: "a" }), fingerprint("read", { path: "b" }));
});

// ── main guard: warn at 3 identical, block at 5 ────────────────────────

test("warns exactly at 3 consecutive identical-args + identical-output results", () => {
	const g = createLoopGuardState();
	const args = { path: "/tmp/x" };
	assert.equal(g.onToolResult("read", args, "content").length, 0);
	assert.equal(g.onToolResult("read", args, "content").length, 0);
	const third = g.onToolResult("read", args, "content");
	assert.equal(third.length, 1);
	assert.ok(third[0].text.includes(LOOP_GUARD_MARKER));
	// 4th identical: warning already delivered, do not repeat-append
	assert.equal(g.onToolResult("read", args, "content").length, 0);
});

test("new output resets the run — legitimate re-read after change never accumulates", () => {
	const g = createLoopGuardState();
	const args = { path: "/tmp/x" };
	g.onToolResult("read", args, "v1");
	g.onToolResult("read", args, "v1");
	g.onToolResult("read", args, "v1"); // warn
	// file changed → new output → fresh run
	assert.equal(g.onToolResult("read", args, "v2").length, 0);
	assert.equal(g.onToolCall("read", args).block, undefined);
});

test("a different intervening call starts a fresh run for the original fingerprint", () => {
	const g = createLoopGuardState();
	const args = { path: "/tmp/x" };
	g.onToolResult("read", args, "same");
	g.onToolResult("read", args, "same");
	g.onToolResult("grep", { pattern: "y" }, "other"); // intervenes
	const after = g.onToolResult("read", args, "same"); // fresh run → 1, no warn
	assert.equal(after.length, 0);
});

test("blocks hard-block tools at 5 confirmed identical runs", () => {
	const g = createLoopGuardState();
	const args = { path: "/tmp/x" };
	for (let i = 0; i < 5; i++) g.onToolResult("read", args, "same");
	const verdict = g.onToolCall("read", args);
	assert.equal(verdict.block, true);
	assert.ok(verdict.reason?.includes("read"));
});

test("grep/glob/find/ls hard-block; bash and edit are warn-only", () => {
	const g = createLoopGuardState();
	for (const tool of ["grep", "glob", "find", "ls"]) {
		const g2 = createLoopGuardState();
		for (let i = 0; i < 5; i++) g2.onToolResult(tool, { q: "x" }, "same");
		assert.equal(g2.onToolCall(tool, { q: "x" }).block, true, `${tool} should hard-block`);
	}
	for (const tool of ["bash", "edit", "write"]) {
		const g3 = createLoopGuardState();
		for (let i = 0; i < 8; i++) g3.onToolResult(tool, { cmd: "x" }, "same");
		assert.equal(g3.onToolCall(tool, { cmd: "x" }).block, undefined, `${tool} must stay warn-only`);
	}
	// silence unused-warning for g (kept for symmetry)
	assert.ok(g);
});

test("exempt tools (team/Agent/subagent-result) never warn or block", () => {
	const g = createLoopGuardState();
	for (let i = 0; i < 10; i++) {
		assert.equal(g.onToolResult("team", { action: "status" }, "same").length, 0);
	}
	assert.equal(g.onToolCall("team", { action: "status" }).block, undefined);
});

test("distinct arguments are distinct fingerprints — pagination never trips the guard", () => {
	const g = createLoopGuardState();
	for (let offset = 0; offset < 8; offset++) {
		g.onToolResult("read", { path: "f", offset }, "page-content");
	}
	assert.equal(g.onToolCall("read", { path: "f", offset: 7 }).block, undefined);
});

// ── wait-style tool (ask) ──────────────────────────────────────────────

test("ask wait-guard: warn at 2, block at 3, reset after any non-ask result", () => {
	const g = createLoopGuardState();
	assert.equal(g.onToolResult("ask", { question: "a" }, "r1").length, 0);
	const second = g.onToolResult("ask", { question: "b" }, "r2"); // keyed by name only
	assert.equal(second.length, 1);
	assert.ok(second[0].text.includes(WAIT_GUARD_MARKER));
	assert.equal(g.onToolCall("ask", { question: "c" }).block, true);

	// a completed non-ask tool resets the turn
	g.onToolResult("read", { path: "x" }, "data");
	assert.equal(g.onToolCall("ask", { question: "d" }).block, undefined);
});

// ── FIFO eviction bound ────────────────────────────────────────────────

test("FIFO eviction: oldest fingerprints are dropped past the bound", () => {
	const g = createLoopGuardState();
	const early = { path: "/tmp/early" };
	for (let i = 0; i < 5; i++) g.onToolResult("read", early, "same");
	assert.equal(g.onToolCall("read", early).block, true);
	// Push 600 distinct fingerprints past the 512 bound
	for (let i = 0; i < 600; i++) {
		g.onToolResult("read", { path: `/tmp/f${i}` }, `v${i}`);
	}
	// The early fingerprint was evicted → no longer blocks
	assert.equal(g.onToolCall("read", early).block, undefined);
});

// ── hook wiring ────────────────────────────────────────────────────────

type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown;

test("installToolLoopGuard wires tool_call block + tool_result append on a fake Pi", async () => {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (name: string, fn: Handler) => {
			handlers.set(name, fn);
		},
	} as unknown as Parameters<typeof installToolLoopGuard>[0];

	installToolLoopGuard(pi);
	assert.ok(handlers.has("tool_call"));
	assert.ok(handlers.has("tool_result"));

	const args = { path: "/tmp/x" };
	const resultEvent = { toolName: "read", input: args, content: [{ type: "text", text: "same" }] };

	// 3 identical results → 3rd appends the warning
	const r1 = handlers.get("tool_result")!(structuredClone(resultEvent));
	assert.equal(r1, undefined);
	const r3Pre = handlers.get("tool_result")!(structuredClone(resultEvent));
	assert.equal(r3Pre, undefined);
	const r3 = handlers.get("tool_result")!(structuredClone(resultEvent)) as { content: Array<{ type: string }> };
	assert.equal(r3.content.length, 2);
	assert.equal(r3.content[1].type, "text");

	// …up to 5 runs, then tool_call blocks
	handlers.get("tool_result")!(structuredClone(resultEvent));
	handlers.get("tool_result")!(structuredClone(resultEvent));
	const blocked = (await handlers.get("tool_call")!({ toolName: "read", input: args })) as {
		block: boolean;
		reason: string;
	};
	assert.equal(blocked.block, true);
	assert.ok(blocked.reason.includes("pi-crew loop guard"));

	// A non-blocked call returns undefined (handler is a no-op passthrough)
	const pass = await handlers.get("tool_call")!({ toolName: "bash", input: { cmd: "ls" } });
	assert.equal(pass, undefined);
});
