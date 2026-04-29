import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyAttentionState, resolveCrewControlConfig } from "../../src/runtime/agent-control.ts";
import { readCrewAgents, upsertCrewAgent } from "../../src/runtime/crew-agent-records.ts";
import { createRunManifest } from "../../src/state/state-store.ts";
import { readEvents } from "../../src/state/event-log.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = { name: "control", description: "control", source: "builtin", filePath: "control.team.md", roles: [{ name: "executor", agent: "executor" }] };
const workflow: WorkflowConfig = { name: "control", description: "control", source: "builtin", filePath: "control.workflow.md", steps: [{ id: "execute", role: "executor", task: "Execute" }] };

test("agent control marks stale running agents as needs_attention", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-control-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest } = createRunManifest({ cwd, team, workflow, goal: "control" });
		const old = new Date(Date.now() - 120_000).toISOString();
		const record = {
			id: `${manifest.runId}:01_execute`,
			runId: manifest.runId,
			taskId: "01_execute",
			agent: "executor",
			role: "executor",
			runtime: "child-process" as const,
			status: "running" as const,
			startedAt: old,
			progress: { recentTools: [], recentOutput: [], toolCount: 0, lastActivityAt: old, activityState: "active" as const },
		};
		upsertCrewAgent(manifest, record);
		const updated = applyAttentionState(manifest, record, resolveCrewControlConfig({ control: { needsAttentionAfterMs: 1000 } }));
		assert.equal(updated.progress?.activityState, "needs_attention");
		assert.equal(readCrewAgents(manifest)[0]!.progress?.activityState, "needs_attention");
		assert.equal(readEvents(manifest.eventsPath).some((event) => event.type === "agent.needs_attention"), true);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
