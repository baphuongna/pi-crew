/**
 * broker-issuer.test.ts — Tests for the process-local broker issuer singleton
 * (src/runtime/broker-issuer.ts) and its cross-module integration with the
 * token registry (src/runtime/crew-broker-tokens.ts).
 *
 * The issuer is the seam between the broker lifecycle controller and the
 * child-spawn path: the parent registers an `issueForChild` function here,
 * `runChildPi` reads it, and the returned credentials become the child's
 * broker env (PI_CREW_BROKER_SOCKET / PI_CREW_BROKER_TOKEN / RUN_ID / TASK_ID).
 *
 * These tests:
 *  - exercise the singleton register/read/clear contract.
 *  - build a registry-backed issuer mirroring the REAL `issueForChild`
 *    wiring (src/extension/registration/lifecycle-handlers.ts:874-889) and
 *    validate the issued token cross-module via BrokerTokenRegistry.
 *  - replicate the child env-injection rule from child-pi-spawn.ts:263-271 to
 *    prove the credentials populate the spawn env correctly, and that a
 *    disabled/gated issuer yields NO broker env keys.
 *
 * Mutation-sensitivity notes are inline.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	type BrokerIssuer,
	type BrokerSpawnCredentials,
	getActiveBrokerIssuer,
	setActiveBrokerIssuer,
} from "../../src/runtime/broker-issuer.ts";
import { BrokerTokenRegistry } from "../../src/runtime/crew-broker-tokens.ts";

// ---------------------------------------------------------------------------
// Singleton state hygiene — restore whatever was registered before this suite.
// ---------------------------------------------------------------------------

const priorIssuer = getActiveBrokerIssuer();

test.after(() => {
	setActiveBrokerIssuer(priorIssuer);
});

// Reset to a known baseline so order-independent assertions hold.
setActiveBrokerIssuer(undefined);

// ---------------------------------------------------------------------------
// Registry-backed issuer factory — mirrors the real issueForChild
// (lifecycle-handlers.ts): gate → registry.issue → { socketPath, token }.
// ---------------------------------------------------------------------------

function makeRegistryBackedIssuer(registry: BrokerTokenRegistry, socketPath: string): BrokerIssuer {
	return async (runId: string, taskId?: string): Promise<BrokerSpawnCredentials | undefined> => {
		if (!runId || typeof runId !== "string") return undefined;
		const token = registry.issue(runId, taskId);
		return { socketPath, token };
	};
}

/** Gated variant: models the effectiveEnabled()/root-session gate so we can
 *  prove the disabled path yields undefined credentials (and thus no env). */
function makeGatedIssuer(registry: BrokerTokenRegistry, socketPath: string, enabled: boolean): BrokerIssuer {
	return async (runId: string, taskId?: string): Promise<BrokerSpawnCredentials | undefined> => {
		if (!enabled) return undefined;
		if (!runId || typeof runId !== "string") return undefined;
		const token = registry.issue(runId, taskId);
		return { socketPath, token };
	};
}

/** Replicates the child env-injection rule from child-pi-spawn.ts:263-271.
 *  Only when both socketPath and token are present are the control-namespace
 *  keys populated. Used to prove the issued credentials are spawn-compatible. */
function buildChildBrokerEnv(
	creds: BrokerSpawnCredentials | undefined,
	runId: string | undefined,
	taskId: string | undefined,
): Record<string, string> {
	const env: Record<string, string> = {};
	if (creds?.socketPath && creds.token) {
		env.PI_CREW_BROKER_SOCKET = creds.socketPath;
		env.PI_CREW_BROKER_TOKEN = creds.token;
		if (runId) env.PI_CREW_BROKER_RUN_ID = runId;
		if (taskId) env.PI_CREW_BROKER_TASK_ID = taskId;
	}
	return env;
}

// ---------------------------------------------------------------------------
// Singleton register / read / clear contract
// ---------------------------------------------------------------------------

