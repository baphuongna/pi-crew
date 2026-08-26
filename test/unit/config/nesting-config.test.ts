/**
 * Governed-nesting config plumbing (ADR-5 §10, WP-5 step 2).
 *
 * Pins:
 * - `nesting.enabled` DEFAULT TRUE since D8 (spec v0.7, 2026-08-26): the
 *   WP-5 completion gate (B3 battery + security sign-off) passed and Task 3
 *   opened the `delegate` role gate, so nested spawning is on out of the box.
 *   The security border is now the depth cap (default 4) + nested-slot
 *   budget, not the master switch. Users can still close it via
 *   `nesting.enabled: false` in USER config.
 * - parse: valid blocks pass; out-of-range / wrong-typed values are dropped
 *   (never thrown as raw), matching the LIMIT_CEILINGS pattern.
 * - merge: per-key user-wins deep merge — a partial user block must NOT erase
 *   the default (the broker wholesale-replacement bug class, WP-2/R2).
 * - `nesting.enabled` is `sensitive: true` → project-level config cannot
 *   flip delegation (privilege-raising flag, user config only).
 * - schema.json carries the same nesting sub-schema as the TypeBox schema.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { invalidateConfigCache } from "../../../src/config/config.ts";
import { mergeConfig } from "../../../src/config/config-merge.ts";
import { parseConfig } from "../../../src/config/config-validation.ts";
import { DEFAULT_NESTING } from "../../../src/config/defaults.ts";
import type { TeamContext } from "../../../src/extension/team-tool/context.ts";
import { handleSettings } from "../../../src/extension/team-tool/handle-settings.ts";
import { textFromToolResult } from "../../../src/extension/tool-result.ts";
import { PiTeamsConfigSchema } from "../../../src/schema/config-schema.ts";
import { collectSensitiveConfigPaths } from "../../../src/schema/sensitive-config-paths.ts";

test("DEFAULT_NESTING is default-on: enabled=true, maxDepth=4 (ADR-5 §10 + D8 flip)", () => {
	assert.equal(DEFAULT_NESTING.enabled, true);
	// D8 (spec v0.7): maxDepth kept in lockstep with DEFAULT_MAX_CREW_DEPTH so
	// the broker-admission gate and spawn-side cap never disagree.
	assert.equal(DEFAULT_NESTING.maxDepth, 4);
});

test("parseConfig: valid nesting block passes through", () => {
	const cfg = parseConfig({ nesting: { enabled: true, maxSlots: 4, maxDepth: 3 } });
	assert.deepEqual(cfg.nesting, { enabled: true, maxSlots: 4, maxDepth: 3 });
});

test("parseConfig: out-of-range nesting values are dropped, not clamped", () => {
	const cfg = parseConfig({ nesting: { maxSlots: 0, maxDepth: 11, enabled: "yes" } });
	// every key invalid → undefined values → whole block drops to undefined
	assert.equal(cfg.nesting, undefined);
});

test("parseConfig: maxSlots=65 and maxDepth=11 exceed ceilings and drop", () => {
	const cfg = parseConfig({ nesting: { maxSlots: 65 } });
	assert.equal(cfg.nesting, undefined);
	const cfg2 = parseConfig({ nesting: { maxDepth: 11, enabled: true } });
	// dropped keys stay as explicit-undefined entries (parseLimitsConfig
	// convention) — assert per-field, not deepEqual.
	assert.equal(cfg2.nesting?.enabled, true);
	assert.equal(cfg2.nesting?.maxDepth, undefined);
});

test("parseConfig: boundaries 1 and 64 / 1 and 10 accepted", () => {
	assert.equal(parseConfig({ nesting: { maxSlots: 1 } }).nesting?.maxSlots, 1);
	assert.equal(parseConfig({ nesting: { maxSlots: 64 } }).nesting?.maxSlots, 64);
	assert.equal(parseConfig({ nesting: { maxDepth: 1 } }).nesting?.maxDepth, 1);
	assert.equal(parseConfig({ nesting: { maxDepth: 10 } }).nesting?.maxDepth, 10);
});

test("mergeConfig: partial user nesting block does not erase the default-on enabled", () => {
	const base = { nesting: { ...DEFAULT_NESTING } };
	const merged = mergeConfig(base, { nesting: { maxSlots: 4 } });
	assert.deepEqual(merged.nesting, { enabled: true, maxDepth: 4, maxSlots: 4 });
});

test("mergeConfig: explicit user enabled=false still closes delegation (kill switch)", () => {
	const base = { nesting: { ...DEFAULT_NESTING } };
	const merged = mergeConfig(base, { nesting: { enabled: false } });
	assert.deepEqual(merged.nesting, { enabled: false, maxDepth: 4 });
});

test("mergeConfig: explicit user enabled=true wins over the default", () => {
	const base = { nesting: { ...DEFAULT_NESTING } };
	const merged = mergeConfig(base, { nesting: { enabled: true } });
	assert.deepEqual(merged.nesting, { enabled: true, maxDepth: 4 });
});

test("nesting.enabled is sensitive: project config cannot enable delegation", () => {
	const sensitive = collectSensitiveConfigPaths(PiTeamsConfigSchema);
	assert.ok(
		sensitive.includes("nesting.enabled"),
		`nesting.enabled must be marked sensitive (got: ${sensitive.filter((p) => p.startsWith("nesting")).join(", ") || "nothing"})`,
	);
});

// Task 7 (deferred from Task 6): the set-path hint list in handle-settings is
// a hardcoded mirror of the schema sensitive marks — `nesting.enabled` became
// reachable through `team-settings set` once Task 6 wired the key, so the
// project-scope write must carry the same "set it in user scope" note.
test("team-settings set nesting.enabled --scope project carries the sensitive hint", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-nest-hint-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-nest-hint-cwd-"));
	const prevHome = process.env.PI_TEAMS_HOME;
	const prevSkip = process.env.PI_CREW_SKIP_HOME_CHECK;
	process.env.PI_TEAMS_HOME = home;
	process.env.PI_CREW_SKIP_HOME_CHECK = "1";
	invalidateConfigCache();
	try {
		const res = handleSettings({ config: { args: "set nesting.enabled false", scope: "project" } }, { cwd } as TeamContext);
		const text = textFromToolResult(res);
		assert.ok(
			text.includes("sensitive"),
			`project-scope set must carry the sensitive hint (got: ${text})`,
		);
	} finally {
		if (prevHome !== undefined) process.env.PI_TEAMS_HOME = prevHome;
		else delete process.env.PI_TEAMS_HOME;
		if (prevSkip !== undefined) process.env.PI_CREW_SKIP_HOME_CHECK = prevSkip;
		else delete process.env.PI_CREW_SKIP_HOME_CHECK;
		invalidateConfigCache();
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("schema.json nesting sub-schema matches the TypeBox properties", () => {
	const schemaJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schema.json"), "utf-8"));
	const jsonNesting = schemaJson.properties?.nesting?.properties;
	assert.ok(jsonNesting, "schema.json must carry a nesting.properties block");
	const typeboxNesting = (PiTeamsConfigSchema.properties as Record<string, { properties?: Record<string, unknown> }>).nesting?.properties;
	assert.ok(typeboxNesting, "TypeBox schema must carry nesting.properties");
	assert.deepEqual(
		Object.keys(jsonNesting).sort(),
		Object.keys(typeboxNesting).sort(),
		"nesting property sets must match between schema.json and TypeBox",
	);
});
