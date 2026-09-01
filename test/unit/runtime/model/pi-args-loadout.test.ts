// Task 1 (loadout/nesting/messaging): D5 (spec v0.7 §6) — worker default
// loadout = FULL pi session (như main session). Restriction chỉ xuất hiện
// khi agent frontmatter khai explicit.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { buildPiWorkerArgs, resolveCrewMaxDepth } from "../../../../src/runtime/model/pi-args.ts";

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
	assert.ok(
		args.some((a, i) => a === "--extension" && args[i + 1]?.includes("prompt-runtime")),
		"prompt-runtime must stay",
	);
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

// B1 (fix round 1): env emission must match argv semantics — undefined
// inheritSkills means INHERIT (like the argv `=== false` check), not "0".
test("B1: PI_CREW_INHERIT_SKILLS env matches argv — undefined = inherit", () => {
	const inherited = buildPiWorkerArgs({ task: "Task: x", agent: agent() });
	assert.ok(!inherited.args.includes("--no-skills"));
	assert.equal(inherited.env.PI_CREW_INHERIT_SKILLS, "1", "undefined inheritSkills → env 1 (inherit)");
	assert.equal(inherited.env.PI_TEAMS_INHERIT_SKILLS, "1", "PI_TEAMS alias must agree");
	const disabled = buildPiWorkerArgs({ task: "Task: x", agent: agent({ inheritSkills: false }) });
	assert.ok(disabled.args.includes("--no-skills"));
	assert.equal(disabled.env.PI_CREW_INHERIT_SKILLS, "0", "inheritSkills:false → env 0");
	assert.equal(disabled.env.PI_TEAMS_INHERIT_SKILLS, "0", "PI_TEAMS alias must agree");
});

// B2 (fix round 1): `disallowedTools:` frontmatter is a declaration-driven
// denylist (opt-in like `tools:`) — NOT the role-based policy D5 removed.
test("B2: declared disallowedTools → --exclude-tools; omitted → none", () => {
	const { args } = buildPiWorkerArgs({ task: "Task: x", agent: agent({ disallowedTools: ["bash", "write"] }) });
	const idx = args.indexOf("--exclude-tools");
	assert.ok(idx >= 0, "--exclude-tools must be present when disallowedTools declared");
	const list = args[idx + 1]!.split(",");
	assert.ok(list.includes("bash") && list.includes("write"), "declared disallowed tools present");
	const full = buildPiWorkerArgs({ task: "Task: x", agent: agent() });
	assert.ok(!full.args.includes("--exclude-tools"), "no --exclude-tools when nothing declared");
});

// GAP-1 (fix round 1): SEC-1 builder strip is restored for DECLARED
// extensions from untrusted sources — auto-discovery stays open (D5), but
// `extensions:` in a project/project-pi/dynamic agent never reaches argv
// without the trust gate.
test("GAP-1: declared extensions from dynamic/project sources are stripped (SEC-1)", () => {
	const { args } = buildPiWorkerArgs({
		task: "Task: x",
		agent: agent({ extensions: ["./.crew/pwn.ts"] }),
		env: {},
	});
	assert.ok(!args.some((a) => a.includes("pwn.ts")), "dynamic-source declaration must be stripped");
	assert.ok(
		args.some((a, i) => a === "--extension" && args[i + 1]?.includes("prompt-runtime")),
		"prompt-runtime stays unconditionally",
	);
});

// Task 2 (loadout/nesting/messaging): D8 (spec v0.7) — default maxDepth
// cho phép 4 level nested (child creates child creates child creates child).
// Cap giữ để chống runaway recursion.
test("default max depth is 4 (child creates child creates child creates child)", () => {
	assert.equal(resolveCrewMaxDepth(undefined, {}), 4);
});
