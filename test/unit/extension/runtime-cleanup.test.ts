/**
 * Unit tests for the navigational-switch gate in stopSessionBoundSubagents.
 *
 * Regression: entering an agent session view (/crew-view) mid-run fired
 * session_before_switch → stopSessionBoundSubagents → child pi workers were
 * killed (exit 143) → the run cancelled seconds into it. The view switch is
 * navigational: during it, the abort cluster must be skipped entirely.
 *
 * The gate is the FIRST statement of the built closure — with the flag set,
 * the closure returns before touching ANY ctx field, so a bare `{}` context
 * proves the early return (the abort cluster below would immediately throw
 * on `ctx.foregroundControllers`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { RegistrationContext } from "../../../src/extension/registration/registration-types.ts";
import { installRuntimeCleanup } from "../../../src/extension/registration/runtime-cleanup.ts";
import {
	clearViewSwitchInFlight,
	markViewSwitchInFlight,
	resetCrewViewSessionState,
} from "../../../src/ui/inline-panel/view-session-store.ts";

/** Minimal ctx: only the fields installRuntimeCleanup reads at build time. */
function bareCtx(): RegistrationContext {
	return {
		globalStore: {},
		runtimeCleanupStoreKey: Symbol("cleanup"),
	} as RegistrationContext;
}

test("stopSessionBoundSubagents is skipped entirely during a view switch", () => {
	resetCrewViewSessionState();
	const ctx = bareCtx();
	installRuntimeCleanup({} as never, ctx);
	markViewSwitchInFlight();
	// A bare ctx would throw on the first abort-cluster access
	// (ctx.foregroundControllers); the early return must avoid it.
	assert.doesNotThrow(() => ctx.stopSessionBoundSubagents());
	clearViewSwitchInFlight();
	resetCrewViewSessionState();
});

test("stopSessionBoundSubagents proceeds normally outside view switches", () => {
	resetCrewViewSessionState();
	clearViewSwitchInFlight();
	const ctx = bareCtx();
	installRuntimeCleanup({} as never, ctx);
	// Flag cleared → the cluster runs → the bare ctx is missing
	// foregroundControllers → throws. This proves the gate only suppresses
	// while a view switch is genuinely in flight.
	assert.throws(() => ctx.stopSessionBoundSubagents());
	resetCrewViewSessionState();
});
