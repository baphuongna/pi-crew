import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import { __test__mergeConfig, parseConfig } from "../../../src/config/config.ts";
import { PiTeamsConfigSchema, PiTeamsRuntimeConfigSchema } from "../../../src/schema/config-schema.ts";

/**
 * Round 19 Part A parity fixes (schema = parser = read), behavior-preserving:
 * - F19-1 runtime.modelFallback: parsed + deep-merged (was declared in types.ts
 *   and the schema, but parseRuntimeConfig never emitted it — user config was
 *   silently inert).
 * - F19-2 reliability.retryPolicy.maxTotalSpawns: parsed + read, but the schema
 *   (additionalProperties:false) rejected it — schema-side phantom.
 * - F19-3 control.consecutiveFailureThreshold / control.longRunningMinutes:
 *   read at agent-control.ts (defaults 3/10) but absent from schema AND parser
 *   — parser-side phantom. Unset MUST stay undefined so the read-site defaults
 *   remain authoritative.
 */

// ---------------------------------------------------------------------------
// F19-1: runtime.modelFallback parse parity
// ---------------------------------------------------------------------------

test("F19-1: parseConfig emits runtime.modelFallback and round-trips all fields", () => {
	const parsed = parseConfig({
		runtime: {
			modelFallback: {
				maxAutoFallbacks: 2,
				order: "parentFirst",
				requireCredentials: true,
				quotaAwareOrdering: false,
				defaultSubagentModel: "zaic/glm-5.2",
			},
		},
	});
	assert.ok(parsed.runtime?.modelFallback, "runtime.modelFallback must be an object, not undefined");
	assert.equal(parsed.runtime.modelFallback.maxAutoFallbacks, 2);
	assert.equal(parsed.runtime.modelFallback.order, "parentFirst");
	assert.equal(parsed.runtime.modelFallback.requireCredentials, true);
	assert.equal(parsed.runtime.modelFallback.quotaAwareOrdering, false);
	assert.equal(parsed.runtime.modelFallback.defaultSubagentModel, "zaic/glm-5.2");
});

test("F19-1: parseConfig drops invalid modelFallback values instead of passing them through", () => {
	const parsed = parseConfig({
		runtime: {
			modelFallback: { maxAutoFallbacks: -1, order: "bogus", defaultSubagentModel: "" },
		},
	});
	// Every field fails its schema bound → helper collapses to undefined.
	assert.equal(parsed.runtime?.modelFallback, undefined);
});

test("F19-1: modelFallback stays undefined when absent (defaults untouched)", () => {
	const parsed = parseConfig({ runtime: { maxTurns: 12 } });
	assert.equal(parsed.runtime?.modelFallback, undefined);
});

// ---------------------------------------------------------------------------
// F19-1: runtime.modelFallback merge parity (user-wins, nested)
// ---------------------------------------------------------------------------

test("F19-1: mergeConfig deep-merges runtime.modelFallback — override wins per key, base preserved", () => {
	const base = { runtime: { modelFallback: { order: "asIs" as const, maxAutoFallbacks: 5 } } };
	const override = { runtime: { modelFallback: { maxAutoFallbacks: 1 } } };
	const merged = __test__mergeConfig(base, override);
	assert.equal(merged.runtime?.modelFallback?.maxAutoFallbacks, 1, "override must win on maxAutoFallbacks");
	assert.equal(merged.runtime?.modelFallback?.order, "asIs", "base order must be preserved");
});

test("F19-1: mergeConfig keeps base modelFallback when override sets none", () => {
	const merged = __test__mergeConfig(
		{ runtime: { modelFallback: { order: "asIs" as const, maxAutoFallbacks: 5 } } },
		{ runtime: { maxTurns: 42 } },
	);
	assert.equal(merged.runtime?.modelFallback?.maxAutoFallbacks, 5);
	assert.equal(merged.runtime?.modelFallback?.order, "asIs");
	assert.equal(merged.runtime?.maxTurns, 42);
});

// ---------------------------------------------------------------------------
// F19-2: reliability.retryPolicy.maxTotalSpawns schema parity
// ---------------------------------------------------------------------------

test("F19-2: retryPolicy.maxTotalSpawns schema-validates and parses (no phantom-field drop)", () => {
	const config = { reliability: { retryPolicy: { maxTotalSpawns: 4 } } };
	// additionalProperties:false previously made this Check fail.
	assert.equal(Value.Check(PiTeamsConfigSchema, config), true, "schema must admit maxTotalSpawns");
	const parsed = parseConfig(config);
	assert.equal(parsed.reliability?.retryPolicy?.maxTotalSpawns, 4, "parser must round-trip maxTotalSpawns");
});

