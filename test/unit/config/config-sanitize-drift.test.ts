import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import { __test__sanitizeProjectConfig, parseConfig } from "../../../src/config/config.ts";
import { CONDITIONAL_PROJECT_DROPS } from "../../../src/config/sanitize-project-config.ts";
import type { PiTeamsConfig } from "../../../src/config/types.ts";
import { PiTeamsConfigSchema } from "../../../src/schema/config-schema.ts";
import { collectSensitiveConfigPaths } from "../../../src/schema/sensitive-config-paths.ts";

/**
 * S-R7 drift gate (Phase 5.2, ADR docs/decisions/2026-08-15-schema-driven-sanitize.md).
 *
 * sanitizeProjectConfig derives its drop-list from `sensitive: true` marks in
 * the config schema. A missed mark = silent security regression, so this file
 * freezes the OLD hardcoded list as a fixture and asserts the schema-derived
 * behavior never regresses relative to it:
 *   (i)   every sensitive-marked path is dropped from project config
 *   (ii)  every OLD hardcoded path is actually marked `sensitive: true`
 *   (iii) schema-derived drop-list is a SUPERSET of the old hardcoded list
 *   (iv)  every sensitive mark maps to an existing schema key (no orphans)
 * plus Wave 1A extensions:
 *   (v)   CONDITIONAL_PROJECT_DROPS — loosening values dropped, tightening
 *         values survive (guard-tiering: project may only tighten)
 *   (vi)  goalWrap subtree fully dropped from project tier
 *   (vii) autonomous.magicKeywords dropped from project tier
 *   (viii) broker.enabled === false dropped / === true + other broker fields
 *         survive (availability-only tiering)
 *   (ix)  F19-5 parser bounds match the schema (metricRetentionDays max 90,
 *         dedupWindowMs min 1000, otlp.endpoint ^https?:// pattern)
 */

const PROJECT_PATH = "/tmp/pi-crew-test/drift-gate.json";
const SENTINEL = "__SENSITIVE_SENTINEL__";

/** The 21 unconditional paths of the pre-Phase-5.1 hardcoded drop-list
 * (frozen from the legacy sanitize-project-config.ts body). */
const OLD_HARDCODED_DROP_LIST = [
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
	"worktree.setupHook",
	"otlp.headers",
	"otlp.endpoint",
	"agents.disableBuiltins",
	"agents.overrides",
	"tools.enableSteer",
	"tools.terminateOnForeground",
] as const;

/** The exact inventory intended by ADR 2026-08-15 (old 21 + S-R5 policy.* +
 * S-R6 seedPaths + Wave 1A goalWrap/magicKeywords = 26 paths).
 * Order follows schema property declaration order. */
const EXPECTED_SENSITIVE_PATHS = [
	"asyncByDefault",
	"executeWorkers",
	"requireCleanWorktreeLeader",
	"autonomous.profile",
	"autonomous.enabled",
	"autonomous.injectPolicy",
	"autonomous.preferAsyncForLongTasks",
	"autonomous.allowWorktreeSuggestion",
	"autonomous.magicKeywords",
	"runtime.mode",
	"runtime.preferLiveSession",
	"runtime.allowChildProcessFallback",
	"runtime.inheritContext",
	"runtime.agentExtensions",
	"runtime.isolationPolicy",
	"worktree.setupHook",
	"worktree.seedPaths",
	"goalWrap",
	"agents.disableBuiltins",
	"agents.overrides",
	"tools.enableSteer",
	"tools.terminateOnForeground",
	"policy.requireIntentForDestructiveActions",
	"policy.disabledCapabilities",
	"otlp.endpoint",
	"otlp.headers",
	"nesting.enabled",
] as const;

/** Wave 1A guard-tiering conditional inventory (frozen fixture — mirrors
 * CONDITIONAL_PROJECT_DROPS in src/config/sanitize-project-config.ts). The
 * legacy requirePlanApproval special-case is entry #1 of this table. */
const EXPECTED_CONDITIONAL_DROPS = [
	"runtime.requirePlanApproval",
	"runtime.completionMutationGuard",
	"runtime.effectivenessGuard",
	"limits.allowUnboundedConcurrency",
	"reliability.autoRecover",
	"reliability.scopeModels",
	"broker.enabled",
] as const;

