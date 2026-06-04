import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	loadCrewSettings,
	saveCrewSettings,
	applyCrewSettingsToConfig,
	type CrewSettings,
} from "../../src/runtime/settings-store.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

describe("saveCrewSettings / loadCrewSettings", () => {
	it("saves and loads settings round-trip", () => {
		const tmp = createTrackedTempDir("pi-crew-settings-");
		try {
			const settings: CrewSettings = {
				maxConcurrent: 4,
				defaultMaxTurns: 50,
				graceTurns: 3,
				defaultJoinMode: "async",
				schedulingEnabled: true,
				notifierIntervalMs: 5000,
			};
			const saved = saveCrewSettings(settings, tmp);
			assert.equal(saved, true);
			const loaded = loadCrewSettings(tmp);
			assert.equal(loaded.maxConcurrent, 4);
			assert.equal(loaded.defaultMaxTurns, 50);
			assert.equal(loaded.graceTurns, 3);
			assert.equal(loaded.defaultJoinMode, "async");
			assert.equal(loaded.schedulingEnabled, true);
			assert.equal(loaded.notifierIntervalMs, 5000);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("loadCrewSettings returns empty object when no file exists", () => {
		const tmp = createTrackedTempDir("pi-crew-settings-");
		try {
			const loaded = loadCrewSettings(tmp);
			assert.equal(loaded.maxConcurrent, undefined);
			assert.equal(loaded.defaultMaxTurns, undefined);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("loadCrewSettings sanitizes out-of-range values", () => {
		const tmp = createTrackedTempDir("pi-crew-settings-");
		try {
			const bad: CrewSettings = {
				maxConcurrent: 0, // below min
				defaultMaxTurns: 99999, // above ceiling
				graceTurns: -1, // below min
			};
			saveCrewSettings(bad as never, tmp);
			const loaded = loadCrewSettings(tmp);
			assert.equal(loaded.maxConcurrent, undefined);
			assert.equal(loaded.defaultMaxTurns, undefined);
			assert.equal(loaded.graceTurns, undefined);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("loadCrewSettings handles malformed JSON gracefully", () => {
		const tmp = createTrackedTempDir("pi-crew-settings-");
		try {
			const p = path.join(tmp, ".pi", "crew-settings.json");
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.writeFileSync(p, "{ invalid json !!!", "utf-8");
			const loaded = loadCrewSettings(tmp);
			assert.deepEqual(loaded, {});
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("preserves scheduledJobs array", () => {
		const tmp = createTrackedTempDir("pi-crew-settings-");
		try {
			const jobs = [{ id: "job-1", scheduleType: "cron", enabled: true, cron: "*/5 * * * *", workflow: "test" }];
			saveCrewSettings({ scheduledJobs: jobs } as never, tmp);
			const loaded = loadCrewSettings(tmp);
			assert.ok(Array.isArray(loaded.scheduledJobs));
			assert.equal(loaded.scheduledJobs!.length, 1);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("saveCrewSettings returns false on write error", () => {
		const tmp = createTrackedTempDir("pi-crew-settings-");
		try {
			// Make .pi directory read-only
			const dotPi = path.join(tmp, ".pi");
			fs.mkdirSync(dotPi, { recursive: true });
			fs.writeFileSync(path.join(dotPi, "crew-settings.json"), "{}", "utf-8");
			fs.chmodSync(dotPi, 0o444);
			const result = saveCrewSettings({ maxConcurrent: 1 }, tmp);
			assert.equal(result, false);
		} finally {
			// Restore permissions for cleanup
			try { fs.chmodSync(path.join(tmp, ".pi"), 0o755); } catch { /* best effort */ }
			removeTrackedTempDir(tmp);
		}
	});
});

describe("applyCrewSettingsToConfig", () => {
	it("applies maxConcurrent when limits object exists", () => {
		const config = { limits: { maxConcurrentWorkers: 1 } };
		applyCrewSettingsToConfig(config, { maxConcurrent: 8 });
		assert.equal(config.limits!.maxConcurrentWorkers, 8);
	});

	it("applies maxTurns when runtime object exists", () => {
		const config = { runtime: { maxTurns: 10 } };
		applyCrewSettingsToConfig(config, { defaultMaxTurns: 100 });
		assert.equal(config.runtime!.maxTurns, 100);
	});

	it("applies graceTurns when runtime object exists", () => {
		const config = { runtime: { graceTurns: 1 } };
		applyCrewSettingsToConfig(config, { graceTurns: 5 });
		assert.equal(config.runtime!.graceTurns, 5);
	});

	it("applies defaultJoinMode to runtime.groupJoin", () => {
		const config = { runtime: { groupJoin: "async" } };
		applyCrewSettingsToConfig(config, { defaultJoinMode: "group" });
		assert.equal(config.runtime!.groupJoin, "group");
	});

	it("applies notifierIntervalMs", () => {
		const config = { notifierIntervalMs: 1000 };
		applyCrewSettingsToConfig(config, { notifierIntervalMs: 10000 });
		assert.equal(config.notifierIntervalMs, 10000);
	});

	it("does nothing when settings fields are null", () => {
		const config = { limits: { maxConcurrentWorkers: 5 }, runtime: { maxTurns: 20, graceTurns: 3, groupJoin: "async" }, notifierIntervalMs: 5000 };
		applyCrewSettingsToConfig(config, {});
		assert.equal(config.limits!.maxConcurrentWorkers, 5);
		assert.equal(config.runtime!.maxTurns, 20);
	});

	it("does nothing when config lacks limits/runtime", () => {
		const config = {};
		applyCrewSettingsToConfig(config, { maxConcurrent: 4, defaultMaxTurns: 50 });
		assert.equal((config as Record<string, unknown>).limits, undefined);
		assert.equal((config as Record<string, unknown>).runtime, undefined);
	});
});
