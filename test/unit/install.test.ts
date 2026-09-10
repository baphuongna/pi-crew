import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const installScript = path.resolve("install.mjs");

function runInstaller(home: string): string {
	return childProcess.execFileSync(process.execPath, [installScript], {
		cwd: path.resolve("."),
		env: { ...process.env, PI_TEAMS_HOME: home },
		encoding: "utf-8",
	});
}

test("install.mjs respects PI_TEAMS_HOME and writes default UI config", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-install-home-"));
	try {
		const output = runInstaller(home);
		const configPath = path.join(home, ".pi", "agent", "pi-crew.json");
		assert.match(output, /Created default pi-crew global config/);
		assert.equal(fs.existsSync(configPath), true);
		const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
			ui?: Record<string, unknown>;
		};
		// WI-1b.2 (G17): widgetPlacement must track DEFAULT_UI ("bottom"),
		// enforced by test/unit/install-defaults-sync.test.ts.
		assert.deepEqual(config.ui, {
			widgetPlacement: "bottom",
			widgetMaxLines: 8,
			powerbar: true,
			dashboardPlacement: "center",
			dashboardWidth: 72,
			dashboardLiveRefreshMs: 1000,
			autoOpenDashboard: false,
			autoOpenDashboardForForegroundRuns: false,
			showModel: true,
			showTokens: true,
			showTools: true,
		});
		const secondOutput = runInstaller(home);
		assert.match(secondOutput, /already exists/);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("install.mjs migrates legacy config inside PI_TEAMS_HOME", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-install-legacy-home-"));
	try {
		const legacyPath = path.join(home, ".pi", "agent", "extensions", "pi-crew", "config.json");
		fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
		fs.writeFileSync(legacyPath, `${JSON.stringify({ ui: { widgetPlacement: "belowEditor" } }, null, 2)}\n`, "utf-8");
		const output = runInstaller(home);
		const configPath = path.join(home, ".pi", "agent", "pi-crew.json");
		assert.match(output, /Migrated pi-crew global config/);
		const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
			ui?: Record<string, unknown>;
		};
		assert.deepEqual(config.ui, { widgetPlacement: "belowEditor" });
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
