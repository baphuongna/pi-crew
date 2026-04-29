import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LiveRunSidebar } from "../../src/ui/live-run-sidebar.ts";
import { createRunManifest, saveRunTasks } from "../../src/state/state-store.ts";
import { saveCrewAgents, recordFromTask } from "../../src/runtime/crew-agent-records.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = { name: "research", description: "research", source: "builtin", filePath: "research.team.md", roles: [{ name: "explorer", agent: "explorer" }, { name: "analyst", agent: "analyst" }] };
const workflow: WorkflowConfig = { name: "research", description: "research", source: "builtin", filePath: "research.workflow.md", steps: [{ id: "explore", role: "explorer", task: "Explore" }, { id: "analyze", role: "analyst", dependsOn: ["explore"], task: "Analyze" }] };

test("LiveRunSidebar renders active, waiting, model, and usage sections", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-live-sidebar-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "sidebar" });
		const updated = tasks.map((task) => task.id === "01_explore" ? { ...task, status: "running" as const, startedAt: "2026-01-01T00:00:00.000Z", modelAttempts: [{ model: "openai-codex/gpt-5.5", success: false }], usage: { input: 10, output: 5 }, agentProgress: { recentTools: [], recentOutput: [], toolCount: 2, currentTool: "read" } } : task);
		saveRunTasks(manifest, updated);
		saveCrewAgents(manifest, [recordFromTask(manifest, updated[0]!, "child-process")]);
		const sidebar = new LiveRunSidebar({ cwd, runId: manifest.runId, done: () => {} });
		const text = sidebar.render(80).join("\n");
		assert.match(text, /pi-crew live sidebar/);
		assert.match(text, /Active agents/);
		assert.match(text, /Waiting tasks/);
		assert.match(text, /model openai-codex\/gpt-5\.5/);
		assert.match(text, /input=10/);
		assert.match(text, /02_analyze waiting for 01_explore/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
