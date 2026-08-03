import assert from "node:assert/strict";
import test from "node:test";
import { decomposeGoal, recommendTeam } from "../../../src/extension/team-recommendation.ts";
import { handleTeamTool } from "../../../src/extension/team-tool.ts";
import { firstText } from "../../fixtures/tool-result-helpers.ts";

test("recommendTeam maps goals to teams", () => {
	assert.equal(recommendTeam("security review this diff").team, "review");
	assert.equal(recommendTeam("quick fix a small typo").team, "fast-fix");
	assert.equal(recommendTeam("research and compare auth approaches").team, "research");
	assert.equal(recommendTeam("Đọc sâu các source pi-* trong Source/").team, "parallel-research");
	assert.equal(recommendTeam("implement feature with tests").team, "implementation");
});

test("decomposeGoal parses bullet lists", () => {
	const decomposition = decomposeGoal("- update docs\n- add tests");
	assert.equal(decomposition.strategy, "bulleted");
	assert.equal(decomposition.subtasks.length, 2);
	assert.equal(decomposition.fanout, 2);
});

test("recommendTeam routes actionable task lists to implementation", () => {
	const recommendation = recommendTeam("Hãy thực hiện các task sau:\n- sửa config parser\n- thêm test\n- cập nhật docs");
	assert.equal(recommendation.team, "implementation");
	assert.equal(recommendation.workflow, "implementation");
	assert.equal(recommendation.confidence, "high");
	assert.equal(recommendation.decomposition.strategy, "bulleted");
	assert.equal(recommendation.decomposition.fanout, 3);
	assert.match(recommendation.reasons.join("\n"), /task list detected \(3 bullets\)/i);
});

test("recommendTeam can suggest async and worktree", () => {
	const recommendation = recommendTeam("large risky refactor migration across multiple packages with tests", {
		preferAsyncForLongTasks: true,
	});
	assert.equal(recommendation.team, "implementation");
	assert.equal(recommendation.async, true);
	assert.equal(recommendation.workspaceMode, "worktree");
});

test("team tool recommend returns suggested call", async () => {
	const result = await handleTeamTool({ action: "recommend", goal: "review this pull request for security" }, { cwd: process.cwd() });
	assert.equal(result.isError, false);
	const text = firstText(result);
	assert.match(text, /Team: review/);
	assert.match(text, /Suggested tool call/);
});
