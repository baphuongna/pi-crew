import assert from "node:assert/strict";
import test from "node:test";
import { __test_resetProviderQuota, isProviderDeprioritized, noteProviderResponse } from "../../../../src/runtime/model/provider-quota.ts";
import {
	__test_resetSessionModel,
	hasActiveLiveAgents,
	liveAgentContext,
	noteSessionModel,
	registerLiveAgentModel,
	resolveProviderForResponse,
	unregisterLiveAgentModel,
} from "../../../../src/runtime/model/session-model.ts";

/**
 * Per-agent quota attribution for the opt-in live-session runtime.
 *
 * Root cause: `currentSessionModel()` is a module-scoped singleton. In
 * live-session mode multiple in-process subagents share it, so a provider-B
 * response gets attributed to the main session's provider-A.
 *
 * Fix: AsyncLocalStorage carries each agent's known model through the async
 * chain. `resolveProviderForResponse()` checks the async context first, then
 * guards (skip when live agents are active but context is absent), then falls
 * back to the global tracker (default child-process path).
 */

test("resolveProviderForResponse uses global tracker when no live agents active", () => {
	__test_resetSessionModel();
	__test_resetProviderQuota();
	noteSessionModel("provider-a/foo");
	assert.equal(resolveProviderForResponse(), "provider-a");
});

test("resolveProviderForResponse returns undefined when live agents active but no async context", () => {
	__test_resetSessionModel();
	__test_resetProviderQuota();
	noteSessionModel("provider-a/foo");
	registerLiveAgentModel("agent-a", "provider-a/foo");
	// No async context → must NOT fall through to the global tracker.
	assert.equal(resolveProviderForResponse(), undefined);
});

test("cross-agent quota attribution: provider-B 429 does NOT contaminate provider-A", () => {
	__test_resetSessionModel();
	__test_resetProviderQuota();
	// Main session tracks provider-A.
	noteSessionModel("provider-a/foo");
	// Two live-session agents with different providers.
	registerLiveAgentModel("agent-a", "provider-a/foo");
	registerLiveAgentModel("agent-b", "provider-b/bar");

	// Simulate the after_provider_response handler for agent-b (provider-B).
	liveAgentContext.run({ agentId: "agent-b", modelRef: "provider-b/bar" }, () => {
		const provider = resolveProviderForResponse();
		assert.equal(provider, "provider-b");
		assert.ok(provider, "must resolve provider-b from async context");
		noteProviderResponse(provider!, 429, { "retry-after": "30" });
	});

	// THE KEY ASSERTION: provider-B is deprioritized, provider-A is NOT.
	assert.equal(isProviderDeprioritized("provider-b"), true, "provider-b should be deprioritized (it got the 429)");
	assert.equal(isProviderDeprioritized("provider-a"), false, "provider-a must NOT be deprioritized (no contamination)");
});

test("unregistering live agents restores default-path behavior", () => {
	__test_resetSessionModel();
	__test_resetProviderQuota();
	noteSessionModel("provider-a/foo");
	registerLiveAgentModel("agent-a", "provider-a/foo");
	registerLiveAgentModel("agent-b", "provider-b/bar");

	unregisterLiveAgentModel("agent-a");
	unregisterLiveAgentModel("agent-b");

	assert.equal(hasActiveLiveAgents(), false);
	// Global tracker is used again.
	assert.equal(resolveProviderForResponse(), "provider-a");
});

test("empty-string modelRef does not attribute to a wrong provider (no model resolved)", () => {
	__test_resetSessionModel();
	__test_resetProviderQuota();
	noteSessionModel("provider-a/foo");
	// An agent whose model could not be resolved (e.g. empty candidates) is
	// registered with "" — providerOfModelRef("") returns undefined, so the
	// handler must skip attribution rather than guess a provider.
	registerLiveAgentModel("agent-x", "");
	const provider = liveAgentContext.run({ agentId: "agent-x", modelRef: "" }, () => resolveProviderForResponse());
	assert.equal(provider, undefined, "empty modelRef must not attribute quota to any provider");
});
