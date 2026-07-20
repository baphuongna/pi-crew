import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkSubagentSpawnPermission, currentCrewRole, permissionForRole } from "../../src/runtime/role-permission.ts";

// ── permissionForRole ───────────────────────────────────────────────────

describe("permissionForRole", () => {
	it("returns 'read_only' for explorer", () => {
		assert.strictEqual(permissionForRole("explorer"), "read_only");
	});

	it("returns 'read_only' for reviewer", () => {
		assert.strictEqual(permissionForRole("reviewer"), "read_only");
	});

	it("returns 'read_only' for security-reviewer", () => {
		assert.strictEqual(permissionForRole("security-reviewer"), "read_only");
	});

	it("returns 'workspace_write' for verifier (F4 — verifier runs tests)", () => {
		// F4 (2026-06-26): verifier moved out of READ_ONLY_ROLES to WRITE_ROLES.
		// Its task runs tests via bash with redirects/cache writes, which the
		// read-only prompt gate forbids — a direct contradiction with
		// agents/verifier.md. A write role + tool-config (no edit/write) lets it
		// run tests without editing source. Mirrors cold-verifier.
		assert.strictEqual(permissionForRole("verifier"), "workspace_write");
	});

	it("returns 'read_only' for analyst", () => {
		assert.strictEqual(permissionForRole("analyst"), "read_only");
	});

	it("returns 'read_only' for critic", () => {
		assert.strictEqual(permissionForRole("critic"), "read_only");
	});

	it("returns 'read_only' for planner (F3 — kept read-only for approval gate)", () => {
		// F3 (2026-06-26): planner stays read-only. Moving it to WRITE_ROLES
		// would fire the plan-approval gate BEFORE planning (breaking the
		// default/implementation workflows). Its deliverables are emitted as
		// result text and persisted by the runner, so read-only is compatible.
		assert.strictEqual(permissionForRole("planner"), "read_only");
	});

	it("returns 'workspace_write' for writer (P0 fix 2026-06-25 — parallel-research incident)", () => {
		// Round 20: writer was misclassified as read-only, blocking built-in
		// workflows (parallel-research, research, pipeline) from emitting their
		// declared `output:` files. 3/3 workflows use writer for deliverable
		// creation, not for read-only docs review. Audit confirmed.
		// See: research-findings/pi-crew-parallel-research-failure-incident.md
		assert.strictEqual(permissionForRole("writer"), "workspace_write");
	});

	it("returns 'workspace_write' for executor", () => {
		assert.strictEqual(permissionForRole("executor"), "workspace_write");
	});

	it("returns 'workspace_write' for test-engineer", () => {
		assert.strictEqual(permissionForRole("test-engineer"), "workspace_write");
	});

	it("returns 'read_only' for unknown role (FIND-12 default-deny)", () => {
		// FIND-12 (2026-07-20): unknown/custom roles default to read-only
		// instead of the previous permissive workspace_write. This prevents
		// privilege escalation via unrecognized agent names. Custom write-capable
		// roles must be added to the WRITE_ROLES allowlist in role-permission.ts.
		assert.strictEqual(permissionForRole("unknown-role"), "read_only");
	});

	// FIND-12 R1 regression test: every SHIPPED write-capable role must resolve
	// to workspace_write. The executor's initial WRITE_ROLES set omitted these,
	// silently demoting them (breaking direct-agent + cold-verifier + the chain
	// workflow). Asserting the real shipped roles guards against future gaps.
	it("returns 'workspace_write' for the default 'agent' role (direct-agent default)", () => {
		assert.strictEqual(permissionForRole("agent"), "workspace_write");
	});

	it("returns 'workspace_write' for cold-verifier (runs bash + cache writes)", () => {
		assert.strictEqual(permissionForRole("cold-verifier"), "workspace_write");
	});

	it("returns 'workspace_write' for chain-executor (chain workflow role)", () => {
		assert.strictEqual(permissionForRole("chain-executor"), "workspace_write");
	});

	it("returns 'workspace_write' for worker (goal-loop + dynamic-workflow executor)", () => {
		// FIND-12 R2: the autonomous goal-loop worker (goal-loop-runner.ts) and
		// dynamic-workflow synthesized roles (run.ts) use role 'worker' — must
		// stay write-capable or they'd be told not to modify files.
		assert.strictEqual(permissionForRole("worker"), "workspace_write");
	});
});

// ── currentCrewRole ─────────────────────────────────────────────────────

describe("currentCrewRole", () => {
	it("returns undefined when no env vars set", () => {
		assert.strictEqual(currentCrewRole({}), undefined);
	});

	it("reads from PI_CREW_ROLE", () => {
		assert.strictEqual(currentCrewRole({ PI_CREW_ROLE: "explorer" }), "explorer");
	});

	it("reads from PI_TEAMS_ROLE as fallback", () => {
		assert.strictEqual(currentCrewRole({ PI_TEAMS_ROLE: "executor" }), "executor");
	});

	it("PI_CREW_ROLE takes precedence over PI_TEAMS_ROLE", () => {
		assert.strictEqual(
			currentCrewRole({
				PI_CREW_ROLE: "explorer",
				PI_TEAMS_ROLE: "executor",
			}),
			"explorer",
		);
	});

	it("trims whitespace from role", () => {
		assert.strictEqual(currentCrewRole({ PI_CREW_ROLE: "  executor  " }), "executor");
	});

	it("returns undefined for empty string after trim", () => {
		assert.strictEqual(currentCrewRole({ PI_CREW_ROLE: "   " }), undefined);
	});
});

// ── checkSubagentSpawnPermission ────────────────────────────────────────

describe("checkSubagentSpawnPermission", () => {
	it("allows when role is undefined", () => {
		const result = checkSubagentSpawnPermission(undefined);
		assert.strictEqual(result.allowed, true);
	});

	it("denies for read-only roles", () => {
		const result = checkSubagentSpawnPermission("explorer");
		assert.strictEqual(result.allowed, false);
		assert.strictEqual(result.mode, "read_only");
		assert.ok(result.reason?.includes("read-only"));
	});

	it("allows for write roles", () => {
		const result = checkSubagentSpawnPermission("executor");
		assert.strictEqual(result.allowed, true);
		assert.strictEqual(result.mode, "workspace_write");
	});

	it("allows for test-engineer", () => {
		const result = checkSubagentSpawnPermission("test-engineer");
		assert.strictEqual(result.allowed, true);
	});

	it("allows for verifier (F4 — now a write role)", () => {
		assert.strictEqual(checkSubagentSpawnPermission("verifier").allowed, true);
	});

	it("denies for reviewer", () => {
		const result = checkSubagentSpawnPermission("reviewer");
		assert.strictEqual(result.allowed, false);
	});
});
