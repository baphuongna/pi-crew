import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { configPath, loadConfig } from "../../../src/config/config.ts";

test("loadConfig drops runtime and limit values above sanity ceilings", () => {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-config-ceiling-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		const filePath = configPath();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(
			filePath,
			JSON.stringify(
				{
					limits: {
						maxConcurrentWorkers: 4,
						maxTasksPerRun: 1_000_000,
						heartbeatStaleMs: 999_999_999_999,
					},
					runtime: {
						maxTurns: 10_001,
						graceTurns: 1_000,
					},
				},
				null,
				2,
			),
			"utf-8",
		);
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

test("loadConfig accepts taskTimeoutMs up to 24h and drops beyond (RT-NEW-1)", () => {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-tasktimeout-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		const filePath = configPath();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		// A reasonable 5-minute per-task timeout. RT-NEW-1 bug: this used the
		// runtimeMaxTurns (10_000) ceiling, so 300_000ms > 10_000 silently returned
		// undefined → NO timeout enforced (runaway task). Now bounded by
		// runtimeTaskTimeoutMs (24h), so it must parse successfully.
		fs.writeFileSync(
			filePath,
			JSON.stringify({ runtime: { taskTimeoutMs: 300_000 } }, null, 2),
			"utf-8",
		);
		const loaded = loadConfig();
		assert.equal(loaded.config.runtime?.taskTimeoutMs, 300_000, "5-minute taskTimeoutMs must parse (RT-NEW-1)");

		// Values above the 24h ceiling are still dropped (sanity guard preserved).
		fs.writeFileSync(filePath, JSON.stringify({ runtime: { taskTimeoutMs: 25 * 60 * 60 * 1000 } }, null, 2), "utf-8");
		const overCeiling = loadConfig();
		assert.equal(overCeiling.config.runtime?.taskTimeoutMs, undefined, "taskTimeoutMs above 24h ceiling must be dropped");
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
});
