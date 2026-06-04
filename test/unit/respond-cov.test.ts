import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleRespond } from "../../src/extension/team-tool/respond.ts";
import type { TeamContext } from "../../src/extension/team-tool/context.ts";

/**
 * handleRespond is the only export; it requires a real run manifest on disk.
 * We test its input validation (early returns) which are pure-logic checks.
 * The existing respond-tool.test.ts covers full filesystem scenarios.
 */
describe("handleRespond", () => {
	it("returns error when runId is missing", () => {
		const ctx: TeamContext = { cwd: "/tmp" };
		const r = handleRespond({}, ctx);
		assert.equal(r.isError, true);
		assert.ok((r.content[0] as any).text.includes("runId"));
	});

	it("returns error when both message and taskId are missing", () => {
		const ctx: TeamContext = { cwd: "/tmp" };
		const r = handleRespond({ runId: "r1" }, ctx);
		assert.equal(r.isError, true);
		const text = (r.content[0] as any).text;
		assert.ok(text.includes("taskId") || text.includes("message"));
	});

	it("returns error for non-existent run", () => {
		const ctx: TeamContext = { cwd: "/tmp" };
		const r = handleRespond({ runId: "nonexistent-run-xyz", taskId: "t1", message: "hi" }, ctx);
		assert.equal(r.isError, true);
	});

	it("returns error when only message provided with no taskId", () => {
		const ctx: TeamContext = { cwd: "/tmp" };
		const r = handleRespond({ runId: "r1", message: "hi" }, ctx);
		assert.equal(r.isError, true);
	});

	it("returns error for empty runId string", () => {
		const ctx: TeamContext = { cwd: "/tmp" };
		const r = handleRespond({ runId: "", taskId: "t1", message: "hi" }, ctx);
		assert.equal(r.isError, true);
	});
});
