/**
 * crew-broker-tokens.test.ts — Behavioral security tests for the per-run
 * broker token registry (src/runtime/broker/crew-broker-tokens.ts).
 *
 * This module is SECURITY-SENSITIVE: it authenticates broker connections
 * (parent ↔ worker IPC). These tests exercise the full accept/reject
 * surface so that a mutation in the auth logic fails a test.
 *
 * Coverage map:
 *  - Generation: uniqueness (N distinct), UUID v4 format/length/version.
 *  - Accept: validly-issued token validates (worker + orchestrator roles).
 *  - Reject: wrong / tampered (one byte) / length-mismatched / non-string /
 *    empty / cross-run / cross-task / revoked / cleared tokens all fail.
 *  - timingSafeEqual path: equal-length one-byte-tamper rejects (no early
 *    leak asserted beyond the rejection itself), differing-length rejects
 *    before entering the constant-time compare.
 *  - Revocation (the module's lifecycle "expiry" — there is no TTL): revoke
 *    (with/without taskId) and clear() both invalidate.
 *  - F-06 role isolation: orchestrator vs worker tokens are never confused.
 *
 * Mutation-sensitivity notes are inline on each assertion block.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { type BrokerToken, BrokerTokenRegistry, newBrokerToken } from "../../../../src/runtime/broker/crew-broker-tokens.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** UUID v4: 8-4-4-4-12 lowercase hex, version nibble '4', variant in {8,9,a,b}. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Flip the first character to a different hex char, preserving length.
 *  Forces the candidate into the equal-length branch of timingSafeEqual
 *  (differing-length inputs short-circuit before the constant-time compare). */
function tamperOneChar(s: string): string {
	const head = s.charCodeAt(0);
	// Toggle the low bit of the first char so the result always differs.
	return String.fromCharCode(head ^ 1) + s.slice(1);
}

// ---------------------------------------------------------------------------
// newBrokerToken — generation
// ---------------------------------------------------------------------------

test("newBrokerToken returns a 36-char UUID v4 string", () => {
	const t = newBrokerToken();
	assert.equal(typeof t, "string");
	assert.equal(t.length, 36);
	assert.match(t, UUID_V4, "token must match the UUID v4 format (version + variant nibbles)");
});

test("newBrokerToken tokens are unique across a large batch", () => {
	const N = 2000;
	const seen = new Set<BrokerToken>();
	for (let i = 0; i < N; i++) {
		const t = newBrokerToken();
		// Mutation: if newBrokerToken returned a constant, this fails fast.
		assert.ok(!seen.has(t), `duplicate token generated at iteration ${i}: ${t}`);
		seen.add(t);
	}
	assert.equal(seen.size, N);
});

test("newBrokerToken version nibble is 4 and variant nibble is in 8/9/a/b", () => {
	for (let i = 0; i < 100; i++) {
		const t = newBrokerToken();
		assert.equal(t[14], "4", "version nibble must be 4 (UUID v4)");
		assert.ok(["8", "9", "a", "b"].includes(t[19]), `variant nibble must be 8/9/a/b, got ${t[19]}`);
	}
});

// ---------------------------------------------------------------------------
// BrokerTokenRegistry — issue / get / matches / tokenRole (accept paths)
// ---------------------------------------------------------------------------

test("issue + get round-trip: the issued token is retrievable unchanged", () => {
	const reg = new BrokerTokenRegistry();
	const t = reg.issue("run-1", "task-1");
	assert.equal(typeof t, "string");
	assert.match(t, UUID_V4);
	assert.equal(reg.get("run-1", "task-1"), t);
});

test("matches + tokenRole ACCEPT a validly-issued worker token", () => {
	const reg = new BrokerTokenRegistry();
	const t = reg.issue("run-1", "task-1");
	assert.equal(reg.matches("run-1", "task-1", t), true);
	assert.equal(reg.tokenRole("run-1", "task-1", t), "worker");
});

test("issue is idempotent per (runId, taskId): repeat calls return the SAME token", () => {
	const reg = new BrokerTokenRegistry();
	const first = reg.issue("run-1", "task-1");
	const second = reg.issue("run-1", "task-1");
	// Mutation: if issue always minted a fresh token, this would fail.
	assert.equal(second, first);
	assert.equal(reg.size, 1, "idempotent issue must not grow the registry");
});

