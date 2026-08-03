/**
 * G3 regression: the live-session system prompt must NOT duplicate the agent
 * MEMORY block. Memory is injected once via renderTaskPrompt().full (the USER
 * prompt), which is shared by both the child-pi path (no system prompt at all)
 * and the live-session path. Before this fix, liveSystemPrompt() also called
 * buildMemoryBlock(), so a 200-line memory file appeared in BOTH the user and
 * system prompts of every live subagent.
 *
 * This test locks the invariant: memory markers/content are absent from the
 * system prompt, while the rest of the system-prompt identity layer (role,
 * agent, communication style, output contract) remains intact.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { LiveSessionSpawnInput } from "../../../../src/runtime/live-session/live-session-runtime.ts";
import { liveSystemPrompt } from "../../../../src/runtime/live-session/live-session-runtime.ts";

function makeTmpDir(prefix: string): { dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return {
		dir,
		cleanup: () => {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		},
	};
}

// Build a minimal LiveSessionSpawnInput. Only the fields liveSystemPrompt
// reads are populated; the rest are cast through `as never` to satisfy the
// type without constructing a full manifest.
function makeInput(
	overrides: Partial<LiveSessionSpawnInput> & {
		cwd: string;
		agentMemory?: string;
		roleName?: string;
	},
): LiveSessionSpawnInput {
	const cwd = overrides.cwd;
	const memoryToken = overrides.agentMemory ?? "UNIQUE_MEMORY_TOKEN_G3";
	// Write a MEMORY.md for the agent in the project-scoped memory dir so
	// buildMemoryBlock (if it were called) would surface the token.
	const memDir = path.join(cwd, ".pi", "agent-memory", "test-agent");
	fs.mkdirSync(memDir, { recursive: true });
	fs.writeFileSync(path.join(memDir, "MEMORY.md"), `# Notes\n${memoryToken}\n`, "utf-8");

	return {
		manifest: { runId: "run_g3", stateRoot: cwd } as never,
		task: {
			id: "task_g3",
			role: overrides.roleName ?? "executor",
			cwd,
		} as never,
		step: {
			id: "execute",
			role: overrides.roleName ?? "executor",
			task: "do",
		} as never,
		agent: {
			name: "test-agent",
			description: "test",
			source: "builtin",
			filePath: "test-agent.md",
			systemPrompt: "Do it",
			// Configure memory so buildMemoryBlock would produce a non-empty block
			// if it were (incorrectly) called inside liveSystemPrompt.
			memory: "project",
			tools: ["read", "write"],
		},
		prompt: "do it",
		workspaceId: cwd,
		...overrides,
	} as LiveSessionSpawnInput;
}

test("G3: liveSystemPrompt does NOT include the agent MEMORY block (dedup)", () => {
	const { dir, cleanup } = makeTmpDir("pi-crew-g3-dedup-");
	try {
		const memoryToken = "G3_UNIQUE_MEMORY_CONTENT_9X";
		const input = makeInput({ cwd: dir, agentMemory: memoryToken });
		const sys = liveSystemPrompt(input);

		// The memory block markers must NOT appear in the system prompt.
		assert.equal(sys.includes("# Agent Memory"), false, "system prompt must not contain the '# Agent Memory' header");
		assert.equal(sys.includes("## Current MEMORY.md"), false, "system prompt must not contain the '## Current MEMORY.md' section");
		// The actual memory content token must NOT leak into the system prompt.
		assert.equal(sys.includes(memoryToken), false, "system prompt must not contain memory content");
	} finally {
		cleanup();
	}
});

test("G3: liveSystemPrompt still emits the identity layer (role, agent, style, contract)", () => {
	const { dir, cleanup } = makeTmpDir("pi-crew-g3-identity-");
	try {
		const input = makeInput({ cwd: dir, roleName: "executor" });
		const sys = liveSystemPrompt(input);

		// Identity / framing must remain (proves only memory was removed, not
		// the whole system prompt).
		assert.ok(sys.includes("# pi-crew Live Subagent"), "system prompt header must remain");
		assert.ok(sys.includes("Role: executor"), "role line must remain");
		assert.ok(sys.includes("Agent: test-agent"), "agent line must remain");
		assert.ok(sys.includes("Run ID: run_g3"), "run id must remain");
		assert.ok(sys.includes("Do it"), "agent.systemPrompt must remain");
	} finally {
		cleanup();
	}
});

test("G3: liveSystemPrompt works when agent has no memory configured", () => {
	const { dir, cleanup } = makeTmpDir("pi-crew-g3-nomem-");
	try {
		const input: LiveSessionSpawnInput = {
			manifest: { runId: "run_g3b", stateRoot: dir } as never,
			task: { id: "task_g3b", role: "explorer", cwd: dir } as never,
			step: { id: "explore", role: "explorer", task: "look" } as never,
			agent: {
				name: "no-mem-agent",
				description: "test",
				source: "builtin",
				filePath: "no-mem-agent.md",
				systemPrompt: "Explore.",
				// memory intentionally unset
			},
			prompt: "look",
			workspaceId: dir,
		} as LiveSessionSpawnInput;
		const sys = liveSystemPrompt(input);
		assert.ok(sys.includes("# pi-crew Live Subagent"));
		assert.equal(sys.includes("# Agent Memory"), false);
	} finally {
		cleanup();
	}
});
