import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configPath, legacyConfigPath, loadConfig, projectConfigPath } from "../../src/config/config.ts";

test("loadConfig returns empty config when config file is absent or user-local", () => {
	const loaded = loadConfig();
	assert.equal(typeof loaded.path, "string");
	assert.equal(loaded.path, configPath());
	assert.equal(typeof loaded.config, "object");
});

test("loadConfig parses notification settings", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-notifications-config-"));
	try {
		fs.mkdirSync(path.dirname(projectConfigPath(cwd)), { recursive: true });
		fs.writeFileSync(projectConfigPath(cwd), JSON.stringify({ notifications: { enabled: true, severityFilter: ["info", "critical"], dedupWindowMs: 5000, batchWindowMs: 100, quietHours: "22:00-07:00", sinkRetentionDays: 14 } }), "utf-8");
		const loaded = loadConfig(cwd);
		assert.equal(loaded.config.notifications?.enabled, true);
		assert.deepEqual(loaded.config.notifications?.severityFilter, ["info", "critical"]);
		assert.equal(loaded.config.notifications?.dedupWindowMs, 5000);
		assert.equal(loaded.config.notifications?.batchWindowMs, 100);
		assert.equal(loaded.config.notifications?.quietHours, "22:00-07:00");
		assert.equal(loaded.config.notifications?.sinkRetentionDays, 14);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadConfig reads new global pi-crew.json before legacy extension config", () => {
	const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-config-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = tempHome;
	try {
		fs.mkdirSync(path.dirname(legacyConfigPath()), { recursive: true });
		fs.writeFileSync(legacyConfigPath(), JSON.stringify({ ui: { powerbar: false }, notifierIntervalMs: 1000 }), "utf-8");
		fs.mkdirSync(path.dirname(configPath()), { recursive: true });
		fs.writeFileSync(configPath(), JSON.stringify({ ui: { powerbar: true } }), "utf-8");
		const loaded = loadConfig();
		assert.equal(loaded.config.ui?.powerbar, true);
		assert.equal(loaded.config.notifierIntervalMs, 1000);
		assert.ok(loaded.paths.includes(legacyConfigPath()));
		assert.ok(loaded.paths.includes(configPath()));
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(tempHome, { recursive: true, force: true });
	}
});

test("loadConfig parses UI settings - user config takes precedence", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ui-config-"));
	// Use isolated temp home to avoid interference from real user config
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = cwd;
	try {
		fs.mkdirSync(path.dirname(projectConfigPath(cwd)), { recursive: true });
		// Project config has belowEditor
		fs.writeFileSync(projectConfigPath(cwd), JSON.stringify({ ui: { widgetPlacement: "belowEditor", widgetMaxLines: 12, powerbar: false } }), "utf-8");
		// User config has aboveEditor (takes precedence)
		fs.mkdirSync(path.dirname(configPath()), { recursive: true });
		fs.writeFileSync(configPath(), JSON.stringify({ ui: { widgetPlacement: "aboveEditor", widgetMaxLines: 10 } }), "utf-8");
		const loaded = loadConfig(cwd);
		// SECURITY: User config takes precedence over project config
		assert.equal(loaded.config.ui?.widgetPlacement, "aboveEditor");
		assert.equal(loaded.config.ui?.widgetMaxLines, 10);
		// Project config provides values not in user config
		assert.equal(loaded.config.ui?.powerbar, false);
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