test("issue with an explicit deterministic token stores that exact token", () => {
	const reg = new BrokerTokenRegistry();
	const fixed = "fixed-deterministic-token-value";
	const t = reg.issue("run-1", "task-1", fixed);
	assert.equal(t, fixed);
	assert.equal(reg.get("run-1", "task-1"), fixed);
	assert.equal(reg.matches("run-1", "task-1", fixed), true);
});

test("bare-runId token (no taskId) authenticates when taskId is omitted at lookup", () => {
	const reg = new BrokerTokenRegistry();
	const t = reg.issue("run-1"); // legacy per-run model
	assert.equal(reg.get("run-1"), t);
	assert.equal(reg.matches("run-1", undefined, t), true);
	assert.equal(reg.tokenRole("run-1", undefined, t), "worker");
});

test("backward-compat fallback: bare-runId token still authenticates when a taskId IS provided", () => {
	const reg = new BrokerTokenRegistry();
	const t = reg.issue("run-1"); // issued without taskId
	// Lookup WITH a taskId falls back to the bare runId entry.
	assert.equal(reg.tokenRole("run-1", "task-late", t), "worker");
	assert.equal(reg.matches("run-1", "task-late", t), true);
});

// ---------------------------------------------------------------------------
// Orchestrator token (F-06: role from token TYPE, not self-declared)
// ---------------------------------------------------------------------------

test("issueOrchestratorToken yields role 'orchestrator'", () => {
	const reg = new BrokerTokenRegistry();
	const orch = reg.issueOrchestratorToken("run-1");
	assert.match(orch, UUID_V4);
	assert.equal(reg.tokenRole("run-1", undefined, orch), "orchestrator");
	assert.equal(reg.matches("run-1", undefined, orch), true);
});

test("issueOrchestratorToken is idempotent per runId", () => {
	const reg = new BrokerTokenRegistry();
	const a = reg.issueOrchestratorToken("run-1");
	const b = reg.issueOrchestratorToken("run-1");
	assert.equal(b, a);
});

test("F-06 role isolation: worker token is NOT orchestrator and vice versa", () => {
	const reg = new BrokerTokenRegistry();
	const worker = reg.issue("run-1", "task-1");
	const orch = reg.issueOrchestratorToken("run-1");
	// Cryptographically distinct tokens by construction.
	assert.notEqual(worker, orch);
	// Each resolves to exactly one role.
	assert.equal(reg.tokenRole("run-1", "task-1", worker), "worker");
	assert.equal(reg.tokenRole("run-1", "task-1", orch), "orchestrator");
	// A worker token presented where an orchestrator is required must NOT
	// escalate — orchestrator is checked first and only the orchestrator
	// token matches that key.
	assert.notEqual(reg.tokenRole("run-1", undefined, worker), "orchestrator");
});

test("orchestrator token is distinct from every normal task token (no key collision)", () => {
	// Contract (documented in source): orchestratorKey is the sentinel
	// `runId:__orchestrator__`; real taskIds are safe-path ids and therefore
	// never collide with it. Verify that invariant with a normal taskId.
	const reg = new BrokerTokenRegistry();
	const orch = reg.issueOrchestratorToken("run-1");
	const taskToken = reg.issue("run-1", "task-1");
	assert.notEqual(orch, taskToken);
	// Each resolves to exactly its own role — never crossed.
	assert.equal(reg.tokenRole("run-1", undefined, orch), "orchestrator");
	assert.equal(reg.tokenRole("run-1", "task-1", taskToken), "worker");
	// The orchestrator token does NOT authenticate as a task worker and the
	// task token does NOT authenticate as orchestrator.
	assert.equal(reg.tokenRole("run-1", "task-1", orch), "orchestrator");
	assert.equal(reg.tokenRole("run-1", undefined, taskToken), null);
});

// ---------------------------------------------------------------------------
// REJECTION paths (security-critical)
// ---------------------------------------------------------------------------

