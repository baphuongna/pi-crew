import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { buildParentContext, MAX_PARENT_CONTEXT_CHARS } from "../../../../src/extension/team-tool/context.ts";

/** Build a minimal TeamContext with a given session branch. */
function ctxWithBranch(branch: unknown[]): TeamContext {
	return {
		cwd: "/tmp/test",
		sessionManager: { getBranch: () => branch },
	} as TeamContext;
}

/** Build a user message entry. */
function userMsg(text: string): unknown {
	return { type: "message", message: { role: "user", content: text } };
}

/** Build an assistant message entry. */
function assistantMsg(text: string): unknown {
	return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

/** Build a compaction summary entry. */
function compaction(summary: string): unknown {
	return { type: "compaction", summary };
}

describe("buildParentContext", () => {
	it("returns undefined when no session branch", () => {
		const ctx = { cwd: "/tmp" } as TeamContext;
		assert.equal(buildParentContext(ctx), undefined);
	});

	it("returns undefined when branch is empty", () => {
		const ctx = ctxWithBranch([]);
		assert.equal(buildParentContext(ctx), undefined);
	});

	it("includes user and assistant messages", () => {
		const ctx = ctxWithBranch([userMsg("Fix the bug in auth.ts"), assistantMsg("I'll look at the auth module.")]);
		const result = buildParentContext(ctx);
		assert.ok(result);
		assert.ok(result!.includes("[User]: Fix the bug in auth.ts"));
		assert.ok(result!.includes("[Assistant]: I'll look at the auth module."));
	});

	it("includes compaction summaries", () => {
		const ctx = ctxWithBranch([compaction("Previously discussed API design"), userMsg("Now implement it")]);
		const result = buildParentContext(ctx);
		assert.ok(result);
		assert.ok(result!.includes("[Summary]: Previously discussed API design"));
	});

	it("respects MAX_PARENT_CONTEXT_CHARS budget", () => {
		// Create messages that exceed the budget
		const bigMsg = "x".repeat(MAX_PARENT_CONTEXT_CHARS);
		const branch = [userMsg(bigMsg), userMsg("recent important message")];
		const ctx = ctxWithBranch(branch);
		const result = buildParentContext(ctx);
		assert.ok(result);
		// Most recent message should be included (budget drops oldest first)
		assert.ok(result!.includes("recent important message"));
		// The big message should be dropped (exceeds budget)
		assert.ok(!result!.includes(bigMsg));
	});

	it("drops oldest messages first when over budget", () => {
		const msgA = "A".repeat(2000);
		const msgB = "B".repeat(2000);
		const msgC = "C".repeat(2000);
		const msgD = "D".repeat(2000);
		const msgE = "E".repeat(2000);
		const ctx = ctxWithBranch([userMsg(msgA), userMsg(msgB), userMsg(msgC), userMsg(msgD), userMsg(msgE)]);
		const result = buildParentContext(ctx);
		assert.ok(result);
		// Budget is 12K, each msg is 2K → can fit ~6 messages but with prefix overhead
		// Most recent (E, D, C) should be present, oldest (A) likely dropped
		assert.ok(result!.includes(msgE));
	});

	it("filters noisy file-dump content", () => {
		const codeDump = "```typescript\n" + "const x = 1;\n".repeat(100) + "```";
		const ctx = ctxWithBranch([
			userMsg(codeDump), // noisy — should be filtered
			userMsg("What does this code do?"),
		]);
		const result = buildParentContext(ctx);
		assert.ok(result);
		// The noisy code dump should NOT be in the context
		assert.ok(!result!.includes("const x = 1;"));
		// The relevant question should be
		assert.ok(result!.includes("What does this code do?"));
	});

	it("truncates long assistant messages", () => {
		const longAssistant = "This is a very long response. ".repeat(50);
		const ctx = ctxWithBranch([userMsg("question"), assistantMsg(longAssistant)]);
		const result = buildParentContext(ctx);
		assert.ok(result);
		// Should be truncated — not the full message
		const assistantLine = result!.split("\n").find((l) => l.includes("[Assistant]"));
		assert.ok(assistantLine);
		assert.ok(assistantLine!.length < longAssistant.length);
		assert.ok(assistantLine!.endsWith("…"));
	});

	it("keeps short messages in full", () => {
		const ctx = ctxWithBranch([userMsg("Short question"), assistantMsg("Short answer")]);
		const result = buildParentContext(ctx);
		assert.ok(result);
		assert.ok(result!.includes("[User]: Short question"));
		assert.ok(result!.includes("[Assistant]: Short answer"));
	});

	it("includes reference-only disclaimer header", () => {
		const ctx = ctxWithBranch([userMsg("test")]);
		const result = buildParentContext(ctx);
		assert.ok(result);
		assert.ok(result!.includes("# Parent Conversation Context"));
		assert.ok(result!.includes("reference-only"));
	});

	it("pins MAX_PARENT_CONTEXT_CHARS at 12_000 (R5 cap census)", () => {
		// R5 census (2026-11-05): every parent-context embed site (child-pi.ts
		// effectiveTask, live-session-runtime.ts effectivePrompt) consumes the
		// string produced here, so this constant is the whole-layer ceiling
		// (~3K tokens). The behavior tests above import the constant, so a
		// silent value change would still pass them — pin the number.
		assert.equal(MAX_PARENT_CONTEXT_CHARS, 12_000);
	});

	it("bounds the final block to budget + fixed wrapper overhead (R5 census)", () => {
		// 20 × ~2.5Kc user messages = ~50Kc input, all inside the slice(-20)
		// window — only the total budget can bound the render. The output may
		// never exceed budget + header (2 lines + blank) + join separators
		// (≤19 × "\n\n"), i.e. a fixed ~160c over 12_000.
		const branch = Array.from({ length: 20 }, (_, i) => userMsg(`${String(i).padStart(3, "0")} ${"x".repeat(2_500)}`));
		const result = buildParentContext(ctxWithBranch(branch));
		assert.ok(result);
		assert.ok(result!.length <= MAX_PARENT_CONTEXT_CHARS + 200, `block ${result!.length}c exceeds budget + wrapper overhead`);
		// Drop-oldest engaged at this volume: oldest gone, newest kept.
		assert.ok(!result!.includes("000 "));
		assert.ok(result!.includes("019 "));
	});
});
