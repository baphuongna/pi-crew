import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { clearRunPromisesForTest } from "../../src/runtime/run-tracker.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("foreground run with scheduler waits for completion and returns results", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-foreground-nonblocking-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	let scheduled = false;
	// Use mock child-pi to simulate fast agent completion without real LLM calls
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousAllowMock = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	try {
		const toolResult = await handleTeamTool(
			{ action: "run", team: "fast-fix", goal: "test" },
			{
				cwd,
				startForegroundRun: (runner, runId) => {
					scheduled = true;
					// Run the runner to completion (mock agents finish instantly)
					const p = runner();
					p.then(() => {}).catch(() => {});
				},
			},
		);

		// Mock runs complete quickly, give a small buffer
		await new Promise((r) => setTimeout(r, 1000));

		assert.equal(toolResult.isError, false);
		assert.equal(scheduled, true);
		const text = firstText(toolResult);
		// Should NOT contain the old "continues in this Pi session without blocking" text
		assert.ok(
			!text.includes("continues in this Pi session without blocking"),
			`Expected no "continues in this Pi session without blocking" but got: ${text}`,
		);
		// Should contain actual run completion output
		assert.match(text, /pi-crew run/, `Expected "pi-crew run" in result but got: ${text}`);
		assert.ok(toolResult.details.runId, "Expected runId in details");
	} finally {
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		if (previousAllowMock === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = previousAllowMock;
		clearRunPromisesForTest();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
