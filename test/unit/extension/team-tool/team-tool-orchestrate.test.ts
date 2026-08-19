/**
 * Unit tests for team-tool orchestrate handler.
 * @see src/extension/team-tool/orchestrate.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { handleOrchestrate } from "../../../../src/extension/team-tool/orchestrate.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import type { TeamToolParamsValue } from "../../../../src/schema/team-tool-schema.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeCtx(cwd: string): TeamContext {
	return { cwd };
}

function makeParams(overrides: Partial<TeamToolParamsValue> = {}): TeamToolParamsValue {
	return { ...overrides };
}

function writePlanFile(dir: string, filename: string, content: string): string {
	const filePath = path.join(dir, filename);
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}

// ─── handleOrchestrate ────────────────────────────────────────────────────────

describe("handleOrchestrate", () => {
	it("returns error when planPath is missing", async () => {
		const tmp = createTrackedTempDir("orch-test-");
		try {
			const res = await handleOrchestrate(makeParams(), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("planPath"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns error when planPath points outside cwd", async () => {
		const tmp = createTrackedTempDir("orch-test-");
		try {
			const res = await handleOrchestrate(makeParams({ planPath: "/etc/passwd" }), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("within project directory") || text.includes("not found"), `Expected path error, got: ${text}`);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns error when plan file does not exist", async () => {
		const tmp = createTrackedTempDir("orch-test-");
		try {
			const res = await handleOrchestrate(makeParams({ planPath: "nonexistent.md" }), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("not found"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("parses a plan with tagged sections", async () => {
		const tmp = createTrackedTempDir("orch-test-");
		try {
			const planPath = writePlanFile(
				tmp,
				"plan.md",
				[
					"# Design Phase",
					"<!-- tag: design -->",
					"Design the authentication system with OAuth2.",
					"",
					"# Testing",
					"<!-- tag: test -->",
					"Write comprehensive unit tests for auth.",
				].join("\n"),
			);

			const res = await handleOrchestrate(makeParams({ planPath }), makeCtx(tmp));

			assert.strictEqual(res.isError, false);
			const text = textFromToolResult(res);
			assert.ok(text.includes("Steps: 2"));
			assert.ok(text.includes("design"));
			assert.ok(text.includes("test"));
			assert.ok(text.includes("Agent Chain Commands"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns error for plan with no tagged sections", async () => {
		const tmp = createTrackedTempDir("orch-test-");
		try {
			const planPath = writePlanFile(tmp, "empty.md", ["# Untitled Plan", "This plan has no tags."].join("\n"));

			const res = await handleOrchestrate(makeParams({ planPath }), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("No tagged sections"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns structured data with steps and commands", async () => {
		const tmp = createTrackedTempDir("orch-test-");
		try {
			const planPath = writePlanFile(
				tmp,
				"structured.md",
				["# Build", "<!-- tag: build -->", "Fix build errors in the project."].join("\n"),
			);

			const res = await handleOrchestrate(makeParams({ planPath }), makeCtx(tmp));

			assert.ok(res.details.data);
			const data = res.details.data as Record<string, unknown>;
			assert.strictEqual(data.stepCount, 1);
			assert.ok(Array.isArray(data.commands));
			assert.ok(Array.isArray(data.steps));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("handles plan with all supported tags", async () => {
		const tmp = createTrackedTempDir("orch-test-");
		try {
			const planPath = writePlanFile(
				tmp,
				"full.md",
				[
					"# Phase 1",
					"<!-- tag: design -->",
					"Design the system.",
					"# Phase 2",
					"<!-- tag: impl -->",
					"Implement the system.",
					"# Phase 3",
					"<!-- tag: test -->",
					"Test the system.",
					"# Phase 4",
					"<!-- tag: security -->",
					"Security review.",
					"# Phase 5",
					"<!-- tag: build -->",
					"Build and deploy.",
					"# Phase 6",
					"<!-- tag: review -->",
					"Code review.",
				].join("\n"),
			);

			const res = await handleOrchestrate(makeParams({ planPath }), makeCtx(tmp));

			const text = textFromToolResult(res);
			assert.ok(text.includes("Steps: 6"));
			// Check that agent chains appear for all tags
			assert.ok(text.includes("planner,architect"));
			assert.ok(text.includes("tdd-guide,lang-reviewer"));
			assert.ok(text.includes("security-reviewer,lang-reviewer"));
			assert.ok(text.includes("build-error-resolver"));
			assert.ok(text.includes("test-engineer,verifier"));
			assert.ok(text.includes("reviewer"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
