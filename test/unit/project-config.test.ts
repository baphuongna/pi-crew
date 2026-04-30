import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, projectConfigPath } from "../../src/config/config.ts";

test("loadConfig merges project config but ignores sensitive project trust-boundary keys", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-project-config-"));
	const oldHome = process.env.HOME;
	const oldUserProfile = process.env.USERPROFILE;
	const oldPiTeamsHome = process.env.PI_TEAMS_HOME;
	process.env.HOME = tmp;
	process.env.USERPROFILE = tmp;
	process.env.PI_TEAMS_HOME = tmp;
	try {
		const userConfig = path.join(tmp, ".pi", "agent", "extensions", "pi-crew", "config.json");
		fs.mkdirSync(path.dirname(userConfig), { recursive: true });
		fs.writeFileSync(userConfig, JSON.stringify({ asyncByDefault: true, autonomous: { profile: "suggested", preferAsyncForLongTasks: false } }), "utf-8");
		const projectConfig = projectConfigPath(tmp);
		fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
		fs.writeFileSync(projectConfig, JSON.stringify({ executeWorkers: true, autonomous: { profile: "manual" } }), "utf-8");

		const loaded = loadConfig(tmp);
		assert.equal(loaded.config.asyncByDefault, true);
		assert.equal(loaded.config.executeWorkers, undefined);
		assert.ok(loaded.warnings?.some((warning) => warning.includes("executeWorkers")));
		assert.equal(loaded.config.autonomous?.profile, "suggested");
		assert.ok(loaded.warnings?.some((warning) => warning.includes("autonomous.profile")));
		assert.equal(loaded.config.autonomous?.preferAsyncForLongTasks, false);
		assert.ok(loaded.paths.includes(projectConfig));
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		if (oldUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = oldUserProfile;
		if (oldPiTeamsHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = oldPiTeamsHome;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
