import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { handleRespond } from "../../../../src/extension/team-tool/respond.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

/**
 * handleRespond is the only export; it requires a real run manifest on disk.
 * We test its input validation (early returns) which are pure-logic checks.
 * The existing respond-tool.test.ts covers full filesystem scenarios.
 *
 * We use isolated empty temp directories (not /tmp) for ctx.cwd so that
 * locateRunCwd's readdirSync scan is bounded and doesn't hang in CI
 * environments where /tmp has hundreds of entries.
 */
function makeEmptyCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-respond-test-"));
}

describe("handleRespond", () => {
	it("returns error when runId is missing", async () => {
		const ctx: TeamContext = { cwd: makeEmptyCwd() };
		const r = await handleRespond({}, ctx);
		assert.equal(r.isError, true);
		assert.ok((r.content[0] as any).text.includes("runId"));
		await removeDirWithRetry(ctx.cwd);
	});

	it("returns error when both message and taskId are missing", async () => {
		const ctx: TeamContext = { cwd: makeEmptyCwd() };
		const r = await handleRespond({ runId: "r1" }, ctx);
		assert.equal(r.isError, true);
		const text = (r.content[0] as any).text;
		assert.ok(text.includes("taskId") || text.includes("message"));
		await removeDirWithRetry(ctx.cwd);
	});

	it("returns error for non-existent run", async () => {
		const ctx: TeamContext = { cwd: makeEmptyCwd() };
		const r = await handleRespond({ runId: "nonexistent-run-xyz", taskId: "t1", message: "hi" }, ctx);
		assert.equal(r.isError, true);
		await removeDirWithRetry(ctx.cwd);
	});

	it("returns error when only message provided with no taskId", async () => {
		const ctx: TeamContext = { cwd: makeEmptyCwd() };
		const r = await handleRespond({ runId: "r1", message: "hi" }, ctx);
		assert.equal(r.isError, true);
		await removeDirWithRetry(ctx.cwd);
	});

	it("returns error for empty runId string", async () => {
		const ctx: TeamContext = { cwd: makeEmptyCwd() };
		const r = await handleRespond({ runId: "", taskId: "t1", message: "hi" }, ctx);
		assert.equal(r.isError, true);
		await removeDirWithRetry(ctx.cwd);
	});
});
