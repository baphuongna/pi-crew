import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import { __test__sanitizeProjectConfig } from "../../../src/config/config.ts";
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
 * plus the runtime.requirePlanApproval conditional known-exception.
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

/** The exact inventory intended by ADR 2026-08-15 (old 21 + S-R5 policy.* + S-R6 seedPaths).
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
	"runtime.mode",
	"runtime.preferLiveSession",
	"runtime.allowChildProcessFallback",
	"runtime.inheritContext",
	"runtime.agentExtensions",
	"runtime.isolationPolicy",
	"worktree.setupHook",
	"worktree.seedPaths",
	"agents.disableBuiltins",
	"agents.overrides",
	"tools.enableSteer",
	"tools.terminateOnForeground",
	"policy.requireIntentForDestructiveActions",
	"policy.disabledCapabilities",
	"otlp.endpoint",
	"otlp.headers",
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

test("drift gate: known exception — runtime.requirePlanApproval drops only when === false", () => {
	const withFalse = __test__sanitizeProjectConfig(PROJECT_PATH, {}, { runtime: { requirePlanApproval: false } } as PiTeamsConfig);
	assert.equal(withFalse.config.runtime?.requirePlanApproval, undefined, "=== false must be dropped");
	assert.ok(
		withFalse.warnings.some((w) => w.includes("runtime.requirePlanApproval")),
		"=== false drop warns",
	);

	const withTrue = __test__sanitizeProjectConfig(PROJECT_PATH, {}, { runtime: { requirePlanApproval: true } } as PiTeamsConfig);
	assert.equal(withTrue.config.runtime?.requirePlanApproval, true, "=== true must be preserved");

	const withUnset = __test__sanitizeProjectConfig(PROJECT_PATH, {}, { runtime: { maxTurns: 10 } } as PiTeamsConfig);
	assert.equal(withUnset.config.runtime?.requirePlanApproval, undefined, "unset stays unset");
	assert.equal(withUnset.warnings.length, 0, "no warning when requirePlanApproval is not explicitly false");
});
