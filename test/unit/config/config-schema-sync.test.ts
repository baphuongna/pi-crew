/**
 * CFG-2: Compile-time schema/type sync test.
 *
 * Verifies that every key in the PiTeamsConfig TypeScript interface
 * exists in the corresponding TypeBox schema (PiTeamsConfigSchema).
 * If someone adds a field to the interface but forgets the schema,
 * this test will catch it.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { PiTeamsConfigSchema } from "../../../src/schema/config-schema.ts";

// All known top-level keys from the PiTeamsConfig interface.
// If you add a new key to the interface, add it here too.
const PI_TEAMS_CONFIG_KEYS: readonly string[] = [
	"asyncByDefault",
	"executeWorkers",
	"notifierIntervalMs",
	"requireCleanWorktreeLeader",
	"ignoreMethod",
	"autonomous",
	"limits",
	"runtime",
	"control",
	"worktree",
	"goalWrap",
	"agents",
	"tools",
	"telemetry",
	"policy",
	"notifications",
	"observability",
	"reliability",
	"otlp",
	"ui",
	"broker",
	"nesting",
	"persistence",
];

describe("config-schema sync (CFG-2)", () => {
	it("every PiTeamsConfig key exists in the TypeBox schema", () => {
		const schemaProps = (PiTeamsConfigSchema.properties ?? {}) as Record<string, unknown>;
		const missing: string[] = [];

		for (const key of PI_TEAMS_CONFIG_KEYS) {
			if (!(key in schemaProps)) {
				missing.push(key);
			}
		}

		assert.deepEqual(missing, [], `PiTeamsConfig keys missing from PiTeamsConfigSchema: ${missing.join(", ")}`);
	});

	it("schema has no extra keys beyond the known interface", () => {
		const schemaProps = Object.keys(PiTeamsConfigSchema.properties ?? {});
		const extra = schemaProps.filter((k) => !PI_TEAMS_CONFIG_KEYS.includes(k));

		assert.deepEqual(extra, [], `PiTeamsConfigSchema has extra keys not in PI_TEAMS_CONFIG_KEYS: ${extra.join(", ")}`);
	});

	it("schema.json top-level keys match TypeBox PiTeamsConfigSchema keys", () => {
		const schemaJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schema.json"), "utf-8"));
		const jsonProps = Object.keys(schemaJson.properties ?? {});
		const typeboxProps = Object.keys(PiTeamsConfigSchema.properties ?? {});
		const missingInJson = typeboxProps.filter((p) => !jsonProps.includes(p));
		const extraInJson = jsonProps.filter((p) => !typeboxProps.includes(p));

		assert.deepEqual(missingInJson, [], `TypeBox keys missing from schema.json: ${missingInJson.join(", ")}`);
		assert.deepEqual(extraInJson, [], `schema.json keys not in TypeBox: ${extraInJson.join(", ")}`);
	});
});
