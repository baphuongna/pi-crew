/**
 * UI-2 — keybinding override tests.
 *
 * Verifies that keybindings can be overridden via:
 *   - the `PI_CREW_KEYBINDINGS` env var (JSON object string), and
 *   - the `.crew/config.json` → `keybindings` section,
 * layered over the hardcoded defaults. Also verifies collision validation:
 * an override that clashes with another binding is reverted to its default.
 *
 * The parity golden snapshot (test/unit/keybinding-map.parity.test.ts) is
 * unaffected because these tests always reset the memoised cache and run with
 * deterministic env/config state.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { __test__resetKeybindingCache, dashboardActionForKey, getKeybindingOverrideWarnings } from "../../../src/ui/keybinding-map.ts";

describe("keybinding-map override (UI-2)", () => {
	const origEnv = process.env.PI_CREW_KEYBINDINGS;
	const origCwd = process.cwd();

	beforeEach(() => {
		delete process.env.PI_CREW_KEYBINDINGS;
		__test__resetKeybindingCache();
	});

	afterEach(() => {
		if (origEnv === undefined) delete process.env.PI_CREW_KEYBINDINGS;
		else process.env.PI_CREW_KEYBINDINGS = origEnv;
		process.chdir(origCwd);
		__test__resetKeybindingCache();
	});

	it("uses hardcoded defaults when no override is present", () => {
		assert.equal(dashboardActionForKey("r", undefined), "reload");
		assert.equal(dashboardActionForKey("a", undefined), "artifacts");
		assert.equal(dashboardActionForKey("e", undefined), "events");
		// unbound key stays unbound
		assert.equal(dashboardActionForKey("z", undefined), undefined);
		// no warnings
		assert.equal(getKeybindingOverrideWarnings().length, 0);
	});

	it("applies a valid env override with a fresh key", () => {
		process.env.PI_CREW_KEYBINDINGS = JSON.stringify({ reload: ["z"] });
		__test__resetKeybindingCache();
		// overridden key triggers the action
		assert.equal(dashboardActionForKey("z", undefined), "reload");
		// replaced default key no longer triggers it
		assert.equal(dashboardActionForKey("r", undefined), undefined);
		// unrelated action keeps its default
		assert.equal(dashboardActionForKey("a", undefined), "artifacts");
		// valid override → no warnings
		assert.equal(getKeybindingOverrideWarnings().length, 0);
	});

	it("reverts an env override that collides with another binding", () => {
		// "a" is the default key for "artifacts"; pointing "select" at ["a"]
		// would collide (both global) → override rejected, defaults preserved.
		process.env.PI_CREW_KEYBINDINGS = JSON.stringify({ select: ["a"] });
		__test__resetKeybindingCache();
		// select keeps its default keys ("s" still selects)
		assert.equal(dashboardActionForKey("s", undefined), "select");
		// "a" still triggers artifacts, not select
		assert.equal(dashboardActionForKey("a", undefined), "artifacts");
		// a collision warning was recorded
		const warnings = getKeybindingOverrideWarnings();
		assert.ok(
			warnings.some((w) => w.includes("select")),
			`expected a collision warning for select, got: ${JSON.stringify(warnings)}`,
		);
	});

	it("reads overrides from .crew/config.json keybindings section", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-crew-kb-"));
		try {
			mkdirSync(join(dir, ".crew"), { recursive: true });
			writeFileSync(join(dir, ".crew", "config.json"), JSON.stringify({ keybindings: { events: ["z"] } }));
			process.chdir(dir);
			__test__resetKeybindingCache();
			assert.equal(dashboardActionForKey("z", undefined), "events", "config override should take effect");
			// replaced default key no longer triggers events
			assert.equal(dashboardActionForKey("e", undefined), undefined);
			// unrelated default intact
			assert.equal(dashboardActionForKey("a", undefined), "artifacts");
		} finally {
			process.chdir(origCwd);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("env override takes precedence over config override", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-crew-kb-prec-"));
		try {
			mkdirSync(join(dir, ".crew"), { recursive: true });
			writeFileSync(join(dir, ".crew", "config.json"), JSON.stringify({ keybindings: { reload: ["y"] } }));
			process.chdir(dir);
			process.env.PI_CREW_KEYBINDINGS = JSON.stringify({ reload: ["z"] });
			__test__resetKeybindingCache();
			// env wins over config
			assert.equal(dashboardActionForKey("z", undefined), "reload");
			// config-proposed key is superseded by env
			assert.equal(dashboardActionForKey("y", undefined), undefined);
			// original default replaced
			assert.equal(dashboardActionForKey("r", undefined), undefined);
		} finally {
			process.chdir(origCwd);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores unknown actions and non-array key values", () => {
		process.env.PI_CREW_KEYBINDINGS = JSON.stringify({ bogusAction: ["z"], reload: 42, events: "" });
		__test__resetKeybindingCache();
		// reload not overridden (42 is not an array) → keeps default "r"
		assert.equal(dashboardActionForKey("r", undefined), "reload");
		// bogus action ignored
		assert.equal(dashboardActionForKey("z", undefined), undefined);
		// events not overridden ("" is not an array) → keeps default "e"
		assert.equal(dashboardActionForKey("e", undefined), "events");
	});

	it("allows a non-conflicting swap of keys between two actions", () => {
		// Swap reload<->artifacts keys: no shared key remains → no collision.
		process.env.PI_CREW_KEYBINDINGS = JSON.stringify({ reload: ["a"], artifacts: ["r"] });
		__test__resetKeybindingCache();
		assert.equal(dashboardActionForKey("a", undefined), "reload");
		assert.equal(dashboardActionForKey("r", undefined), "artifacts");
		assert.equal(getKeybindingOverrideWarnings().length, 0);
	});
});

it("RR-020 A0-4: reads overrides from the .pi/teams layout too (no hardcoded .crew)", () => {
	const origCwdLocal = process.cwd();
	const dir = mkdtempSync(join(tmpdir(), "pi-crew-kb-pi-"));
	try {
		// .git makes findRepoRoot resolve INSIDE the temp tree; a `.pi` dir
		// (and no `.crew`) makes projectCrewRoot pick the .pi/teams layout.
		mkdirSync(join(dir, ".git"), { recursive: true });
		mkdirSync(join(dir, ".pi", "teams"), { recursive: true });
		writeFileSync(join(dir, ".pi", "teams", "config.json"), JSON.stringify({ keybindings: { events: ["z"] } }));
		delete process.env.PI_CREW_KEYBINDINGS;
		process.chdir(dir);
		__test__resetKeybindingCache();
		assert.equal(dashboardActionForKey("z", undefined), "events", "config override in .pi/teams must take effect");
		assert.equal(dashboardActionForKey("e", undefined), undefined);
		assert.equal(dashboardActionForKey("a", undefined), "artifacts");
		// mtime cache path must also watch the layout-resolved file: write a
		// NEW override with a FORCED later mtime (the memo compares mtimeMs, and
		// two writes within the same millisecond are indistinguishable — a
		// pre-existing granularity limit) and confirm the cache re-reads it.
		const cfgPath = join(dir, ".pi", "teams", "config.json");
		writeFileSync(cfgPath, JSON.stringify({ keybindings: { reload: ["9"] } }));
		const later = new Date(Date.now() + 10);
		utimesSync(cfgPath, later, later);
		assert.equal(dashboardActionForKey("9", undefined), "reload", "mtime cache watches the layout-resolved config path");
	} finally {
		process.chdir(origCwdLocal);
		__test__resetKeybindingCache();
		rmSync(dir, { recursive: true, force: true });
	}
});
