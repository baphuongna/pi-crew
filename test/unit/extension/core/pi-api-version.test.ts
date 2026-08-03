import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILT_AGAINST_PI_VERSION } from "../../../../src/extension/pi-api.ts";

describe("BUILT_AGAINST_PI_VERSION (deprecated)", () => {
	// Phase 5 follow-up to H1: pi-crew declares peerDependencies as '*',
	// so runtime version is set by host pi install. Pinning this
	// constant to a devDep range was a false invariant — see the
	// @deprecated note on BUILT_AGAINST_PI_VERSION in src/extension/pi-api.ts.
	//
	// The matching subtest (FIX #10 — drift detection against the
	// local node_modules) was removed entirely. Only the type/shape
	// check remains so we keep coverage on the deprecated export
	// without the false coupling.
	it("is a non-empty string", () => {
		assert.ok(typeof BUILT_AGAINST_PI_VERSION === "string");
		assert.ok(BUILT_AGAINST_PI_VERSION.length > 0);
	});
});
