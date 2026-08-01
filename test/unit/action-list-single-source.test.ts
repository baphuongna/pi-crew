/**
 * action-list-single-source.test.ts — EXT-4/EXT-8 drift guard.
 *
 * Asserts that every consumer of the action list derives from the same single
 * source of truth (`allActionLiterals` in team-tool-schema.ts). If any consumer
 * hand-maintains a divergent list, this test fails.
 *
 * The three consumers checked:
 * 1. Schema: allActionLiterals (the source of truth itself).
 * 2. Suggestions: KNOWN_TEAM_ACTIONS in action-suggestions.ts.
 * 3. Dispatch: ACTION_TO_DOMAIN mapping (via domainForAction) in dispatch/.
 *
 * Run: `env -u PI_CREW_KIND -u PI_CREW_RUN_ID npx tsx --test test/unit/action-list-single-source.test.ts`
 */
import assert from "node:assert/strict";
import test from "node:test";
import { KNOWN_TEAM_ACTIONS } from "../../src/extension/action-suggestions.ts";
import { domainForAction } from "../../src/extension/team-tool/dispatch/index.ts";
import { allActionLiterals } from "../../src/schema/team-tool-schema.ts";

/** Extract raw action strings from the schema's allActionLiterals. */
const schemaActions = new Set(allActionLiterals.map((l) => (l as { const: string }).const));

test("allActionLiterals is non-empty (54 actions expected)", () => {
	assert.ok(schemaActions.size >= 54, `expected >=54 actions, got ${schemaActions.size}`);
});

test("KNOWN_TEAM_ACTIONS (suggestions) equals allActionLiterals (schema) — no drift", () => {
	const suggestionActions = new Set(KNOWN_TEAM_ACTIONS);
	assert.deepEqual(
		[...schemaActions].sort(),
		[...suggestionActions].sort(),
		"KNOWN_TEAM_ACTIONS must exactly match allActionLiterals — they must derive from the same source",
	);
});

test("every schema action has a dispatch domain mapping — no drift", () => {
	const missing: string[] = [];
	for (const action of schemaActions) {
		if (domainForAction(action) === undefined) {
			missing.push(action);
		}
	}
	assert.deepEqual(missing, [], "actions in schema but missing from dispatch (ACTION_TO_DOMAIN)");
});

test("no duplicate actions across domain arrays in allActionLiterals", () => {
	const all = allActionLiterals.map((l) => (l as { const: string }).const);
	assert.equal(all.length, schemaActions.size, "duplicate action strings found in allActionLiterals");
});
