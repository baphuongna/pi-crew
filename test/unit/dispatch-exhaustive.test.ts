/**
 * dispatch-exhaustive.test.ts — EXT-5 runtime parity guard.
 *
 * Complements the compile-time `never` exhaustiveness sentinels in
 * src/extension/team-tool/dispatch/{run,status,control,manage,automate}.ts.
 *
 * Division of safety:
 *   - Compile-time (tsc, run at gate): each domain switch covers every literal
 *     in its own `*_DOMAIN_ACTIONS` array (the `never` sentinel errors on a
 *     missing case; case-comparability errors on an extra case).
 *   - Runtime (this test): the cross-source property — every action in the
 *     schema's single source of truth (`allActionLiterals`) is (a) routed to a
 *     domain by `domainForAction` AND (b) present in that domain's exported
 *     `*_DOMAIN_ACTIONS` array, i.e. it has a real dispatch `case`.
 *
 * If a new action literal is added to the schema but not to any domain
 * dispatch, this test fails.
 *
 * Run: `env -u PI_CREW_KIND -u PI_CREW_RUN_ID npx tsx --test test/unit/dispatch-exhaustive.test.ts`
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AUTOMATE_DOMAIN_ACTIONS } from "../../src/extension/team-tool/dispatch/automate.ts";
import { CONTROL_DOMAIN_ACTIONS } from "../../src/extension/team-tool/dispatch/control.ts";
import { domainForAction } from "../../src/extension/team-tool/dispatch/index.ts";
import { MANAGE_DOMAIN_ACTIONS } from "../../src/extension/team-tool/dispatch/manage.ts";
import { RUN_DOMAIN_ACTIONS } from "../../src/extension/team-tool/dispatch/run.ts";
import { STATUS_DOMAIN_ACTIONS } from "../../src/extension/team-tool/dispatch/status.ts";
import { allActionLiterals } from "../../src/schema/team-tool-schema.ts";

/** Raw action strings from the schema's single source of truth. */
const schemaActions: string[] = allActionLiterals.map((l) => (l as { const: string }).const);

/** Per-domain dispatch action arrays — the runtime image of each switch. */
const DOMAIN_DISPATCH: Record<string, readonly string[]> = {
	run: RUN_DOMAIN_ACTIONS,
	status: STATUS_DOMAIN_ACTIONS,
	control: CONTROL_DOMAIN_ACTIONS,
	manage: MANAGE_DOMAIN_ACTIONS,
	automate: AUTOMATE_DOMAIN_ACTIONS,
};

test("every allActionLiteral has a dispatch handler in its routed domain", () => {
	const missing: string[] = [];
	for (const action of schemaActions) {
		const domain = domainForAction(action);
		const handled = domain ? DOMAIN_DISPATCH[domain] : undefined;
		if (!handled?.includes(action)) {
			missing.push(`${action} → ${domain ?? "(no domain)"}`);
		}
	}
	assert.deepEqual(missing, [], "actions routed to a domain but missing a dispatch case (switch handler)");
});

test("no action is claimed by two domain dispatch arrays", () => {
	const seen = new Map<string, string>();
	const dupes: string[] = [];
	for (const [domain, actions] of Object.entries(DOMAIN_DISPATCH)) {
		for (const action of actions) {
			if (seen.has(action)) {
				dupes.push(`${action} in ${seen.get(action)} and ${domain}`);
			} else {
				seen.set(action, domain);
			}
		}
	}
	assert.deepEqual(dupes, [], "an action is dispatched by two domains");
});

test("union of domain dispatch arrays exactly equals allActionLiterals (no drift)", () => {
	const union = new Set<string>();
	for (const actions of Object.values(DOMAIN_DISPATCH)) {
		for (const action of actions) union.add(action);
	}
	assert.deepEqual([...union].sort(), [...new Set(schemaActions)].sort(), "domain dispatch arrays drifted from the schema action list");
});

test("each domain dispatch array has no internal duplicates", () => {
	for (const [domain, actions] of Object.entries(DOMAIN_DISPATCH)) {
		assert.equal(actions.length, new Set(actions).size, `${domain} dispatch array has duplicate action strings`);
	}
});
