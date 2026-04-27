import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configPath, loadConfig } from "../../src/config/config.ts";

test("loadConfig drops runtime and limit values above sanity ceilings", () => {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-config-ceiling-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		const filePath = configPath();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify({
			limits: {
				maxConcurrentWorkers: 4,
				maxTasksPerRun: 1_000_000,
				heartbeatStaleMs: 999_999_999_999,
			},
			runtime: {
				maxTurns: 10_001,
				graceTurns: 1_000,
			},
		}, null, 2), "utf-8");
		const loaded = loadConfig();
		assert.equal(loaded.config.limits?.maxConcurrentWorkers, 4);
		assert.equal(loaded.config.limits?.maxTasksPerRun, undefined);
		assert.equal(loaded.config.limits?.heartbeatStaleMs, undefined);
		assert.equal(loaded.config.runtime?.maxTurns, undefined);
		assert.equal(loaded.config.runtime?.graceTurns, 1_000);
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
});
