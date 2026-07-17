import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { TEAM_EVENT_TYPES } from "../../src/state/contracts.ts";

test("pre-step audit events are registered without exposing script output", () => {
	assert.ok(TEAM_EVENT_TYPES.includes("hook.pre_step_started"));
	assert.ok(TEAM_EVENT_TYPES.includes("hook.pre_step_completed"));
	assert.ok(TEAM_EVENT_TYPES.includes("hook.pre_step_failed"));
	assert.ok(TEAM_EVENT_TYPES.includes("hook.pre_step_optional_failed"));
});

test("preStepOptional cannot bypass path-containment validation", () => {
	const text = readFileSync("src/runtime/task-runner.ts", "utf8");
	const validation = text.indexOf("resolveRealContainedPath(manifest.cwd, input.step.preStepScript);");
	const optionalCatch = text.indexOf("if (input.step.preStepOptional)", validation);
	assert.ok(validation >= 0);
	assert.ok(optionalCatch > validation);
});
