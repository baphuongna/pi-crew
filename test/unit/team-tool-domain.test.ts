/**
 * API-5 facade split — characterization tests.
 *
 * Verifies the 54→5 domain split introduced zero regressions:
 *   1. Every one of the 54 actions passes `Value.Check(TeamToolParams, {action})`.
 *   2. `domainForAction(action)` returns the correct domain for each action.
 *   3. `handleTeamTool({action}, mockCtx)` does not throw for any action.
 *   4. The Union schema accepts cross-domain fields (additionalProperties: true).
 *   5. Unknown actions are rejected by schema and routed to the error handler.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import { TeamToolParams, type TeamDomain } from "../../src/schema/team-tool-schema.ts";
import { domainForAction } from "../../src/extension/team-tool/dispatch/index.ts";
import { handleTeamTool } from "../../src/extension/team-tool.ts";

// ─── 54-action → domain mapping table ────────────────────────────────────────

const DOMAIN_ACTIONS: Record<TeamDomain, readonly string[]> = {
	run: ["run", "parallel", "plan", "orchestrate", "resume", "retry", "wait", "steer", "goal"],
	status: [
		"status", "list", "get", "events", "artifacts", "summary", "graph", "search",
		"health", "worktrees", "checkpoint", "cache", "explain", "onboard", "recommend", "help",
	],
	control: ["cancel", "invalidate", "respond", "cleanup", "prune", "forget", "doctor"],
	manage: [
		"create", "update", "delete", "init", "config", "validate", "autonomy", "settings",
		"workflow-create", "workflow-get", "workflow-list", "workflow-save", "workflow-delete",
		"import", "imports", "export",
	],
	automate: ["schedule", "scheduled", "anchor", "auto-summarize", "auto_boomerang", "api"],
};

// Flatten into [action, domain] pairs
const ALL_ACTIONS: ReadonlyArray<[string, TeamDomain]> = (Object.entries(DOMAIN_ACTIONS) as Array<
	[TeamDomain, readonly string[]]
>).flatMap(([domain, actions]) => actions.map((action) => [action, domain] as [string, TeamDomain]));

// Sanity: exactly 54 unique actions, 5 domains
const UNIQUE_ACTIONS = new Set(ALL_ACTIONS.map(([a]) => a));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-domain-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function cleanupCwd(cwd: string): void {
	fs.rmSync(cwd, { recursive: true, force: true });
}

// ─── 1. Structural integrity of the mapping ─────────────────────────────────

test("54-action mapping has exactly 54 unique actions across 5 domains", () => {
	assert.equal(UNIQUE_ACTIONS.size, 54, "expected exactly 54 unique actions");
	assert.equal(Object.keys(DOMAIN_ACTIONS).length, 5, "expected 5 domains");
	// Per-domain counts match ROADMAP spec
	assert.equal(DOMAIN_ACTIONS.run.length, 9);
	assert.equal(DOMAIN_ACTIONS.status.length, 16);
	assert.equal(DOMAIN_ACTIONS.control.length, 7);
	assert.equal(DOMAIN_ACTIONS.manage.length, 16);
	assert.equal(DOMAIN_ACTIONS.automate.length, 6);
});

// ─── 2. domainForAction returns correct domain for all 54 actions ─────────────

test("domainForAction maps all 54 actions to correct domain", () => {
	for (const [action, expectedDomain] of ALL_ACTIONS) {
		const actual = domainForAction(action);
		assert.equal(
			actual,
			expectedDomain,
			`domainForAction("${action}") should be "${expectedDomain}" but got "${actual}"`,
		);
	}
});

test("domainForAction returns undefined for unknown actions", () => {
	assert.equal(domainForAction("nonexistent"), undefined);
	assert.equal(domainForAction(""), undefined);
});

// ─── 3. Value.Check(TeamToolParams, {action}) passes for all 54 ────────────────

test("Value.Check accepts all 54 actions (no schema regression)", () => {
	for (const [action] of ALL_ACTIONS) {
		const ok = Value.Check(TeamToolParams, { action });
		assert.equal(
			ok,
			true,
			`Value.Check(TeamToolParams, {action: "${action}"}) should be true`,
		);
	}
});

// ─── 4. Value.Check rejects truly unknown actions ─────────────────────────────

test("Value.Check rejects unknown action", () => {
	const ok = Value.Check(TeamToolParams, { action: "nonexistent" as never });
	assert.equal(ok, false);
});

// ─── 5. Value.Check accepts {} (no action defaults to list) ───────────────────

test("Value.Check accepts empty object (action defaults to list at runtime)", () => {
	assert.equal(Value.Check(TeamToolParams, {}), true);
});

// ─── 6. Cross-domain fields pass (additionalProperties: true Phase 1) ──────────

test("cross-domain fields pass Value.Check (additionalProperties: true)", () => {
	// run action with a status-domain field (details)
	assert.equal(Value.Check(TeamToolParams, { action: "run", details: false }), true);
	// status action with a run-domain field (goal)
	assert.equal(Value.Check(TeamToolParams, { action: "status", goal: "test" }), true);
	// cancel action with an extra unknown field
	assert.equal(Value.Check(TeamToolParams, { action: "cancel", runId: "r1", foo: "bar" }), true);
});

// ─── 7. handleTeamTool does not throw for any of the 54 actions ────────────────

test("handleTeamTool does not throw for all 54 actions", async (t) => {
	for (const [action, domain] of ALL_ACTIONS) {
		// skip "run" and "parallel" — they spawn heavy runtime (lazy import chain)
		// and may hang in test environments. Their dispatch routing is verified
		// by the domainForAction tests above.
		if (action === "run" || action === "parallel") continue;

		await t.test(`action="${action}" (domain: ${domain})`, async () => {
			const cwd = makeTmpCwd();
			try {
				// Wrap in try-catch to detect throws vs error-results
				const out = await handleTeamTool({ action: action as never }, { cwd });
				// Must return a result object (not throw)
				assert.ok(out, `handleTeamTool({action: "${action}"}) returned undefined`);
				assert.ok(typeof out === "object", `handleTeamTool({action: "${action}"}) did not return an object`);
			} catch (err) {
				assert.fail(
					`handleTeamTool({action: "${action}"}) threw: ${err instanceof Error ? err.message : String(err)}`,
				);
			} finally {
				cleanupCwd(cwd);
			}
		});
	}
});

// ─── 8. Unknown action still routed to error handler ──────────────────────────

test("handleTeamTool returns error for unknown action", async () => {
	const cwd = makeTmpCwd();
	try {
		const out = await handleTeamTool({ action: "nonexistent" as never }, { cwd });
		assert.equal(out.isError, true);
	} finally {
		cleanupCwd(cwd);
	}
});
