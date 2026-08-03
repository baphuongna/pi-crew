import assert from "node:assert/strict";
import test from "node:test";
import { appendAutonomousPolicy, buildAutonomousPolicy, detectTeamIntent } from "../../../../src/extension/autonomous-policy.ts";

test("detectTeamIntent detects default, custom, and task-list signals", () => {
	assert.deepEqual(detectTeamIntent("autoteam refactor this"), ["implementation"]);
	assert.deepEqual(
		detectTeamIntent("please swarm this", {
			magicKeywords: { custom: ["swarm"] },
		}),
		["custom"],
	);
	assert.deepEqual(detectTeamIntent("Hãy thực hiện các task sau:\n- sửa config parser\n- thêm test\n- cập nhật docs"), ["taskList"]);
});

test("detectTeamIntent handles docs-only task-list bullets", () => {
	assert.deepEqual(detectTeamIntent("- docs cho API\n- docs cho CLI\n- docs cho config"), ["taskList"]);
});

test("buildAutonomousPolicy contains routing guidance", () => {
	const policy = buildAutonomousPolicy("review-team this diff", {
		preferAsyncForLongTasks: true,
	});
	assert.match(policy, /pi-crew Delegation Policy/);
	assert.match(policy, /team='review'/);
	assert.match(policy, /review/);
	assert.match(policy, /Decision Table/);
	assert.match(policy, /Conflict-safe task splitting/);
	assert.match(policy, /prefer async/);
});

test("appendAutonomousPolicy appends to system prompt", () => {
	const prompt = appendAutonomousPolicy("base", "quick fix bug");
	assert.match(prompt, /^base/);
	assert.match(prompt, /fastFix/);
});
