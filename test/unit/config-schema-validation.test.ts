import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../../src/config/config.ts";
import { configPatchFromConfig } from "../../src/extension/team-tool/config-patch.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configPath, loadConfig } from "../../src/config/config.ts";

test("parseConfig accepts valid values and drops invalid siblings using TypeBox validation", () => {
	const parsed = parseConfig({
		asyncByDefault: "true",
		limits: {
			maxConcurrentWorkers: 4,
			allowUnboundedConcurrency: true,
			maxTaskDepth: "bad",
		},
		runtime: {
			mode: "child-process",
			maxTurns: "oops",
			graceTurns: 9,
		},
		ui: {
			widgetPlacement: "aboveEditor",
			widgetMaxLines: "no",
		},
	});
	assert.equal(parsed.asyncByDefault, undefined);
	assert.equal(parsed.limits?.maxConcurrentWorkers, 4);
	assert.equal(parsed.limits?.allowUnboundedConcurrency, true);
	assert.equal(parsed.limits?.maxTaskDepth, undefined);
	assert.equal(parsed.runtime?.mode, "child-process");
	assert.equal(parsed.runtime?.maxTurns, undefined);
	assert.equal(parsed.runtime?.graceTurns, 9);
	assert.equal(parsed.ui?.widgetPlacement, "aboveEditor");
	assert.equal(parsed.ui?.widgetMaxLines, undefined);
});

test("configPatchFromConfig validates config updates with TypeBox and drops invalid values", () => {
	const patch = configPatchFromConfig({
		asyncByDefault: "yes",
		notifierIntervalMs: "2500",
		runtime: {
			groupJoin: "smart",
			mode: 123,
			graceTurns: 99,
		},
		limits: {
			maxTasksPerRun: 20,
			maxRunMinutes: "invalid",
		},
	});
	assert.equal(patch.asyncByDefault, undefined);
	assert.equal(patch.notifierIntervalMs, undefined);
	assert.equal(patch.runtime?.mode, undefined);
	assert.equal(patch.runtime?.groupJoin, "smart");
	assert.equal(patch.runtime?.graceTurns, 99);
	assert.equal(patch.limits?.maxTasksPerRun, 20);
	assert.equal(patch.limits?.maxRunMinutes, undefined);
});

test("loadConfig surfaces schema warnings without failing config load", () => {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-config-warn-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		const filePath = configPath();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify({ notifierIntervalMs: 100, runtime: { mode: "invalid-mode", unknown: true } }), "utf-8");
		const loaded = loadConfig();
		assert.equal(typeof loaded.config.notifierIntervalMs, "undefined");
		assert.equal((loaded.warnings?.length ?? 0) > 0, true);
		assert.match(loaded.warnings?.[0] ?? "", /notifierIntervalMs/);
		assert.match((loaded.warnings?.[1] ?? loaded.warnings?.[0] ?? ""), /runtime/);
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
});
