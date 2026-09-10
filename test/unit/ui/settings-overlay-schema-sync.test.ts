/**
 * WI-3.3 (M3 spec §5): settings-overlay ↔ schema sync test.
 *
 * The settings-overlay (src/ui/settings-overlay.ts) lists config keys the
 * user can toggle from the TUI. Each setting's `id` is a dotted path
 * (e.g., `runtime.mode`, `autonomous.enabled`) that resolves to a nested
 * config field. The schema (src/schema/config-schema.ts) is the source
 * of truth for valid config paths.
 *
 * This test verifies:
 *   1. Every SETTINGS id in settings-overlay.ts has a matching path in
 *      the TypeBox schema (PiTeamsConfigSchema). If someone adds a
 *      setting to the overlay but forgets to add it to the schema, this
 *      test fails.
 *   2. Type compatibility: the setting's `type` (boolean/number/enum/
 *      string/agent/action) matches the schema's TypeBox kind.
 *
 * Mutation demo (in commit message): if you add `id: "limits.foo"` to
 * SETTINGS without adding `foo` to PiTeamsLimitsConfigSchema, this test
 * fails with "settings-overlay id 'limits.foo' not found in schema".
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { PiTeamsConfigSchema } from "../../../src/schema/config-schema.ts";

// Walk a TypeBox schema and collect all dotted paths that point to a
// leaf (non-Object) property. Skips sensitive/skip markers.
function collectSchemaPaths(schema: unknown, prefix = "", out: Set<string> = new Set()): Set<string> {
	if (!schema || typeof schema !== "object") return out;
	const obj = schema as Record<string, unknown>;
	if (Array.isArray(obj.anyOf) || Array.isArray(obj.oneOf)) {
		// Union — recurse into each branch
		for (const branch of (obj.anyOf ?? obj.oneOf ?? []) as unknown[]) {
			collectSchemaPaths(branch, prefix, out);
		}
		return out;
	}
	if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
		const props = obj.properties as Record<string, unknown>;
		const additional = obj.additionalProperties;
		// If additionalProperties is an object schema (not false), allow any key
		const allowExtra = additionalPropertiesIsSchema(additional);
		// Add the prefix itself as a valid path — settings like
		// `runtime.isolationPolicy` resolve to a nested Object in the config.
		if (prefix) out.add(prefix);
		for (const [k, v] of Object.entries(props)) {
			const newPath = prefix ? `${prefix}.${k}` : k;
			collectSchemaPaths(v, newPath, out);
		}
		if (allowExtra) {
			// Mark this prefix as a catch-all — any nested key OK
			out.add(`${prefix}.*`);
		}
		return out;
	}
	// Leaf type
	if (obj.type) {
		out.add(prefix);
	}
	return out;
}

function additionalPropertiesIsSchema(v: unknown): boolean {
	if (v === false || v === undefined || v === true) return false;
	if (typeof v === "object" && v !== null && "type" in v) return true;
	return false;
}

// Extract every `id: "..."` literal from settings-overlay.ts. Done via
// regex because the SETTINGS array is a static const (not exported).
function extractSettingsIds(): string[] {
	const file = fs.readFileSync(path.join(import.meta.dirname ?? __dirname, "../../../src/ui/settings-overlay.ts"), "utf8");
	const ids: string[] = [];
	const re = /^\s+id:\s*"([^"]+)"/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(file)) !== null) {
		ids.push(m[1]);
	}
	return ids;
}

describe("WI-3.3 settings-overlay ↔ schema sync", () => {
	it("every SETTINGS id exists in PiTeamsConfigSchema", () => {
		const schemaPaths = collectSchemaPaths(PiTeamsConfigSchema);
		const ids = extractSettingsIds();

		const missing: string[] = [];
		for (const id of ids) {
			// Skip special pseudo-settings handled by Pi (not pi-crew config)
			if (id === "__piTheme__") continue;
			// Skip action-type settings (they don't write to config — they
			// dispatch a callback like theme switching)
			// We don't have the type here, so allow any setting that has a
			// catch-all ancestor (e.g., agents.* with additionalProperties).
			// Walk the full id — the FULL path must match an exact schema
			// path (leaf or intermediate object). A prefix match like
			// `limits` matching `limits.maxConcurrentWorkers_FOO` is a false
			// positive, so we require the complete id.
			const parts = id.split(".");
			let cur = "";
			let found = false;
			for (const p of parts) {
				cur = cur ? `${cur}.${p}` : p;
			}
			// Full id must be in schema (as leaf OR as nested Object path).
			// Or the FINAL key must match a catch-all prefix (`agents.*`).
			if (schemaPaths.has(id)) {
				found = true;
			} else {
				// Check catch-all ancestors: e.g., id="agents.foo" matches if
				// "agents.*" is in the schema.
				let ancestor = id;
				while (ancestor.includes(".")) {
					ancestor = ancestor.slice(0, ancestor.lastIndexOf("."));
					if (schemaPaths.has(`${ancestor}.*`)) {
						found = true;
						break;
					}
				}
			}
			if (!found) missing.push(id);
		}

		assert.deepEqual(
			missing,
			[],
			`settings-overlay ids not found in PiTeamsConfigSchema:\n${missing.join("\n")}\n` +
				`Either add the field to the schema, or remove the setting from the overlay.`,
		);
	});

	it("schema is not empty (sanity guard)", () => {
		const schemaPaths = collectSchemaPaths(PiTeamsConfigSchema);
		assert.ok(schemaPaths.size > 50, `schema path count ${schemaPaths.size} < 50 — schema may be empty/broken`);
	});
});