test("getActiveBrokerIssuer returns undefined when nothing is registered", () => {
	setActiveBrokerIssuer(undefined);
	assert.equal(getActiveBrokerIssuer(), undefined);
});

test("setActiveBrokerIssuer(fn) is returned verbatim by getActiveBrokerIssuer", () => {
	const fn: BrokerIssuer = async () => undefined;
	setActiveBrokerIssuer(fn);
	// Mutation: if setActive no longer stored the reference, identity check fails.
	assert.equal(getActiveBrokerIssuer(), fn);
});

test("setActiveBrokerIssuer(undefined) clears the active issuer", () => {
	const fn: BrokerIssuer = async () => undefined;
	setActiveBrokerIssuer(fn);
	assert.equal(getActiveBrokerIssuer(), fn);
	setActiveBrokerIssuer(undefined);
	assert.equal(getActiveBrokerIssuer(), undefined);
});

test("last-write-wins: registering a second issuer replaces the first", () => {
	const first: BrokerIssuer = async () => undefined;
	const second: BrokerIssuer = async () => undefined;
	setActiveBrokerIssuer(first);
	setActiveBrokerIssuer(second);
	assert.equal(getActiveBrokerIssuer(), second);
	assert.notEqual(getActiveBrokerIssuer(), first);
});

// ---------------------------------------------------------------------------
// Registry-backed issuer — issue + cross-module validation
// ---------------------------------------------------------------------------

test("issuer creates credentials { socketPath, token } for a (runId, taskId)", async () => {
	const registry = new BrokerTokenRegistry();
	const issuer = makeRegistryBackedIssuer(registry, "/tmp/broker-test.sock");
	const creds = await issuer("run-1", "task-1");
	assert.ok(creds, "issuer must return credentials for a valid runId");
	assert.equal(creds!.socketPath, "/tmp/broker-test.sock");
	assert.equal(typeof creds!.token, "string");
	assert.ok(creds!.token.length > 0);
});

test("issued token validates cross-module against BrokerTokenRegistry (role: worker)", async () => {
	const registry = new BrokerTokenRegistry();
	const issuer = makeRegistryBackedIssuer(registry, "/tmp/broker-test.sock");
	const creds = await issuer("run-1", "task-1");
	assert.ok(creds);
	// Cross-module: the credential's token must authenticate via the same
	// registry the issuer draws from (this is the broker's hello auth gate).
	assert.equal(registry.matches("run-1", "task-1", creds!.token), true);
	assert.equal(registry.tokenRole("run-1", "task-1", creds!.token), "worker");
	assert.equal(registry.get("run-1", "task-1"), creds!.token);
});

test("issuer with only runId (no taskId) still issues a validating token", async () => {
	const registry = new BrokerTokenRegistry();
	const issuer = makeRegistryBackedIssuer(registry, "/tmp/broker-test.sock");
	const creds = await issuer("run-1");
	assert.ok(creds);
	assert.equal(registry.tokenRole("run-1", undefined, creds!.token), "worker");
});

test("issuer is idempotent per (runId, taskId): repeated calls yield the same token", async () => {
	const registry = new BrokerTokenRegistry();
	const issuer = makeRegistryBackedIssuer(registry, "/tmp/broker-test.sock");
	const a = await issuer("run-1", "task-1");
	const b = await issuer("run-1", "task-1");
	assert.ok(a && b);
	assert.equal(b!.token, a!.token, "registry-backed issue must be idempotent");
});

test("issuer returns undefined for an empty runId (spawn gate)", async () => {
	const registry = new BrokerTokenRegistry();
	const issuer = makeRegistryBackedIssuer(registry, "/tmp/broker-test.sock");
	assert.equal(await issuer(""), undefined);
	assert.equal(await issuer(undefined as unknown as string), undefined);
});

// ---------------------------------------------------------------------------
// Env injection — the issued credentials populate the child spawn env
// (mirrors child-pi-spawn.ts:263-271)
// ---------------------------------------------------------------------------

