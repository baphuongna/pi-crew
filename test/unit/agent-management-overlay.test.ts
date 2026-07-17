import assert from "node:assert/strict";
import test from "node:test";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import {
	agentToEntry,
	createAgentOverlayState,
	moveSelection,
	renderAgentOverlay,
	toggleExpand,
} from "../../src/ui/agent-management-overlay.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "A test agent",
		source: "project",
		filePath: "/agents/test-agent.md",
		systemPrompt: "You are a test agent.",
		...overrides,
	};
}

test("agentToEntry maps AgentConfig fields", () => {
	const agent = makeAgent({
		model: "gpt-4",
		thinking: "high",
		loadMode: "lean",
	});
	const entry = agentToEntry(agent);
	assert.equal(entry.name, "test-agent");
	assert.equal(entry.model, "gpt-4");
	assert.equal(entry.thinking, "high");
	assert.equal(entry.loadMode, "lean");
	assert.equal(entry.source, "project");
});

test("createAgentOverlayState sorts by source priority then name", () => {
	const agents = [
		makeAgent({ name: "bravo", source: "builtin" }),
		makeAgent({ name: "alpha", source: "project" }),
		makeAgent({ name: "charlie", source: "user" }),
	];
	const state = createAgentOverlayState(agents.map(agentToEntry), 20);
	assert.equal(state.entries[0].name, "alpha"); // project first
	assert.equal(state.entries[1].name, "charlie"); // user second
	assert.equal(state.entries[2].name, "bravo"); // builtin last
});

test("moveSelection navigates within bounds", () => {
	const agents = [makeAgent({ name: "a" }), makeAgent({ name: "b" }), makeAgent({ name: "c" })];
	const state = createAgentOverlayState(agents.map(agentToEntry), 20);
	assert.equal(state.selectedIndex, 0);
	const down = moveSelection(state, 1);
	assert.equal(down.selectedIndex, 1);
	const downAgain = moveSelection(down, 1);
	assert.equal(downAgain.selectedIndex, 2);
	// Can't go past end
	const clamped = moveSelection(downAgain, 1);
	assert.equal(clamped.selectedIndex, 2);
	// Go back up
	const up = moveSelection(clamped, -1);
	assert.equal(up.selectedIndex, 1);
});

test("moveSelection clamps at 0", () => {
	const agents = [makeAgent()];
	const state = createAgentOverlayState(agents.map(agentToEntry), 20);
	const up = moveSelection(state, -1);
	assert.equal(up.selectedIndex, 0);
});

test("toggleExpand adds and removes from expanded set", () => {
	const agents = [makeAgent(), makeAgent()];
	let state = createAgentOverlayState(agents.map(agentToEntry), 20);
	assert.equal(state.expanded.size, 0);
	state = toggleExpand(state);
	assert.equal(state.expanded.size, 1);
	assert.ok(state.expanded.has(0));
	state = toggleExpand(state);
	assert.equal(state.expanded.size, 0);
});

test("renderAgentOverlay shows header and agents", () => {
	const agents = [makeAgent({ name: "explorer" })];
	const state = createAgentOverlayState(agents.map(agentToEntry), 20);
	const lines = renderAgentOverlay(state, 80);
	assert.ok(lines.length >= 2);
	assert.ok(lines[0].includes("Agent Configuration"));
	assert.ok(lines[2].includes("explorer"));
});

test("renderAgentOverlay shows expanded details", () => {
	const agent = makeAgent({
		name: "executor",
		model: "gpt-4",
		description: "Does work",
	});
	let state = createAgentOverlayState([agentToEntry(agent)], 20);
	state = toggleExpand(state);
	const lines = renderAgentOverlay(state, 80);
	const joined = lines.join("\n");
	assert.ok(joined.includes("Does work"));
	assert.ok(joined.includes("gpt-4"));
	assert.ok(joined.includes("source: project"));
});

test("renderAgentOverlay handles empty agents", () => {
	const state = createAgentOverlayState([], 20);
	const lines = renderAgentOverlay(state, 80);
	const joined = lines.join("\n");
	assert.ok(joined.includes("No agents discovered"));
});

test("renderAgentOverlay truncates to maxWidth", () => {
	const agent = makeAgent({ name: "a".repeat(100) });
	const state = createAgentOverlayState([agentToEntry(agent)], 20);
	const lines = renderAgentOverlay(state, 40);
	for (const line of lines) {
		assert.ok(line.length <= 40, `Line too long: ${line.length} chars`);
	}
});

test("moveSelection adjusts scrollOffset when selection goes out of view", () => {
	const agents = Array.from({ length: 30 }, (_, i) => makeAgent({ name: `agent-${i}` }));
	const state = createAgentOverlayState(agents.map(agentToEntry), 5);
	assert.equal(state.scrollOffset, 0);
	// Move down 5 times — should start scrolling
	let current = state;
	for (let i = 0; i < 5; i++) current = moveSelection(current, 1);
	assert.equal(current.selectedIndex, 5);
	assert.ok(current.scrollOffset > 0, "scrollOffset should have moved");
});
