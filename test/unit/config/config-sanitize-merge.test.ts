import assert from "node:assert/strict";
import test from "node:test";
import { __test__mergeConfig, __test__sanitizeProjectConfig } from "../../../src/config/config.ts";
import type { PiTeamsConfig } from "../../../src/config/types.ts";

/**
 * Direct tests for the Phase 2.2 extraction targets (refactor-plan step 1.9c,
 * review §ROUND 9 T-3): sanitizeProjectConfig (:272) and mergeConfig (:359).
 * These were previously covered only transitively through loadConfig; the
 * __test__ seams let us pin behavior before the Phase 2.2 split.
 */

const PROJECT_PATH = "/tmp/pi-crew-test/project-config.json";

// ---------------------------------------------------------------------------
// (i) Precedence matrix — user > project > defaults (mergeConfig layering)
// ---------------------------------------------------------------------------

test("mergeConfig: user wins over project wins over defaults (scalar layering)", () => {
	// Defaults are the base layer; project overrides defaults; user overrides both.
	const defaults: PiTeamsConfig = {
		limits: { maxConcurrentWorkers: 4 },
		runtime: { maxTurns: 100, mode: "auto" },
		autonomous: { profile: "suggested" },
		notifierIntervalMs: 60_000,
	};
	const project: PiTeamsConfig = {
		limits: { maxConcurrentWorkers: 8 },
		runtime: { mode: "scaffold" },
		autonomous: { enabled: true },
	};
	const user: PiTeamsConfig = {
		limits: { maxConcurrentWorkers: 16 },
		runtime: { maxTurns: 250 },
	};

	// Layering as done in loadConfig: merge(merge(defaults, project), user).
	const layered = __test__mergeConfig(__test__mergeConfig(defaults, project), user);

	assert.equal(layered.limits?.maxConcurrentWorkers, 16, "user must win over project and defaults");
	assert.equal(layered.runtime?.maxTurns, 250, "user must win over defaults");
	assert.equal(layered.runtime?.mode, "scaffold", "project must win over defaults when user is silent");
	assert.equal(layered.autonomous?.enabled, true, "project must win over defaults when user is silent");
	assert.equal(layered.autonomous?.profile, "suggested", "defaults preserved when neither overrides");
	assert.equal(layered.notifierIntervalMs, 60_000, "defaults preserved when neither overrides");
});

test("mergeConfig: override object merges nested sections, does not replace them", () => {
	const base: PiTeamsConfig = {
		runtime: { mode: "auto", maxTurns: 100, inheritContext: true },
		autonomous: { profile: "suggested", enabled: false },
	};
	const override: PiTeamsConfig = {
		runtime: { maxTurns: 500 },
		autonomous: { enabled: true },
	};
	const merged = __test__mergeConfig(base, override);

	assert.deepEqual(merged.runtime, { mode: "auto", maxTurns: 500, inheritContext: true }, "section merge keeps untouched base fields");
	assert.deepEqual(merged.autonomous, { profile: "suggested", enabled: true }, "section merge keeps untouched base fields");
});

test("mergeConfig: undefined override values do not clobber base values", () => {
	const base: PiTeamsConfig = { limits: { maxConcurrentWorkers: 8 }, runtime: { maxTurns: 100 } };
	const override: PiTeamsConfig = { limits: { maxConcurrentWorkers: undefined }, runtime: { maxTurns: undefined } };
	const merged = __test__mergeConfig(base, override);
	assert.equal(merged.limits?.maxConcurrentWorkers, 8, "undefined override must not erase base");
	assert.equal(merged.runtime?.maxTurns, 100, "undefined override must not erase base");
});

test("mergeConfig: agents.overrides and otlp.headers deep-merge per-key", () => {
	const base: PiTeamsConfig = {
		agents: { overrides: { researcher: { model: "deepseek/deepseek-v4-flash" } } },
		otlp: { headers: { authorization: "Bearer abc" } },
	};
	const override: PiTeamsConfig = {
		agents: { overrides: { implementer: { model: "openai/gpt-5" } } },
		otlp: { headers: { "x-tenant": "acme" } },
	};
	const merged = __test__mergeConfig(base, override);
	assert.equal(merged.agents?.overrides?.researcher?.model, "deepseek/deepseek-v4-flash", "base agent override preserved");
	assert.equal(merged.agents?.overrides?.implementer?.model, "openai/gpt-5", "override agent override merged in");
	assert.equal(merged.otlp?.headers?.authorization, "Bearer abc", "base otlp header preserved");
	assert.equal(merged.otlp?.headers?.["x-tenant"], "acme", "override otlp header merged in");
});