test("F19-2: retryPolicy.maxTotalSpawns still rejects invalid values (schema bounds)", () => {
	assert.equal(Value.Check(PiTeamsConfigSchema, { reliability: { retryPolicy: { maxTotalSpawns: -1 } } }), false);
	const parsed = parseConfig({ reliability: { retryPolicy: { maxTotalSpawns: 1.5 } } });
	assert.equal(parsed.reliability?.retryPolicy?.maxTotalSpawns, undefined, "non-integer must not pass through");
});

// ---------------------------------------------------------------------------
// F19-3: control.consecutiveFailureThreshold / longRunningMinutes parity
// ---------------------------------------------------------------------------

test("F19-3: control thresholds round-trip through schema and parser", () => {
	const config = { control: { consecutiveFailureThreshold: 5, longRunningMinutes: 20 } };
	assert.equal(Value.Check(PiTeamsConfigSchema, config), true, "schema must admit both control thresholds");
	const parsed = parseConfig(config);
	assert.equal(parsed.control?.consecutiveFailureThreshold, 5);
	assert.equal(parsed.control?.longRunningMinutes, 20);
});

test("F19-3: unset control thresholds stay undefined — read-site defaults 3/10 untouched", () => {
	const parsed = parseConfig({});
	assert.equal(parsed.control?.consecutiveFailureThreshold, undefined);
	assert.equal(parsed.control?.longRunningMinutes, undefined);
	const parsedEnabledOnly = parseConfig({ control: { enabled: true } });
	assert.equal(parsedEnabledOnly.control?.consecutiveFailureThreshold, undefined);
	assert.equal(parsedEnabledOnly.control?.longRunningMinutes, undefined);
});

test("F19-3: invalid control thresholds are dropped, siblings survive", () => {
	const parsed = parseConfig({ control: { consecutiveFailureThreshold: 0, longRunningMinutes: -5, needsAttentionAfterMs: 5000 } });
	assert.equal(parsed.control?.consecutiveFailureThreshold, undefined, "0 is below minimum 1");
	assert.equal(parsed.control?.longRunningMinutes, undefined, "negative must be dropped");
	assert.equal(parsed.control?.needsAttentionAfterMs, 5000, "sibling fields unaffected");
});

// ---------------------------------------------------------------------------
// F19-1 discipline (R3-19/D5): runtime.hermeticWorkers parse parity
// ---------------------------------------------------------------------------

test("F19-1/D5: parseConfig emits runtime.hermeticWorkers (schema + parser + types aligned)", () => {
	const config = { runtime: { hermeticWorkers: false } };
	assert.equal(Value.Check(PiTeamsConfigSchema, config), true, "schema must admit runtime.hermeticWorkers");
	const parsed = parseConfig(config);
	assert.equal(parsed.runtime?.hermeticWorkers, false, "parser must emit the key — not parse-dead");
});

test("F19-1/D5: runtime.hermeticWorkers stays undefined when absent (default TRUE stays read-site)", () => {
	const parsed = parseConfig({ runtime: { maxTurns: 12 } });
	assert.equal(parsed.runtime?.hermeticWorkers, undefined, "unset must not leak a false default");
});

test("F19-1/D5: invalid runtime.hermeticWorkers values are dropped, siblings survive", () => {
	const parsed = parseConfig({ runtime: { hermeticWorkers: "yes", maxTurns: 9 } });
	assert.equal(parsed.runtime?.hermeticWorkers, undefined, "non-boolean must not pass through");
	assert.equal(parsed.runtime?.maxTurns, 9, "sibling keys unaffected");
});

