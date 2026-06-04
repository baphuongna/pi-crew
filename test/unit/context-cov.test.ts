import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { result, formatScoped, buildParentContext, configRecord, withSessionId, type TeamContext } from "../../src/extension/team-tool/context.ts";

	describe("result", () => {
	it("creates a tool result with isError false by default", () => {
		const r = result("hello", { action: "test", status: "ok" });
		assert.equal(r.isError, false);
		assert.equal((r.content[0] as any).text, "hello");
		assert.equal(r.details.action, "test");
	});

	it("creates an error result when isError is true", () => {
		const r = result("fail", { action: "run", status: "error" }, true);
		assert.equal(r.isError, true);
	});

	it("preserves all detail fields", () => {
		const r = result("msg", { action: "cancel", status: "ok", runId: "r1" });
		assert.equal(r.details.runId, "r1");
	});
});

describe("formatScoped", () => {
	it("formats name, source, and description", () => {
		const formatted = formatScoped("agent1", "project", "does stuff");
		assert.equal(formatted, "- agent1 (project): does stuff");
	});

	it("handles empty strings", () => {
		const formatted = formatScoped("", "", "");
		assert.equal(formatted, "-  (): ");
	});

	it("handles special characters", () => {
		const formatted = formatScoped("a/b", "src", "it's <cool>");
		assert.ok(formatted.includes("a/b"));
	});
});

describe("buildParentContext", () => {
	it("returns undefined for empty branch", () => {
		const ctx: TeamContext = { cwd: "/tmp", sessionManager: { getBranch: () => [] } };
		assert.equal(buildParentContext(ctx), undefined);
	});

	it("returns undefined when getBranch returns undefined", () => {
		const ctx: TeamContext = { cwd: "/tmp" };
		assert.equal(buildParentContext(ctx), undefined);
	});

	it("extracts user message text from branch", () => {
		const branch = [
			{ type: "message", message: { role: "user", content: "hello world" } },
		];
		const ctx: TeamContext = { cwd: "/tmp", sessionManager: { getBranch: () => branch } };
		const text = buildParentContext(ctx);
		assert.ok(text);
		assert.ok(text!.includes("hello world"));
	});

	it("extracts assistant message text from branch", () => {
		const branch = [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "response" }] } },
		];
		const ctx: TeamContext = { cwd: "/tmp", sessionManager: { getBranch: () => branch } };
		const text = buildParentContext(ctx);
		assert.ok(text);
		assert.ok(text!.includes("response"));
	});

	it("handles compaction summary", () => {
		const branch = [
			{ type: "compaction", summary: "Summarized conversation" },
		];
		const ctx: TeamContext = { cwd: "/tmp", sessionManager: { getBranch: () => branch } };
		const text = buildParentContext(ctx);
		assert.ok(text);
		assert.ok(text!.includes("Summarized conversation"));
	});

	it("skips non-object entries", () => {
		const branch = [null, 42, "string"];
		const ctx: TeamContext = { cwd: "/tmp", sessionManager: { getBranch: () => branch } };
		assert.equal(buildParentContext(ctx), undefined);
	});

	it("skips entries with no relevant content", () => {
		const branch = [{ type: "other" }];
		const ctx: TeamContext = { cwd: "/tmp", sessionManager: { getBranch: () => branch } };
		assert.equal(buildParentContext(ctx), undefined);
	});
});

describe("configRecord", () => {
	it("returns object when given a valid object", () => {
		const r = configRecord({ a: 1 });
		assert.deepEqual(r, { a: 1 });
	});

	it("returns empty object for null", () => {
		assert.deepEqual(configRecord(null), {});
	});

	it("returns empty object for undefined", () => {
		assert.deepEqual(configRecord(undefined), {});
	});

	it("returns empty object for arrays", () => {
		assert.deepEqual(configRecord([1, 2]), {});
	});

	it("returns empty object for primitives", () => {
		assert.deepEqual(configRecord("string"), {});
		assert.deepEqual(configRecord(42), {});
	});
});

describe("withSessionId", () => {
	it("adds sessionId when available", () => {
		const ctx = { sessionManager: { getSessionId: () => "s1" } as any };
		const result = withSessionId(ctx);
		assert.equal(result.sessionId, "s1");
	});

	it("omits sessionId when not available", () => {
		const ctx = { sessionManager: { getSessionId: () => undefined } as any };
		const result = withSessionId(ctx);
		assert.equal(result.sessionId, undefined);
	});

	it("omits sessionId when sessionManager is undefined", () => {
		const ctx = { sessionManager: undefined } as any;
		const result = withSessionId(ctx);
		assert.equal(result.sessionId, undefined);
	});
});
