import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { recordFromTask, saveCrewAgents } from "../../../../src/runtime/crew-agent-records.ts";
import { createRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import { LiveRunSidebar } from "../../../../src/ui/live-run-sidebar.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

const team: TeamConfig = {
	name: "research",
	description: "research",
	source: "builtin",
	filePath: "research.team.md",
	roles: [
		{ name: "explorer", agent: "explorer" },
		{ name: "analyst", agent: "analyst" },
	],
};
const workflow: WorkflowConfig = {
	name: "research",
	description: "research",
	source: "builtin",
	filePath: "research.workflow.md",
	steps: [
		{ id: "explore", role: "explorer", task: "Explore" },
		{
			id: "analyze",
			role: "analyst",
			dependsOn: ["explore"],
			task: "Analyze",
		},
	],
};

test("LiveRunSidebar renders active, waiting, model, and usage sections", () => {
	const cwd = createTrackedTempDir("pi-crew-live-sidebar-");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest, tasks } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "sidebar",
		});
		const updated = tasks.map((task) =>
			task.id === "01_explore"
				? {
						...task,
						status: "running" as const,
						startedAt: "2026-01-01T00:00:00.000Z",
						modelAttempts: [{ model: "openai-codex/gpt-5.5", success: false }],
						usage: { input: 10, output: 5 },
						agentProgress: {
							recentTools: [],
							recentOutput: [],
							toolCount: 2,
							currentTool: "read",
						},
					}
				: task,
		);
		saveRunTasks(manifest, updated);
		saveCrewAgents(manifest, [recordFromTask(manifest, updated[0]!, "child-process")]);
		const sidebar = new LiveRunSidebar({
			cwd,
			runId: manifest.runId,
			done: () => undefined,
		});
		const text = sidebar.render(80).join("\n");
		// RAIL §2.E: `┏ LIVE ▸ <run8>` canopy + `┣ SECTION` headers + `┗ <hint>`
		// cap. The rounded `╭─╮│╰─╯` box is retired.
		assert.match(text, /^┏ LIVE ▸ \w{8}/);
		assert.ok(!/[╭╮╰╯│]/.test(text), `rounded box glyphs retired, got '${text}'`);
		assert.match(text, /┣ ACTIVE ▸ 1 agent/);
		assert.match(text, /┣ WAITING ▸ \d+ tasks?/);
		assert.match(text, /model openai-codex\/gpt-5\.5/);
		// M4 polish (2026-09-16): the sidebar prints the TUI usage form
		// (`↑10 ↓5`), not the `key=value` form used by CLI/status output — the
		// raw form buried the numbers under `cacheRead=…, cacheWrite=0,
		// cost=0.000000, turns=0` on a 118-column row.
		assert.match(text, /↑10 ↓5/, `compact usage form expected, got ${text}`);
		assert.match(text, /02_analyze waiting for 01_explore/);
		assert.ok(text.trimEnd().split("\n").at(-1)?.startsWith("┗ "), "closes with the `┗ <hint>` cap");
		assert.ok(!text.includes("->"), "the legacy `role->agent` separator is retired");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
