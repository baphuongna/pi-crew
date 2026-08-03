import assert from "node:assert/strict";
import test from "node:test";
import { rewriteTeamWorkerPrompt } from "../../../src/prompt/prompt-runtime.ts";

test("rewriteTeamWorkerPrompt strips project context and skills", () => {
	const prompt = [
		"Base prompt",
		"",
		"# Project Context",
		"",
		"Project-specific instructions and guidelines:",
		"",
		"secret project rules",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		"skill catalog",
		"Current date: 2026-04-26",
	].join("\n");
	const rewritten = rewriteTeamWorkerPrompt(prompt, {
		inheritProjectContext: false,
		inheritSkills: false,
	});
	assert.equal(rewritten.includes("secret project rules"), false);
	assert.equal(rewritten.includes("skill catalog"), false);
	assert.equal(rewritten.includes("Current date"), true);
});
