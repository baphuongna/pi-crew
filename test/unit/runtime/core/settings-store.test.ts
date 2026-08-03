import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { applyCrewSettingsToConfig, loadCrewSettings, saveCrewSettings } from "../../../../src/runtime/settings-store.ts";

test("loadCrewSettings returns defaults when file missing", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "settings-store-missing-"));
	try {
		const settings = loadCrewSettings(cwd);
		assert.deepEqual(settings, {});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("save + load roundtrip preserves all fields", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "settings-store-roundtrip-"));
	const original = {
		maxConcurrent: 4,
		defaultMaxTurns: 100,
		graceTurns: 10,
		defaultJoinMode: "async" as const,
		schedulingEnabled: true,
		notifierIntervalMs: 5000,
	};
	try {
		assert.equal(saveCrewSettings(original, cwd), true);
		const settings = loadCrewSettings(cwd);
		assert.deepEqual(settings, original);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("applyCrewSettingsToConfig merges into runtime config", () => {
	const config = {
		limits: { maxConcurrentWorkers: 1 },
		runtime: { maxTurns: 50, graceTurns: 5, groupJoin: "smart" as const },
		notifierIntervalMs: 1000,
	};
	const settings = {
		maxConcurrent: 8,
		defaultMaxTurns: 200,
		graceTurns: 20,
		defaultJoinMode: "group" as const,
		notifierIntervalMs: 3000,
	};
	applyCrewSettingsToConfig(config, settings);
	assert.equal(config.limits.maxConcurrentWorkers, 8);
	assert.equal(config.runtime.maxTurns, 200);
	assert.equal(config.runtime.graceTurns, 20);
	assert.equal(config.runtime.groupJoin, "group");
	assert.equal(config.notifierIntervalMs, 3000);
});

test("applyCrewSettingsToConfig handles missing config sections gracefully", () => {
	const configWithoutLimits = {
		runtime: { maxTurns: 50, graceTurns: 5, groupJoin: "smart" as const },
	} as {
		limits?: { maxConcurrentWorkers?: number };
		runtime?: {
			maxTurns?: number;
			graceTurns?: number;
			groupJoin?: string;
		};
		notifierIntervalMs?: number;
	};
	const settings = {
		maxConcurrent: 4,
		defaultMaxTurns: 100,
		graceTurns: 10,
		defaultJoinMode: "async" as const,
		notifierIntervalMs: 2000,
	};
	assert.doesNotThrow(() => applyCrewSettingsToConfig(configWithoutLimits, settings));
	assert.equal(configWithoutLimits.limits, undefined);
	assert.equal(configWithoutLimits.runtime!.maxTurns, 100);

	const configWithoutRuntime = { limits: { maxConcurrentWorkers: 2 } } as {
		limits?: { maxConcurrentWorkers?: number };
		runtime?: {
			maxTurns?: number;
			graceTurns?: number;
			groupJoin?: string;
		};
		notifierIntervalMs?: number;
	};
	assert.doesNotThrow(() => applyCrewSettingsToConfig(configWithoutRuntime, settings));
	assert.equal(configWithoutRuntime.limits!.maxConcurrentWorkers, 4);
	assert.equal(configWithoutRuntime.runtime, undefined);
	assert.equal(configWithoutRuntime.notifierIntervalMs, 2000);
});

test("saveCrewSettings writes to .pi/crew-settings.json within the temp cwd", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "settings-store-path-"));
	const settings = { maxConcurrent: 2 };
	const expectedPath = path.join(cwd, ".pi", "crew-settings.json");
	try {
		assert.equal(saveCrewSettings(settings, cwd), true);
		assert.equal(fs.existsSync(expectedPath), true);
		const raw = JSON.parse(fs.readFileSync(expectedPath, "utf-8"));
		assert.deepEqual(raw, settings);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
