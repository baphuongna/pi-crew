import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import { RunDomainParams, TeamToolParams } from "../../src/schema/team-tool-schema.ts";

function walkSchema(node: unknown, visit: (node: Record<string, unknown>) => void): void {
	if (!node || typeof node !== "object" || Array.isArray(node)) return;
	const record = node as Record<string, unknown>;
	visit(record);
	for (const value of Object.values(record)) {
		if (Array.isArray(value)) {
			for (const item of value) walkSchema(item, visit);
		} else {
			walkSchema(value, visit);
		}
	}
}

test("team tool schema is strict-provider friendly", () => {
	const violations: string[] = [];
	walkSchema(TeamToolParams, (node) => {
		if (Array.isArray(node.type)) violations.push("array type union");
		if (node.description && !node.type && !node.anyOf && !node.oneOf && !node.allOf && !node.properties)
			violations.push(`description-only schema: ${node.description}`);
		if (node.type === "array" && !node.items) violations.push("array without items");
		if (node.type && (node.anyOf || node.oneOf)) violations.push("type combined with union keyword");
	});
	assert.deepEqual(violations, []);
});

test("team tool flexible fields use explicit schema shapes", () => {
	// API-5: TeamToolParams is now a Union of 5 domain schemas. All share the
	// same field definitions, so we inspect the first variant (RunDomainParams).
	const properties = (RunDomainParams as { properties: Record<string, unknown> }).properties;
	const skill = properties.skill as { anyOf?: unknown[] };
	const config = properties.config as {
		type?: string;
		additionalProperties?: boolean;
	};
	assert.equal(Array.isArray(skill.anyOf), true);
	assert.equal(skill.anyOf?.length, 3);
	assert.equal(config.type, "object");
	assert.equal(config.additionalProperties, true);
});

test("schema accepts action: retry", () => {
	const ok = Value.Check(TeamToolParams, { action: "retry", runId: "r1" });
	assert.strictEqual(ok, true);
});

test("schema accepts action: invalidate", () => {
	// FIX: Previously "invalidate" was in TS interface but missing from TypeBox schema,
	// causing silent failure with -32602 at the JSON-RPC layer.
	const ok = Value.Check(TeamToolParams, {
		action: "invalidate",
		runId: "r1",
	});
	assert.strictEqual(ok, true);
});

test("schema accepts action: anchor", () => {
	const ok = Value.Check(TeamToolParams, {
		action: "anchor",
		anchor: "test",
	});
	assert.strictEqual(ok, true);
});

test("schema accepts action: auto-summarize", () => {
	const ok = Value.Check(TeamToolParams, { action: "auto-summarize" });
	assert.strictEqual(ok, true);
});

test("schema accepts action: auto_boomerang", () => {
	const ok = Value.Check(TeamToolParams, { action: "auto_boomerang" });
	assert.strictEqual(ok, true);
});
