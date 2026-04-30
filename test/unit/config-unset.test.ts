import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadConfig } from "../../src/config/config.ts";

test("config action can unset nested config keys", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-config-unset-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-config-unset-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = home;
	try {
		await handleTeamTool({ action: "config", config: { scope: "project", notifications: { enabled: true, dedupWindowMs: 1000 } } }, { cwd });
		let loaded = loadConfig(cwd);
		assert.equal(loaded.config.notifications?.dedupWindowMs, 1000);
		await handleTeamTool({ action: "config", config: { scope: "project", unset: ["notifications.dedupWindowMs"] } }, { cwd });
		loaded = loadConfig(cwd);
		assert.equal(loaded.config.notifications?.enabled, true);
		assert.equal(loaded.config.notifications?.dedupWindowMs, undefined);
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
	}
});
