import assert from "node:assert/strict";
import test from "node:test";
import { checkSubagentSpawnPermission, currentCrewRole, permissionForRole } from "../../../../src/runtime/role-permission.ts";

test("role permissions classify read-only and write roles", () => {
	assert.equal(permissionForRole("explorer"), "read_only");
	assert.equal(permissionForRole("executor"), "workspace_write");
});

// F4 (2026-06-26): verifier moved to WRITE_ROLES — its task runs tests
// (npm test | tee, mkdir, rm cache) which the read-only prompt gate forbids.
// The read-only command classifier (isReadOnlyCommand/checkRolePermission)
// was dead code (zero runtime callers) and has been removed (F5); real
// read-only enforcement is the role tool-config + prompt gate.
test("read-only roles cannot spawn recursive subagents", () => {
	assert.equal(currentCrewRole({ PI_CREW_ROLE: "explorer" } as NodeJS.ProcessEnv), "explorer");
	const denied = checkSubagentSpawnPermission("explorer");
	assert.equal(denied.allowed, false);
	assert.equal(denied.mode, "read_only");
	assert.match(denied.reason ?? "", /cannot spawn/);
	assert.equal(checkSubagentSpawnPermission("executor").allowed, true);
});
