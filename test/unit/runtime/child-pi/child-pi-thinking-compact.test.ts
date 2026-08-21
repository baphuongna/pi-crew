/**
 * Regression test: compaction keeps assistant `thinking` (reasoning) content
 * parts so the agent view pane can render a full-looking session transcript
 * (AssistantMessageComponent renders thinking blocks).
 *
 * Run: PI_CREW_ALLOW_MOCK=1 PI_TEAMS_MOCK_CHILD_PI=success npx tsx --test test/unit/child-pi-thinking-compact.test.ts
 */

import assert from "node:assert";
import { test } from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { MAX_THINKING_CHARS } from "../../../../src/runtime/child-pi/child-pi-constants.ts";
import type { ChildPiRunInput } from "../../../../src/runtime/child-pi/child-pi.ts";
import { ChildPiLineObserver } from "../../../../src/runtime/child-pi/child-pi.ts";

const SAMPLE_AGENT: AgentConfig = {
	name: "explorer",
	description: "",
	source: "builtin",
	filePath: "/test/explorer.json",
	systemPrompt: "",
};

function buildInput(): ChildPiRunInput {
	return {
		cwd: process.cwd(),
		task: "test",
		agent: SAMPLE_AGENT,
		onJsonEvent: () => undefined,
		onStdoutLine: () => undefined,
	};
}

test("compaction keeps thinking parts with capped text", () => {
	const events: Array<Record<string, unknown>> = [];
	const input = buildInput();
	input.onJsonEvent = (e) => events.push(e as Record<string, unknown>);
	const observer = new ChildPiLineObserver(input);

	const longReasoning = "step ".repeat(10_000); // > MAX_THINKING_CHARS (8k)
	observer.observe(
		`${JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: longReasoning },
					{ type: "text", text: "done" },
				],
			},
		})}\n`,
	);

	assert.equal(events.length, 1, "one compacted event");
	const message = (events[0]?.message ?? {}) as Record<string, unknown>;
	const content = message.content;
	assert.ok(Array.isArray(content), "content kept");
	const thinkingPart = (content as Array<Record<string, unknown>>).find((part) => part.type === "thinking");
	assert.ok(thinkingPart, "thinking part survives compaction");
	const kept = String((thinkingPart as Record<string, unknown>).thinking);
	assert.ok(kept.startsWith("step"), "thinking text present");
	// compactString can exceed the target by its truncation marker/slack.
	assert.ok(kept.length <= MAX_THINKING_CHARS + 256, `thinking capped (${kept.length})`);
	assert.ok((content as Array<Record<string, unknown>>).some((part) => part.type === "text" && part.text === "done"));
});