// ---------------------------------------------------------------------------
// F19-AUTO (QW#3 wave, 0.11.8): 3-way parity DERIVED, not hand-listed.
//
// Bug class F19-1 struck three times before anyone noticed (runtime.modelFallback,
// runtime.sessionRecovery, runtime.workerTransport each spent time declared in
// types.ts + schema while parseRuntimeConfig silently dropped them). The tests
// above pin those specific regressions; this section removes the root cause —
// a hand-maintained key list can go stale the day someone adds a key. Instead:
//   1. types side    — parse src/config/types.ts source, extract the
//                      CrewRuntimeConfig member tree (incl. nested inline
//                      objects and named interface refs, resolved recursively);
//   2. schema side   — walk PiTeamsRuntimeConfigSchema.properties;
//   3. parser side   — synthesize a schema-valid probe value for EVERY key and
//                      assert parseConfig emits each one with the exact value
//                      (parse-dead detection) and emits nothing extra
//                      (phantom detection, F19-3 class).
// No key name appears in this file except in comments. If the harness itself
// drifts (interface not found, unsynthesizable schema node), the tests fail
// loudly instead of degrading to a vacuous pass.
// ---------------------------------------------------------------------------

/** Minimal structural view of a TypeBox node (JSON-schema-ish). */
type SchemaNode = {
	properties?: Record<string, SchemaNode>;
	anyOf?: SchemaNode[];
	items?: SchemaNode;
	const?: unknown;
	type?: string;
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	minLength?: number;
	pattern?: string;
	multipleOf?: number;
};

/** Member name → nested members (null = leaf). */
interface MemberTree {
	[key: string]: MemberTree | null;
}

const TYPES_TS = readFileSync(fileURLToPath(new URL("../../../src/config/types.ts", import.meta.url)), "utf8");

const RUNTIME_SCHEMA_PROPS = PiTeamsRuntimeConfigSchema.properties as unknown as Record<string, SchemaNode>;

/** Full text of `export interface <name> { ... }` via a brace walk (comment-safe enough: an unbalanced brace in a doc comment fails the parity assert loudly, never silently). */
function interfaceBlock(source: string, name: string): string | undefined {
	const start = source.indexOf(`export interface ${name} {`);
	if (start === -1) return undefined;
	const open = source.indexOf("{", start);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	return undefined;
}

/**
 * Derive the member tree of an interface block from source:
 *  - one leading tab  = top-level member;
 *  - two leading tabs inside a member's section = members of its inline object;
 *  - a section that is a bare `Ident;` resolves recursively when `Ident` names
 *    another interface in the same file (modelFallback → CrewModelFallbackConfig).
 */
function memberTree(block: string, source: string): MemberTree {
	const starts = [...block.matchAll(/(?:^|\n)\t([A-Za-z_$][A-Za-z0-9_$]*)\??:/g)];
	const tree: MemberTree = {};
	for (let i = 0; i < starts.length; i++) {
		const name = starts[i][1];
		const from = (starts[i].index ?? 0) + starts[i][0].length;
		const to = i + 1 < starts.length ? starts[i + 1].index : undefined;
		const section = block.slice(from, to).trim();
		const nestedInline = [...section.matchAll(/(?:^|\n)\t\t([A-Za-z_$][A-Za-z0-9_$]*)\??:/g)].map((m) => m[1]);
		const namedRef = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*;/.exec(section)?.[1];
		if (nestedInline.length > 0) {
			tree[name] = Object.fromEntries(nestedInline.map((n) => [n, null]));
		} else if (namedRef) {
			const refBlock = interfaceBlock(source, namedRef);
			tree[name] = refBlock ? memberTree(refBlock, source) : null;
		} else {
			tree[name] = null;
		}
	}
	return tree;
}

/** Inner .properties of a node, looking through union wrappers. */
function innerProperties(node: SchemaNode): Record<string, SchemaNode> | undefined {
	if (node.properties) return node.properties;
	if (node.anyOf) {
		for (const sub of node.anyOf) {
			const found = innerProperties(sub);
			if (found) return found;
		}
	}
	return undefined;
}

function schemaMemberTree(props: Record<string, SchemaNode>): MemberTree {
	const tree: MemberTree = {};
	for (const [key, node] of Object.entries(props)) {
		const inner = innerProperties(node);
		tree[key] = inner ? schemaMemberTree(inner) : null;
	}
	return tree;
}

/**
 * Synthesize a valid value for a schema node: first union member that works,
 * const literals as-is, numbers at their minimum, strings as "x"×minLength,
 * arrays of one item, objects recursively. Throws on pattern-gated strings —
 * better a loud harness failure than a silently vacuous probe.
 */
