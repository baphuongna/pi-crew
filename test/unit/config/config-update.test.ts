import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { projectConfigPath } from "../../../src/config/config.ts";
import { handleTeamTool } from "../../../src/extension/team-tool.ts";

test("config action can update project config", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-config-update-"));
	try {
		const result = await handleTeamTool(
			{
				action: "config",
				config: {
					scope: "project",
					asyncByDefault: true,
					notifierIntervalMs: 2000,
				},
			},
			{ cwd },
		);
		assert.equal(result.isError, false);
		const raw = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf-8")) as {
			asyncByDefault?: boolean;
			notifierIntervalMs?: number;
		};
		assert.equal(raw.asyncByDefault, true);
		assert.equal(raw.notifierIntervalMs, 2000);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
