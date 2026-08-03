import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import { configPath, loadConfig, parseConfig } from "../../../src/config/config.ts";
import { configPatchFromConfig } from "../../../src/extension/team-tool/config-patch.ts";
import { PiTeamsConfigSchema } from "../../../src/schema/config-schema.ts";

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
		tools: {
			enableSteer: false,
			terminateOnForeground: true,
		},
		telemetry: {
			enabled: false,
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
	assert.equal(parsed.tools?.enableSteer, false);
	assert.equal(parsed.tools?.terminateOnForeground, true);
	assert.equal(parsed.telemetry?.enabled, false);
});

test("parseConfig parses worktree.seedPaths (C6 regression)", () => {
	// seedPaths was declared in the type + schema but never parsed in
	// parseWorktreeConfig, so it silently dropped to undefined.
	const parsed = parseConfig({
		worktree: { seedPaths: ["shared/a.txt", "shared/b.txt"], linkNodeModules: true },
	});
	assert.deepStrictEqual(parsed.worktree?.seedPaths, ["shared/a.txt", "shared/b.txt"]);
	assert.equal(parsed.worktree?.linkNodeModules, true);

	// Undefined when absent (does not force worktree to be defined).
	assert.equal(parseConfig({}).worktree, undefined);
});

test("parseConfig enforces public UI schema ranges", () => {
	const parsed = parseConfig({
		ui: {
			widgetMaxLines: 51,
			dashboardWidth: 31,
			dashboardLiveRefreshMs: 249,
			transcriptTailBytes: 50 * 1024 * 1024 + 1,
		},
	});
	assert.equal(parsed.ui, undefined);
	const tooSmall = parseConfig({ ui: { transcriptTailBytes: 1023 } });
	assert.equal(tooSmall.ui, undefined);
	const valid = parseConfig({
		ui: {
			widgetMaxLines: 50,
			dashboardWidth: 32,
			dashboardLiveRefreshMs: 250,
			transcriptTailBytes: 1024,
		},
	});
	assert.equal(valid.ui?.widgetMaxLines, 50);
	assert.equal(valid.ui?.dashboardWidth, 32);
	assert.equal(valid.ui?.dashboardLiveRefreshMs, 250);
	assert.equal(valid.ui?.transcriptTailBytes, 1024);
});

test("PiTeamsConfigSchema rejects unknown keys and allows runtime notifier numbers", () => {
	assert.equal(Value.Check(PiTeamsConfigSchema, { unknown: true }), false);
	assert.equal(Value.Check(PiTeamsConfigSchema, { ui: { unknown: true } }), false);
	assert.equal(Value.Check(PiTeamsConfigSchema, { autonomous: { unknown: true } }), false);
	assert.equal(Value.Check(PiTeamsConfigSchema, { limits: { unknown: true } }), false);
	assert.equal(
		Value.Check(PiTeamsConfigSchema, {
			reliability: { retryPolicy: { unknown: true } },
		}),
		false,
	);
	assert.equal(Value.Check(PiTeamsConfigSchema, { notifierIntervalMs: 1000.5 }), true);
	assert.equal(parseConfig({ notifierIntervalMs: 1000.5 }).notifierIntervalMs, 1000.5);
});

test("configPatchFromConfig validates config updates with TypeBox and drops invalid values", () => {
	const patch = configPatchFromConfig({
		asyncByDefault: "yes",
		notifierIntervalMs: "2500",
		runtime: {
			groupJoin: "smart",
			groupJoinAckTimeoutMs: 5000,
			completionMutationGuard: "fail",
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
	assert.equal(patch.runtime?.groupJoinAckTimeoutMs, 5000);
	assert.equal(patch.runtime?.completionMutationGuard, "fail");
	assert.equal(patch.runtime?.graceTurns, 99);
	assert.equal(patch.limits?.maxTasksPerRun, 20);
	assert.equal(patch.limits?.maxRunMinutes, undefined);
});

test("loadConfig surfaces schema warnings without failing config load", () => {
	const previousHome = process.env.PI_TEAMS_HOME;
	const previousSkipCheck = process.env.PI_CREW_SKIP_HOME_CHECK;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-config-warn-"));
	process.env.PI_TEAMS_HOME = home;
	process.env.PI_CREW_SKIP_HOME_CHECK = "1";
	try {
		const filePath = configPath();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				notifierIntervalMs: 100,
				runtime: { mode: "invalid-mode", unknown: true },
			}),
			"utf-8",
		);
		const loaded = loadConfig();
		assert.equal(typeof loaded.config.notifierIntervalMs, "undefined");
		assert.equal((loaded.warnings?.length ?? 0) > 0, true);
		assert.match(loaded.warnings?.[0] ?? "", /notifierIntervalMs/);
		assert.match(loaded.warnings?.[1] ?? loaded.warnings?.[0] ?? "", /runtime/);
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		if (previousSkipCheck === undefined) delete process.env.PI_CREW_SKIP_HOME_CHECK;
		else process.env.PI_CREW_SKIP_HOME_CHECK = previousSkipCheck;
		fs.rmSync(home, { recursive: true, force: true });
	}
});
