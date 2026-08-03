import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { allAgents, discoverAgents } from "../../../src/agents/discover-agents.ts";
import { buildMemoryBlock, isUnsafeMemoryName, readMemoryIndex, resolveMemoryDir } from "../../../src/runtime/agent-memory.ts";

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

test("readMemoryIndex truncates >200 lines and embeds the absolute MEMORY.md path", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-memory-trunc-"));
	try {
		const memoryDir = resolveMemoryDir("executor", "project", cwd);
		fs.mkdirSync(memoryDir, { recursive: true });
		const memPath = path.join(memoryDir, "MEMORY.md");
		// Sanity: memory dir + file path are absolute.
		assert.equal(path.isAbsolute(memoryDir), true);
		assert.equal(path.isAbsolute(memPath), true);

		// 250 lines (no trailing newline) → strictly > 200 line threshold.
		const headToken = "MEMORY_HEAD_TOKEN_9X";
		const lines = [headToken, ...Array.from({ length: 249 }, (_, i) => `entry ${i + 2}`)];
		fs.writeFileSync(memPath, lines.join("\n"), "utf-8");

		const out = readMemoryIndex(memoryDir);
		assert.notEqual(out, undefined, "readMemoryIndex must return content for an existing file");
		// Head content is present.
		assert.ok(out!.includes(headToken), "head content should survive truncation");
		// Marker text appears.
		assert.match(out!, /\(truncated at 200 lines\)/);
		// The absolute path to MEMORY.md is embedded in the marker.
		assert.ok(out!.includes(memPath), `marker should embed the absolute MEMORY.md path; got path=${memPath}`);
		assert.equal(fs.existsSync(memPath), true, "embedded path must resolve to a real file");
		// Mentions the read tool hint.
		assert.match(out!, /use the `read` tool/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("readMemoryIndex does NOT add a truncation marker when content is under 200 lines", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-memory-small-"));
	try {
		const memoryDir = resolveMemoryDir("executor", "project", cwd);
		fs.mkdirSync(memoryDir, { recursive: true });
		const memPath = path.join(memoryDir, "MEMORY.md");
		// 100 lines → well under 200 threshold.
		const lines = Array.from({ length: 100 }, (_, i) => `entry ${i + 1}`);
		fs.writeFileSync(memPath, lines.join("\n"), "utf-8");

		const out = readMemoryIndex(memoryDir);
		assert.notEqual(out, undefined);
		assert.equal(out!.includes("truncated at"), false, "no marker should appear under threshold");
		assert.ok(out!.includes("entry 1"));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("readMemoryIndex returns undefined when MEMORY.md is absent", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-memory-absent-"));
	try {
		const memoryDir = resolveMemoryDir("executor", "project", cwd);
		fs.mkdirSync(memoryDir, { recursive: true });
		const out = readMemoryIndex(memoryDir);
		assert.equal(out, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