test("REJECTS a wrong (random different) token", () => {
	const reg = new BrokerTokenRegistry();
	reg.issue("run-1", "task-1");
	const wrong = newBrokerToken();
	assert.equal(reg.matches("run-1", "task-1", wrong), false);
	assert.equal(reg.tokenRole("run-1", "task-1", wrong), null);
});

test("REJECTS a token tampered by exactly one byte (timingSafeEqual equal-length path)", () => {
	const reg = new BrokerTokenRegistry();
	const t = reg.issue("run-1", "task-1");
	const tampered = tamperOneChar(t);
	// Same length, single-byte difference → must reject. This exercises the
	// constant-time compare branch (no early length short-circuit).
	assert.equal(tampered.length, t.length);
	assert.notEqual(tampered, t);
	assert.equal(reg.matches("run-1", "task-1", tampered), false);
	assert.equal(reg.tokenRole("run-1", "task-1", tampered), null);
});

test("REJECTS differing-length candidates (shorter and longer) without entering timingSafeEqual", () => {
	const reg = new BrokerTokenRegistry();
	const t = reg.issue("run-1", "task-1");
	const shorter = t.slice(0, -1);
	const longer = `${t}x`;
	assert.equal(reg.matches("run-1", "task-1", shorter), false);
	assert.equal(reg.matches("run-1", "task-1", longer), false);
	assert.equal(reg.tokenRole("run-1", "task-1", shorter), null);
	assert.equal(reg.tokenRole("run-1", "task-1", longer), null);
});

test("REJECTS non-string candidates: number, null, undefined, object, boolean", () => {
	const reg = new BrokerTokenRegistry();
	reg.issue("run-1", "task-1");
	const bad: unknown[] = [1234, null, undefined, { token: "x" }, true, [], 0];
	for (const candidate of bad) {
		assert.equal(reg.matches("run-1", "task-1", candidate), false, `must reject ${typeof candidate}`);
		assert.equal(reg.tokenRole("run-1", "task-1", candidate), null);
	}
});

test("REJECTS an empty-string candidate", () => {
	const reg = new BrokerTokenRegistry();
	reg.issue("run-1", "task-1");
	assert.equal(reg.matches("run-1", "task-1", ""), false);
	assert.equal(reg.tokenRole("run-1", "task-1", ""), null);
});

test("REJECTS when no token was ever issued for the runId (undefined expected, no throw)", () => {
	const reg = new BrokerTokenRegistry();
	const candidate = newBrokerToken();
	// expected === undefined → must short-circuit to false WITHOUT calling
	// timingSafeEqual on undefined (which would throw). Mutation-sensitive:
	// removing the undefined guard makes this throw instead of returning false.
	assert.equal(reg.matches("run-ghost", "task-1", candidate), false);
	assert.equal(reg.tokenRole("run-ghost", "task-1", candidate), null);
	assert.equal(reg.get("run-ghost", "task-1"), undefined);
});

test("REJECTS cross-run: a token issued for runA does not authenticate runB", () => {
	const reg = new BrokerTokenRegistry();
	const tA = reg.issue("run-A", "task-1");
	// Same taskId, different runId → reject (run isolation).
	assert.equal(reg.matches("run-B", "task-1", tA), false);
	assert.equal(reg.tokenRole("run-B", "task-1", tA), null);
});

test("REJECTS cross-task: a token issued for taskA does not authenticate taskB", () => {
	const reg = new BrokerTokenRegistry();
	const tA = reg.issue("run-1", "task-A");
	// Same runId, different taskId → reject (per-task isolation, F-06).
	assert.equal(reg.matches("run-1", "task-B", tA), false);
	assert.equal(reg.tokenRole("run-1", "task-B", tA), null);
});

test("REJECTS a worker token presented for orchestrator-only resolution is 'worker', never 'orchestrator'", () => {
	const reg = new BrokerTokenRegistry();
	const worker = reg.issue("run-1", "task-1");
	// No orchestrator token issued for run-1 → worker token resolves as
	// 'worker', proving it cannot impersonate orchestrator.
	assert.equal(reg.tokenRole("run-1", "task-1", worker), "worker");
});

// ---------------------------------------------------------------------------
// Revocation / expiry (lifecycle teardown — the module has no TTL)
// ---------------------------------------------------------------------------

