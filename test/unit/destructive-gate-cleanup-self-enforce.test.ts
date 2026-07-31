import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { TeamContext } from "../../src/extension/team-tool/context.ts";
import { handleCleanup } from "../../src/extension/team-tool/lifecycle-actions.ts";
import { textFromToolResult } from "../../src/extension/tool-result.ts";
import type { TeamToolParamsValue } from "../../src/schema/team-tool-schema.ts";

/**
 * SEC-5: `handleCleanup` must self-enforce `confirm: true` at the top of the
 * function, matching `handlePrune` and `handleForget`. Previously the only
 * barrier was the `pi.on("tool_call")` hook — a defense-in-depth gap. This
 * test verifies the handler itself rejects cleanup without confirm, while
 * allowing `dryRun: true` (non-destructive preview) to pass through.
 */

function makeCtx(cwd: string): TeamContext {
	return {
		cwd,
		config: undefined,
		sessionId: "test-session",
		signal: undefined,
	} as unknown as TeamContext;
}

function params(p: Partial<TeamToolParamsValue> = {}): TeamToolParamsValue {
	return { action: "cleanup", ...p } as TeamToolParamsValue;
}

describe("SEC-5 — handleCleanup confirm self-enforcement", () => {
	let tempCwd: string;

	beforeEach(() => {
		tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "crew-sec5-"));
		// Minimal git marker so projectCrewRoot anchors at cwd.
		fs.mkdirSync(path.join(tempCwd, ".git"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempCwd, { recursive: true, force: true });
	});

	it("returns an error when confirm is not provided", async () => {
		const r = await handleCleanup(params({}), makeCtx(tempCwd));
		assert.equal(r.isError, true);
		assert.equal(r.details.status, "error");
		assert.equal(r.details.action, "cleanup");
	});

	it("returns an error when confirm is explicitly false", async () => {
		const r = await handleCleanup(params({ confirm: false }), makeCtx(tempCwd));
		assert.equal(r.isError, true);
		assert.equal(r.details.status, "error");
	});

	it("error message matches the sibling action pattern (includes 'requires confirm: true')", async () => {
		const r = await handleCleanup(params({}), makeCtx(tempCwd));
		assert.match(textFromToolResult(r), /requires confirm: true/);
	});

	it("passes through to routing logic when confirm: true is provided", async () => {
		// With confirm:true and no runId, routes to handleProjectCleanup.
		// It should NOT return the confirm error — it should proceed.
		const r = await handleCleanup(params({ confirm: true }), makeCtx(tempCwd));
		assert.equal(r.isError, false);
		// Project cleanup output mentions "Project cleanup".
		assert.match(textFromToolResult(r), /Project cleanup/);
	});

	it("passes through with dryRun: true even without confirm (non-destructive preview)", async () => {
		const r = await handleCleanup(params({ dryRun: true }), makeCtx(tempCwd));
		assert.equal(r.isError, false);
		// Dry-run preview mentions "dry-run preview".
		assert.match(textFromToolResult(r), /dry-run preview/);
	});

	it("passes through with both confirm: true and dryRun: true", async () => {
		const r = await handleCleanup(params({ confirm: true, dryRun: true }), makeCtx(tempCwd));
		assert.equal(r.isError, false);
		assert.match(textFromToolResult(r), /dry-run preview/);
	});
});
