import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildMemoryBlock, isUnsafeMemoryName, resolveMemoryDir } from "../../src/runtime/agent-memory.ts";
import { allAgents, discoverAgents } from "../../src/agents/discover-agents.ts";

test("agent memory rejects unsafe names and reads project memory", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-memory-"));
	try {
		assert.equal(isUnsafeMemoryName("../bad"), true);
		assert.equal(isUnsafeMemoryName("executor"), false);
		const dir = resolveMemoryDir("executor", "project", cwd);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "MEMORY.md"), "remember this\n", "utf-8");
		const block = buildMemoryBlock("executor", "project", cwd, false);
		assert.match(block, /read-only/);
		assert.match(block, /remember this/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("agent discovery parses memory frontmatter", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-memory-agent-"));
	try {
		const agentDir = path.join(cwd, ".crew", "agents");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "mem.md"), "---\nname: mem\ndescription: mem\nmemory: project\n---\nPrompt\n", "utf-8");
		const agent = allAgents(discoverAgents(cwd)).find((item) => item.name === "mem");
		assert.equal(agent?.memory, "project");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