function synthValue(node: SchemaNode): unknown {
	if (node.anyOf) {
		let lastError: unknown = new Error("empty union");
		for (const sub of node.anyOf) {
			try {
				return synthValue(sub);
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError;
	}
	if (node.const !== undefined) return node.const;
	switch (node.type) {
		case "boolean":
			return true;
		case "integer":
		case "number": {
			let v = node.minimum ?? 1;
			if (node.exclusiveMinimum !== undefined && v <= node.exclusiveMinimum) v = node.exclusiveMinimum + 1;
			if (node.maximum !== undefined && v > node.maximum) v = node.maximum;
			if (node.multipleOf !== undefined) v = Math.ceil(v / node.multipleOf) * node.multipleOf;
			return v;
		}
		case "string": {
			if (node.pattern) throw new Error(`pattern-gated string not synthesizable: ${node.pattern}`);
			return "x".repeat(Math.max(node.minLength ?? 1, 1));
		}
		case "array":
			if (!node.items) throw new Error("array without items");
			return [synthValue(node.items)];
		case "object": {
			if (!node.properties) throw new Error("object without properties");
			const out: Record<string, unknown> = {};
			for (const [key, sub] of Object.entries(node.properties)) out[key] = synthValue(sub);
			return out;
		}
		default:
			throw new Error(`unsupported schema type: ${String(node.type)}`);
	}
}

test("F19-AUTO: types.ts CrewRuntimeConfig member tree === PiTeamsRuntimeConfigSchema property tree", () => {
	const block = interfaceBlock(TYPES_TS, "CrewRuntimeConfig");
	assert.ok(block, "harness drift: `export interface CrewRuntimeConfig {` not found in src/config/types.ts");
	const fromTypes = memberTree(block, TYPES_TS);
	const fromSchema = schemaMemberTree(RUNTIME_SCHEMA_PROPS);

	const typeKeys = Object.keys(fromTypes).sort();
	const schemaKeys = Object.keys(fromSchema).sort();
	assert.deepEqual(
		typeKeys.filter((k) => !schemaKeys.includes(k)),
		[],
		"keys declared in CrewRuntimeConfig but ABSENT from PiTeamsRuntimeConfigSchema (schema-side phantom)",
	);
	assert.deepEqual(
		schemaKeys.filter((k) => !typeKeys.includes(k)),
		[],
		"keys declared in PiTeamsRuntimeConfigSchema but ABSENT from CrewRuntimeConfig (types-side phantom)",
	);
	// Full recursive tree equality — nested blocks (yield / surface /
	// isolationPolicy / modelFallback) drift too, and past bugs lived exactly there.
	assert.deepEqual(
		fromTypes,
		fromSchema,
		"CrewRuntimeConfig (types.ts) and PiTeamsRuntimeConfigSchema member trees must match at every depth",
	);
});

test("F19-AUTO: parseConfig emits every schema key of runtime.* — no parse-dead keys, no phantom keys, exact round-trip", () => {
	const probeObj = synthValue({ type: "object", properties: RUNTIME_SCHEMA_PROPS }) as Record<string, unknown>;
	// Harness sanity: the synthesized block must itself validate against the
	// schema, otherwise the probe proves nothing about real configs.
	assert.equal(
		Value.Check(PiTeamsRuntimeConfigSchema, probeObj),
		true,
		"harness drift: synthesized runtime block fails Value.Check — see synthValue",
	);
	const parsed = parseConfig({ runtime: probeObj });
	assert.ok(parsed.runtime, "parsed.runtime must exist for a fully-set runtime block");
	const assertSubtree = (props: Record<string, SchemaNode>, obj: Record<string, unknown>, path: string): void => {
		const phantom = Object.keys(obj)
			.filter((k) => !(k in props))
			.sort();
		assert.deepEqual(
			phantom,
			[],
			`${path}: parser emits keys absent from schema+types (phantom, F19-3 bug class): ${phantom.join(", ")}`,
		);
		for (const key of Object.keys(props).sort()) {
			const node = props[key];
			const value = obj[key];
			assert.notEqual(
				value,
				undefined,
				`${path}.${key} is parse-dead: declared in types.ts + schema but parseConfig never emits it (F19-1 bug class — modelFallback/sessionRecovery/workerTransport each missed once)`,
			);
			const inner = innerProperties(node);
			if (inner) {
				assertSubtree(inner, value as Record<string, unknown>, `${path}.${key}`);
			} else {
				assert.deepEqual(
					value,
					synthValue(node),
					`${path}.${key}: parsed value must equal the schema-valid probe value (silent coercion drift)`,
				);
			}
		}
	};
	assertSubtree(RUNTIME_SCHEMA_PROPS, parsed.runtime as Record<string, unknown>, "runtime");
});
