import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { shouldRegisterDelegateTool } from "../../../src/prompt/prompt-runtime.ts";
import { prepareSpawnContext } from "../../../src/runtime/child-pi/child-pi-spawn.ts";
import type { AgentConfig } from "../../../src/agents/agent-config.ts";

test("delegate registers for ANY role when env gate on (D8)", () => {
	assert.equal(shouldRegisterDelegateTool({ PI_CREW_DELEGATE_ENABLED: "1", PI_CREW_ROLE: "analyst" } as NodeJS.ProcessEnv), true);
	assert.equal(shouldRegisterDelegateTool({ PI_CREW_DELEGATE_ENABLED: "1", PI_CREW_ROLE: "verifier" } as NodeJS.ProcessEnv), true);
	assert.equal(shouldRegisterDelegateTool({} as NodeJS.ProcessEnv), false);
});

test("D8: PI_CREW_DELEGATE_ENABLED is set for EVERY role and depth (spawn env unconditional)", () => {
	const roles = ["executor", "test-engineer", "explorer", "analyst", "planner", "critic", "reviewer", "verifier", "writer", "security-reviewer"];
	for (const role of roles) {
		// Depth-1 worker (base env, no depthOverride) AND a depth-2+ grandchild
		// (depthOverride pre-encodes parent depth into the base env).
		for (const depthEnv of [undefined, { PI_CREW_DEPTH: "2", PI_TEAMS_DEPTH: "2" }]) {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-d8-env-"));
			try {
				const agent: AgentConfig = {
					name: role,
					description: "d8 test",
					source: "builtin",
					filePath: `${role}.md`,
					systemPrompt: role,
				};
				const res = prepareSpawnContext(
					{ cwd: dir, task: "small task", agent, role, agentId: "task-1" },
					"small task",
					depthEnv,
				);
				assert.equal(res.kind, "ready");
				if (res.kind !== "ready") continue;
				const env = res.ctx.mergedEnv as Record<string, string | undefined>;
				assert.equal(env.PI_CREW_DELEGATE_ENABLED, "1", `role=${role} depthEnv=${depthEnv !== undefined}`);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	}
});