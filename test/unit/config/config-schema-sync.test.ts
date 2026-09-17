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
import { PiTeamsConfigSchema, PiTeamsUiConfigSchema, validateConfig } from "../../../src/schema/config-schema.ts";

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

/**
 * M1-9 / P1-8 (UI-AUDIT-2026-09-15 §3 P1-8): the ui.* sub-block had drifted.
 *
 * `PiTeamsUiConfigSchema` is `additionalProperties: false`, so a key that is
 * parsed and honoured by the config layer but absent from the schema produced a
 * hard "unknown property" finding from validateConfig() — a false alarm on a
 * supported setting. Before this fix (HEAD):
 *   - `ui.inlinePanel` was parsed by parseUiConfig() (config-validation.ts)
 *     and read by src/ui/inline-panel/index.ts, but missing from the schema;
 *   - `ui.autoCloseDashboardMs` was in the schema but missing from
 *     handle-settings KNOWN_KEYS.
 * UPDATE 2026-09-16: `ui.widgetRowStyle` was REMOVED entirely — the M4 RAIL
 * dock redesign deleted its last reader (`compactDock`), so the config chain
 * (defaults/types/parser/schema/KNOWN_KEYS/model field) was dead weight.
 * The removal is pinned below: the strict schema must now reject it as an
 * unknown property (a supported-then-removed key resurfacing would mean the
 * dead chain crept back).
 * Note: this test pins the NESTED ui.* keys; the top-level sync test above and
 * schema.json only cover top-level keys, which is exactly the gap that let the
 * drift live (see the scout memo §5 — schema.json is hand-maintained).
 */
describe("M1-9 (P1-8): ui.* sub-key parity", () => {
	const DRIFTED_UI_KEYS = ["inlinePanel", "autoCloseDashboardMs"] as const;

	it("PiTeamsUiConfigSchema declares the previously-drifted ui keys", () => {
		const props = (PiTeamsUiConfigSchema.properties ?? {}) as Record<string, unknown>;
		assert.ok("inlinePanel" in props, "ui.inlinePanel must be in PiTeamsUiConfigSchema");
		assert.ok("autoCloseDashboardMs" in props, "ui.autoCloseDashboardMs must be in PiTeamsUiConfigSchema");
		assert.ok(
			!("widgetRowStyle" in props),
			"ui.widgetRowStyle was removed 2026-09-16 with its dead config chain — it must not resurface",
		);
	});

	it("validateConfig() accepts the drifted ui keys with no unknown-property finding", () => {
		const outcome = validateConfig({ ui: { inlinePanel: false, autoCloseDashboardMs: 5000 } });
		const unknown = outcome.findings.filter((f) => f.message.includes("unknown property") || f.message.includes("Unexpected property"));
		assert.deepEqual(unknown, [], `validateConfig() reported unknown ui keys: ${JSON.stringify(unknown)}`);
		assert.equal(outcome.hasErrors, false, `validateConfig() errored on supported ui keys: ${JSON.stringify(outcome.findings)}`);
	});

	it("validateConfig() rejects the removed ui.widgetRowStyle as unknown (the dead chain stays dead)", () => {
		const outcome = validateConfig({ ui: { widgetRowStyle: "detailed" } });
		assert.equal(outcome.hasErrors, true, "the removed row-style key must be rejected");
		assert.ok(
			outcome.findings.some((f) => f.field === "ui.widgetRowStyle"),
			`expected a ui.widgetRowStyle finding, got ${JSON.stringify(outcome.findings)}`,
		);
	});

	it("schema stays strict: a key absent from the ui block is still an unknown-property error", () => {
		// This is the P1-8 mechanism — it must keep working, otherwise the test
		// above could pass merely because strictness was relaxed.
		const outcome = validateConfig({ ui: { definitelyBogusKey: true } });
		assert.ok(
			outcome.findings.some((f) => f.severity === "ERROR" && f.message.includes("unknown property")),
			`expected an unknown-property ERROR, got ${JSON.stringify(outcome.findings)}`,
		);
	});
});

/**
 * M1-9b (closes the gap the M1-9 block above explicitly documented as still
 * open): `schema.json` is a hand-maintained, PUBLISHED artifact
 * (`package.json` files + exports) that editors use to validate
 * `pi-crew.json`. The pre-existing sync test only compared TOP-LEVEL keys, so a
 * nested block could drift forever — which is exactly how
 * `ui.widgetRowStyle` / `ui.inlinePanel` / `ui.autoCloseDashboardMs` stayed
 * missing from `schema.json` even after M1-9 fixed the TypeBox schema and
 * KNOWN_KEYS.
 *
 * Both directions are asserted: a key added to the TypeBox ui block but not to
 * schema.json (false editor errors on a supported setting) and a key left in
 * schema.json after removal from the TypeBox block (editor accepts a setting
 * the loader drops).
 */
describe("M1-9b: schema.json ui.* block parity (published artifact)", () => {
	const readSchemaJson = (): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(process.cwd(), "schema.json"), "utf-8"));

	it("schema.json ui.properties keys match PiTeamsUiConfigSchema exactly", () => {
		const jsonUi = Object.keys(
			(readSchemaJson().properties as Record<string, { properties?: Record<string, unknown> }>).ui?.properties ?? {},
		);
		const tsUi = Object.keys(PiTeamsUiConfigSchema.properties ?? {});

		assert.deepEqual(
			tsUi.filter((k) => !jsonUi.includes(k)),
			[],
			"ui.* keys missing from schema.json (editors would flag a supported setting)",
		);
		assert.deepEqual(
			jsonUi.filter((k) => !tsUi.includes(k)),
			[],
			"ui.* keys in schema.json but not honoured by the loader",
		);
	});

	it("schema.json ui block is still strict and widgetRowStyle stays removed", () => {
		const ui = (
			readSchemaJson().properties as Record<
				string,
				{ additionalProperties?: boolean; properties?: Record<string, { enum?: unknown[] }> }
			>
		).ui;
		assert.equal(ui?.additionalProperties, false, "schema.json ui block must stay additionalProperties:false");
		assert.ok(
			!("widgetRowStyle" in (ui?.properties ?? {})),
			"schema.json must not re-add ui.widgetRowStyle after its 2026-09-16 removal (editors would validate a dead setting)",
		);
	});
});