type SchemaLike = { sensitive?: unknown; properties?: Record<string, SchemaLike>; anyOf?: SchemaLike[] };

/** Resolve a dotted path to the schema property it names (or undefined). */
function resolveSchemaProperty(root: SchemaLike, dotted: string): SchemaLike | undefined {
	let current: SchemaLike | undefined = root;
	for (const segment of dotted.split(".")) {
		if (!current || typeof current !== "object") return undefined;
		current = current.properties?.[segment];
	}
	return current;
}

/** Every key path declared by a schema (Objects/Unions recursed, Records terminal). */
function allSchemaKeyPaths(schema: SchemaLike, prefix = ""): string[] {
	const out: string[] = [];
	for (const [key, property] of Object.entries(schema.properties ?? {})) {
		if (!property || typeof property !== "object") continue;
		const dotted = prefix === "" ? key : `${prefix}.${key}`;
		out.push(dotted);
		const branches = Array.isArray(property.anyOf) ? property.anyOf : [property];
		for (const branch of branches) {
			if (branch && typeof branch === "object" && branch.properties) out.push(...allSchemaKeyPaths(branch, dotted));
		}
	}
	return out;
}

function setAtPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
	const segments = dotted.split(".");
	let node = target;
	for (const segment of segments.slice(0, -1)) {
		if (typeof node[segment] !== "object" || node[segment] === null) node[segment] = {};
		node = node[segment] as Record<string, unknown>;
	}
	node[segments[segments.length - 1]] = value;
}

function getAtPath(source: Record<string, unknown>, dotted: string): unknown {
	let node: unknown = source;
	for (const segment of dotted.split(".")) {
		if (node === null || typeof node !== "object") return undefined;
		node = (node as Record<string, unknown>)[segment];
	}
	return node;
}

// ---------------------------------------------------------------------------
// Walk unit coverage (Phase 5.1 B)
// ---------------------------------------------------------------------------