test("env injection: credentials populate PI_CREW_BROKER_{SOCKET,TOKEN,RUN_ID,TASK_ID}", async () => {
	const registry = new BrokerTokenRegistry();
	const issuer = makeRegistryBackedIssuer(registry, "/tmp/broker-test.sock");
	const creds = await issuer("run-1", "task-1");
	assert.ok(creds);
	const env = buildChildBrokerEnv(creds, "run-1", "task-1");
	// Mutation: if the issuer returned the token under the wrong field name,
	// these equalities break.
	assert.equal(env.PI_CREW_BROKER_SOCKET, "/tmp/broker-test.sock");
	assert.equal(env.PI_CREW_BROKER_TOKEN, creds!.token);
	assert.equal(env.PI_CREW_BROKER_RUN_ID, "run-1");
	assert.equal(env.PI_CREW_BROKER_TASK_ID, "task-1");
	// The env-injected token must itself validate against the registry.
	assert.equal(registry.matches("run-1", "task-1", env.PI_CREW_BROKER_TOKEN), true);
});

test("env injection: when runId/taskId are absent, only SOCKET+TOKEN keys are set", async () => {
	const registry = new BrokerTokenRegistry();
	const issuer = makeRegistryBackedIssuer(registry, "/tmp/broker-test.sock");
	const creds = await issuer("run-1"); // no taskId
	const env = buildChildBrokerEnv(creds, "run-1", undefined);
	assert.equal(env.PI_CREW_BROKER_SOCKET, "/tmp/broker-test.sock");
	assert.equal(env.PI_CREW_BROKER_TOKEN, creds!.token);
	assert.equal("PI_CREW_BROKER_TASK_ID" in env, false, "no taskId → no TASK_ID key");
});

test("disabled-path: gated issuer returns undefined → env has NO broker keys at all", async () => {
	const registry = new BrokerTokenRegistry();
	const issuer = makeGatedIssuer(registry, "/tmp/broker-test.sock", false);
	const creds = await issuer("run-1", "task-1");
	assert.equal(creds, undefined, "disabled broker must not issue credentials");
	const env = buildChildBrokerEnv(creds, "run-1", "task-1");
	assert.equal("PI_CREW_BROKER_SOCKET" in env, false);
	assert.equal("PI_CREW_BROKER_TOKEN" in env, false);
	assert.equal("PI_CREW_BROKER_RUN_ID" in env, false);
	assert.equal("PI_CREW_BROKER_TASK_ID" in env, false);
});

test("disabled-path: a credentials object missing the token yields no TOKEN key (guard rule)", () => {
	// Mirrors the `if (creds?.socketPath && creds.token)` guard: a tokenless
	// credential must NOT inject partial env (defense-in-depth).
	const malformed: BrokerSpawnCredentials = { socketPath: "/tmp/x.sock", token: "" };
	const env = buildChildBrokerEnv(malformed, "run-1", "task-1");
	assert.equal("PI_CREW_BROKER_SOCKET" in env, false);
	assert.equal("PI_CREW_BROKER_TOKEN" in env, false);
});

// ---------------------------------------------------------------------------
// Issuer swallowing throw → undefined (mirrors runChildPi try/catch)
// ---------------------------------------------------------------------------

test("issuer that throws is surfaced as a rejection (caller wraps in try/catch like runChildPi)", async () => {
	const throwingIssuer: BrokerIssuer = async () => {
		throw new Error("broker bind failed");
	};
	await assert.rejects(() => throwingIssuer("run-1", "task-1"), /broker bind failed/);
	// runChildPi wraps the issuer call in try/catch and falls back to undefined;
	// verify that fallback shape here.
	const safeCreds = await (async () => {
		try {
			return await throwingIssuer("run-1", "task-1");
		} catch {
			return undefined;
		}
	})();
	assert.equal(safeCreds, undefined);
});
