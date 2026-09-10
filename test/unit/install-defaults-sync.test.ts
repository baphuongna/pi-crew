/**
 * WI-1b.2 (G17): install.mjs ⇄ src/config/defaults.ts sync test.
 *
 * install.mjs writes `~/.pi/agent/pi-crew.json` on fresh installs. Before the
 * WI-1b.2 refactor its values were an unexported, drifting duplicate of the
 * src-side defaults (worst case: ui.widgetPlacement was pinned to
 * "aboveEditor" while DEFAULT_UI.widgetPlacement is "bottom"). This test makes
 * that drift impossible: every value install.mjs writes is compared against
 * the REAL source of truth —
 *   - ui.*        ⇄ DEFAULT_UI (src/config/defaults.ts)
 *   - autonomous  ⇄ effectiveAutonomousConfig(undefined) suggested-profile
 *                  defaults (src/config/config-validation.ts)
 *   - agents.overrides ⇄ the 10-role builtin fixture (mirrors the module-local
 *     DEFAULT_PI_CREW_CONFIG in src/extension/project-init.ts — not exported
 *     yet; exporting it so this section derives too is an M2 candidate).
 *
 * Derivation-method decision (documented per WI-1b.2): install.mjs runs under
 * bare `node` as the `pi-crew` bin; engines floor is >=22.0.0 while .ts
 * imports need >=22.18 (or `--experimental-strip-types`, which the bin shim
 * cannot pass). Runtime jiti/esbuild loading was rejected as a postinstall
 * failure surface; build-time codegen needs package.json/prepack wiring.
 * Cheapest safe option: embedded literal in install.mjs + THIS test enforcing
 * it in CI (`npm test` runs test/unit/**). Mutation demo: edit DEFAULT_UI →
 * this file goes red.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectiveAutonomousConfig } from "../../src/config/config-validation.ts";
import { DEFAULT_UI } from "../../src/config/defaults.ts";

/** Structural shape of install.mjs's exported defaultConfig. install.mjs is
 * plain .mjs with no shipped declaration file; the import below is suppressed
 * and type-asserted here — values still come from the real module at runtime. */
interface InstallDefaultConfig {
	autonomous: {
		enabled: boolean;
		injectPolicy: boolean;
		preferAsyncForLongTasks: boolean;
		allowWorktreeSuggestion: boolean;
	};
	agents: {
		overrides: Record<string, { model: false; thinking: string }>;
	};
	ui: Record<string, unknown>;
}

// @ts-expect-error TS7016 — install.mjs ships no .d.mts (adding one would
// widen the publish surface for zero runtime value). If a declaration file
// ever lands, this suppression turns unused (TS2578) and must be removed.
import { defaultConfig as rawDefaultConfig } from "../../install.mjs";

const defaultConfig = rawDefaultConfig as InstallDefaultConfig;

// Curated ui subset install.mjs is allowed to pin — mirrors
// src/extension/project-init.ts DEFAULT_PI_CREW_CONFIG.ui. Adding a key to
// install.mjs's ui block without adding it here (and to project-init.ts) is
// flagged as drift.
const CURATED_UI_KEYS = [
	"widgetPlacement",
	"widgetMaxLines",
	"powerbar",
	"dashboardPlacement",
	"dashboardWidth",
	"dashboardLiveRefreshMs",
	"autoOpenDashboard",
	"autoOpenDashboardForForegroundRuns",
	"showModel",
	"showTokens",
	"showTools",
] as const;

// Builtin agent roles and their thinking tiers as generated on fresh installs
// (mirrors src/extension/project-init.ts DEFAULT_PI_CREW_CONFIG.agents).
const EXPECTED_AGENT_OVERRIDES: Record<string, string> = {
	explorer: "off",
	writer: "off",
	planner: "medium",
	analyst: "off",
	critic: "low",
	executor: "medium",
	reviewer: "off",
	"security-reviewer": "medium",
	"test-engineer": "low",
	verifier: "off",
};

describe("install.mjs ⇄ defaults.ts sync (WI-1b.2 / G17)", () => {
	it("top-level shape is exactly { autonomous, agents, ui }", () => {
		assert.deepEqual(Object.keys(defaultConfig).sort(), ["agents", "autonomous", "ui"]);
	});

	it("every ui value install.mjs writes equals DEFAULT_UI (no drift, no stale keys)", () => {
		assert.deepEqual(
			Object.keys(defaultConfig.ui).sort(),
			[...CURATED_UI_KEYS].sort(),
			"install.mjs ui key set must match the curated subset (see project-init.ts DEFAULT_PI_CREW_CONFIG)",
		);
		for (const key of CURATED_UI_KEYS) {
			assert.ok(Object.hasOwn(DEFAULT_UI, key), `install.mjs ui.${key} no longer exists in DEFAULT_UI — stale key, remove it`);
			assert.deepEqual(
				defaultConfig.ui[key],
				(DEFAULT_UI as Record<string, unknown>)[key],
				`install.mjs ui.${key} drifted from DEFAULT_UI (src/config/defaults.ts) — G17 regression`,
			);
		}
	});

	it("autonomous block equals effectiveAutonomousConfig(undefined) suggested-profile defaults", () => {
		const effective = effectiveAutonomousConfig(undefined);
		assert.deepEqual(defaultConfig.autonomous, {
			enabled: effective.enabled,
			injectPolicy: effective.injectPolicy,
			preferAsyncForLongTasks: effective.preferAsyncForLongTasks,
			allowWorktreeSuggestion: effective.allowWorktreeSuggestion,
		});
	});

	it("agents.overrides pins the 10 builtin roles with model:false and known thinking tiers", () => {
		const overrides = defaultConfig.agents.overrides;
		assert.deepEqual(
			Object.keys(overrides).sort(),
			Object.keys(EXPECTED_AGENT_OVERRIDES).sort(),
			"install.mjs agents.overrides role set drifted from the builtin roster",
		);
		for (const [role, thinking] of Object.entries(EXPECTED_AGENT_OVERRIDES)) {
			assert.deepEqual(overrides[role], { model: false, thinking }, `install.mjs agents.overrides.${role} drifted`);
		}
	});

	it("defaultConfig is plain JSON (what install.mjs serializes to disk)", () => {
		assert.deepEqual(JSON.parse(JSON.stringify(defaultConfig)), defaultConfig);
	});
});