test("mergeConfig: reliability.retryPolicy deep-merges", () => {
	const base: PiTeamsConfig = { reliability: { autoRetry: true, retryPolicy: { maxAttempts: 3 } } };
	const override: PiTeamsConfig = { reliability: { retryPolicy: { backoffMs: 500 } } };
	const merged = __test__mergeConfig(base, override);
	assert.equal(merged.reliability?.retryPolicy?.maxAttempts, 3, "base retryPolicy field preserved");
	assert.equal(merged.reliability?.retryPolicy?.backoffMs, 500, "override retryPolicy field merged in");
});

// ---------------------------------------------------------------------------
// (ii) Sensitive-key drop-list — extracted from sanitizeProjectConfig body
// ---------------------------------------------------------------------------

test("sanitizeProjectConfig: drops every key in the drop-list and warns per path", () => {
	const projectConfig: PiTeamsConfig = {
		executeWorkers: false,
		asyncByDefault: true,
		requireCleanWorktreeLeader: true,
		runtime: {
			mode: "live-session",
			preferLiveSession: true,
			allowChildProcessFallback: true,
			inheritContext: false,
			isolationPolicy: { isolatedRoles: ["researcher"], defaultRuntime: "child-process" },
			agentExtensions: ["pi-commandcode-provider"],
		},
		autonomous: {
			profile: "aggressive",
			enabled: true,
			injectPolicy: true,
			preferAsyncForLongTasks: true,
			allowWorktreeSuggestion: true,
			magicKeywords: { research: ["deep"] },
		},
		worktree: { setupHook: "npm install" },
		otlp: { headers: { authorization: "Bearer super-secret" }, endpoint: "https://otel.internal" },
		agents: { disableBuiltins: true, overrides: { researcher: { model: "x" } } },
		tools: { enableSteer: true, terminateOnForeground: true },
	};

	const { config: sanitized, warnings } = __test__sanitizeProjectConfig(PROJECT_PATH, {}, projectConfig);

	// Top-level sensitive keys.
	assert.equal(sanitized.executeWorkers, undefined, "executeWorkers must be dropped");
	assert.equal(sanitized.asyncByDefault, undefined, "asyncByDefault must be dropped");
	assert.equal(sanitized.requireCleanWorktreeLeader, undefined, "requireCleanWorktreeLeader must be dropped");

	// runtime.* sensitive keys.
	assert.equal(sanitized.runtime?.mode, undefined, "runtime.mode must be dropped");
	assert.equal(sanitized.runtime?.preferLiveSession, undefined, "runtime.preferLiveSession must be dropped");
	assert.equal(sanitized.runtime?.allowChildProcessFallback, undefined, "runtime.allowChildProcessFallback must be dropped");
	assert.equal(sanitized.runtime?.inheritContext, undefined, "runtime.inheritContext must be dropped");
	assert.equal(sanitized.runtime?.isolationPolicy, undefined, "runtime.isolationPolicy must be dropped");
	assert.equal(sanitized.runtime?.agentExtensions, undefined, "runtime.agentExtensions must be dropped");

	// autonomous.* sensitive keys.
	assert.equal(sanitized.autonomous?.profile, undefined, "autonomous.profile must be dropped");
	assert.equal(sanitized.autonomous?.enabled, undefined, "autonomous.enabled must be dropped");
	assert.equal(sanitized.autonomous?.injectPolicy, undefined, "autonomous.injectPolicy must be dropped");
	assert.equal(sanitized.autonomous?.preferAsyncForLongTasks, undefined, "autonomous.preferAsyncForLongTasks must be dropped");
	assert.equal(sanitized.autonomous?.allowWorktreeSuggestion, undefined, "autonomous.allowWorktreeSuggestion must be dropped");
	assert.equal(sanitized.autonomous?.magicKeywords, undefined, "autonomous.magicKeywords must be dropped (S19-5, Wave 1A)");

	// Nested sensitive keys.
	assert.equal(sanitized.worktree?.setupHook, undefined, "worktree.setupHook must be dropped");
	assert.equal(sanitized.otlp?.headers, undefined, "otlp.headers must be dropped");
	assert.equal(sanitized.otlp?.endpoint, undefined, "otlp.endpoint must be dropped");
	assert.equal(sanitized.agents?.disableBuiltins, undefined, "agents.disableBuiltins must be dropped");
	assert.equal(sanitized.agents?.overrides, undefined, "agents.overrides must be dropped");
	assert.equal(sanitized.tools?.enableSteer, undefined, "tools.enableSteer must be dropped");
	assert.equal(sanitized.tools?.terminateOnForeground, undefined, "tools.terminateOnForeground must be dropped");

	// Every dropped path gets a warning referencing the project file.
	for (const expected of [
		"executeWorkers",
		"asyncByDefault",
		"requireCleanWorktreeLeader",
		"runtime.mode",
		"runtime.preferLiveSession",
		"runtime.allowChildProcessFallback",
		"runtime.inheritContext",
		"runtime.isolationPolicy",
		"runtime.agentExtensions",
		"autonomous.profile",
		"autonomous.enabled",
		"autonomous.injectPolicy",
		"autonomous.preferAsyncForLongTasks",
		"autonomous.allowWorktreeSuggestion",
		"autonomous.magicKeywords",
		"worktree.setupHook",
		"otlp.headers",
		"otlp.endpoint",
		"agents.disableBuiltins",
		"agents.overrides",
		"tools.enableSteer",
		"tools.terminateOnForeground",
	]) {
		assert.ok(
			warnings.some((w) => w.includes(expected) && w.includes(PROJECT_PATH)),
			`expected a warning for '${expected}' mentioning the project path`,
		);
	}
});

