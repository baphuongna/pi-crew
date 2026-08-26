/**
 * runtime.surface config plumbing (mux-surface spec v0.7 §8.1-8.2, Task 6).
 *
 * Pins:
 * - parse: mode enum (auto|tmux|herdr|off) + visibleAgents string[] survive
 *   parseConfig; a bogus mode is DROPPED (never thrown), following the
 *   parseIsolationPolicy pattern (config-validation.ts).
 * - loadConfig round-trip: a user-config runtime.surface block reaches the
 *   effective config object.
 * - merge: per-key user-wins inside the surface block (a user surface with
 *   only visibleAgents must not erase a project surface.mode) — the
 *   WP-2/R2 wholesale-replacement bug class.
 * - team-settings: KNOWN_KEYS carries runtime.surface.mode +
 *   runtime.surface.visibleAgents; EFFECTIVE_DEFAULTS answers mode "auto".
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { invalidateConfigCache, loadConfig, parseConfig } from "../../../src/config/config.ts";
import { mergeConfig } from "../../../src/config/config-merge.ts";
import type { TeamContext } from "../../../src/extension/team-tool/context.ts";
import { handleSettings } from "../../../src/extension/team-tool/handle-settings.ts";
import { textFromToolResult } from "../../../src/extension/tool-result.ts";

/** Redirect the user-config home to a temp dir (agent-extensions pattern). */
function withTempHome(config: Record<string, unknown> | undefined, fn: (home: string, cwd: string) => void): void {
	const previousHome = process.env.PI_TEAMS_HOME;
	const previousSkip = process.env.PI_CREW_SKIP_HOME_CHECK;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-surface-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-surface-cwd-"));
	process.env.PI_TEAMS_HOME = home;
	process.env.PI_CREW_SKIP_HOME_CHECK = "1";
	try {
		if (config !== undefined) {
			const filePath = path.join(home, ".pi", "agent", "pi-crew.json");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, JSON.stringify(config), "utf-8");
		}
		invalidateConfigCache();
		fn(home, cwd);
	} finally {
		if (previousHome !== undefined) process.env.PI_TEAMS_HOME = previousHome;
		else delete process.env.PI_TEAMS_HOME;
		if (previousSkip !== undefined) process.env.PI_CREW_SKIP_HOME_CHECK = previousSkip;
		else delete process.env.PI_CREW_SKIP_HOME_CHECK;
		invalidateConfigCache();
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function makeCtx(cwd: string): TeamContext {
	return { cwd };
}

function settingsText(args: string): string {
	const res = handleSettings({ config: { args } }, makeCtx(process.cwd()));
	return textFromToolResult(res);
}

// ─── parse ───────────────────────────────────────────────────────────────────

test("parseConfig: runtime.surface parses mode + visibleAgents", () => {
	const parsed = parseConfig({ runtime: { surface: { mode: "tmux", visibleAgents: ["executor"] } } });
	assert.equal(parsed.runtime?.surface?.mode, "tmux");
	assert.deepEqual(parsed.runtime?.surface?.visibleAgents, ["executor"]);
});

test("parseConfig: runtime.surface accepts every mode literal", () => {
	for (const mode of ["auto", "tmux", "herdr", "off"] as const) {
		const parsed = parseConfig({ runtime: { surface: { mode } } });
		assert.equal(parsed.runtime?.surface?.mode, mode, `mode ${mode} must parse`);
	}
});

test("parseConfig: bogus surface mode is dropped, not thrown (no crash)", () => {
	const parsed = parseConfig({ runtime: { surface: { mode: "bogus" } } });
	// mode alone invalid → surface drops to undefined (parseIsolationPolicy
	// convention: all-invalid block → undefined, never a raw pass-through).
	assert.equal(parsed.runtime?.surface?.mode, undefined);
	assert.ok(parsed.runtime?.surface === undefined || parsed.runtime?.surface.mode === undefined);
});

test("parseConfig: bogus mode drops only the mode — valid visibleAgents survives", () => {
	const parsed = parseConfig({ runtime: { surface: { mode: "bogus", visibleAgents: ["executor"] } } });
	assert.equal(parsed.runtime?.surface?.mode, undefined);
	assert.deepEqual(parsed.runtime?.surface?.visibleAgents, ["executor"]);
});

test("parseConfig: empty surface block is undefined; surface alone defines runtime", () => {
	assert.equal(parseConfig({ runtime: { surface: {} } }).runtime?.surface, undefined);
	const parsed = parseConfig({ runtime: { surface: { mode: "off" } } });
	assert.equal(parsed.runtime?.surface?.mode, "off");
});

// ─── loadConfig round-trip ───────────────────────────────────────────────────

test("loadConfig: user-config runtime.surface survives to the effective config", () => {
	withTempHome({ runtime: { surface: { mode: "herdr", visibleAgents: ["explorer", "executor"] } } }, () => {
		const loaded = loadConfig(process.cwd());
		assert.equal(loaded.config.runtime?.surface?.mode, "herdr");
		assert.deepEqual(loaded.config.runtime?.surface?.visibleAgents, ["explorer", "executor"]);
		// A valid surface block must not trip schema warnings (CFG-1 drift class).
		assert.equal(loaded.warnings, undefined);
	});
});

test("loadConfig: bogus surface mode in a config file is dropped without warnings-as-errors", () => {
	withTempHome({ runtime: { surface: { mode: "bogus" } } }, () => {
		const loaded = loadConfig(process.cwd());
		assert.equal(loaded.config.runtime?.surface, undefined);
	});
});

// ─── merge (WP-2/R2 bug class) ───────────────────────────────────────────────

test("mergeConfig: per-key user-wins inside runtime.surface (no wholesale replacement)", () => {
	const base = { runtime: { surface: { mode: "tmux" as const } } };
	const merged = mergeConfig(base, { runtime: { surface: { visibleAgents: ["executor"] } } });
	assert.equal(merged.runtime?.surface?.mode, "tmux");
	assert.deepEqual(merged.runtime?.surface?.visibleAgents, ["executor"]);
});

// ─── team-settings ───────────────────────────────────────────────────────────

test("team-settings schema: KNOWN_KEYS carries both runtime.surface keys", () => {
	withTempHome(undefined, () => {
		const text = settingsText("schema");
		assert.ok(text.includes("runtime.surface.mode"), `schema must list runtime.surface.mode, got: ${text.slice(0, 400)}`);
		assert.ok(text.includes("runtime.surface.visibleAgents"), `schema must list runtime.surface.visibleAgents`);
	});
});

test("team-settings get: EFFECTIVE_DEFAULTS answers runtime.surface.mode = auto", () => {
	withTempHome(undefined, () => {
		const text = settingsText("get runtime.surface.mode");
		assert.ok(text.includes("auto"), `get runtime.surface.mode must show the 'auto' default, got: ${text}`);
		assert.ok(text.includes("default"), `unset key must render the default marker, got: ${text}`);
	});
});

test("team-settings get: runtime.surface.mode shows the configured value when set", () => {
	withTempHome({ runtime: { surface: { mode: "tmux" as const } } }, () => {
		const text = settingsText("get runtime.surface.mode");
		assert.ok(text.includes("tmux"), `configured mode must surface via get, got: ${text}`);
	});
});
