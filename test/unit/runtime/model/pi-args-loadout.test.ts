// Task 1 (loadout/nesting/messaging): D5 (spec v0.7 §6) — worker default
// loadout = FULL pi session (như main session). Restriction chỉ xuất hiện
// khi agent frontmatter khai explicit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPiWorkerArgs } from "../../../../src/runtime/model/pi-args.ts";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";

function agent(fields: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "test",
		source: "dynamic",
		filePath: "/test",
		systemPrompt: "",
		...fields,
	} as AgentConfig;
}

test("default loadout is FULL session: no --no-extensions/--no-skills/--tools", () => {
	const { args } = buildPiWorkerArgs({ task: "Task: do it", agent: agent() });
	assert.ok(!args.includes("--no-extensions"), "must not disable extension discovery");
	assert.ok(!args.includes("--no-skills"), "must not disable skills discovery");
	assert.ok(!args.includes("--tools"), "must not restrict tools when agent declares none");
	assert.ok(!args.includes("--exclude-tools"), "must not exclude tools by default");
	assert.ok(args.some((a, i) => a === "--extension" && args[i + 1]?.includes("prompt-runtime")), "prompt-runtime must stay");
});

test("explicit frontmatter tools → lock + auto-add control tools", () => {
	const { args } = buildPiWorkerArgs({ task: "Task: x", agent: agent({ tools: "read,grep" as unknown as AgentConfig["tools"] }) });
	const idx = args.indexOf("--tools");
	assert.ok(idx >= 0, "--tools must be present when declared");
	const list = args[idx + 1]!.split(",");
	assert.ok(list.includes("read") && list.includes("grep"), "declared tools present");
	assert.ok(list.includes("ask"), "ask control tool auto-added");
	assert.ok(list.includes("delegate"), "delegate control tool auto-added");
});

test("inheritSkills:false vẫn tắt skills khi agent khai explicit", () => {
	const { args } = buildPiWorkerArgs({ task: "Task: x", agent: agent({ inheritSkills: false }) });
	assert.ok(args.includes("--no-skills"), "explicit inheritSkills:false still disables skills");
});