test("revoke(runId, taskId) invalidates the task token", () => {
	const reg = new BrokerTokenRegistry();
	const t = reg.issue("run-1", "task-1");
	assert.equal(reg.matches("run-1", "task-1", t), true);
	reg.revoke("run-1", "task-1");
	assert.equal(reg.matches("run-1", "task-1", t), false, "revoked token must not authenticate");
	assert.equal(reg.tokenRole("run-1", "task-1", t), null);
	assert.equal(reg.get("run-1", "task-1"), undefined);
});

test("revoke(runId, taskId) also removes the bare-runId fallback entry", () => {
	const reg = new BrokerTokenRegistry();
	const t = reg.issue("run-1"); // bare per-run token
	reg.revoke("run-1", "task-1"); // taskId provided → also deletes bare runId
	assert.equal(reg.matches("run-1", undefined, t), false);
	assert.equal(reg.get("run-1"), undefined);
});

test("revoke(runId) without taskId removes the bare-runId + orchestrator entries (compound task keys survive)", () => {
	// Documented scope of revoke(runId) with no taskId: deletes the bare
	// `runId` key and the orchestrator sentinel key. Compound per-task keys
	// (`runId:taskId`) are NOT touched by a bare revoke — they require a
	// per-task revoke(runId, taskId).
	const reg = new BrokerTokenRegistry();
	const orch = reg.issueOrchestratorToken("run-1");
	const bare = reg.issue("run-1");
	const taskWorker = reg.issue("run-1", "task-1");
	reg.revoke("run-1");
	assert.equal(reg.tokenRole("run-1", undefined, orch), null, "orchestrator token must be revoked");
	assert.equal(reg.matches("run-1", undefined, bare), false, "bare-runId token must be revoked");
	// Compound task key survives a bare revoke (per-task keys need explicit revoke).
	assert.equal(
		reg.matches("run-1", "task-1", taskWorker),
		true,
		"compound task token survives revoke(runId); use revoke(runId, taskId) for it",
	);
});

test("revoke is a no-op-safe call for an unknown key (does not throw, does not affect others)", () => {
	const reg = new BrokerTokenRegistry();
	const keep = reg.issue("run-1", "task-1");
	reg.revoke("run-ghost", "task-x");
	assert.equal(reg.matches("run-1", "task-1", keep), true);
});

test("clear() wipes every token (orchestrator + worker + bare)", () => {
	const reg = new BrokerTokenRegistry();
	const orch = reg.issueOrchestratorToken("run-1");
	const w1 = reg.issue("run-1", "task-1");
	const bare = reg.issue("run-2");
	assert.ok(reg.size >= 3);
	reg.clear();
	assert.equal(reg.size, 0);
	assert.equal(reg.tokenRole("run-1", undefined, orch), null);
	assert.equal(reg.matches("run-1", "task-1", w1), false);
	assert.equal(reg.matches("run-2", undefined, bare), false);
});

test("size reflects distinct registry keys", () => {
	const reg = new BrokerTokenRegistry();
	assert.equal(reg.size, 0);
	reg.issue("run-1", "task-1");
	reg.issue("run-1", "task-1"); // idempotent — no growth
	assert.equal(reg.size, 1);
	reg.issue("run-1", "task-2");
	reg.issueOrchestratorToken("run-1");
	assert.equal(reg.size, 3);
});

// ---------------------------------------------------------------------------
// Input validation — issue / issueOrchestratorToken throw on bad runId
// ---------------------------------------------------------------------------

test("issue throws on empty runId", () => {
	const reg = new BrokerTokenRegistry();
	assert.throws(() => reg.issue("", "task-1"), /runId must be a non-empty string/);
});

test("issue throws on non-string runId", () => {
	const reg = new BrokerTokenRegistry();
	assert.throws(() => reg.issue(123 as unknown as string, "task-1"), /runId must be a non-empty string/);
});

test("issueOrchestratorToken throws on empty runId", () => {
	const reg = new BrokerTokenRegistry();
	assert.throws(() => reg.issueOrchestratorToken(""), /runId must be a non-empty string/);
});
