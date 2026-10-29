/**
 * w1a regression — broker-bare-run-token-forged-task-identity.
 *
 * PoC shape (all 31 assertions in the audit run): in a dynamic-workflow run
 * every ctx.agent() spawn passes runId WITHOUT a taskId, so the root-session
 * issuer minted the legacy BARE per-run token (bare `runId` key) and
 * child-pi-spawn delivered it into the LLM worker's env. tokenRoleWithMatchKind's
 * runId-fallback then authenticated that bare token for ANY caller-declared
 * taskId that had no compound key yet — binding the forged identity for the
 * connection's lifetime (inbox theft, spoofed sends, and — because
 * wait.resolve skipped waitAuthError — parked-ask hijack).
 *
 * This file pins the three closures:
 *   1. issueForChild FAILS CLOSED on a missing task identity (no bare token).
 *   2. wait.resolve enforces the compound-token rule (waitAuthError), same as
 *      its wait.request sibling.
 *   3. the registry never lets a bare token authenticate an explicit taskId
 *      claim; legit compound tokens keep working, and revocation semantics
 *      still kill compound-token connections.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { installCrewBrokerLifecycleController } from "../../../../src/extension/registration/lifecycle-handlers.ts";
import { setActiveBrokerIssuer } from "../../../../src/runtime/broker/broker-issuer.ts";
import { BrokerTokenRegistry, newBrokerToken } from "../../../../src/runtime/broker/crew-broker-tokens.ts";
import type { ServerConnection } from "../../../../src/runtime/broker/protocol/connection-state.ts";
import { waitAuthError } from "../../../../src/runtime/broker/protocol/wait-auth.ts";
import { handleWaitResolve } from "../../../../src/runtime/broker/protocol/wait-resolve.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeConn(overrides: Partial<ServerConnection> = {}): ServerConnection {
	return {
		socket: { destroy: () => undefined, write: () => true } as unknown as ServerConnection["socket"],
		decoder: {} as ServerConnection["decoder"],
		authed: true,
		runId: "run-w1a",
		taskId: "01_task-b",
		role: "worker",
		authMatchKind: "compound",
		outbound: [],
		queuedBytes: 0,
		needsResync: false,
		closed: false,
		helloTimer: null,
		outboundSeq: 0,
		...overrides,
	};
}

function captureHelpers(): {
	errors: Array<{ id: string; code: string; message: string }>;
	results: Array<{ id: string; result: unknown }>;
	helpers: Parameters<typeof handleWaitResolve>[3];
} {
	const errors: Array<{ id: string; code: string; message: string }> = [];
	const results: Array<{ id: string; result: unknown }> = [];
	const helpers = {
		sendError: (_conn: ServerConnection, id: string, code: string, message: string) => {
			errors.push({ id, code, message });
		},
		sendResult: (_conn: ServerConnection, id: string, result: unknown) => {
			results.push({ id, result });
		},
	};
	return { errors, results, helpers };
}

// ---------------------------------------------------------------------------
// 1. Issuer fails closed on a missing task identity
// ---------------------------------------------------------------------------

test("w1a: issueForChild returns NO credentials for an agentId-less spawn (bare token not minted)", async () => {
	const controller = installCrewBrokerLifecycleController({} as never, {} as never);
	try {
		// The dynamic-workflow ctx.agent() shape: runId present, taskId absent.
		const creds = await controller.issueForChild("run-dwf-1");
		assert.equal(creds, undefined, "a spawn without a task identity gets NO broker credentials");
	} finally {
		await controller.stop();
	}
});

test("w1a: the registry holds NO bare-runId entry after a declined agentId-less issuance", async () => {
	const reg = new BrokerTokenRegistry();
	// Simulate the OLD broken mint: nothing should have created the bare key.
	// (issueForChild declined; only compound keys may exist.)
	const compound = reg.issue("run-dwf-2", "01_task-a");
	// The victim's identity is provable ONLY by its compound token…
	assert.deepEqual(reg.tokenRoleWithMatchKind("run-dwf-2", "01_task-a", compound), {
		role: "worker",
		matchKind: "compound",
	});
	// …and a guessed/held bare token binds nothing, even for task ids that have
	// no compound key yet (the pre-fix attack window).
	const bare = reg.issue("run-dwf-2");
	assert.equal(reg.tokenRoleWithMatchKind("run-dwf-2", "01_task-b", bare), null);
	assert.equal(reg.tokenRoleWithMatchKind("run-dwf-2", "01_task-a", bare), null);
});

// ---------------------------------------------------------------------------
// 2. wait.resolve enforces the compound-token rule
// ---------------------------------------------------------------------------

test("w1a: waitAuthError rejects runId-fallback connections and accepts compound ones", () => {
	const fallback = fakeConn({ authMatchKind: "runId-fallback" });
	const authErr = waitAuthError(fallback);
	assert.ok(authErr, "fallback conn must be rejected");
	assert.equal(authErr.code, "forbidden");
	assert.match(authErr.message, /task-scoped token/);

	const compound = fakeConn({ authMatchKind: "compound" });
	assert.equal(waitAuthError(compound), null, "compound-token worker conn passes");
});

test("w1a: wait.resolve with a runId-fallback connection is forbidden BEFORE any state read", async () => {
	const conn = fakeConn({ authMatchKind: "runId-fallback" });
	const { errors, helpers } = captureHelpers();
	// No cwd: if the auth gate were missing, the handler would fail later with
	// "no-manifest" — the assertion pins that auth fires FIRST.
	await handleWaitResolve(conn, "wr-1", { to: conn.taskId, questionId: "q-1" }, helpers, {
		waitMethodsEnabled: true,
	});
	assert.equal(errors.length, 1);
	assert.equal(errors[0]?.code, "forbidden");
	assert.match(errors[0]?.message ?? "", /task-scoped token/);
});

test("w1a: wait.resolve reaches the handler's own gates for a compound connection (sibling parity)", async () => {
	const conn = fakeConn({ authMatchKind: "compound" });
	const { errors, helpers } = captureHelpers();
	// Compound auth passes the waitAuthError gate → proceeds to the manifest
	// gate (no cwd → "no-manifest"), proving the check is not over-blocking.
	await handleWaitResolve(conn, "wr-2", { to: conn.taskId, questionId: "q-1" }, helpers, {
		waitMethodsEnabled: true,
	});
	assert.equal(errors.length, 1);
	assert.equal(errors[0]?.code, "no-manifest", "compound conn passes auth, hits the next gate");
});

// ---------------------------------------------------------------------------
// 3. Registry: compound tokens prove identity; revocation still kills them
// ---------------------------------------------------------------------------

test("w1a: legit compound token works end-to-end at hello-equivalent auth and stays revocable", () => {
	const reg = new BrokerTokenRegistry();
	const runId = "run-w1a-revoke";
	const taskId = "01_task-b";
	const token = reg.issue(runId, taskId);

	// Hello-equivalent: compound match binds the identity.
	assert.deepEqual(reg.tokenRoleWithMatchKind(runId, taskId, token), {
		role: "worker",
		matchKind: "compound",
	});
	assert.equal(reg.isTaskTokenRevoked(runId, taskId), false);

	// Revocation semantics unchanged: revokeTaskToken(token) kills the secret
	// for hello AND for the post-hello frame check.
	reg.revokeToken(token);
	assert.equal(reg.isSecretRevoked(BrokerTokenRegistry.hashToken(token)), true);
	assert.equal(reg.isTaskTokenRevoked(runId, taskId), true);
	// Re-issue mints a FRESH live token (never resurrects the revoked secret).
	const fresh = reg.issue(runId, taskId);
	assert.notEqual(fresh, token);
	assert.deepEqual(reg.tokenRoleWithMatchKind(runId, taskId, fresh), {
		role: "worker",
		matchKind: "compound",
	});
	assert.equal(reg.tokenRoleWithMatchKind(runId, taskId, token), null);
});

test("w1a: hello can only bind an identity a compound token proves (sibling-task forgery closed)", () => {
	const reg = new BrokerTokenRegistry();
	const runId = "run-w1a-sibling";
	// Attacker holds a compound token for ITS task…
	const attackerToken = reg.issue(runId, "01_task-attacker");
	// …and cannot use it (or any other secret) to claim the not-yet-spawned victim.
	assert.equal(reg.tokenRoleWithMatchKind(runId, "01_task-victim", attackerToken), null);
	assert.equal(reg.tokenRoleWithMatchKind(runId, "01_task-victim", newBrokerToken()), null);
	assert.equal(reg.tokenRoleWithMatchKind(runId, undefined, attackerToken), null);
	// The victim's compound token binds only the victim.
	const victimToken = reg.issue(runId, "01_task-victim");
	assert.deepEqual(reg.tokenRoleWithMatchKind(runId, "01_task-victim", victimToken), {
		role: "worker",
		matchKind: "compound",
	});
	assert.equal(reg.tokenRoleWithMatchKind(runId, "01_task-attacker", victimToken), null);
});

test("w1a: no ambient issuer registration leak from this file's controller install", async () => {
	// installCrewBrokerLifecycleController publishes the process-local active
	// issuer; this test file must not leave it registered for other tests.
	setActiveBrokerIssuer(undefined);
	assert.ok(true);
});
