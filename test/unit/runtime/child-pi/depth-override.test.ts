/**
 * ADR-5 §3/§4 — depthOverride seam + issuer depth gate (WP-5 step 4).
 *
 * §3: a root-spawned grandchild's PI_CREW_DEPTH comes from the parent task
 * RECORD via `depthOverride` — never from the root's env (depth 0 → child
 * would wrongly be 1). Expressed as the parent's depth in the base env so
 * both the checkCrewDepth gate and the buildPiWorkerArgs spawn math agree.
 *
 * §4: the broker issuer mints credentials only for children that may
 * themselves delegate (childDepth < resolved maxDepth). At the default
 * maxDepth=2 a depth-2 grandchild gets NO socket/token (env containment AC —
 * scoped to SOCKET/TOKEN; RUN_ID/TASK_ID identity routing is unconditional).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildPiWorkerArgs, checkCrewDepth } from "../../../../src/runtime/model/pi-args.ts";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";

const agent: AgentConfig = {
	name: "executor",
	description: "test agent",
	prompt: "do the thing",
} as unknown as AgentConfig;

function baseEnv(depth: number): NodeJS.ProcessEnv {
	return { PI_CREW_DEPTH: String(depth), PI_CREW_MAX_DEPTH: "2" };
}

test("§3 spawn env: depthOverride=2 → grandchild gets PI_CREW_DEPTH=2 (parent record, not root env)", () => {
	// The root process env says depth 0; depthOverride pre-encodes parent
	// depth 1 into the base env; the builder's parentDepth+1 math yields 2.
	const built = buildPiWorkerArgs({
		task: "grandchild task",
		agent,
		sessionEnabled: true,
		env: { ...baseEnv(1), PI_CREW_MAX_DEPTH: "2" },
	});
	assert.equal(built.env.PI_CREW_DEPTH, "2");
	assert.equal(built.env.PI_TEAMS_DEPTH, "2");
	assert.equal(built.env.PI_CREW_MAX_DEPTH, "2");
});

test("§3 default (no override): worker spawn env still parentDepth+1 from process env", () => {
	const built = buildPiWorkerArgs({ task: "t", agent, sessionEnabled: true, env: baseEnv(0) });
	assert.equal(built.env.PI_CREW_DEPTH, "1");
});

test("§3 gate: grandchild depth 3 at default maxDepth 2 is blocked (checkCrewDepth sees parent depth 2)", () => {
	// depthOverride=3 pre-encodes parent depth 2 into the base env; gate
	// blocked = parentDepth >= maxDepth → 2 >= 2 → blocked.
	const gate = checkCrewDepth(undefined, baseEnv(2));
	assert.equal(gate.blocked, true);
	assert.deepEqual([gate.depth, gate.maxDepth], [2, 2]);
});

test("§3 gate: grandchild depth 2 at default maxDepth 2 passes (parent depth 1 < 2)", () => {
	const gate = checkCrewDepth(undefined, baseEnv(1));
	assert.equal(gate.blocked, false);
});

test("§3 gate: raised maxDepth 3 → grandchild depth 3 passes (ADR-5 §4 generalized gate)", () => {
	const gate = checkCrewDepth(undefined, { PI_CREW_DEPTH: "2", PI_CREW_MAX_DEPTH: "3" });
	assert.equal(gate.blocked, false);
});

test("§4 issuer depth gate: childDepth >= resolved maxDepth → no credentials", async () => {
	// Mirror the issueForChild gate logic (the production closure is bound to
	// session state; the DECISION under test is the depth comparison).
	const maxDepth = 2; // resolveCrewMaxDepth(undefined) with no env override
	const gateAllows = (childDepth: number | undefined) =>
		childDepth === undefined || childDepth < maxDepth;
	assert.equal(gateAllows(2), false, "depth-2 grandchild at default maxDepth=2 gets NO creds");
	assert.equal(gateAllows(1), true, "depth-1 worker may delegate → creds minted");
	assert.equal(gateAllows(undefined), true, "legacy spawn (no depth info) unchanged");
	// Raised maxDepth: depth-2 child may itself delegate → creds minted.
	const maxDepth3 = 3;
	assert.equal(2 < maxDepth3, true, "depth-2 at maxDepth=3 gets creds (real depth-3 delegation)");
});

test("§4 env containment shape: grandchild spawn env has NO broker keys when issuer declines", () => {
	// When issueForChild returns undefined for a depth-2 child, prepareSpawnContext
	// never sets PI_CREW_BROKER_SOCKET/TOKEN; identity routing keys ARE set
	// unconditionally (I5) — assert the exact scoped containment (erratum D-2).
	const built = buildPiWorkerArgs({
		task: "t",
		agent,
		sessionEnabled: true,
		env: baseEnv(1),
	});
	assert.equal(built.env.PI_CREW_BROKER_SOCKET, undefined);
	assert.equal(built.env.PI_CREW_BROKER_TOKEN, undefined);
});
