import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PiTeamsConfigSchema } from "../../../src/schema/config-schema.ts";

/**
 * G17-class drift guard (found live 2026-09-12 by the real-test battery):
 * `reliability.loopGuard` shipped in types.ts + config-validation but was
 * missing from the TypeBox schema, the team-settings KNOWN_KEYS list, and
 * BOTH EFFECTIVE_DEFAULTS maps — `team-settings get reliability.loopGuard`
 * answered "unknown key" while the feature was actually running.
 *
 * This test pins: every BOOLEAN key in the schema's reliability block must
 * be addressable through team-settings (KNOWN_KEYS) and must carry an
 * effective default in BOTH EFFECTIVE_DEFAULTS maps. Non-boolean keys
 * (retryPolicy object, numeric intervals) are out of scope for now — the
 * pre-existing gaps there are tracked as long-tail cleanup.
 */

const SCHEMA_REL = PiTeamsConfigSchema.properties.reliability?.properties ?? {};
const BOOLEAN_REL_KEYS = Object.entries(SCHEMA_REL)
	.filter(([, node]) => (node as { type?: string }).type === "boolean")
	.map(([key]) => `reliability.${key}`);

function readMapKeys(source: string, marker: string): Set<string> {
	const idx = source.indexOf(marker);
	assert.ok(idx >= 0, `marker ${marker} not found`);
	const body = source.slice(idx);
	const keys = new Set<string>();
	for (const m of body.matchAll(/"((?:runtime\.)?reliability\.[\w.]+)"/g)) {
		keys.add(m[1]);
	}
	return keys;
}

describe("reliability settings-key parity (G17 guard)", () => {
	it("schema has the expected boolean reliability keys (incl. loopGuard)", () => {
		assert.ok(BOOLEAN_REL_KEYS.includes("reliability.loopGuard"), `loopGuard missing from schema: ${BOOLEAN_REL_KEYS}`);
	});

	it("every boolean schema reliability key is in handle-settings KNOWN_KEYS + EFFECTIVE_DEFAULTS", async () => {
		const fs = await import("node:fs");
		const src = fs.readFileSync("src/extension/team-tool/handle-settings.ts", "utf-8");
		const knownKeys = readMapKeys(src, "// reliability");
		const effective = readMapKeys(src, "notifierIntervalMs");
		for (const key of BOOLEAN_REL_KEYS) {
			assert.ok(knownKeys.has(key), `${key} missing from KNOWN_KEYS — team-settings get/set would say "unknown key"`);
			assert.ok(effective.has(key), `${key} missing from handle-settings EFFECTIVE_DEFAULTS`);
		}
	});

	it("settings-overlay EFFECTIVE_DEFAULTS agrees for every boolean schema reliability key", async () => {
		const fs = await import("node:fs");
		const src = fs.readFileSync("src/ui/settings-overlay.ts", "utf-8");
		const overlayKeys = readMapKeys(src, "const EFFECTIVE_DEFAULTS");
		for (const key of BOOLEAN_REL_KEYS) {
			assert.ok(overlayKeys.has(key), `${key} missing from settings-overlay EFFECTIVE_DEFAULTS (drifted default risk)`);
		}
	});
});
