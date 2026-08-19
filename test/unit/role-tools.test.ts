import assert from "node:assert/strict";
import test from "node:test";
import { getRestrictedRoles, getToolConfig, hasToolRestrictions, type RoleToolConfig } from "../../src/config/role-tools.ts";

test("getToolConfig returns config for known roles", () => {
	const explorer = getToolConfig("explorer");
	assert.ok(explorer.tools !== undefined);
	assert.ok(explorer.tools!.includes("read"));
	assert.ok(explorer.tools!.includes("grep"));
	// W7 update: bash is now in explorer's tools (not excludeTools) so the
	// research-5 (decisions) stream can run `git log --grep` to mine commit
	// history. State-mutation safety is enforced separately by READ_ONLY_ROLES
	// in role-permission.ts; edit/write remain excluded.
	assert.ok(explorer.tools!.includes("bash"));
	assert.ok(explorer.excludeTools!.includes("edit"));
	assert.ok(explorer.excludeTools!.includes("write"));
	assert.ok(explorer.excludeTools!.includes("web"));

	const executor = getToolConfig("executor");
	assert.equal(executor.tools, undefined);
	assert.equal(executor.excludeTools, undefined);
});

test("getToolConfig returns empty config for unknown roles", () => {
	const unknown = getToolConfig("unknown-role");
	assert.equal(unknown.tools, undefined);
	assert.equal(unknown.excludeTools, undefined);
});

test("hasToolRestrictions returns true for restricted roles", () => {
	assert.equal(hasToolRestrictions("explorer"), true);
	// F1: runtime uses the HYPHEN form; map key is now hyphenated too.
	assert.equal(hasToolRestrictions("security-reviewer"), true);
	assert.equal(hasToolRestrictions("writer"), true);
});

test("hasToolRestrictions returns false for executor", () => {
	assert.equal(hasToolRestrictions("executor"), false);
});

test("getRestrictedRoles returns all restricted roles", () => {
	const restricted = getRestrictedRoles();
	assert.ok(restricted.includes("explorer"));
	assert.ok(restricted.includes("security-reviewer"));
	assert.ok(!restricted.includes("executor"));
});

test("security-reviewer has strictest restrictions (F1: hyphen key resolves)", () => {
	// F1 regression: the runtime role string is the HYPHEN form. The underscore
	// form previously never resolved (returned {}), silently dropping the
	// strictest tool restrictions in the codebase.
	const security = getToolConfig("security-reviewer");
	assert.ok(security.tools!.length <= 4, "3 core tools + dormant ask (QW17/B1-F4)");
	assert.ok(security.excludeTools!.includes("bash"));
	assert.ok(security.excludeTools!.includes("edit"));
	assert.ok(security.excludeTools!.includes("write"));
});

test("explorer has read-only + bash tools, excludes edit/write", () => {
	// W7 update: bash added for git log/show (decisions stream) + grep -r +
	// find. Still no edit/write (file mutations are blocked at the
	// READ_ONLY_ROLES layer in role-permission.ts). Renamed from
	// "explorer has read-only tools" to reflect the new design.
	const explorer = getToolConfig("explorer");
	assert.ok(explorer.tools!.includes("read"));
	assert.ok(explorer.tools!.includes("grep"));
	assert.ok(explorer.tools!.includes("find"));
	assert.ok(explorer.tools!.includes("ls"));
	assert.ok(explorer.tools!.includes("glob"));
	assert.ok(explorer.tools!.includes("bash"));
	assert.ok(!explorer.tools!.includes("edit"));
	assert.ok(!explorer.tools!.includes("write"));
	assert.ok(!explorer.tools!.includes("web"));
});

test("reviewer can use bash but not edit/write", () => {
	const reviewer = getToolConfig("reviewer");
	assert.ok(reviewer.tools!.includes("bash"));
	assert.ok(reviewer.excludeTools!.includes("edit"));
	assert.ok(reviewer.excludeTools!.includes("write"));
});

test("writer has edit and write but no bash", () => {
	const writer = getToolConfig("writer");
	assert.ok(writer.tools!.includes("edit"));
	assert.ok(writer.tools!.includes("write"));
	assert.ok(!writer.tools!.includes("bash"));
});

test("test-engineer has bash but no web (F1: hyphen key resolves)", () => {
	const testEngineer = getToolConfig("test-engineer");
	assert.ok(testEngineer.tools!.includes("bash"));
	assert.ok(!testEngineer.tools!.includes("web"));
});

// ── F1/F2/F4 additions ──────────────────────────────────────────────────

test("F1: getToolConfig normalizes underscore → hyphen (back-compat for underscore callers)", () => {
	// Both forms must resolve to the SAME non-empty config. This guards against
	// the original defect class (underscore map key vs hyphen runtime string).
	assert.deepEqual(getToolConfig("security-reviewer"), getToolConfig("security_reviewer"));
	assert.deepEqual(getToolConfig("test-engineer"), getToolConfig("test_engineer"));
	assert.ok(getToolConfig("security_reviewer").excludeTools !== undefined);
});

test("F1: every runtime role name resolves its intended tool config", () => {
	// Derive the REAL runtime role strings from the permission sets (the source
	// of truth for role names) and assert each read-only/write role that should
	// have a tool-config actually resolves one. This is the test the original
	// bug evaded (tests only queried underscore forms that existed in the map).
	const readRolesWithConfig = ["explorer", "reviewer", "security-reviewer", "analyst", "critic", "planner"];
	const writeRolesWithConfig = ["executor", "test-engineer", "writer", "verifier"];
	for (const role of [...readRolesWithConfig, ...writeRolesWithConfig]) {
		const cfg: RoleToolConfig = getToolConfig(role);
		const hasCfg = cfg.tools !== undefined || cfg.excludeTools !== undefined;
		// executor intentionally has no restrictions; every other role must.
		if (role === "executor") {
			assert.equal(hasCfg, false, `executor should be unrestricted, got ${JSON.stringify(cfg)}`);
		} else {
			assert.ok(hasCfg, `role '${role}' must resolve a tool config (F1/F2 regression)`);
		}
	}
});

test("F2: critic is read-only (read tools, excludes edit/write/bash)", () => {
	const critic = getToolConfig("critic");
	assert.ok(critic.tools!.includes("read"));
	assert.ok(critic.excludeTools!.includes("edit"));
	assert.ok(critic.excludeTools!.includes("write"));
	assert.ok(critic.excludeTools!.includes("bash"));
});

test("F2: planner is read-only and cannot write/bash (strengthened)", () => {
	const planner = getToolConfig("planner");
	assert.ok(planner.tools!.includes("read"));
	assert.ok(planner.excludeTools!.includes("edit"));
	assert.ok(planner.excludeTools!.includes("write"));
	assert.ok(planner.excludeTools!.includes("bash"));
});

test("F4: verifier can run tests (bash) but cannot edit/write source", () => {
	const verifier = getToolConfig("verifier");
	assert.ok(verifier.tools!.includes("bash"), "verifier needs bash to run tests");
	assert.ok(verifier.tools!.includes("read"));
	assert.ok(verifier.excludeTools!.includes("edit"), "verifier must not edit source");
	assert.ok(verifier.excludeTools!.includes("write"), "verifier must not write source");
});
