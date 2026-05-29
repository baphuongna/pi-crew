import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, loadConfig } from "../../src/config/config.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("AgentOverrideConfig skills field", () => {
	it("parses skills override as string array", () => {
		const config = parseConfig({
			agents: {
				overrides: {
					explorer: {
						skills: ["git-master", "safe-bash"],
					},
				},
			},
		});
		assert.ok(config.agents?.overrides?.explorer);
		assert.deepEqual(config.agents.overrides.explorer.skills, ["git-master", "safe-bash"]);
	});

	it("parses skills override as false", () => {
		const config = parseConfig({
			agents: {
				overrides: {
					explorer: {
						skills: false,
					},
				},
			},
		});
		assert.ok(config.agents?.overrides?.explorer);
		assert.equal(config.agents.overrides.explorer.skills, false);
	});

	it("skills override absent by default", () => {
		const config = parseConfig({
			agents: {
				overrides: {
					explorer: {
						model: "claude-haiku-4-5",
					},
				},
			},
		});
		assert.ok(config.agents?.overrides?.explorer);
		assert.equal(config.agents.overrides.explorer.skills, undefined);
	});
});

function withIsolatedGlobalConfig<T>(fn: () => T): T {
	const previous = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-home-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		return fn();
	} finally {
		if (previous === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previous;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

describe("projectPiCrewJsonPath", () => {
	it("loadConfig reads from .pi/pi-crew.json for safe config", () => withIsolatedGlobalConfig(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-test-"));
		try {
			const piDir = path.join(tmpDir, ".pi");
			fs.mkdirSync(piDir, { recursive: true });
			// ui.powerbar is a safe (non-sensitive) config that survives project sanitization
			fs.writeFileSync(path.join(piDir, "pi-crew.json"), JSON.stringify({
				ui: { powerbar: true },
			}));

			const loaded = loadConfig(tmpDir);
			assert.equal(loaded.config.ui?.powerbar, true);
			assert.ok(loaded.paths.some((p) => p.includes("pi-crew.json")));
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}));

	it("loadConfig sanitizes .pi/pi-crew.json agent overrides for security", () => withIsolatedGlobalConfig(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-test-"));
		try {
			const piDir = path.join(tmpDir, ".pi");
			fs.mkdirSync(piDir, { recursive: true });
			fs.writeFileSync(path.join(piDir, "pi-crew.json"), JSON.stringify({
				agents: {
					overrides: { explorer: { model: "test-model", thinking: "low" } },
				},
				ui: { powerbar: true },
			}));

			const loaded = loadConfig(tmpDir);
			// SECURITY: agents.overrides should be stripped from project config
			assert.equal(loaded.config.agents?.overrides, undefined);
			// UI settings should still be loaded (not sensitive)
			assert.equal(loaded.config.ui?.powerbar, true);
			// SECURITY WARNING: agents.overrides should trigger a warning
			assert.ok(loaded.warnings?.some((w) => w.includes("agents.overrides")));
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}));

	it("loadConfig ignores invalid .pi/pi-crew.json and keeps defaults", () => withIsolatedGlobalConfig(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-test-"));
		try {
			const piDir = path.join(tmpDir, ".pi");
			fs.mkdirSync(piDir, { recursive: true });
			fs.writeFileSync(path.join(piDir, "pi-crew.json"), "{ invalid json");
			const loaded = loadConfig(tmpDir);
			assert.equal(loaded.config.agents?.overrides, undefined);
			assert.ok(loaded.warnings?.some((w) => w.includes("invalid config ignored")));
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}));

	it("loadConfig ignores missing .pi/pi-crew.json gracefully", () => withIsolatedGlobalConfig(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-test-"));
		try {
			const loaded = loadConfig(tmpDir);
			assert.equal(loaded.config.ui?.powerbar, undefined);
			assert.ok(loaded.error === undefined);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}));
});
