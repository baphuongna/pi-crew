import test from "node:test";
import assert from "node:assert/strict";
import { checkRolePermission, isReadOnlyCommand, permissionForRole } from "../../src/runtime/role-permission.ts";

test("role permissions classify read-only and write roles", () => {
	assert.equal(permissionForRole("explorer"), "read_only");
	assert.equal(permissionForRole("executor"), "workspace_write");
});

test("read-only role blocks mutating commands", () => {
	assert.equal(isReadOnlyCommand("rg hello src"), true);
	assert.equal(isReadOnlyCommand("git commit -m test"), false);
	assert.equal(checkRolePermission("reviewer", "rg hello src").allowed, true);
	const denied = checkRolePermission("reviewer", "npm install lodash");
	assert.equal(denied.allowed, false);
	assert.equal(denied.mode, "read_only");
});