test("collectSensitiveConfigPaths: walks marks on Optional/Union/Record/Object properties", () => {
	const schema = Type.Object({
		plain: Type.Optional(Type.Boolean()),
		marked: Type.Optional(Type.Boolean({ sensitive: true })),
		markedUnion: Type.Optional(Type.Union([Type.Literal("a"), Type.Literal("b")], { sensitive: true })),
		markedRecord: Type.Optional(Type.Record(Type.String(), Type.String(), { sensitive: true })),
		markedObject: Type.Optional(
			Type.Object({ inner: Type.Optional(Type.Boolean({ sensitive: true })) }, { additionalProperties: false, sensitive: true }),
		),
		nested: Type.Optional(
			Type.Object(
				{
					deep: Type.Optional(Type.Array(Type.String(), { sensitive: true })),
					unmarked: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
		),
	});
	assert.deepEqual(collectSensitiveConfigPaths(schema as SchemaLike), [
		"marked",
		"markedUnion",
		"markedRecord",
		"markedObject", // terminal — NOT recursed into (no "markedObject.inner")
		"nested.deep",
	]);
});

test("collectSensitiveConfigPaths: defensive — mark on a Union member still counts", () => {
	const schema = Type.Object({
		memberMarked: Type.Optional(Type.Union([Type.Boolean(), Type.Union([Type.Literal(false)], { sensitive: true })])),
	});
	assert.deepEqual(collectSensitiveConfigPaths(schema as SchemaLike), ["memberMarked"]);
});

test("collectSensitiveConfigPaths: no marks yields an empty list", () => {
	const schema = Type.Object({
		a: Type.Optional(Type.Boolean()),
		b: Type.Optional(Type.Object({ c: Type.Optional(Type.String()) }, { additionalProperties: false })),
	});
	assert.deepEqual(collectSensitiveConfigPaths(schema as SchemaLike), []);
});

test("collectSensitiveConfigPaths: default walk of PiTeamsConfigSchema pins the ADR inventory", () => {
	assert.deepEqual(collectSensitiveConfigPaths(), [...EXPECTED_SENSITIVE_PATHS]);
	assert.ok(
		!collectSensitiveConfigPaths().includes("runtime.requirePlanApproval"),
		"requirePlanApproval must stay unmarked (conditional exception)",
	);
});

// ---------------------------------------------------------------------------
// S-R7 drift gate (Phase 5.2)
// ---------------------------------------------------------------------------

test("drift gate (i): every sensitive-marked path is dropped from project config", () => {
	const sensitivePaths = collectSensitiveConfigPaths();
	const projectConfig: Record<string, unknown> = {
		// non-sensitive canaries that must survive
		notifierIntervalMs: 30_000,
		runtime: {},
		otlp: {},
	};
	for (const dotted of sensitivePaths) setAtPath(projectConfig, dotted, SENTINEL);
	// canaries inside sections that also carry sensitive keys
	projectConfig.runtime = { ...(projectConfig.runtime as object), maxTurns: 50 };
	projectConfig.otlp = { ...(projectConfig.otlp as object), enabled: true };
	projectConfig.worktree = { ...(projectConfig.worktree as object), linkNodeModules: true };

	const { config: sanitized } = __test__sanitizeProjectConfig(PROJECT_PATH, {}, projectConfig as unknown as PiTeamsConfig);
	const sanitizedRecord = sanitized as unknown as Record<string, unknown>;

	for (const dotted of sensitivePaths) {
		assert.equal(getAtPath(sanitizedRecord, dotted), undefined, `sensitive path '${dotted}' must be dropped from project config`);
	}
	assert.equal((sanitizedRecord.runtime as Record<string, unknown> | undefined)?.maxTurns, 50, "runtime.maxTurns canary survives");
	assert.equal((sanitizedRecord.otlp as Record<string, unknown> | undefined)?.enabled, true, "otlp.enabled canary survives");
	assert.equal(
		(sanitizedRecord.worktree as Record<string, unknown> | undefined)?.linkNodeModules,
		true,
		"worktree.linkNodeModules canary survives",
	);
	assert.equal(sanitizedRecord.policy, undefined, "policy section with only sensitive keys collapses to undefined");
});

test("drift gate (ii): every OLD hardcoded drop-list path is marked sensitive in the schema", () => {
	const root = PiTeamsConfigSchema as unknown as SchemaLike;
	const unmarked = OLD_HARDCODED_DROP_LIST.filter((dotted) => resolveSchemaProperty(root, dotted)?.sensitive !== true);
	assert.deepEqual(unmarked, [], `old drop-list paths missing a sensitive mark: ${unmarked.join(", ")}`);
});

test("drift gate (iii): schema-derived drop-list is a superset of the old hardcoded list", () => {
	const derived = new Set(collectSensitiveConfigPaths());
	const regressed = OLD_HARDCODED_DROP_LIST.filter((dotted) => !derived.has(dotted));
	assert.deepEqual(regressed, [], `paths dropped by the legacy hardcode but no longer schema-marked: ${regressed.join(", ")}`);
});

test("drift gate (iv): every sensitive mark maps to an existing schema key path (no orphans)", () => {
	const root = PiTeamsConfigSchema as unknown as SchemaLike;
	const allPaths = new Set(allSchemaKeyPaths(root));
	const orphans = collectSensitiveConfigPaths().filter((dotted) => !allPaths.has(dotted));
	assert.deepEqual(orphans, [], `sensitive marks that do not resolve to a schema key: ${orphans.join(", ")}`);
});

test("drift gate (v): conditional drop table inventory pinned", () => {
	assert.deepEqual(Object.keys(CONDITIONAL_PROJECT_DROPS), [...EXPECTED_CONDITIONAL_DROPS]);
	// limits.maxConcurrentWorkers deliberately has NO conditional entry: the
	// schema bounds it (Integer minimum 1 + reader ceilings) and a project can
	// only lower it (tighten) — see the ADR Wave 1A section.
	assert.ok(
		!("limits.maxConcurrentWorkers" in CONDITIONAL_PROJECT_DROPS),
		"maxConcurrentWorkers must not be conditionally dropped (tighten-only by bounds)",
	);
	// Every conditional path resolves to a real schema property (no orphans).
	const root = PiTeamsConfigSchema as unknown as SchemaLike;
	const orphans = EXPECTED_CONDITIONAL_DROPS.filter((dotted) => resolveSchemaProperty(root, dotted) === undefined);
	assert.deepEqual(orphans, [], `conditional paths that do not resolve to a schema key: ${orphans.join(", ")}`);
});

test("drift gate (v): loosening values dropped with warning, tightening values survive", () => {
	// [dotted, loosening value, tightening value] per CONDITIONAL_PROJECT_DROPS entry.
	// The project tier may only TIGHTEN these guards — never loosen them.
	const cases: ReadonlyArray<[string, unknown, unknown]> = [
		["runtime.requirePlanApproval", false, true],
		["runtime.completionMutationGuard", "off", "warn"],
		["runtime.completionMutationGuard", "off", "fail"],
		["runtime.effectivenessGuard", "off", "warn"],
		["runtime.effectivenessGuard", "off", "block"],
		["runtime.effectivenessGuard", "off", "fail"],
		["limits.allowUnboundedConcurrency", true, false],
		["reliability.autoRecover", false, true],
		["reliability.scopeModels", false, true],
		["broker.enabled", false, true],
	];
	for (const [dotted, loosening, tightening] of cases) {
		const loosened = __test__sanitizeProjectConfig(PROJECT_PATH, {}, setPath({}, dotted, loosening) as PiTeamsConfig);
		assert.equal(
			getAtPath(loosened.config as unknown as Record<string, unknown>, dotted),
			undefined,
			`loosening value ${JSON.stringify(loosening)} for '${dotted}' must be dropped`,
		);
		assert.ok(
			loosened.warnings.some((w) => w.includes(`'${dotted}'`) && w.includes(PROJECT_PATH)),
			`expected a warning for '${dotted}' mentioning the project path`,
		);

		const tightened = __test__sanitizeProjectConfig(PROJECT_PATH, {}, setPath({}, dotted, tightening) as PiTeamsConfig);
		assert.equal(
			getAtPath(tightened.config as unknown as Record<string, unknown>, dotted),
			tightening,
			`tightening value ${JSON.stringify(tightening)} for '${dotted}' must survive`,
		);
		assert.equal(tightened.warnings.length, 0, `no warning when '${dotted}' only tightens`);
	}
});

test("drift gate (v): conditional drop sections collapse when fully emptied, other keys survive", () => {
	// limits: only the loosening key -> section collapses to undefined.
	const collapsed = __test__sanitizeProjectConfig(PROJECT_PATH, {}, {
		limits: { allowUnboundedConcurrency: true },
	} as PiTeamsConfig);
	assert.equal(collapsed.config.limits, undefined, "limits with only a dropped key collapses");

	// Sibling keys survive; the section itself stays an object.
	const partial = __test__sanitizeProjectConfig(PROJECT_PATH, {}, {
		limits: { allowUnboundedConcurrency: true, maxConcurrentWorkers: 4 },
		reliability: { autoRecover: false, scopeModels: false, autoRetry: true },
		runtime: { completionMutationGuard: "off", effectivenessGuard: "off", requirePlanApproval: false, maxTurns: 50 },
	} as PiTeamsConfig);
	assert.deepEqual(partial.config.limits, { maxConcurrentWorkers: 4 }, "maxConcurrentWorkers always survives");
	assert.deepEqual(partial.config.reliability, { autoRetry: true }, "surviving reliability keys kept");
	assert.deepEqual(partial.config.runtime, { maxTurns: 50 }, "runtime keeps non-conditional keys");
	for (const dotted of [
		"limits.allowUnboundedConcurrency",
		"reliability.autoRecover",
		"reliability.scopeModels",
		"runtime.completionMutationGuard",
		"runtime.effectivenessGuard",
		"runtime.requirePlanApproval",
	]) {
		assert.ok(
			partial.warnings.some((w) => w.includes(`'${dotted}'`)),
			`warning for '${dotted}'`,
		);
	}
});

test("drift gate (v): input config is not mutated by conditional drops", () => {
	const input = { limits: { allowUnboundedConcurrency: true }, broker: { enabled: false } } as PiTeamsConfig;
	__test__sanitizeProjectConfig(PROJECT_PATH, {}, input);
	assert.equal(input.limits?.allowUnboundedConcurrency, true, "input limits must not be mutated");
	assert.equal(input.broker?.enabled, false, "input broker must not be mutated");
});

test("drift gate (vi): goalWrap subtree fully dropped from project config", () => {
	const { config: sanitized, warnings } = __test__sanitizeProjectConfig(PROJECT_PATH, {}, {
		goalWrap: {
			implementation: {
				enabled: true,
				budgetUnlimited: true,
				evaluatorModel: "claude-opus-4",
				verification: { commands: ["npm test"], mode: "text-only" },
			},
		},
	} as unknown as PiTeamsConfig);
	assert.equal((sanitized as Record<string, unknown>).goalWrap, undefined, "whole goalWrap subtree drops (top-level key)");
	assert.ok(
		warnings.some((w) => w.includes("'goalWrap'") && w.includes(PROJECT_PATH)),
		"goalWrap drop warns with the standard format",
	);
});

test("drift gate (vii): autonomous.magicKeywords dropped from project config", () => {
	const { config: sanitized, warnings } = __test__sanitizeProjectConfig(PROJECT_PATH, {}, {
		autonomous: { magicKeywords: { research: ["deep"] } },
	} as PiTeamsConfig);
	assert.equal(sanitized.autonomous, undefined, "autonomous with only magicKeywords collapses");
	assert.ok(
		warnings.some((w) => w.includes("'autonomous.magicKeywords'") && w.includes(PROJECT_PATH)),
		"magicKeywords drop warns with the standard format",
	);
});

test("drift gate (viii): broker.enabled === false dropped; === true and other broker fields survive", () => {
	const disabled = __test__sanitizeProjectConfig(PROJECT_PATH, {}, {
		broker: { enabled: false, pathHashLen: 8 },
	} as PiTeamsConfig);
	assert.equal(disabled.config.broker?.enabled, undefined, "broker.enabled === false must be dropped");
	assert.equal(disabled.config.broker?.pathHashLen, 8, "non-availability broker fields survive");
	assert.ok(
		disabled.warnings.some((w) => w.includes("'broker.enabled'")),
		"broker.enabled drop warns",
	);

	const enabled = __test__sanitizeProjectConfig(PROJECT_PATH, {}, { broker: { enabled: true } } as PiTeamsConfig);
	assert.equal(enabled.config.broker?.enabled, true, "project may ENABLE the broker (=== true survives)");
	assert.equal(enabled.warnings.length, 0, "no warning when the project only enables the broker");

	const bareDisabled = __test__sanitizeProjectConfig(PROJECT_PATH, {}, { broker: { enabled: false } } as PiTeamsConfig);
	assert.equal(bareDisabled.config.broker, undefined, "broker with only the dropped key collapses");
});

test("drift gate (ix): F19-5 parser bounds match the schema (no parser/schema bound drift)", () => {
	// The schema is the source of truth (ADR Wave 1A remediation). Violations parse
	// to undefined via parseWithSchema. Asserted through parseConfig — the full bound
	// matrix lives in config-validation-bounds.test.ts; this pins the alignment
	// inside the drift gate itself.
	// observability.metricRetentionDays: schema max 90. Absent is NOT defaulted by
	// the parser (undefined); the effective runtime default is 7 days, applied at
	// registration (extension/registration/observability.ts `?? 7`).
	const retention = (metricRetentionDays: unknown): number | undefined =>
		parseConfig({ observability: { enabled: true, metricRetentionDays } }).observability?.metricRetentionDays;
	assert.equal(retention(undefined), undefined);
	assert.equal(retention(90), 90);
	assert.equal(retention(365), undefined);

	// notifications.dedupWindowMs: schema minimum 1000 (the old parser-only 24h
	// ceiling is gone — the schema has no maximum).
	const dedup = (dedupWindowMs: unknown): number | undefined =>
		parseConfig({ notifications: { enabled: true, dedupWindowMs } }).notifications?.dedupWindowMs;
	assert.equal(dedup(999), undefined);
	assert.equal(dedup(1000), 1000);

	// otlp.endpoint: schema pattern ^https?:// (config-schema.ts).
	const endpoint = (value: unknown): string | undefined => parseConfig({ otlp: { enabled: true, endpoint: value } }).otlp?.endpoint;
	assert.equal(endpoint("unix:///tmp/x"), undefined);
	assert.equal(endpoint("https://collector.local:4318"), "https://collector.local:4318");
});

/** Build a nested object from a dotted path (test-local helper). */
function setPath(target: Record<string, unknown>, dotted: string, value: unknown): Record<string, unknown> {
	setAtPath(target, dotted, value);
	return target;
}
