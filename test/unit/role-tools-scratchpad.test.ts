import assert from "node:assert/strict";
import test from "node:test";
import { isScratchpadEnabledForRole } from "../../src/config/role-tools.ts";

// Phase 1 — scratchpad opt-in mapping + S-6 privilege-elevation gate + F6
// kill-switch. See spec §3.1/§3.2 and plan checkpoint A (T2).

test("scratchpad default-on for the three Phase 1 opt-in roles", () => {
	assert.equal(isScratchpadEnabledForRole("executor"), true);
	assert.equal(isScratchpadEnabledForRole("test-engineer"), true);
	assert.equal(isScratchpadEnabledForRole("verifier"), true);
});

test("scratchpad off for non-opt-in roles (read-only and other write roles)", () => {
	// read-only roles
	for (const role of ["explorer", "reviewer", "security-reviewer", "analyst", "critic", "planner"]) {
		assert.equal(isScratchpadEnabledForRole(role), false, `${role} should be off`);
	}
	// writer is a WRITE role but Phase 1 default-off (no use-case yet — Q1)
	assert.equal(isScratchpadEnabledForRole("writer"), false);
});

test("S-6: read-only role with agent scratchpad:true stays DISABLED (privilege-elevation guard)", () => {
	// security-reviewer's tool-set is read/grep/find with NO bash — a frontmatter
	// scratchpad:true must NOT grant full-trust JS execution in a read-only role.
	assert.equal(isScratchpadEnabledForRole("security-reviewer", { scratchpad: true }), false);
	assert.equal(isScratchpadEnabledForRole("reviewer", { scratchpad: true }), false);
	assert.equal(isScratchpadEnabledForRole("planner", { scratchpad: true }), false);
	assert.equal(isScratchpadEnabledForRole("explorer", { scratchpad: true }), false);
});

test("F6: agent scratchpad:false wins over role default (kill-switch)", () => {
	assert.equal(isScratchpadEnabledForRole("executor", { scratchpad: false }), false);
	assert.equal(isScratchpadEnabledForRole("verifier", { scratchpad: false }), false);
	assert.equal(isScratchpadEnabledForRole("test-engineer", { scratchpad: false }), false);
});

test("N2-3: WRITE role can opt in via agent frontmatter (not blocked by S-6)", () => {
	// writer is WRITE (not read-only) → agent opt-in enables it (Q1 = role default
	// off, not a ban). This is the explicit user opt-in path for write roles.
	assert.equal(isScratchpadEnabledForRole("writer", { scratchpad: true }), true);
	// other WRITE roles (cold-verifier/chain-executor/worker/agent) likewise.
	assert.equal(isScratchpadEnabledForRole("cold-verifier", { scratchpad: true }), true);
	assert.equal(isScratchpadEnabledForRole("chain-executor", { scratchpad: true }), true);
	assert.equal(isScratchpadEnabledForRole("worker", { scratchpad: true }), true);
	assert.equal(isScratchpadEnabledForRole("agent", { scratchpad: true }), true);
});

test("F10: underscore role names normalize to hyphenated before lookup", () => {
	// permissionForRole + getToolConfig expect hyphenated runtime strings;
	// underscore forms must normalize so test_engineer → true (not default-deny).
	assert.equal(isScratchpadEnabledForRole("test_engineer"), true);
	assert.equal(isScratchpadEnabledForRole("security_reviewer"), false); // via S-6 after normalize
	assert.equal(isScratchpadEnabledForRole("security_reviewer", { scratchpad: true }), false); // S-6 still wins
});

test("unknown role defaults to disabled (permissionForRole default-deny → read_only)", () => {
	assert.equal(isScratchpadEnabledForRole("nonexistent-role"), false);
	assert.equal(isScratchpadEnabledForRole("nonexistent-role", { scratchpad: true }), false);
	assert.equal(isScratchpadEnabledForRole(""), false);
});

test("S-6 fail-closed: case-drift / whitespace / typo cannot bypass the read-only gate", () => {
	// permissionForRole is case-sensitive + exact-match + default-deny, so any
	// drift off the canonical hyphenated name falls through to read_only → false,
	// even with an agent opt-in. This is the load-bearing S-6 defence — lock it.
	assert.equal(isScratchpadEnabledForRole("Executor"), false); // case-drift
	assert.equal(isScratchpadEnabledForRole("executor "), false); // trailing whitespace
	assert.equal(isScratchpadEnabledForRole(" executor"), false); // leading whitespace
	assert.equal(isScratchpadEnabledForRole("executer"), false); // typo
	assert.equal(isScratchpadEnabledForRole("Executor", { scratchpad: true }), false); // drift + opt-in still denied
});
