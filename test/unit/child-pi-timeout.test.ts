import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CHILD_PI } from "../../src/config/defaults.ts";

test("child Pi response timeout allows normal provider think time", () => {
	assert.ok(DEFAULT_CHILD_PI.responseTimeoutMs >= 2 * 60_000, `expected child response timeout to be at least 2 minutes, got ${DEFAULT_CHILD_PI.responseTimeoutMs}ms`);
});
