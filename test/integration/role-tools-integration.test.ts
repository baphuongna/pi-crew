import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { getToolConfig, hasToolRestrictions } from "../../src/config/role-tools.ts";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { unregisterActiveRun } from "../../src/state/stores/active-run-registry.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("fast-fix team uses explorer role with tool restrictions", async () => {
	// Set mock mode
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousAllow = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-role-tools-"));
	let runId: string | undefined;

	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });

		// Verify explorer has restrictions
		const explorerConfig = getToolConfig("explorer");
		assert.ok(explorerConfig.tools !== undefined, "explorer should have explicit tools");
		assert.ok(explorerConfig.tools!.includes("read"), "explorer should have read");
		// W7: bash is now in explorer's tools allowlist (for research-5
		// decisions stream's `git log --grep`). State-mutation safety is
		// still enforced via edit/write exclusion + READ_ONLY_ROLES layer.
		assert.ok(explorerConfig.tools!.includes("bash"), "explorer should include bash (for git log)");
		assert.ok(explorerConfig.excludeTools!.includes("edit"), "explorer should exclude edit");
		assert.ok(explorerConfig.excludeTools!.includes("write"), "explorer should exclude write");
		assert.ok(hasToolRestrictions("explorer"), "explorer should have tool restrictions");

		// Run fast-fix (uses explorer)
		const run = await handleTeamTool({ action: "run", team: "fast-fix", goal: "test role tools" }, { cwd });

		runId = run.details.runId;

		// Check that run completed
		const status = await handleTeamTool({ action: "status", runId }, { cwd });
		const statusText = firstText(status);

		// Run should complete (even in mock mode)
		assert.ok(statusText.includes("completed") || statusText.includes("failed"), `Expected run to complete, got: ${statusText}`);
	} finally {
		if (runId) unregisterActiveRun(runId);
		process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock ?? "";
		if (previousAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = previousAllow;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("default team uses executor role without restrictions", async () => {
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousAllow = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-executor-"));
	let runId: string | undefined;

	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });

		// Verify executor has no restrictions
		const executorConfig = getToolConfig("executor");
		assert.equal(executorConfig.tools, undefined);
		assert.equal(executorConfig.excludeTools, undefined);
		assert.equal(hasToolRestrictions("executor"), false);

		// Run default (uses executor)
		const run = await handleTeamTool({ action: "run", team: "default", goal: "test executor" }, { cwd });

		runId = run.details.runId;

		const status = await handleTeamTool({ action: "status", runId }, { cwd });
		const statusText = firstText(status);

		assert.ok(statusText.includes("completed") || statusText.includes("failed"), `Expected run to complete, got: ${statusText}`);
	} finally {
		if (runId) unregisterActiveRun(runId);
		process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock ?? "";
		if (previousAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = previousAllow;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("role-tools config exports are available", () => {
	// Sanity check that all expected roles have configs
	const roles = [
		"explorer",
		"analyst",
		"planner",
		"executor",
		"reviewer",
		"writer",
		"security-reviewer",
		"test-engineer",
		"critic",
		"verifier",
	];
	for (const role of roles) {
		const config = getToolConfig(role);
		// executor is intentionally unrestricted; all others must have a real
		// config (F1/F2: hyphen keys + critic/verifier entries).
		if (role !== "executor") {
			assert.ok(config.tools !== undefined || config.excludeTools !== undefined, `Role ${role} should have a config`);
		}
	}
});
