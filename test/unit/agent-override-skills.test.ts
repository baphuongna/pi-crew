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

describe("projectPiCrewJsonPath", () => {
	it("loadConfig reads from .pi/pi-crew.json for safe config", () => {
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
	});

	it("loadConfig sanitizes sensitive fields from .pi/pi-crew.json", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-test-"));
		try {
			const piDir = path.join(tmpDir, ".pi");
			fs.mkdirSync(piDir, { recursive: true });
			fs.writeFileSync(path.join(piDir, "pi-crew.json"), JSON.stringify({
				agents: {
					overrides: { explorer: { model: "test-model" } },
				},
				ui: { powerbar: true },
			}));

			const loaded = loadConfig(tmpDir);
			// agents.overrides is stripped from project config (security)
			assert.equal(loaded.config.agents?.overrides, undefined);
			// ui.powerbar survives
			assert.equal(loaded.config.ui?.powerbar, true);
			// Warning should mention agents.overrides
			assert.ok(loaded.warnings?.some((w) => w.includes("agents.overrides")));
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("loadConfig ignores missing .pi/pi-crew.json gracefully", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-test-"));
		try {
			const loaded = loadConfig(tmpDir);
			assert.equal(loaded.config.ui?.powerbar, undefined);
			assert.ok(loaded.error === undefined);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
