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

// ─── T2/R4: runId persist branch (review R7a + security S1/S2) ────────────────

describe("handleOrchestrate runId persistence (ADR-4 §6 producer 1)", () => {
	function writePlanDoc(dir: string): string {
		const planPath = path.join(dir, "plan.md");
		fs.writeFileSync(planPath, "# Design\n<!-- tag: design -->\nDesign the thing.\n");
		return planPath;
	}

	it("persists a PlanRecord v1 + manifest pointer when runId resolves", async () => {
		const tmp = createTrackedTempDir("orch-persist-");
		try {
			const planPath = writePlanDoc(tmp);
			const { createRunManifest, saveRunManifest } = await import("../../../../src/state/stores/state-store.ts");
			const { allTeams, discoverTeams } = await import("../../../../src/teams/discover-teams.ts");
			const { allWorkflows, discoverWorkflows } = await import("../../../../src/workflows/discover-workflows.ts");
			const team = allTeams(discoverTeams(tmp)).find((t) => t.name === "implementation")!;
			const workflow = allWorkflows(discoverWorkflows(tmp)).find((w) => w.name === "implementation")!;
			const { manifest } = createRunManifest({ cwd: tmp, team, workflow, goal: "persist test" });
			saveRunManifest(manifest);

			const res = await handleOrchestrate(makeParams({ planPath, runId: manifest.runId }), makeCtx(tmp));
			assert.strictEqual(res.isError !== true, true, textFromToolResult(res));
			const { loadPlanRecords } = await import("../../../../src/state/stores/plan-store.ts");
			const records = loadPlanRecords(manifest);
			assert.equal(records.length, 1);
			assert.equal(records[0]?.version, 1);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("read-only role is denied (S1): no file written", async () => {
		const tmp = createTrackedTempDir("orch-role-");
		const prevRole = process.env.PI_CREW_ROLE;
		try {
			const planPath = writePlanDoc(tmp);
			const { createRunManifest, saveRunManifest } = await import("../../../../src/state/stores/state-store.ts");
			const { allTeams, discoverTeams } = await import("../../../../src/teams/discover-teams.ts");
			const { allWorkflows, discoverWorkflows } = await import("../../../../src/workflows/discover-workflows.ts");
			const team = allTeams(discoverTeams(tmp)).find((t) => t.name === "implementation")!;
			const workflow = allWorkflows(discoverWorkflows(tmp)).find((w) => w.name === "implementation")!;
			const { manifest } = createRunManifest({ cwd: tmp, team, workflow, goal: "role gate" });
			saveRunManifest(manifest);

			process.env.PI_CREW_ROLE = "explorer";
			const res = await handleOrchestrate(makeParams({ planPath, runId: manifest.runId }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			assert.ok(textFromToolResult(res).includes("read-only"));
			const plansDir = path.join(manifest.stateRoot, "plans");
			assert.ok(!fs.existsSync(plansDir), "read-only role must not create plans.json");
		} finally {
			if (prevRole === undefined) delete process.env.PI_CREW_ROLE;
			else process.env.PI_CREW_ROLE = prevRole;
			removeTrackedTempDir(tmp);
		}
	});

	it("foreign-session run requires force (S1): no file written", async () => {
		const tmp = createTrackedTempDir("orch-foreign-");
		try {
			const planPath = writePlanDoc(tmp);
			const { createRunManifest, saveRunManifest } = await import("../../../../src/state/stores/state-store.ts");
			const { allTeams, discoverTeams } = await import("../../../../src/teams/discover-teams.ts");
			const { allWorkflows, discoverWorkflows } = await import("../../../../src/workflows/discover-workflows.ts");
			const team = allTeams(discoverTeams(tmp)).find((t) => t.name === "implementation")!;
			const workflow = allWorkflows(discoverWorkflows(tmp)).find((w) => w.name === "implementation")!;
			const { manifest } = createRunManifest({ cwd: tmp, team, workflow, goal: "foreign gate" });
			manifest.ownerSessionId = "session-other-1234";
			saveRunManifest(manifest);

			const res = await handleOrchestrate(makeParams({ planPath, runId: manifest.runId }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			assert.ok(textFromToolResult(res).includes("another session"));
			assert.ok(!fs.existsSync(path.join(manifest.stateRoot, "plans")));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
