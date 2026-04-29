import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("foreground child-process run returns immediately when scheduler is available", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-foreground-nonblocking-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	let scheduled = false;
	try {
		const result = await handleTeamTool({ action: "run", team: "implementation", goal: "large foreground run" }, {
			cwd,
			startForegroundRun: () => { scheduled = true; },
		});
		assert.equal(result.isError, false);
		assert.equal(scheduled, true);
		assert.match(firstText(result), /continues in this Pi session without blocking/);
		assert.ok(result.details.runId);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

