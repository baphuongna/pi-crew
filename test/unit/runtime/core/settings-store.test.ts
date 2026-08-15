import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	applyCrewSettingsTiersToConfig,
	applyCrewSettingsToConfig,
	loadCrewSettings,
	loadCrewSettingsTiers,
	saveCrewSettings,
} from "../../../../src/runtime/settings-store.ts";

/** Hermetic helper: write a crew-settings file and return its path. */
function writeSettingsFile(filePath: string, data: unknown): string {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
	return filePath;
}

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

// ---------------------------------------------------------------------------
// Wave 2B (ITEM 1, P1): project-tier crew-settings must not bypass the config
// sanitize pipeline. Regression tests pin the tighten-only guard tiering.
// The `globalFile` param of loadCrewSettingsTiers pins a hermetic user tier
// (never touches the real ~/.pi/crew-settings.json).
// ---------------------------------------------------------------------------

test("project crew-settings raising guard values is dropped with the standard warning", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "settings-store-tier-raise-"));
	try {
		const projectFile = writeSettingsFile(path.join(cwd, ".pi", "crew-settings.json"), {
			maxConcurrent: 1024,
			defaultMaxTurns: 9999,
			graceTurns: 500,
		});
		const tiers = loadCrewSettingsTiers(cwd, path.join(cwd, "absent-global.json"));
		const config = {
			limits: { maxConcurrentWorkers: 4 },
			runtime: { maxTurns: 50, graceTurns: 5 },
			notifierIntervalMs: 1000,
		};
		const warnings = applyCrewSettingsTiersToConfig(config, tiers);
		// Guards untouched — the raise is refused.
		assert.equal(config.limits.maxConcurrentWorkers, 4);
		assert.equal(config.runtime.maxTurns, 50);
		assert.equal(config.runtime.graceTurns, 5);
		// Standard warning format (same as sanitizeProjectConfig drops).
		assert.equal(warnings.length, 3);
		for (const dotted of ["limits.maxConcurrentWorkers", "runtime.maxTurns", "runtime.graceTurns"]) {
			assert.ok(
				warnings.includes(
					`${projectFile}: project-level sensitive config '${dotted}' is ignored; set it in user config to trust it explicitly`,
				),
				`missing warning for ${dotted}: ${JSON.stringify(warnings)}`,
			);
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("project crew-settings lowering or equalling guard values is applied", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "settings-store-tier-lower-"));
	try {
		writeSettingsFile(path.join(cwd, ".pi", "crew-settings.json"), {
			maxConcurrent: 2,
			defaultMaxTurns: 10,
			graceTurns: 2,
			defaultJoinMode: "group",
			notifierIntervalMs: 9000,
		});
		const tiers = loadCrewSettingsTiers(cwd, path.join(cwd, "absent-global.json"));
		const config = {
			limits: { maxConcurrentWorkers: 4 },
			runtime: { maxTurns: 50, graceTurns: 5, groupJoin: "smart" as const },
			notifierIntervalMs: 1000,
		};
		const warnings = applyCrewSettingsTiersToConfig(config, tiers);
		assert.equal(config.limits.maxConcurrentWorkers, 2);
		assert.equal(config.runtime.maxTurns, 10);
		assert.equal(config.runtime.graceTurns, 2);
		// Non-guard fields ride the sanitize choke point unchanged.
		assert.equal(config.runtime.groupJoin, "group");
		assert.equal(config.notifierIntervalMs, 9000);
		assert.equal(warnings.length, 0);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("user-tier crew-settings stay fully trusted (raising applies, no tiering)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "settings-store-tier-user-"));
	try {
		const globalFile = writeSettingsFile(path.join(cwd, "user-crew-settings.json"), {
			maxConcurrent: 1024,
			defaultMaxTurns: 10000,
			graceTurns: 500,
		});
		const tiers = loadCrewSettingsTiers(cwd, globalFile);
		assert.deepEqual(tiers.project, {});
		const config = {
			limits: { maxConcurrentWorkers: 4 },
			runtime: { maxTurns: 50, graceTurns: 5 },
		};
		const warnings = applyCrewSettingsTiersToConfig(config, tiers);
		assert.equal(config.limits.maxConcurrentWorkers, 1024);
		assert.equal(config.runtime.maxTurns, 10000);
		assert.equal(config.runtime.graceTurns, 500);
		assert.equal(warnings.length, 0);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("project guard value with no effective baseline is dropped (cannot verify tightening)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "settings-store-tier-nobaseline-"));
	try {
		const projectFile = writeSettingsFile(path.join(cwd, ".pi", "crew-settings.json"), { defaultMaxTurns: 100 });
		const tiers = loadCrewSettingsTiers(cwd, path.join(cwd, "absent-global.json"));
		const config: { runtime?: { maxTurns?: number; graceTurns?: number } } = { runtime: { graceTurns: 5 } };
		const warnings = applyCrewSettingsTiersToConfig(config, tiers);
		assert.equal(config.runtime?.maxTurns, undefined);
		assert.equal(config.runtime?.graceTurns, 5);
		assert.ok(warnings.some((w) => w.includes("runtime.maxTurns")));
		assert.ok(warnings[0].startsWith(projectFile));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("project-tier scheduledJobs remain honored after the tier split (documented boundary)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "settings-store-tier-jobs-"));
	try {
		writeSettingsFile(path.join(cwd, ".pi", "crew-settings.json"), {
			scheduledJobs: [{ id: "j1", scheduleType: "interval", enabled: true }],
		});
		const tiers = loadCrewSettingsTiers(cwd, path.join(cwd, "absent-global.json"));
		assert.equal(tiers.merged.scheduledJobs?.length, 1);
		// scheduledJobs never interact with the config-guard pipeline.
		const config = { runtime: { maxTurns: 50 } };
		const warnings = applyCrewSettingsTiersToConfig(config, tiers);
		assert.equal(warnings.length, 0);
		assert.equal(config.runtime.maxTurns, 50);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