test("sanitizeProjectConfig: requiresPlanApproval dropped only when === false", () => {
	// requirePlanApproval: false → conditional drop (Wave 1A: folded into
	// CONDITIONAL_PROJECT_DROPS in sanitize-project-config.ts).
	const withFalse = __test__sanitizeProjectConfig(PROJECT_PATH, {}, {
		runtime: { requirePlanApproval: false },
	} as PiTeamsConfig);
	assert.equal(withFalse.config.runtime?.requirePlanApproval, undefined, "runtime.requirePlanApproval=false must be dropped");
	assert.ok(
		withFalse.warnings.some((w) => w.includes("runtime.requirePlanApproval")),
		"warning emitted for conditional drop",
	);

	// requirePlanApproval: true → NOT dropped.
	const withTrue = __test__sanitizeProjectConfig(PROJECT_PATH, {}, {
		runtime: { requirePlanApproval: true },
	} as PiTeamsConfig);
	assert.equal(withTrue.config.runtime?.requirePlanApproval, true, "runtime.requirePlanApproval=true must be kept");
});

test("sanitizeProjectConfig: non-sensitive keys pass through unchanged", () => {
	const projectConfig = {
		notifierIntervalMs: 30_000,
		limits: { maxConcurrentWorkers: 4, maxTaskDepth: 5 },
		runtime: { maxTurns: 50, taskTimeoutMs: 300_000 },
		autonomous: { magicKeywords: { research: ["deep"] } }, // S19-5 (Wave 1A): now dropped
		worktree: { linkNodeModules: true, setupHookTimeoutMs: 120_000 },
		otlp: { enabled: true, intervalMs: 60_000 },
		agents: {},
		tools: { enableClaudeStyleAliases: true },
		ui: { widgetPlacement: "aboveEditor" },
	} as PiTeamsConfig;

	const { config: sanitized, warnings } = __test__sanitizeProjectConfig(PROJECT_PATH, {}, projectConfig);

	assert.equal(sanitized.notifierIntervalMs, 30_000);
	assert.deepEqual(sanitized.limits, { maxConcurrentWorkers: 4, maxTaskDepth: 5 });
	assert.equal(sanitized.runtime?.maxTurns, 50, "runtime.maxTurns is not on the drop-list");
	assert.equal(sanitized.runtime?.taskTimeoutMs, 300_000, "runtime.taskTimeoutMs is not on the drop-list");
	// Wave 1A (S19-5): magicKeywords flips autonomous mode on by itself — now
	// project-tier dropped; every autonomous key is sensitive, so the section collapses.
	assert.equal(sanitized.autonomous, undefined, "autonomous with only magicKeywords collapses");
	assert.ok(
		warnings.some((w) => w.includes("'autonomous.magicKeywords'") && w.includes(PROJECT_PATH)),
		"magicKeywords drop warns with the standard format",
	);
	assert.equal(sanitized.worktree?.linkNodeModules, true, "worktree.linkNodeModules is not dropped");
	assert.equal(sanitized.worktree?.setupHookTimeoutMs, 120_000, "worktree.setupHookTimeoutMs is not dropped");
	assert.equal(sanitized.otlp?.enabled, true, "otlp.enabled is not dropped");
	assert.equal(sanitized.otlp?.intervalMs, 60_000, "otlp.intervalMs is not dropped");
	assert.equal(sanitized.tools?.enableClaudeStyleAliases, true, "tools.enableClaudeStyleAliases is not dropped");
	assert.equal(sanitized.ui?.widgetPlacement, "aboveEditor", "ui.* is not dropped");
});

// ---------------------------------------------------------------------------
// (iii) Partial-object handling — a section collapses to undefined when every
//       defined key was dropped (:302-327).
// ---------------------------------------------------------------------------

