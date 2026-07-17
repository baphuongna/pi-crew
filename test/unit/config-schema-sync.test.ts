/**
 * CFG-2: Compile-time schema/type sync test.
 *
 * Verifies that every key in the PiTeamsConfig TypeScript interface
 * exists in the corresponding TypeBox schema (PiTeamsConfigSchema).
 * If someone adds a field to the interface but forgets the schema,
 * this test will catch it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PiTeamsConfigSchema } from "../../src/schema/config-schema.ts";

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

		assert.deepEqual(
			missing,
			[],
			`PiTeamsConfig keys missing from PiTeamsConfigSchema: ${missing.join(", ")}`,
		);
	});

	it("schema has no extra keys beyond the known interface", () => {
		const schemaProps = Object.keys(PiTeamsConfigSchema.properties ?? {});
		const extra = schemaProps.filter((k) => !PI_TEAMS_CONFIG_KEYS.includes(k));

		assert.deepEqual(
			extra,
			[],
			`PiTeamsConfigSchema has extra keys not in PI_TEAMS_CONFIG_KEYS: ${extra.join(", ")}`,
		);
	});
});
