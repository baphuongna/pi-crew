import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { serializeAgent } from "../../../src/agents/agent-serializer.ts";
import { discoverAgents, invalidateAgentDiscoveryCache } from "../../../src/agents/discover-agents.ts";
import { createTrackedTempDir } from "../../fixtures/test-tempdir.ts";

// Phase 1 — T4: frontmatter `scratchpad:` parses into AgentConfig.scratchpad.
// parseAgentFile is module-private, so exercise it via the public discoverAgents
// flow with a temp repo fixture (pattern: project-agent-extensions-rce.test.ts).

/** Write a project agent file with the given frontmatter and discover it. */
function discoverWithFrontmatter(frontmatterLines: string[]): { scratchpad?: boolean } | undefined {
	const dir = createTrackedTempDir("scratchpad-parse-");
	const agentsDir = path.join(dir, ".crew", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentsDir, "probe.md"),
		["---", "name: probe", "description: probe agent", ...frontmatterLines, "---", "You are a probe agent."].join("\n"),
		"utf-8",
	);
	invalidateAgentDiscoveryCache();
	const result = discoverAgents(dir);
	const agent = [...result.project, ...result.builtin, ...result.user].find((a) => a.name === "probe");
	return agent ? { scratchpad: agent.scratchpad } : undefined;
}

test("T4: frontmatter `scratchpad: true` parses to agent.scratchpad === true", () => {
	const parsed = discoverWithFrontmatter(["scratchpad: true"]);
	assert.ok(parsed, "probe agent should be discovered");
	assert.equal(parsed!.scratchpad, true);
});

test("T4: frontmatter `scratchpad: false` parses to agent.scratchpad === false", () => {
	const parsed = discoverWithFrontmatter(["scratchpad: false"]);
	assert.ok(parsed, "probe agent should be discovered");
	assert.equal(parsed!.scratchpad, false);
});

test("T4: omitted `scratchpad` key → agent.scratchpad === undefined (role default applies)", () => {
	const parsed = discoverWithFrontmatter([]);
	assert.ok(parsed, "probe agent should be discovered");
	assert.equal(parsed!.scratchpad, undefined);
});

test('T4: non-"true" value (e.g. yes / 1) → undefined, not truthy (strict `=== "true"` parse)', () => {
	// Q3: parsed like inheritProjectContext (`=== "true"`), so only the literal
	// string "true" enables; anything else (yes/1/True) → undefined → fail-closed.
	for (const val of ["yes", "1", "True", ""]) {
		const parsed = discoverWithFrontmatter([`scratchpad: ${val}`]);
		assert.ok(parsed, `probe agent should be discovered for scratchpad: ${val}`);
		assert.equal(parsed!.scratchpad, undefined, `scratchpad: ${val} must not enable (strict parse)`);
	}
});

test("F1 round-trip: serialize→parse preserves scratchpad (kill-switch not stripped by management rewrite)", () => {
	// serializeAgent whitelist must include scratchpad, else editing an agent via
	// management rewrites the file WITHOUT the key → `scratchpad: false` (F6
	// kill-switch) gets stripped → rediscover → omitted → role default-on (fail-open).
	const dir = createTrackedTempDir("scratchpad-roundtrip-");
	const agentsDir = path.join(dir, ".crew", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	const filePath = path.join(agentsDir, "rt.md");
	// discover with scratchpad:false, then re-serialize the discovered agent
	fs.writeFileSync(filePath, ["---", "name: rt", "description: rt agent", "scratchpad: false", "---", "You are rt."].join("\n"), "utf-8");
	invalidateAgentDiscoveryCache();
	let parsed = discoverAgents(dir).project.find((a) => a.name === "rt");
	assert.ok(parsed, "rt discovered");
	assert.equal(parsed!.scratchpad, false, "parse: explicit false");
	// management rewrite path: serialize discovered agent → overwrite file
	fs.writeFileSync(filePath, serializeAgent(parsed!), "utf-8");
	invalidateAgentDiscoveryCache();
	parsed = discoverAgents(dir).project.find((a) => a.name === "rt");
	assert.ok(parsed, "rt re-discovered after serialize rewrite");
	assert.equal(parsed!.scratchpad, false, "round-trip: serialize must preserve scratchpad: false (F6 kill-switch not stripped)");
});
