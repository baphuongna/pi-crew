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
 *   - `ui.widgetRowStyle` and `ui.inlinePanel` were parsed by parseUiConfig()
 *     (config-validation.ts) and read by src/ui/widget/index.ts /
 *     src/ui/inline-panel/index.ts, but missing from the schema;
 *   - `ui.autoCloseDashboardMs` was in the schema but missing from
 *     handle-settings KNOWN_KEYS.
 * Note: this test pins the NESTED ui.* keys; the top-level sync test above and
 * schema.json only cover top-level keys, which is exactly the gap that let the
 * drift live (see the scout memo §5 — schema.json is hand-maintained).
 */
describe("M1-9 (P1-8): ui.* sub-key parity", () => {
	const DRIFTED_UI_KEYS = ["widgetRowStyle", "inlinePanel", "autoCloseDashboardMs"] as const;

	it("PiTeamsUiConfigSchema declares the previously-drifted ui keys", () => {
		const props = (PiTeamsUiConfigSchema.properties ?? {}) as Record<string, unknown>;
		assert.ok(
			"widgetRowStyle" in props,
			"ui.widgetRowStyle must be in PiTeamsUiConfigSchema (parsed + honoured but absent = false 'unknown key')",
		);
		assert.ok("inlinePanel" in props, "ui.inlinePanel must be in PiTeamsUiConfigSchema");
		assert.ok("autoCloseDashboardMs" in props, "ui.autoCloseDashboardMs must be in PiTeamsUiConfigSchema");
	});

	it("ui.widgetRowStyle literals match WidgetRowStyle and the parser", () => {
		const rowStyle = PiTeamsUiConfigSchema.properties.widgetRowStyle as { anyOf?: { const?: unknown }[] } | undefined;
		const literals = (rowStyle?.anyOf ?? []).map((b) => b.const).sort();
		assert.deepEqual(literals, ["compact", "detailed"], "ui.widgetRowStyle literals must match the real values");

		// The real values live in the renderer type + the parser union.
		const renderer = fs.readFileSync(path.join(process.cwd(), "src/ui/widget/widget-renderer.ts"), "utf8");
		assert.match(renderer, /export type WidgetRowStyle = "compact" \| "detailed";/, "WidgetRowStyle drifted from compact|detailed");
		const parser = fs.readFileSync(path.join(process.cwd(), "src/config/config-validation.ts"), "utf8");
		assert.match(parser, /Type\.Union\(\[Type\.Literal\("compact"\), Type\.Literal\("detailed"\)\]\)/, "parseUiConfig union drifted");
	});

	it("validateConfig() accepts the 3 drifted ui keys with no unknown-property finding", () => {
		const outcome = validateConfig({ ui: { widgetRowStyle: "detailed", inlinePanel: false, autoCloseDashboardMs: 5000 } });
		const unknown = outcome.findings.filter((f) => f.message.includes("unknown property") || f.message.includes("Unexpected property"));
		assert.deepEqual(unknown, [], `validateConfig() reported unknown ui keys: ${JSON.stringify(unknown)}`);
		assert.equal(outcome.hasErrors, false, `validateConfig() errored on supported ui keys: ${JSON.stringify(outcome.findings)}`);
	});

	it("validateConfig() still rejects an out-of-union ui.widgetRowStyle (the bound is real)", () => {
		const outcome = validateConfig({ ui: { widgetRowStyle: "bogus" } });
		assert.equal(outcome.hasErrors, true, "an invalid row style must stay rejected");
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

	it("schema.json ui block is still strict and pins widgetRowStyle to the real literals", () => {
		const ui = (
			readSchemaJson().properties as Record<
				string,
				{ additionalProperties?: boolean; properties?: Record<string, { enum?: unknown[] }> }
			>
		).ui;
		assert.equal(ui?.additionalProperties, false, "schema.json ui block must stay additionalProperties:false");
		assert.deepEqual(
			[...(ui?.properties?.widgetRowStyle?.enum ?? [])].sort(),
			["compact", "detailed"],
			"schema.json widgetRowStyle enum must match WidgetRowStyle",
		);
	});
});