test("sanitizeProjectConfig: section with only dropped keys collapses to undefined", () => {
	const { config: sanitized } = __test__sanitizeProjectConfig(PROJECT_PATH, {}, {
		runtime: { mode: "live-session" },
		autonomous: { profile: "aggressive" },
		worktree: { setupHook: "npm install" },
		otlp: { headers: { authorization: "x" } },
		agents: { overrides: { researcher: { model: "x" } } },
		tools: { enableSteer: true },
		goalWrap: { implementation: { enabled: true, budgetUnlimited: true } },
	} as unknown as PiTeamsConfig);

	assert.equal(sanitized.runtime, undefined, "runtime with only dropped keys collapses");
	assert.equal(sanitized.autonomous, undefined, "autonomous with only dropped keys collapses");
	assert.equal(sanitized.worktree, undefined, "worktree with only dropped keys collapses");
	assert.equal(sanitized.otlp, undefined, "otlp with only dropped keys collapses");
	assert.equal(sanitized.agents, undefined, "agents with only dropped keys collapses");
	assert.equal(sanitized.tools, undefined, "tools with only dropped keys collapses");
	assert.equal((sanitized as Record<string, unknown>).goalWrap, undefined, "goalWrap subtree collapses (S19-2, Wave 1A)");
});

test("sanitizeProjectConfig: section keeps surviving keys after partial drop", () => {
	const { config: sanitized } = __test__sanitizeProjectConfig(PROJECT_PATH, {}, {
		runtime: { mode: "live-session", maxTurns: 50, taskTimeoutMs: 300_000 },
		autonomous: { profile: "aggressive", magicKeywords: { research: ["deep"] } },
		worktree: { setupHook: "npm install", linkNodeModules: true },
		otlp: { headers: { authorization: "x" }, enabled: true },
	} as PiTeamsConfig);

	assert.deepEqual(sanitized.runtime, { maxTurns: 50, taskTimeoutMs: 300_000 }, "non-sensitive runtime keys survive");
	// Wave 1A (S19-5): magicKeywords is now sensitive too — every autonomous
	// key drops, so the section collapses instead of keeping survivors.
	assert.equal(sanitized.autonomous, undefined, "autonomous fully dropped (magicKeywords now sensitive)");
	// NOTE: worktree/otlp are redacted via `{ ...section, key: undefined }`
	// (not `delete`), so the dropped key remains present as `undefined` —
	// characterize that shape as-is so the Phase 2.2 split preserves it.
	assert.deepEqual(
		sanitized.worktree,
		{ linkNodeModules: true, setupHook: undefined },
		"non-sensitive worktree keys survive (dropped key kept as undefined)",
	);
	assert.deepEqual(
		sanitized.otlp,
		{ enabled: true, headers: undefined },
		"non-sensitive otlp keys survive (dropped keys kept as undefined)",
	);
});

test("sanitizeProjectConfig: does not mutate the input config object", () => {
	const projectConfig = {
		runtime: { mode: "live-session", maxTurns: 50 },
		executeWorkers: false,
	} as PiTeamsConfig;

	__test__sanitizeProjectConfig(PROJECT_PATH, {}, projectConfig);

	assert.equal(projectConfig.runtime?.mode, "live-session", "input must not be mutated");
	assert.equal(projectConfig.executeWorkers, false, "input must not be mutated");
});

// WP-2/R2 regression (B1 battery 2026-08-18): parseBrokerConfig's hand-rolled
// whitelist dropped broker.waitMethodsEnabled, so a workspace config setting it
// true never reached the broker (live ask rejected policy-disabled despite
// schema + defaults + ctor all supporting it). Pin the full loadConfig path.
test("broker config: waitMethodsEnabled survives parse + merge + defaults (B1 regression)", async () => {
	const { loadConfig, __test__setConfigCacheTtlMs } = await import("../../../src/config/config.ts");
	__test__setConfigCacheTtlMs(0);
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-broker-cfg-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".crew", "config.json"), JSON.stringify({ broker: { enabled: true, waitMethodsEnabled: true } }));
		const broker = loadConfig(cwd).config.broker;
		assert.equal(broker?.waitMethodsEnabled, true, "workspace waitMethodsEnabled:true must reach the merged broker config");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("broker config: workspace config reaches the production broker ctor path (loadConfig WITH cwd)", async () => {
	// B1 battery third bug: lifecycle-handlers called loadConfig() with NO cwd,
	// so even a correctly-parsed workspace broker config never reached the
	// broker. Pin the contract the ctor relies on: loadConfig(cwd) picks up the
	// workspace file; loadConfig() alone does NOT (user-level only).
	const { loadConfig, __test__setConfigCacheTtlMs } = await import("../../../src/config/config.ts");
	__test__setConfigCacheTtlMs(0);
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-broker-ctor-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".crew", "config.json"), JSON.stringify({ broker: { enabled: true, waitMethodsEnabled: true } }));
		assert.equal(loadConfig(cwd).config.broker?.waitMethodsEnabled, true, "with-cwd read must see the workspace flag");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
